/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 §2: a device that moves to the HTTPS address is a new device to the app. One tap
 * ("Copy settings from another device", Settings > Data) brings over all of the old device's
 * own settings, whispersync's included, but not the AnkiConnect keys.
 *
 * The old device publishes like the app (publishAllSettings before every sync) from its own
 * storage; the new device is "this tab": its live settings and the app's localStorage,
 * against the real storage server.
 */
import 'fake-indexeddb/auto';
// Load the store first, like the app does (store.ts and database.service.ts import each other).
import { fontSize$ } from '$lib/data/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localStorage } from '$lib/data/window/local-storage';
import { settings$ } from '$lib/whispersync/lib/stores';
import { applyDeviceSettings } from '$lib/sync/apply-device-settings';
import {
  allDeviceSettingKeys,
  otherDevicesSettings,
  planSettingsCopy
} from '$lib/sync/copy-device-settings';
import { applyGlobalSettingValue } from '$lib/sync/settings-apply';
import { keysWithScope } from '$lib/sync/settings-registry';
import {
  becomeSettingsSource,
  onPulledSettings,
  publishAllSettings
} from '$lib/sync/settings-source';
import { Device, TestServer, seedServer } from './helpers/sync-harness';

const FOOTER = JSON.stringify([
  { action: 'Toggle playback', enabled: true },
  { action: 'Rewind', enabled: true }
]);

/** What the old device has stored (a raw localStorage, like the app's). */
const OLD_VALUES: Record<string, string> = {
  fontSize: '26',
  theme: 'dark-theme',
  einkMode: '1',
  zenMode: '1',
  trackerIdleTime: '120',
  homeRows: JSON.stringify([{ id: 'continue', visible: true }]),
  lastBlurredTrackerItems: JSON.stringify(['readingTime']),
  libraryView: 'list',
  ankiConnectUrl: 'http://10.0.0.2:8765',
  'ttu-whispersync-player-rewind-time': '15',
  'ttu-whispersync-anki-url': 'http://10.0.0.2:8765',
  'ttu-whispersync-action-list-of-footer': FOOTER,
  // Never leave the device:
  ankiConnectKey: 'old-device-key',
  'ttu-whispersync-anki-key': 'old-whispersync-key',
  // Shared by every device:
  startDayHoursForTracker: '4'
};

const ANKI_KEYS = ['ankiConnectKey', 'ttu-whispersync-anki-key'];

class OldDevice {
  readonly values: Record<string, string> = { ...OLD_VALUES };
  readonly storage = { getItem: (key: string) => this.values[key] ?? null };
  readonly deps = {
    apply: (key: string, raw: string | null) => {
      if (raw !== null) this.values[key] = raw;
    },
    readStored: (key: string) => this.values[key] ?? null
  };

  constructor(readonly device: Device) {}

  get engine() {
    return this.device.engine;
  }

  async cycle() {
    await publishAllSettings(this.engine, this.storage, this.deps);
    await this.device.sync();
  }
}

/** This tab: the app's own live settings and localStorage. */
class NewDevice {
  private readonly pending: Promise<unknown>[] = [];
  readonly deps = {
    apply: applyGlobalSettingValue,
    readStored: (key: string) => localStorage.getItem(key) ?? null
  };

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

  async cycle() {
    await publishAllSettings(this.engine, localStorage, this.deps);
    await this.device.sync();
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }

  /** What Settings > Data lists, from this device's mirror. */
  async otherDevices() {
    const records = await this.engine.getAll('setting');
    const names: Record<string, string | undefined> = {};
    for (const r of await this.engine.getAll('device')) {
      names[r.id] = typeof r.data?.name === 'string' ? r.data.name : undefined;
    }
    return otherDevicesSettings(records, this.engine.deviceId, names, allDeviceSettingKeys());
  }
}

function stored(key: string): string | null {
  return localStorage.getItem(key) ?? null;
}

describe('one tap copies all of another device’s own settings (real server)', () => {
  const server = new TestServer();
  let old: OldDevice;
  let fresh: NewDevice;

  beforeAll(async () => {
    const { tokens } = seedServer(server, 2);
    await server.start();
    old = new OldDevice(new Device('old-address', tokens[0], server));
    fresh = new NewDevice(new Device('new-address', tokens[1], server));
    await old.device.open();
    await becomeSettingsSource(old.engine, old.storage, [], () => {});
    await old.cycle();

    // The new device has a few settings of its own already, and its own AnkiConnect key.
    localStorage.setItem('fontSize', '18');
    localStorage.setItem('ttu-whispersync-player-alt-rewind-time', '30');
    localStorage.setItem('ankiConnectKey', 'new-device-key');
    await fresh.open();
    await fresh.cycle();
    await fresh.cycle();
  }, 120_000);

  afterAll(async () => {
    old?.engine.close();
    fresh?.engine.close();
    for (const key of [...keysWithScope('device'), ...ANKI_KEYS, 'startDayHoursForTracker']) {
      localStorage.removeItem(key);
    }
    await server.stop();
  });

  it('the old device publishes whispersync’s settings, never the AnkiConnect keys', async () => {
    const own = (await old.engine.getAll('setting')).filter((r) =>
      r.id.startsWith(`device:${old.engine.deviceId}:`)
    );
    expect(own).toHaveLength(keysWithScope('device').length);
    expect(await old.device.setting(`device:${old.engine.deviceId}:ttu-whispersync-anki-url`)).toBe(
      'http://10.0.0.2:8765'
    );
    // And what the new device pulled from the server has none either.
    const pulled = (await fresh.engine.getAll('setting')).map((r) => r.id);
    for (const key of ANKI_KEYS) {
      expect(pulled.filter((id) => id.endsWith(`:${key}`))).toEqual([]);
    }
  });

  it('lists the old device by name with all its own settings', async () => {
    const devices = await fresh.otherDevices();
    // The name the server gave the old device (its `device` record).
    expect(devices.map((d) => d.name)).toEqual(['Device 1']);
    expect(devices[0].deviceId).toBe(old.engine.deviceId);
    expect(Object.keys(devices[0].values).sort()).toEqual(keysWithScope('device').sort());
  });

  it('copies every per-device setting exactly, and nothing else', async () => {
    const [device] = await fresh.otherDevices();
    const plan = planSettingsCopy(device.values, ['Noto Serif JP', 'Noto Sans JP']);
    const changed = applyDeviceSettings(plan.apply);

    expect(changed).toContain('fontSize');
    expect(changed).toContain('ttu-whispersync-player-alt-rewind-time');
    for (const key of keysWithScope('device')) {
      expect(stored(key), key).toBe(old.values[key] ?? null);
    }
    // Live settings follow at once, whispersync's too.
    expect(fontSize$.getValue()).toBe(26);
    expect(settings$.playerRewindTime$.get()).toBe(15);
    expect(settings$.playerAltRewindTime$.get()).toBe(10); // never set on the old device
    expect(settings$.actionListOfFooter$.get()).toEqual(JSON.parse(FOOTER));
    // Not copied: the AnkiConnect keys. The shared setting is the shared value already.
    expect(stored('ankiConnectKey')).toBe('new-device-key');
    expect(stored('ttu-whispersync-anki-key')).toBeNull();
    expect(stored('startDayHoursForTracker')).toBe('4');
  });

  it('the new device then publishes the copied values as its own; the old device’s stay', async () => {
    await fresh.cycle();
    await old.cycle();
    const freshId = fresh.engine.deviceId;
    const oldId = old.engine.deviceId;
    expect(await old.device.setting(`device:${freshId}:fontSize`)).toBe('26');
    expect(await old.device.setting(`device:${freshId}:ttu-whispersync-player-rewind-time`)).toBe(
      '15'
    );
    expect(await old.device.setting(`device:${freshId}:ankiConnectKey`)).toBeUndefined();
    const oldFont = await old.engine.get('setting', `device:${oldId}:fontSize`);
    expect(oldFont?.deviceId).toBe(oldId);
    expect(oldFont?.data.value).toBe('26');
    expect(old.values.ankiConnectKey).toBe('old-device-key');
    // Copying again changes nothing.
    const [device] = await fresh.otherDevices();
    expect(applyDeviceSettings(planSettingsCopy(device.values, []).apply)).toEqual([]);
  });
});
