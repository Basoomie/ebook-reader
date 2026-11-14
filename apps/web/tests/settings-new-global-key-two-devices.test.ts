/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Phase 7 bug 2: a global setting added by an app update (the Anki field mapping, WP14)
 * must reach a device that took over the shared settings before the setting existed.
 *
 * Found on the NAS: such a device published its own never-set value (null) for the new
 * key with a newer timestamp, replacing the shared value on the server, and never applied
 * the shared value it had pulled while running the older version.
 *
 * Each device here runs what the app runs (sync-service.ts): publishAllSettings before
 * every sync, onPulledSettings for every pulled batch, against the real storage server.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  becomeSettingsSource,
  onPulledSettings,
  publishAllSettings
} from '$lib/sync/settings-source';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const MAPPING = JSON.stringify({
  'JP Mining Note': {
    sentence: { field: 'Sentence', mode: 'fill-if-empty' },
    sentenceAudio: { field: 'SentenceAudio', mode: 'append' }
  }
});

/** A device with its own localStorage, publishing and applying settings like the app. */
class SettingsDevice {
  readonly values: Record<string, string> = {};
  private readonly pending: Promise<unknown>[] = [];
  readonly deps = {
    // applyGlobalSettingValue: null (never set elsewhere) leaves this device's value.
    apply: (key: string, raw: string | null) => {
      if (raw !== null) this.values[key] = raw;
    },
    readStored: (key: string) => this.values[key] ?? null
  };
  readonly storage = { getItem: (key: string) => this.values[key] ?? null };

  constructor(readonly device: Device) {}

  get engine() {
    return this.device.engine;
  }

  async open() {
    await this.device.open();
    this.engine.onRemoteChange((records) => {
      this.pending.push(onPulledSettings(this.engine, records, this.deps));
    });
  }

  /** One sync as the runner does it: publish, push and pull, then the pulled settings applied. */
  async cycle() {
    await publishAllSettings(this.engine, this.storage, this.deps);
    await this.device.sync();
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }

  /**
   * What a device left behind when it ran a version without `key`: the record may sit in
   * the mirror (pulled, never applied), there is no local value and nothing was published.
   */
  async forgetAsOlderVersion(key: string, options: { mirror: boolean }) {
    delete this.values[key];
    await this.engine.updateMeta((m) => {
      delete m.publishedSettings?.[`global:${key}`];
    });
    if (!options.mirror) {
      // The engine has no local-only delete; reach its IndexedDB directly.
      const db = (
        this.engine as unknown as { db: { delete(s: string, k: unknown): Promise<void> } }
      ).db;
      await db.delete('records', ['setting', `global:${key}`]);
    }
  }

  /** Global setting records this device wrote itself, as kept in its mirror. */
  async ownGlobalRecords() {
    return (await this.engine.getAll('setting')).filter(
      (r) => r.id.startsWith('global:') && r.deviceId === this.engine.deviceId
    );
  }
}

describe('a global setting added by an update reaches every device (real server)', () => {
  const server = new TestServer();
  let tokens: string[] = [];
  let desktop: SettingsDevice;
  let phone: SettingsDevice;

  beforeAll(async () => {
    tokens = seedServer(server, 3).tokens;
    await server.start();
    desktop = new SettingsDevice(new Device('desktop', tokens[0], server));
    phone = new SettingsDevice(new Device('phone', tokens[1], server));
    await desktop.open();
    await phone.open();

    // The desktop becomes the settings source; the phone takes the shared values over.
    desktop.values.startDayHoursForTracker = '4';
    await becomeSettingsSource(desktop.engine, desktop.storage, [], () => {});
    await desktop.cycle();
    phone.values.startDayHoursForTracker = '0';
    await phone.cycle();
    expect(phone.values.startDayHoursForTracker).toBe('4');
  }, 120_000);

  afterAll(async () => {
    desktop?.engine.close();
    phone?.engine.close();
    await server.stop();
  });

  it('the shared value already in the mirror is taken over, not replaced by the device’s empty value', async () => {
    desktop.values.ankiFieldMapping = MAPPING;
    await desktop.cycle();
    await phone.cycle(); // pulls the desktop's mapping
    await phone.forgetAsOlderVersion('ankiFieldMapping', { mirror: true });

    await phone.cycle(); // the first sync after the update
    expect(phone.values.ankiFieldMapping).toBe(MAPPING);
    expect((await phone.ownGlobalRecords()).map((r) => r.id)).not.toContain(
      'global:ankiFieldMapping'
    );

    // The server still holds the desktop's value.
    await desktop.cycle();
    const record = await desktop.engine.get('setting', 'global:ankiFieldMapping');
    expect(record?.deviceId).toBe(desktop.engine.deviceId);
    expect(record?.data.value).toBe(MAPPING);
  });

  it('a shared value not pulled yet arrives with the pull instead of being replaced', async () => {
    await phone.forgetAsOlderVersion('ankiTagPrefix', { mirror: false });
    desktop.values.ankiTagPrefix = 'book::';
    await desktop.cycle();

    await phone.cycle();
    expect(phone.values.ankiTagPrefix).toBe('book::');
    expect((await phone.ownGlobalRecords()).map((r) => r.id)).not.toContain('global:ankiTagPrefix');

    await desktop.cycle();
    const record = await desktop.engine.get('setting', 'global:ankiTagPrefix');
    expect(record?.deviceId).toBe(desktop.engine.deviceId);
    expect(desktop.values.ankiTagPrefix).toBe('book::');
  });

  it('later edits still sync both ways', async () => {
    const edited = JSON.stringify({
      'JP Mining Note': { sentence: { field: 'Sentence', mode: 'append' } }
    });
    phone.values.ankiFieldMapping = edited;
    await phone.cycle();
    await desktop.cycle();
    expect(desktop.values.ankiFieldMapping).toBe(edited);

    desktop.values.ankiTagPrefix = 'novel::';
    await desktop.cycle();
    await phone.cycle();
    expect(phone.values.ankiTagPrefix).toBe('novel::');
  });

  it('a newly paired device gets the shared values and publishes none of its own', async () => {
    const tablet = new SettingsDevice(new Device('tablet', tokens[2], server));
    await tablet.open();
    await tablet.cycle();
    await tablet.cycle();
    expect(tablet.values.ankiFieldMapping).toBe(phone.values.ankiFieldMapping);
    expect(tablet.values.ankiTagPrefix).toBe('novel::');
    expect(tablet.values.startDayHoursForTracker).toBe('4');
    expect(await tablet.ownGlobalRecords()).toEqual([]);
    tablet.engine.close();
  });
});
