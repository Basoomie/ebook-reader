/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP5 end to end against the real storage server (a separate process, with
 * a copy of the Calibre-made fixture library and an old-sync folder):
 * device reports, scan (fingerprint and exact Calibre identity), import,
 * pulling the links, side-by-side statistics, the check page's comparison,
 * the desktop as settings source, the old-sync switch and the apply side.
 */
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
import { MigrationApi } from '$lib/migration/api';
import { applyStatDays } from '$lib/sync/apply-records';
import { bookIdForTitle, legacyBookIdForTitle } from '$lib/sync/book-ids';
import { legacySyncEnabledFrom } from '$lib/sync/legacy-switch';
import { recordStatistics } from '$lib/sync/record-statistics';
import { becomeSettingsSource, publishAllSettings } from '$lib/sync/settings-source';
import { fingerprintEpub } from '../../storage-server/src/migration/fingerprint';
import {
  makeZip,
  sanitizeForFilename,
  statRow
} from '../../storage-server/tests/helpers/epub-fixture';
import { Device, tempDir, TestServer } from './helpers/sync-harness';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../storage-server/tests/fixtures/calibre-7.1'
);
const BOOK1_EPUB =
  'japanese-test/Ri Xiang Xia/Yao Wu nohitorigoto 1 (1)/Yao Wu nohitorigoto 1 - Ri Xiang Xia.epub';
const T1 = '薬屋のひとりごと 1';
const T2 = '薬屋のひとりごと 2';

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else
        out[path.relative(dir, full)] = createHash('sha1')
          .update(fs.readFileSync(full))
          .digest('hex');
    }
  };
  walk(dir);
  return out;
}

function writeStats(dir: string, rows: object[], title: string) {
  for (const f of fs.readdirSync(dir))
    if (f.startsWith('statistics_')) fs.unlinkSync(path.join(dir, f));
  const modified = Math.max(
    ...rows.map((r) => Number((r as { lastStatisticModified?: number }).lastStatisticModified))
  );
  fs.writeFileSync(
    path.join(dir, `statistics_1_6_${modified}_0_0_0_0_0_0_0_0_0_0_0_0_na.json`),
    JSON.stringify(rows.map((r) => ({ title, ...r })))
  );
}

function writeProgress(dir: string, charPos: number, progress: number, at: number) {
  for (const f of fs.readdirSync(dir))
    if (f.startsWith('progress_')) fs.unlinkSync(path.join(dir, f));
  fs.writeFileSync(
    path.join(dir, `progress_1_6_${at}_${progress}.json`),
    JSON.stringify({ dataId: 1, exploredCharCount: charPos, progress, lastBookmarkModified: at })
  );
}

const calibreRoot = tempDir('calibre');
fs.cpSync(FIXTURE, calibreRoot, { recursive: true });
// The WP5 side-by-side week, when devices still wrote stat days (frozen for devices since WP12).
const server = new TestServer({
  SYNC_FROZEN_KINDS: 'none',
  CALIBRE_DIR: calibreRoot,
  CACHE_DIR: tempDir('cache'),
  CALIBRE_REQUIRE_READONLY: 'false',
  CALIBRE_SETTLE_SECONDS: '0',
  CALIBRE_POLL_SECONDS: '5'
});

let desktop: Device;
let phone: Device;
let desktopApi: MigrationApi;
const tokens: string[] = [];
const ids: Record<string, string> = {};
const uuids: Record<string, string> = {};
let dir1 = '';
let dir2 = '';

async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 60_000
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  // The old sync's folder: book 1 stored with its data, book 2 only progress and stats.
  const epub = await fingerprintEpub(path.join(calibreRoot, BOOK1_EPUB), (f) =>
    fs.promises.open(f, 'r')
  );
  dir1 = path.join(server.dataDir, sanitizeForFilename(T1));
  dir2 = path.join(server.dataDir, sanitizeForFilename(T2));
  fs.mkdirSync(dir1);
  fs.mkdirSync(dir2);
  fs.writeFileSync(
    path.join(dir1, 'bookdata_1_6_8_1700000000000_1700000000001.zip'),
    makeZip([
      {
        name: 'staticdata.json',
        data: JSON.stringify({
          title: epub.title,
          sections: [...epub.spineIds!].map((id) => ({ reference: `ttu-${id}` }))
        }),
        deflate: true
      }
    ])
  );
  writeProgress(dir1, 4, 0.5, 1_790_000_000_000);
  writeStats(dir1, [statRow('2026-10-01', 4, 60, 1_790_000_000_100)], T1);
  writeProgress(dir2, 2, 0.25, 1_790_000_000_000);
  writeStats(dir2, [statRow('2026-10-02', 2, 30, 1_790_000_000_200)], T2);

  await server.start();
  for (const label of ['Desktop', 'Phone']) {
    tokens.push(server.cli('token', 'create', label).trim().split(/\r?\n/).pop()!);
  }
  const libraryLine = await waitFor(async () =>
    server
      .cli('library', 'list')
      .split(/\r?\n/)
      .find((l) => l.includes('folder="japanese-test"'))
  );
  server.cli('library', 'set', libraryLine.split(/\s+/)[0], '--language', 'ja', '--enable');
  const auth = { Authorization: `Bearer ${tokens[0]}` };
  const books = await waitFor(async () => {
    const res = await fetch(`${server.url}/api/v1/books?limit=50`, { headers: auth });
    const body = (await res.json()) as { books?: { id: string; title: string }[] };
    return body.books?.some((b) => b.title === T2) ? body.books : null;
  });
  for (const t of [T1, T2]) {
    ids[t] = books.find((b) => b.title === t)!.id;
    const detail = await (
      await fetch(`${server.url}/api/v1/books/${ids[t]}`, { headers: auth })
    ).json();
    uuids[t] = detail.sources[0].calibreUuid;
  }

  desktop = new Device('desktop', tokens[0], server);
  phone = new Device('phone', tokens[1], server);
  await desktop.open();
  await phone.open();
  await desktop.sync();
  await phone.sync();
  desktopApi = new MigrationApi(server.url, tokens[0], 20);
}, 120_000);

afterAll(async () => {
  await server.stop();
});

describe('migration with two devices against the real server', () => {
  it('links, imports, compares, adopts settings and switches the old sync off', async () => {
    // 1. The desktop opened book 2 from the library (a WP6 link) and reports it.
    await desktopApi.report({
      calibreLinks: [{ title: T2, bookId: ids[T2], calibreUuid: uuids[T2] }],
      localTitles: [
        { title: T1, hasBookmark: true, statDays: 1 },
        { title: T2, hasBookmark: true, statDays: 1 }
      ]
    });
    const before = hashTree(server.dataDir);

    // 2. Scan: book 1 by fingerprint, book 2 by exact identity.
    await desktopApi.scan();
    const overview = await waitFor(async () => {
      const o = await desktopApi.overview();
      return o.scan.running ? null : o;
    });
    expect(overview.scan.error).toBeNull();
    const byTitle = new Map(overview.books.map((b) => [b.title, b]));
    expect(byTitle.get(T1)).toMatchObject({
      state: 'linked',
      method: 'fingerprint',
      bookId: ids[T1]
    });
    expect(byTitle.get(T2)).toMatchObject({
      state: 'linked',
      method: 'calibre-link',
      bookId: ids[T2]
    });

    // 3. Import, then both devices pull the links.
    expect(await desktopApi.import()).toMatchObject({ books: 2, positions: 2, statDays: 2 });
    await desktop.sync();
    await phone.sync();
    expect(await legacyBookIdForTitle(phone.engine, T1)).toBe(ids[T1]);
    expect((await desktopApi.check()).allMatch).toBe(true);
    // Nothing above wrote to the old sync's folder.
    expect(hashTree(server.dataDir)).toEqual(before);

    // 4. The phone reads book 1 on a new day: the new sync has it first...
    const phoneRows: BooksDbStatistic[] = [
      { title: T1, ...statRow('2026-10-01', 4, 60, 1_790_000_000_100) },
      { title: T1, ...statRow('2026-10-03', 3, 45, 1_790_000_100_000) }
    ];
    const queued = await recordStatistics(T1, {
      getEngine: async () => phone.engine,
      bookIdForTitle: (t) =>
        bookIdForTitle(t, {
          getEngine: async () => phone.engine,
          allLinks: async () => [],
          warn: () => {}
        }),
      statisticsForTitle: async () => phoneRows,
      warn: () => {}
    });
    expect(queued).toBe(1);
    await phone.sync();
    let check = await desktopApi.check();
    expect(check.allMatch).toBe(false);
    expect(check.books.find((b) => b.title === T1)?.stats.days).toEqual([
      { dateKey: '2026-10-03', old: null, new: { characters: 3, seconds: 45 } }
    ]);
    // ...then the old sync uploads the same day: all match again.
    writeStats(dir1, phoneRows, T1);
    check = await desktopApi.check();
    expect(check.allMatch).toBe(true);

    // 5. The desktop becomes the settings source; the phone adopts its values.
    const desktopValues: Record<string, string> = { startDayHoursForTracker: '4' };
    await becomeSettingsSource(
      desktop.engine,
      { getItem: (k) => desktopValues[k] ?? null },
      [],
      () => {}
    );
    await desktop.sync();
    await phone.sync();
    const phoneValues: Record<string, string> = { startDayHoursForTracker: '0' };
    await publishAllSettings(
      phone.engine,
      { getItem: (k) => phoneValues[k] ?? null },
      {
        apply: (k, raw) => {
          if (raw !== null) phoneValues[k] = raw;
        },
        readStored: (k) => phoneValues[k] ?? null
      }
    );
    expect(phoneValues.startDayHoursForTracker).toBe('4');
    expect((await desktopApi.overview()).settingsSourceDeviceId).toBe(desktop.engine.deviceId);

    // 6. The phone switches the old sync off; the desktop learns it and applies the phone's day.
    await phone.engine.write('migration', 'legacy-sync', { enabled: false });
    await phone.sync();
    await desktop.sync();
    expect(legacySyncEnabledFrom(await desktop.engine.get('migration', 'legacy-sync'))).toBe(false);
    expect((await desktopApi.overview()).legacySyncEnabled).toBe(false);
    const desktopLocal: BooksDbStatistic[] = [
      { title: T1, ...statRow('2026-10-01', 4, 60, 1_790_000_000_100) }
    ];
    const written: BooksDbStatistic[] = [];
    await applyStatDays(await desktop.engine.getAll('stat-day'), {
      titlesByBookId: async () => new Map([[ids[T1], new Set([T1])]]),
      statisticsForTitle: async () => desktopLocal,
      putStatistics: async (_t, rows) => {
        written.push(...rows);
      }
    });
    expect(written.map((r) => [r.dateKey, r.charactersRead])).toEqual([['2026-10-03', 3]]);

    // 7. And back on (rollback level 1).
    await desktop.engine.write('migration', 'legacy-sync', { enabled: true });
    await desktop.sync();
    await phone.sync();
    expect(legacySyncEnabledFrom(await phone.engine.get('migration', 'legacy-sync'))).toBe(true);

    // 8. Undo (rollback level 2) removes the links on every device.
    server.cli('migration', 'undo');
    await phone.sync();
    expect(await legacyBookIdForTitle(phone.engine, T1)).toBeNull();
  }, 120_000);
});
