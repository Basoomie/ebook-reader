/**
 * WP5: migration off the old file sync. Scan (exact links, fingerprint, the
 * reasons a book waits for the user), the user's decisions, import, check,
 * undo, the new kinds, the routes, and that the old sync's files and Calibre
 * are never written.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { crc32 } from 'zlib';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from '../src/db/migrations';
import { DEFAULT_SYNC_CONFIG } from '../src/config';
import { listUsers } from '../src/db/users';
import { fingerprintEpub, fingerprintStoredZip } from '../src/migration/fingerprint';
import { desanitizeFolderName } from '../src/migration/legacy-fs';
import { IMPORT_DEVICE_NAME, legacyBookRecordId, MigrationService } from '../src/migration/service';
import { ZipFile } from '../src/migration/zip-read';
import { SyncStore } from '../src/sync/store';
import { CalibreRoot, fingerprint } from './helpers/calibre-fixture';
import {
  BookSpec,
  image,
  makeEpub,
  makeStoredZip,
  makeZip,
  sanitizeForFilename,
  statRow,
  writeLegacyFolder,
} from './helpers/epub-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

const openRead = (file: string) => fs.promises.open(file, 'r');

function spec(title: string, seed: number, spine = ['c1', 'c2']): BookSpec {
  return {
    title,
    images: { 'images/cover.jpg': image(seed), 'images/p1.jpg': image(seed + 100) },
    spine,
  };
}

const VERIFIED = spec('薬屋のひとりごと 1', 1);
const DUPLICATE = spec('舟を編む', 2);
const EDITION_CALIBRE = spec('負けヒロインが多すぎる！　２', 3);
const EDITION_STORED = spec('負けヒロインが多すぎる！　２', 4);
const NOT_IN_CALIBRE = spec('神に愛されていた', 5);
const PROGRESS_ONLY_TITLE = 'ビブリア古書堂の事件手帖';
const PROGRESS_ONLY = spec(PROGRESS_ONLY_TITLE, 6);
const DAMAGED_TITLE = '壊れた本';
const SPECIAL_TITLE = 'なぜ?：テスト*';

async function setup() {
  const root = new CalibreRoot();
  const lib = root.library('lib');
  const calibre: Record<string, number> = {};
  const add = async (key: string, s: BookSpec) => {
    const id = await lib.addBook({ title: s.title });
    fs.writeFileSync(path.join(lib.bookDir(id), `Book ${id} - Author ${id}.epub`), makeEpub(s));
    calibre[key] = id;
  };
  await add('verified', VERIFIED);
  await add('dupA', DUPLICATE);
  await add('dupB', DUPLICATE);
  await add('edition', EDITION_CALIBRE);
  await add('progressOnly', PROGRESS_ONLY);
  await add('special', spec(SPECIAL_TITLE, 7));
  lib.age();

  const dataRoot = makeTempDir('data');
  const dbDir = makeTempDir('db');
  // These tests replay the WP5 side-by-side week, when devices still wrote stat days
  // (frozen for devices since WP12; tests/stat-sessions.test.ts covers the freeze).
  const e = makeIndexerEnv(
    root.dir,
    {},
    { dataRoot, dbDir, sync: { ...DEFAULT_SYNC_CONFIG, frozenKinds: [] } },
  );
  envs.push(e);
  await e.indexer.start({ timer: false });
  enableLibrary(e.db, 'lib');
  await e.indexer.tick();

  const bookId = (key: string) =>
    (
      e.db
        .prepare("SELECT book_id FROM book_sources WHERE calibre_id = ? AND kind = 'calibre'")
        .get(calibre[key]) as { book_id: string }
    ).book_id;
  const calibreUuid = (key: string) =>
    (
      e.db
        .prepare("SELECT calibre_uuid FROM book_sources WHERE calibre_id = ? AND kind = 'calibre'")
        .get(calibre[key]) as { calibre_uuid: string }
    ).calibre_uuid;

  const folders = {
    verified: writeLegacyFolder(dataRoot, VERIFIED.title, {
      book: VERIFIED,
      characters: 5000,
      progress: {
        exploredCharCount: 1234.6,
        progress: 0.25,
        lastBookmarkModified: 1_790_000_000_000,
      },
      statistics: [
        statRow('2026-10-01', 1000, 300, 1_790_000_000_100),
        statRow('2026-10-02', 2000, 600, 1_790_000_000_200),
      ],
    }),
    duplicate: writeLegacyFolder(dataRoot, DUPLICATE.title, { book: DUPLICATE }),
    edition: writeLegacyFolder(dataRoot, EDITION_STORED.title, { book: EDITION_STORED }),
    notInCalibre: writeLegacyFolder(dataRoot, NOT_IN_CALIBRE.title, {
      book: NOT_IN_CALIBRE,
      audio: true,
    }),
    progressOnly: writeLegacyFolder(dataRoot, PROGRESS_ONLY_TITLE, {
      progress: { exploredCharCount: 10, progress: 0.1, lastBookmarkModified: 1_790_000_000_000 },
    }),
    damaged: writeLegacyFolder(dataRoot, DAMAGED_TITLE, { rawBookData: Buffer.from('not a zip') }),
    special: writeLegacyFolder(dataRoot, SPECIAL_TITLE, { book: spec(SPECIAL_TITLE, 7) }),
  };

  const store = new SyncStore(e.db, { maxClockSkewMs: 300_000 });
  const service = new MigrationService({
    db: e.db,
    store,
    dataRoot,
    dbDir,
    calibreDir: root.dir,
    indexerEnabled: () => true,
  });
  const userId = listUsers(e.db)[0].id;
  const byFolder = (folder: string) =>
    service.overview(userId).books.find((b) => b.folder === folder)!;

  /** A registered device (over HTTP) with its auth header. */
  async function device(name = 'Desktop') {
    const token = e.token();
    const auth = { Authorization: `Bearer ${token}` };
    const res = await request(e.app).post('/api/v1/devices/register').set(auth).send({ name });
    expect(res.status).toBe(200);
    return { auth, id: res.body.device.id as string };
  }

  return {
    e,
    root,
    lib,
    dataRoot,
    dbDir,
    calibre,
    bookId,
    calibreUuid,
    folders,
    store,
    service,
    userId,
    byFolder,
    device,
  };
}

describe('zip reader and fingerprint', () => {
  it('reads names and CRCs from the central directory and inflates text entries', async () => {
    const dir = makeTempDir('zip');
    const file = path.join(dir, 'a.zip');
    const text = 'テキスト'.repeat(1000);
    fs.writeFileSync(
      file,
      makeZip([
        { name: 'a.txt', data: text, deflate: true },
        { name: 'b/画像.jpg', data: image(1) },
      ]),
    );
    const zip = await ZipFile.open(file, openRead);
    try {
      expect(zip.entries.map((e) => e.name)).toEqual(['a.txt', 'b/画像.jpg']);
      expect(zip.get('b/画像.jpg')!.crc32).toBe(crc32(image(1)));
      expect(await zip.readText(zip.get('a.txt')!)).toBe(text);
    } finally {
      await zip.close();
    }
  });

  it('reports a file that is not a ZIP', async () => {
    const file = path.join(makeTempDir('zip'), 'bad.zip');
    fs.writeFileSync(file, 'definitely not a zip file, just some text');
    await expect(ZipFile.open(file, openRead)).rejects.toThrow(/Not a ZIP/);
  });

  it('fingerprints an EPUB and a stored book the same way', async () => {
    const dir = makeTempDir('fp');
    fs.writeFileSync(path.join(dir, 'b.epub'), makeEpub(VERIFIED));
    fs.writeFileSync(path.join(dir, 's.zip'), makeStoredZip(VERIFIED));
    const epub = await fingerprintEpub(path.join(dir, 'b.epub'), openRead);
    const stored = await fingerprintStoredZip(path.join(dir, 's.zip'), openRead);
    expect(epub.title).toBe(VERIFIED.title);
    expect([...epub.spineIds!]).toEqual(['c1', 'c2']);
    expect(stored.sectionIds).toEqual(['ttu-c1', 'ttu-c2']);
    expect([...stored.images.entries()]).toEqual([...epub.images.entries()]);
  });

  it('decodes folder names like the selfhost handler encodes them', () => {
    for (const title of ['a/b?c', 'end.', 'space ', 'star*', '100% "q"', '日本語：テスト']) {
      expect(desanitizeFolderName(sanitizeForFilename(title))).toBe(title);
    }
    expect(desanitizeFolderName('%E0%A4%A')).toBeNull();
  });
});

describe('migration 5', () => {
  it('upgrades a version-4 database', () => {
    const file = path.join(makeTempDir('db'), 'ttsu.db');
    const db = new Database(file);
    for (const m of MIGRATIONS.filter((m) => m.version <= 4)) db.exec(m.sql);
    db.pragma('user_version = 4');
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(['legacy_books', 'legacy_device_reports', 'migration_state']),
    );
    db.close();
  });
});

describe('scan', () => {
  it('links verified books and says why the others wait for the user', async () => {
    const t = await setup();
    await t.service.scan(t.userId);
    const v = t.byFolder(t.folders.verified);
    expect(v).toMatchObject({
      state: 'linked',
      method: 'fingerprint',
      bookId: t.bookId('verified'),
    });
    expect(v.details).toMatchObject({
      characters: 5000,
      progress: { charPos: 1235, progress: 0.25, at: 1_790_000_000_000 },
      stats: { days: 2, characters: 3000, seconds: 900, lastDay: '2026-10-02' },
    });
    expect(t.byFolder(t.folders.special)).toMatchObject({ state: 'linked', title: SPECIAL_TITLE });

    const dup = t.byFolder(t.folders.duplicate);
    expect(dup).toMatchObject({ state: 'needs_user', reason: 'several' });
    expect(dup.candidates.map((c) => c.bookId).sort()).toEqual(
      [t.bookId('dupA'), t.bookId('dupB')].sort(),
    );
    expect(dup.candidates[0].book?.title).toBe(DUPLICATE.title);

    const ed = t.byFolder(t.folders.edition);
    expect(ed).toMatchObject({ state: 'needs_user', reason: 'unverified' });
    expect(ed.candidates[0]).toMatchObject({
      bookId: t.bookId('edition'),
      titleMatches: true,
      imagesMatched: 0,
      imagesTotal: 2,
      verified: false,
    });

    expect(t.byFolder(t.folders.notInCalibre)).toMatchObject({
      state: 'needs_user',
      reason: 'no_candidate',
      candidates: [],
    });
    const po = t.byFolder(t.folders.progressOnly);
    expect(po).toMatchObject({ state: 'needs_user', reason: 'no_book_file' });
    expect(po.candidates).toEqual([
      expect.objectContaining({ bookId: t.bookId('progressOnly'), fingerprinted: false }),
    ]);
    expect(t.byFolder(t.folders.damaged)).toMatchObject({ state: 'needs_user', reason: 'damaged' });
  });

  it('prefers the exact Calibre identity a device reports, and flags conflicting reports', async () => {
    const t = await setup();
    const a = await t.device('Desktop');
    const b = await t.device('Phone');
    const report = (auth: object, links: unknown[]) =>
      request(t.e.app)
        .post('/api/v1/migration/report')
        .set(auth)
        .send({ calibreLinks: links, localTitles: [] });
    // Exact link for the progress-only folder and for one of the identical copies.
    expect(
      (
        await report(a.auth, [
          {
            title: PROGRESS_ONLY_TITLE,
            bookId: t.bookId('progressOnly'),
            calibreUuid: t.calibreUuid('progressOnly'),
          },
          { title: DUPLICATE.title, bookId: t.bookId('dupB'), calibreUuid: t.calibreUuid('dupB') },
          // A link whose Calibre identity no longer holds is ignored.
          { title: EDITION_STORED.title, bookId: t.bookId('edition'), calibreUuid: 'not-the-uuid' },
        ])
      ).status,
    ).toBe(200);
    await t.service.scan(t.userId);
    expect(t.byFolder(t.folders.progressOnly)).toMatchObject({
      state: 'linked',
      method: 'calibre-link',
      bookId: t.bookId('progressOnly'),
    });
    expect(t.byFolder(t.folders.duplicate)).toMatchObject({
      state: 'linked',
      method: 'calibre-link',
      bookId: t.bookId('dupB'),
    });
    expect(t.byFolder(t.folders.edition)).toMatchObject({
      state: 'needs_user',
      reason: 'unverified',
    });

    // Another device says the duplicate is the other copy: the user decides.
    await report(b.auth, [
      { title: DUPLICATE.title, bookId: t.bookId('dupA'), calibreUuid: t.calibreUuid('dupA') },
    ]);
    await t.service.scan(t.userId);
    expect(t.byFolder(t.folders.duplicate)).toMatchObject({
      state: 'needs_user',
      reason: 'conflict',
    });
  });

  it("keeps the user's decisions across scans", async () => {
    const t = await setup();
    await t.service.scan(t.userId);
    t.service.link(t.userId, t.folders.duplicate, t.bookId('dupA'));
    t.service.unlink(t.userId, t.folders.verified);
    t.service.defer(t.userId, t.folders.notInCalibre);
    await t.service.scan(t.userId);
    expect(t.byFolder(t.folders.duplicate)).toMatchObject({
      state: 'linked',
      method: 'user',
      bookId: t.bookId('dupA'),
    });
    // An unlinked book is never linked automatically again.
    expect(t.byFolder(t.folders.verified)).toMatchObject({
      state: 'needs_user',
      reason: 'unlinked',
    });
    expect(t.byFolder(t.folders.notInCalibre)).toMatchObject({ state: 'deferred' });

    // "Decide later", the EPUB is added to Calibre, "Check again": linked.
    const id = await t.lib.addBook({ title: NOT_IN_CALIBRE.title });
    fs.writeFileSync(
      path.join(t.lib.bookDir(id), `Book ${id} - Author ${id}.epub`),
      makeEpub(NOT_IN_CALIBRE),
    );
    t.lib.age();
    await t.e.indexer.tick();
    await t.service.scan(t.userId);
    expect(t.byFolder(t.folders.notInCalibre)).toMatchObject({
      state: 'linked',
      method: 'fingerprint',
    });
  });
});

describe('import', () => {
  it('writes links, the old position and the statistics as the import device', async () => {
    const t = await setup();
    await t.service.scan(t.userId);
    const result = await t.service.import(t.userId);
    expect(result).toMatchObject({ books: 2, positions: 1, statDays: 2 });
    expect(result.snapshot).toMatch(/^pre-import-\d{8}-\d{6}Z\.db$/);
    expect(fs.existsSync(path.join(t.dbDir, 'snapshots', result.snapshot))).toBe(true);

    const importDevice = t.service.overview(t.userId).importDeviceId!;
    expect(t.store.getRecord(t.userId, 'device', importDevice)?.data).toEqual({
      name: IMPORT_DEVICE_NAME,
    });
    const bookId = t.bookId('verified');
    expect(
      t.store.getRecord(t.userId, 'legacy-book', legacyBookRecordId(VERIFIED.title)),
    ).toMatchObject({ bookId, data: { title: VERIFIED.title, bookId, method: 'fingerprint' } });
    expect(t.store.getRecord(t.userId, 'position', `${bookId}:${importDevice}`)).toMatchObject({
      updatedAt: 1_790_000_000_000,
      data: { charPos: 1235, progress: 0.25, readThroughId: null },
    });
    expect(t.store.getRecord(t.userId, 'stat-day', `${bookId}:2026-10-02`)).toMatchObject({
      updatedAt: 1_790_000_000_200,
      data: statRow('2026-10-02', 2000, 600, 1_790_000_000_200),
    });
    // The device list hides the import device; imported books are marked.
    const o = t.service.overview(t.userId);
    expect(o.devices.find((d) => d.id === importDevice)).toBeUndefined();
    expect(t.byFolder(t.folders.verified).importedAt).not.toBeNull();
  });

  it('can run again without changing anything and never overwrites newer records', async () => {
    const t = await setup();
    await t.service.scan(t.userId);
    await t.service.import(t.userId);
    const d = await t.device('Phone');
    const bookId = t.bookId('verified');
    // The phone kept reading on 2026-10-02 after the old data was written.
    const newer = statRow('2026-10-02', 2500, 700, 1_790_000_000_900);
    const push = await request(t.e.app)
      .post('/api/v1/sync')
      .set(d.auth)
      .send({
        changes: [
          {
            kind: 'stat-day',
            id: `${bookId}:2026-10-02`,
            updatedAt: 1_790_000_000_900,
            data: newer,
          },
        ],
      });
    expect(push.body.results[0].status).toBe('applied');
    const before = t.store.getState(t.userId).lastRev;
    const again = await t.service.import(t.userId);
    expect(again).toMatchObject({ positions: 0, statDays: 0 });
    expect(t.store.getState(t.userId).lastRev).toBe(before);
    expect(t.store.getRecord(t.userId, 'stat-day', `${bookId}:2026-10-02`)!.data).toEqual(newer);
  });

  it('refuses when nothing is linked', async () => {
    const t = await setup();
    await expect(t.service.import(t.userId)).rejects.toThrow(/No linked books/);
  });
});

describe('check', () => {
  it('shows all match after import and lists differences', async () => {
    const t = await setup();
    await t.service.scan(t.userId);
    await t.service.import(t.userId);
    let check = await t.service.check(t.userId);
    expect(check.allMatch).toBe(true);
    expect(check.books.map((b) => b.title).sort()).toEqual([SPECIAL_TITLE, VERIFIED.title].sort());
    expect(check.notMigrated.map((b) => b.title)).toContain(NOT_IN_CALIBRE.title);
    expect(check.audioOnOldSync.map((b) => b.title)).toEqual([NOT_IN_CALIBRE.title]);

    // A device reads further: new place and a new day, not yet in the old sync.
    const d = await t.device('Boox');
    const bookId = t.bookId('verified');
    await request(t.e.app)
      .post('/api/v1/sync')
      .set(d.auth)
      .send({
        changes: [
          {
            kind: 'position',
            id: `${bookId}:${d.id}`,
            updatedAt: 1_790_000_100_000,
            data: { charPos: 2000, progress: 0.4, readThroughId: null },
          },
          {
            kind: 'stat-day',
            id: `${bookId}:2026-10-03`,
            updatedAt: 1_790_000_100_000,
            data: statRow('2026-10-03', 765, 200, 1_790_000_100_000),
          },
        ],
      });
    check = await t.service.check(t.userId);
    expect(check.allMatch).toBe(false);
    expect(check.differences).toBe(1);
    const book = check.books.find((b) => b.bookId === bookId)!;
    expect(book.position).toMatchObject({
      match: false,
      old: { charPos: 1235 },
      new: { charPos: 2000, deviceName: 'Boox' },
    });
    expect(book.stats).toMatchObject({
      match: false,
      old: { days: 2, characters: 3000, seconds: 900 },
      new: { days: 3, characters: 3765, seconds: 1100 },
      days: [{ dateKey: '2026-10-03', old: null, new: { characters: 765, seconds: 200 } }],
    });
  });
});

describe('undo', () => {
  it('deletes what the import wrote and lets the import run again', async () => {
    const t = await setup();
    await t.service.scan(t.userId);
    await t.service.import(t.userId);
    const bookId = t.bookId('verified');
    expect(t.service.undo(t.userId)).toBe(5); // 2 links, 1 position, 2 stat days
    expect(
      t.store.getRecord(t.userId, 'legacy-book', legacyBookRecordId(VERIFIED.title))?.deletedAt,
    ).not.toBeNull();
    expect(
      t.store.getRecord(t.userId, 'stat-day', `${bookId}:2026-10-01`)?.deletedAt,
    ).not.toBeNull();
    expect(t.byFolder(t.folders.verified)).toMatchObject({ state: 'linked', importedAt: null });
    // The import brings it back (the tombstone is older than a new link write).
    const again = await t.service.import(t.userId);
    expect(again.books).toBe(2);
    expect(
      t.store.getRecord(t.userId, 'legacy-book', legacyBookRecordId(VERIFIED.title))?.deletedAt,
    ).toBeNull();
  });

  it('forgets the scan results on request', async () => {
    const t = await setup();
    await t.service.scan(t.userId);
    await t.service.import(t.userId);
    t.service.undo(t.userId, true);
    expect(t.service.overview(t.userId).books).toEqual([]);
  });
});

describe('the old sync and Calibre are never written', () => {
  it('leaves DATA_DIR and the Calibre library byte-identical', async () => {
    const t = await setup();
    const data = fingerprint(t.dataRoot);
    const calibre = fingerprint(t.root.dir);
    await t.service.scan(t.userId);
    await t.service.import(t.userId);
    await t.service.check(t.userId);
    t.service.undo(t.userId);
    expect(fingerprint(t.dataRoot)).toEqual(data);
    expect(fingerprint(t.root.dir)).toEqual(calibre);
  });
});

describe('kinds', () => {
  it('only the server writes legacy-book links', async () => {
    const t = await setup();
    const d = await t.device();
    const res = await request(t.e.app)
      .post('/api/v1/sync')
      .set(d.auth)
      .send({
        changes: [
          {
            kind: 'legacy-book',
            id: legacyBookRecordId('x'),
            updatedAt: Date.now(),
            data: { title: 'x', bookId: t.bookId('verified'), method: 'user' },
          },
        ],
      });
    expect(res.body.results[0]).toMatchObject({
      status: 'rejected',
      error: { code: 'server_only' },
    });
  });

  it('validates stat days, reading goals and the migration switches', async () => {
    const t = await setup();
    const d = await t.device();
    const bookId = t.bookId('verified');
    const push = async (changes: unknown[]) =>
      (await request(t.e.app).post('/api/v1/sync').set(d.auth).send({ changes })).body.results as {
        status: string;
        error?: { code: string };
      }[];
    const now = Date.now();
    // The migration writes stat days through the store (devices may not since WP12).
    const statResults = t.store.push(t.userId, d.id, [
      {
        kind: 'stat-day',
        id: `${bookId}:2026-10-05`,
        updatedAt: now,
        data: statRow('2026-10-05', 1, 1, now),
      },
      { kind: 'stat-day', id: `${bookId}:2026-10-05x`, updatedAt: now, data: {} },
      {
        kind: 'stat-day',
        id: `${bookId}:2026-10-06`,
        updatedAt: now,
        data: statRow('2026-10-07', 1, 1, now),
      },
      {
        kind: 'stat-day',
        id: `${bookId}:2026-10-08`,
        updatedAt: now,
        data: {
          ...statRow('2026-10-08', 1, 1, now),
          completedBook: 1,
          completedData: {
            dateKey: '2026-10-08',
            charactersRead: 9,
            averageReadingSpeed: null,
            finishDate: 'na',
          },
        },
      },
    ]);
    expect(statResults.map((r) => r.status)).toEqual([
      'applied',
      'rejected',
      'rejected',
      'applied',
    ]);
    const results = await push([
      {
        kind: 'reading-goal',
        id: '2026-10-01',
        updatedAt: now,
        data: {
          timeGoal: 60,
          characterGoal: 0,
          goalFrequency: 'daily',
          goalStartDate: '2026-10-01',
          goalEndDate: '',
          goalOriginalEndDate: '',
          lastGoalModified: now,
        },
      },
      {
        kind: 'reading-goal',
        id: '2026-10-02',
        updatedAt: now,
        data: { goalStartDate: '2026-10-03' },
      },
      { kind: 'migration', id: 'legacy-sync', updatedAt: now, data: { enabled: false } },
      { kind: 'migration', id: 'legacy-sync', updatedAt: now + 1, data: { enabled: 'no' } },
      { kind: 'migration', id: 'settings-source', updatedAt: now, data: { deviceId: d.id } },
      { kind: 'migration', id: 'other', updatedAt: now, data: {} },
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'applied',
      'rejected',
      'applied',
      'rejected',
      'applied',
      'rejected',
    ]);
    const overview = await request(t.e.app).get('/api/v1/migration').set(d.auth);
    expect(overview.body).toMatchObject({ legacySyncEnabled: false, settingsSourceDeviceId: d.id });
  });
});

describe('routes', () => {
  it('scans in the background, resolves, imports and checks over HTTP', async () => {
    const t = await setup();
    const d = await t.device();
    const start = await request(t.e.app).post('/api/v1/migration/scan').set(d.auth);
    expect(start.status).toBe(202);
    expect(start.body.scan.running).toBe(true);
    let overview;
    for (let i = 0; i < 100; i++) {
      overview = await request(t.e.app).get('/api/v1/migration').set(d.auth);
      if (!overview.body.scan.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(overview!.body.scan.error).toBeNull();
    expect(overview!.body.books).toHaveLength(7);
    expect(overview!.body.devices.map((x: { name: string }) => x.name)).toEqual(['Desktop']);

    const resolve = (body: object) =>
      request(t.e.app).post('/api/v1/migration/resolve').set(d.auth).send(body);
    expect(
      (await resolve({ folder: t.folders.duplicate, action: 'link', bookId: t.bookId('dupA') }))
        .status,
    ).toBe(200);
    expect((await resolve({ folder: t.folders.duplicate, action: 'link' })).status).toBe(400);
    expect((await resolve({ folder: 'nope', action: 'defer' })).status).toBe(404);
    expect((await resolve({ folder: t.folders.duplicate, action: 'zap' })).status).toBe(400);

    const imported = await request(t.e.app).post('/api/v1/migration/import').set(d.auth);
    expect(imported.status).toBe(200);
    expect(imported.body.books).toBe(3);
    // After import, a link can't be changed any more (undo is the way back).
    expect((await resolve({ folder: t.folders.duplicate, action: 'unlink' })).status).toBe(409);

    const check = await request(t.e.app).get('/api/v1/migration/check').set(d.auth);
    expect(check.status).toBe(200);
    expect(check.body.allMatch).toBe(true);
  });

  it('records what a device holds and lists titles that exist only there', async () => {
    const t = await setup();
    const d = await t.device('Phone');
    await t.service.scan(t.userId);
    await request(t.e.app)
      .post('/api/v1/migration/report')
      .set(d.auth)
      .send({
        calibreLinks: [],
        localTitles: [
          { title: VERIFIED.title, hasBookmark: true, statDays: 3 },
          { title: 'Only on the phone', hasBookmark: true, statDays: 0 },
          { title: 'Never read', hasBookmark: false, statDays: 0 },
        ],
      });
    const o = t.service.overview(t.userId);
    expect(o.devices).toEqual([
      expect.objectContaining({ name: 'Phone', localOnlyTitles: ['Only on the phone'] }),
    ]);
  });

  it('needs a registered device to report and the Calibre library to scan', async () => {
    const t = await setup();
    const token = t.e.token();
    const res = await request(t.e.app)
      .post('/api/v1/migration/report')
      .set({ Authorization: `Bearer ${token}` })
      .send({});
    expect(res.status).toBe(409);
    const off = new MigrationService({
      db: t.e.db,
      store: t.store,
      dataRoot: t.dataRoot,
      dbDir: t.dbDir,
      calibreDir: null,
      indexerEnabled: () => false,
    });
    expect(() => off.startScan(t.userId)).toThrow(/not available/);
  });
});

// Keep sanitizeForFilename used in the special-title folder name.
it('uses encoded folder names for titles with reserved characters', async () => {
  const t = await setup();
  expect(t.folders.special).toBe(sanitizeForFilename(SPECIAL_TITLE));
  expect(t.folders.special).not.toBe(SPECIAL_TITLE);
});
