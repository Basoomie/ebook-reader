/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import 'fake-indexeddb/auto';
// Load the store first, like the app does (store.ts and database.service.ts import each other).
import { database } from '$lib/data/store';
import { describe, expect, it } from 'vitest';
import type {
  BooksDbReadingGoal,
  BooksDbStatistic
} from '$lib/data/database/books-db/versions/books-db';
import { StorageDataType } from '$lib/data/storage/storage-types';
import type { CalibreLink } from '$lib/library/library-db';
import type { LegacyBookView } from '$lib/migration/api';
import { dataText, fingerprintText, reasonText } from '$lib/migration/describe';
import { localBookmarkForTitle, localTitleSummaries } from '$lib/migration/local-summary';
import { applyReadingGoals, applyStatDays } from './apply-records';
import { bookIdForTitle, legacyBookIdForTitle, titlesByBookId } from './book-ids';
import { allowedLegacyTypes, legacySyncEnabledFrom } from './legacy-switch';
import { publishReadingGoals } from './record-goals';
import { resolveLinkedBookId } from './record-position';
import { recordStatistics, statDayData, statDayRow } from './record-statistics';
import { becomeSettingsSource, onPulledSettings, publishAllSettings } from './settings-source';
import { openSyncDb, type LocalRecord } from './sync-db';
import { SyncEngine } from './sync-engine';

const BOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_BOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = '11111111-1111-4111-8111-111111111111';
const DESKTOP = '22222222-2222-4222-8222-222222222222';
const SERVER = '33333333-3333-4333-8333-333333333333';
const TITLE = '薬屋のひとりごと 1';

let run = 0;
async function engine(deviceId = DEVICE) {
  run += 1;
  const name = `wp5-${run}`;
  const e = await SyncEngine.open({ openDb: () => openSyncDb(name), newId: () => deviceId });
  /** Puts a record into the mirror as if pulled from the server. */
  const pulled = async (r: Partial<LocalRecord> & Pick<LocalRecord, 'kind' | 'id' | 'data'>) => {
    const db = await openSyncDb(name);
    const record: LocalRecord = {
      bookId: null,
      deviceId: SERVER,
      updatedAt: 1000,
      deletedAt: null,
      rev: run,
      ...r
    };
    await db.put('records', record);
    db.close();
    return record;
  };
  return { e, pulled };
}

function link(partial: Partial<CalibreLink> = {}): CalibreLink {
  return {
    bookId: BOOK,
    libraryId: 'lib',
    calibreLibraryUuid: null,
    calibreUuid: 'cal-uuid',
    calibreId: 1,
    localId: 7,
    title: TITLE,
    calibreTitle: TITLE,
    characters: 1000,
    fileEtag: null,
    linkedAt: 1,
    how: 'imported',
    ...partial
  };
}

function stat(dateKey: string, chars: number, modified: number, title = TITLE): BooksDbStatistic {
  return {
    title,
    dateKey,
    charactersRead: chars,
    readingTime: chars / 10,
    minReadingSpeed: 1,
    altMinReadingSpeed: 2,
    lastReadingSpeed: 3,
    maxReadingSpeed: 4,
    lastStatisticModified: modified
  };
}

function goal(start: string, timeGoal: number, end = ''): BooksDbReadingGoal {
  return {
    timeGoal,
    characterGoal: 0,
    goalFrequency: 'daily' as BooksDbReadingGoal['goalFrequency'],
    goalStartDate: start,
    goalEndDate: end,
    goalOriginalEndDate: end,
    lastGoalModified: 5
  };
}

const legacyBook = (title: string, bookId: string, deletedAt: number | null = null) => ({
  kind: 'legacy-book',
  id: `t:${title.length}${bookId.slice(0, 4)}`,
  bookId,
  deletedAt,
  data: deletedAt ? {} : { title, bookId, method: 'fingerprint' }
});

describe('book ids for migrated books', () => {
  it('finds the migrated link of a title, ignoring deleted ones', async () => {
    const { e, pulled } = await engine();
    expect(await legacyBookIdForTitle(e, TITLE)).toBeNull();
    await pulled(legacyBook(TITLE, BOOK));
    await pulled(legacyBook('別の本', OTHER_BOOK, 5));
    expect(await legacyBookIdForTitle(e, TITLE)).toBe(BOOK);
    expect(await legacyBookIdForTitle(e, '別の本')).toBeNull();
  });

  it('prefers the Calibre link and falls back to the migrated link', async () => {
    const { e, pulled } = await engine();
    await pulled(legacyBook(TITLE, OTHER_BOOK));
    const warnings: string[] = [];
    const deps = (links: CalibreLink[]) => ({
      getEngine: async () => e,
      allLinks: async () => links,
      warn: (m: string) => warnings.push(m)
    });
    expect(await bookIdForTitle(TITLE, deps([link()]))).toBe(BOOK);
    expect(await bookIdForTitle(TITLE, deps([]))).toBe(OTHER_BOOK);
    expect(
      await bookIdForTitle(TITLE, deps([link(), link({ bookId: OTHER_BOOK, calibreUuid: 'x' })]))
    ).toBeNull();
    expect(warnings).toHaveLength(1);
    const titles = await titlesByBookId(deps([link({ title: 'Calibre title' })]));
    expect([...(titles.get(BOOK) ?? [])]).toEqual(['Calibre title']);
    expect([...(titles.get(OTHER_BOOK) ?? [])]).toEqual([TITLE]);

    // The reader's resolver: Calibre link first, then the migrated link.
    const byLocalId = async () => [] as CalibreLink[];
    expect(
      await resolveLinkedBookId(
        7,
        TITLE,
        byLocalId,
        () => {},
        (t) => legacyBookIdForTitle(e, t)
      )
    ).toBe(OTHER_BOOK);
    expect(await resolveLinkedBookId(7, TITLE, byLocalId, () => {})).toBeNull();
  });
});

describe('statistics side by side', () => {
  it('writes changed days, skips unchanged and newer ones, and prunes deleted days', async () => {
    const { e, pulled } = await engine();
    let rows = [stat('2026-10-01', 100, 10), stat('2026-10-02', 200, 20)];
    const deps = {
      getEngine: async () => e,
      bookIdForTitle: async (t: string) => (t === TITLE ? BOOK : null),
      statisticsForTitle: async () => rows,
      warn: () => {}
    };
    expect(await recordStatistics(TITLE, deps)).toBe(2);
    expect((await e.get('stat-day', `${BOOK}:2026-10-01`))?.data).toEqual(statDayData(rows[0]));
    expect(await recordStatistics(TITLE, deps)).toBe(0);
    expect(await recordStatistics('unknown', deps)).toBe(0);

    // Another device has a newer version of 2026-10-02: kept.
    await pulled({
      kind: 'stat-day',
      id: `${BOOK}:2026-10-02`,
      bookId: BOOK,
      data: statDayData(stat('2026-10-02', 999, 50))
    });
    rows = [stat('2026-10-01', 150, 30), stat('2026-10-02', 200, 20)];
    expect(await recordStatistics(TITLE, deps)).toBe(1);
    expect((await e.get('stat-day', `${BOOK}:2026-10-02`))?.data.charactersRead).toBe(999);

    rows = [stat('2026-10-02', 200, 20)];
    expect(await recordStatistics(TITLE, deps, { pruneMissing: true })).toBe(1);
    expect((await e.get('stat-day', `${BOOK}:2026-10-01`))?.deletedAt).not.toBeNull();
  });

  it('keeps completion data and round-trips a row', () => {
    const row = {
      ...stat('2026-10-03', 10, 3),
      completedBook: 1,
      completedData: { dateKey: '2026-10-03', charactersRead: 10, title: 'x' } as never
    };
    const data = statDayData(row);
    expect(data.completedData).toEqual({ dateKey: '2026-10-03', charactersRead: 10 });
    expect(statDayRow(TITLE, data)).toMatchObject({ title: TITLE, completedBook: 1 });
  });

  it('applies pulled days to known books only, newer version wins', async () => {
    const local = new Map<string, BooksDbStatistic[]>([
      [TITLE, [stat('2026-10-01', 100, 10), stat('2026-10-02', 300, 90)]]
    ]);
    const written: BooksDbStatistic[][] = [];
    const records: LocalRecord[] = [
      ['2026-10-01', 150, 20],
      ['2026-10-02', 200, 40],
      ['2026-10-03', 50, 5]
    ].map(([day, chars, modified]) => ({
      kind: 'stat-day',
      id: `${BOOK}:${day}`,
      bookId: BOOK,
      deviceId: SERVER,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      data: statDayData(stat(day as string, chars as number, modified as number))
    }));
    records.push({ ...records[0], id: `${OTHER_BOOK}:2026-10-01`, bookId: OTHER_BOOK });
    records.push({ ...records[2], id: `${BOOK}:2026-10-04`, deletedAt: 9, data: {} });
    const n = await applyStatDays(records, {
      titlesByBookId: async () => new Map([[BOOK, new Set([TITLE])]]),
      statisticsForTitle: async (t) => local.get(t) ?? [],
      putStatistics: async (_t, rows) => {
        written.push(rows);
      }
    });
    expect(n).toBe(2);
    expect(written[0].map((r) => [r.dateKey, r.charactersRead])).toEqual([
      ['2026-10-01', 150],
      ['2026-10-03', 50]
    ]);
  });
});

describe('reading goals', () => {
  it('publishes changed goals and deletes removed ones', async () => {
    const { e } = await engine();
    expect(
      await publishReadingGoals(e, [goal('2026-10-01', 60), goal('2026-11-01', 30)], () => {})
    ).toBe(2);
    expect(
      await publishReadingGoals(e, [goal('2026-10-01', 60), goal('2026-11-01', 30)], () => {})
    ).toBe(0);
    expect(await publishReadingGoals(e, [goal('2026-11-01', 45)], () => {})).toBe(2);
    expect((await e.get('reading-goal', '2026-10-01'))?.deletedAt).not.toBeNull();
    expect((await e.get('reading-goal', '2026-11-01'))?.data.timeGoal).toBe(45);
  });

  it('replaces local goals only when synced ones exist and differ', async () => {
    const replaced: BooksDbReadingGoal[][] = [];
    const deps = (local: BooksDbReadingGoal[]) => ({
      localGoals: async () => local,
      replaceGoals: async (g: BooksDbReadingGoal[]) => {
        replaced.push(g);
      }
    });
    expect(await applyReadingGoals([], deps([goal('2026-10-01', 60)]))).toBe(false);
    expect(await applyReadingGoals([goal('2026-10-01', 60)], deps([goal('2026-10-01', 60)]))).toBe(
      false
    );
    expect(await applyReadingGoals([goal('2026-10-01', 90)], deps([goal('2026-10-01', 60)]))).toBe(
      true
    );
    expect(replaced).toEqual([[goal('2026-10-01', 90)]]);
  });
});

describe('global settings source', () => {
  const storage = (values: Record<string, string>) => ({
    getItem: (k: string) => values[k] ?? null
  });

  it('publishes no global setting until a source device exists', async () => {
    const { e } = await engine();
    await publishAllSettings(e, storage({ startDayHoursForTracker: '4' }), {
      apply: () => {},
      readStored: () => null
    });
    expect(await e.get('setting', 'global:startDayHoursForTracker')).toBeUndefined();
    expect(await e.get('setting', `device:${DEVICE}:startDayHoursForTracker`)).toBeUndefined();
  });

  it('the source publishes its values and goals; another device adopts them without echo', async () => {
    const desktop = await engine(DESKTOP);
    await becomeSettingsSource(
      desktop.e,
      storage({ startDayHoursForTracker: '4', customThemes: '{"a":1}' }),
      [goal('2026-10-01', 60)],
      () => {}
    );
    expect((await desktop.e.get('migration', 'settings-source'))?.data).toEqual({
      deviceId: DESKTOP
    });
    expect((await desktop.e.get('setting', 'global:startDayHoursForTracker'))?.data).toEqual({
      value: '4'
    });
    expect((await desktop.e.get('setting', 'global:overwriteBookCompletion'))?.data).toEqual({
      value: null
    });
    expect(await desktop.e.get('reading-goal', '2026-10-01')).toBeDefined();

    // The phone has its own earlier values.
    const phone = await engine(DEVICE);
    const phoneValues: Record<string, string> = {
      startDayHoursForTracker: '0',
      overwriteBookCompletion: '1'
    };
    const applied: [string, string | null][] = [];
    const deps = {
      apply: (key: string, raw: string | null) => {
        applied.push([key, raw]);
        if (raw !== null) phoneValues[key] = raw;
      },
      readStored: (key: string) => phoneValues[key] ?? null
    };
    const marker = await phone.pulled({
      kind: 'migration',
      id: 'settings-source',
      deviceId: DESKTOP,
      data: { deviceId: DESKTOP }
    });
    const pulledSettings: LocalRecord[] = [];
    for (const [key, value] of [
      ['startDayHoursForTracker', '4'],
      ['overwriteBookCompletion', null]
    ] as const) {
      pulledSettings.push(
        await phone.pulled({
          kind: 'setting',
          id: `global:${key}`,
          deviceId: DESKTOP,
          data: { value }
        })
      );
    }
    expect(await onPulledSettings(phone.e, [marker, ...pulledSettings], deps)).toEqual([]);
    expect(phoneValues.startDayHoursForTracker).toBe('4');
    expect(applied).toContainEqual(['overwriteBookCompletion', null]);

    // Nothing of the phone's is published as global: its kept value is recorded as published.
    await publishAllSettings(phone.e, storage(phoneValues), deps);
    expect(await phone.e.get('setting', 'global:startDayHoursForTracker')).toMatchObject({
      deviceId: DESKTOP
    });
    expect(await phone.e.get('setting', 'global:overwriteBookCompletion')).toMatchObject({
      deviceId: DESKTOP
    });
    // Nor any other global key (never set on the phone): Phase 7 bug 2.
    expect(
      (await phone.e.getAll('setting')).filter(
        (r) => r.id.startsWith('global:') && r.deviceId === DEVICE
      )
    ).toEqual([]);

    // Later changes flow both ways.
    phoneValues.startDayHoursForTracker = '5';
    await publishAllSettings(phone.e, storage(phoneValues), deps);
    expect((await phone.e.get('setting', 'global:startDayHoursForTracker'))?.data).toEqual({
      value: '5'
    });
    const later = await phone.pulled({
      kind: 'setting',
      id: 'global:customThemes',
      deviceId: DESKTOP,
      data: { value: '{"b":2}' }
    });
    expect(await onPulledSettings(phone.e, [later], deps)).toEqual(['customThemes']);
  });

  describe('a global key added after the device adopted (Phase 7 bug 2)', () => {
    const MAPPING = '{"JP Mining Note":{"sentence":{"field":"Sentence","mode":"fill-if-empty"}}}';

    /** A phone that adopted the desktop's values with a version that didn't know `key`. */
    async function adoptedPhone(values: Record<string, string>, key: string) {
      const phone = await engine(DEVICE);
      const deps = {
        apply: (k: string, raw: string | null) => {
          if (raw !== null) values[k] = raw;
        },
        readStored: (k: string) => values[k] ?? null
      };
      const marker = await phone.pulled({
        kind: 'migration',
        id: 'settings-source',
        deviceId: DESKTOP,
        data: { deviceId: DESKTOP }
      });
      await onPulledSettings(phone.e, [marker], deps);
      // The older version's syncs (it didn't know `key`, so never read its value).
      await publishAllSettings(phone.e, storage({}), deps);
      // What an older version leaves: the key was never applied or published.
      await phone.e.updateMeta((m) => {
        delete m.publishedSettings?.[`global:${key}`];
      });
      const own = async () =>
        (await phone.e.getAll('setting')).filter(
          (r) => r.id.startsWith('global:') && r.deviceId === DEVICE
        );
      return { ...phone, deps, own };
    }

    it('takes over the shared value already in the mirror instead of publishing its own', async () => {
      const values: Record<string, string> = {};
      const phone = await adoptedPhone(values, 'ankiFieldMapping');
      // Pulled while the older version ran: kept in the mirror, never applied.
      await phone.pulled({
        kind: 'setting',
        id: 'global:ankiFieldMapping',
        deviceId: DESKTOP,
        data: { value: MAPPING }
      });

      await publishAllSettings(phone.e, storage(values), phone.deps);
      expect(values.ankiFieldMapping).toBe(MAPPING);
      expect(await phone.own()).toEqual([]);
      expect((await phone.e.getMeta()).publishedSettings?.['global:ankiFieldMapping']).toBe(
        MAPPING
      );

      // A later edit on the phone is published as usual.
      values.ankiFieldMapping = '{}';
      await publishAllSettings(phone.e, storage(values), phone.deps);
      expect((await phone.e.get('setting', 'global:ankiFieldMapping'))?.data).toEqual({
        value: '{}'
      });
    });

    it('publishes nothing for a never-set key the mirror lacks; the next pull applies it', async () => {
      const values: Record<string, string> = {};
      const phone = await adoptedPhone(values, 'ankiFieldMapping');
      await publishAllSettings(phone.e, storage(values), phone.deps);
      expect(await phone.e.get('setting', 'global:ankiFieldMapping')).toBeUndefined();

      const record = await phone.pulled({
        kind: 'setting',
        id: 'global:ankiFieldMapping',
        deviceId: DESKTOP,
        data: { value: MAPPING }
      });
      expect(await onPulledSettings(phone.e, [record], phone.deps)).toEqual(['ankiFieldMapping']);
      expect(values.ankiFieldMapping).toBe(MAPPING);
      await publishAllSettings(phone.e, storage(values), phone.deps);
      expect(await phone.own()).toEqual([]);
    });

    it('keeps its own value when the shared one was never set, without pushing it', async () => {
      const values: Record<string, string> = { ankiTagPrefix: 'book::' };
      const phone = await adoptedPhone(values, 'ankiTagPrefix');
      await phone.pulled({
        kind: 'setting',
        id: 'global:ankiTagPrefix',
        deviceId: DESKTOP,
        data: { value: null }
      });

      await publishAllSettings(phone.e, storage(values), phone.deps);
      expect(values.ankiTagPrefix).toBe('book::');
      expect(await phone.own()).toEqual([]);
      expect(await phone.e.get('setting', 'global:ankiTagPrefix')).toMatchObject({
        deviceId: DESKTOP
      });
    });

    it('publishes a value set on this device when there is no shared one', async () => {
      const values: Record<string, string> = { ankiTagPrefix: 'book::' };
      const phone = await adoptedPhone(values, 'ankiTagPrefix');
      expect(await phone.e.get('setting', 'global:ankiTagPrefix')).toBeUndefined();
      await publishAllSettings(phone.e, storage(values), phone.deps);
      expect(await phone.e.get('setting', 'global:ankiTagPrefix')).toMatchObject({
        deviceId: DEVICE,
        data: { value: 'book::' }
      });
    });
  });
});

describe('old-sync switch', () => {
  it('is on without a record and stops only reading data', () => {
    expect(legacySyncEnabledFrom(undefined)).toBe(true);
    const r = {
      kind: 'migration',
      id: 'legacy-sync',
      bookId: null,
      deviceId: DEVICE,
      updatedAt: 1,
      deletedAt: null,
      rev: 1,
      data: { enabled: false }
    };
    expect(legacySyncEnabledFrom(r)).toBe(false);
    expect(legacySyncEnabledFrom({ ...r, data: { enabled: true } })).toBe(true);
    const all = [
      StorageDataType.DATA,
      StorageDataType.PROGRESS,
      StorageDataType.STATISTICS,
      StorageDataType.READING_GOALS,
      StorageDataType.AUDIOBOOK,
      StorageDataType.SUBTITLE
    ];
    expect(allowedLegacyTypes(all, false)).toEqual(all);
    // Book files stay: whispersync's "save match" uploads the matched HTML with them.
    expect(allowedLegacyTypes(all, true)).toEqual([
      StorageDataType.DATA,
      StorageDataType.AUDIOBOOK,
      StorageDataType.SUBTITLE
    ]);
  });
});

describe('device report and check page reads', () => {
  it('summarizes titles, bookmarks and stat days without loading books', async () => {
    const db = await database.db;
    await db.clear('data');
    await db.clear('bookmark');
    await db.clear('statistic');
    const id = await db.add('data', {
      title: TITLE,
      styleSheet: '',
      elementHtml: '<p>x</p>',
      blobs: {},
      hasThumb: false,
      characters: 100,
      lastBookModified: 1,
      lastBookOpen: 1
    } as never);
    await db.add('data', {
      title: '未読',
      styleSheet: '',
      elementHtml: '',
      blobs: {},
      hasThumb: false,
      characters: 1,
      lastBookModified: 1,
      lastBookOpen: 1
    } as never);
    await db.put('bookmark', {
      dataId: Number(id),
      exploredCharCount: 42.4,
      progress: 0.4,
      lastBookmarkModified: 77
    });
    await db.put('statistic', stat('2026-10-01', 1, 1));
    await db.put('statistic', stat('2026-10-02', 1, 1));
    await db.put('statistic', stat('2026-10-01', 1, 1, '削除済みの本'));
    expect(await localTitleSummaries(db)).toEqual([
      { title: '削除済みの本', hasBookmark: false, statDays: 1 },
      { title: '未読', hasBookmark: false, statDays: 0 },
      { title: TITLE, hasBookmark: true, statDays: 2 }
    ]);
    expect(await localBookmarkForTitle(db, TITLE)).toEqual({ charPos: 42, at: 77 });
    expect(await localBookmarkForTitle(db, '未読')).toBeNull();
  });
});

describe('texts', () => {
  const view = (partial: Partial<LegacyBookView>): LegacyBookView => ({
    folder: 'f',
    title: 't',
    state: 'needs_user',
    reason: null,
    method: null,
    bookId: null,
    book: null,
    candidates: [],
    details: {
      characters: null,
      bookFiles: 1,
      progress: null,
      stats: null,
      audioBook: false,
      subtitles: false
    },
    scannedAt: 0,
    decidedAt: null,
    importedAt: null,
    ...partial
  });

  it('explains every reason in plain words', () => {
    const c = {
      bookId: BOOK,
      fingerprinted: true,
      titleMatches: true,
      imagesMatched: 0,
      imagesTotal: 31,
      missingSpineIds: 0,
      verified: false,
      book: null
    };
    expect(reasonText(view({ reason: 'several', candidates: [c, c] }))).toMatch(/^2 identical/);
    expect(reasonText(view({ reason: 'unverified', candidates: [c] }))).toBe(
      'Title matches but the file differs (0 of 31 pictures match).'
    );
    for (const reason of [
      'no_candidate',
      'no_book_file',
      'damaged',
      'conflict',
      'unlinked'
    ] as const) {
      expect(reasonText(view({ reason }))).not.toBe('');
    }
    expect(fingerprintText(c)).toBe('title ✓ · pictures 0/31 · chapters ✓');
    expect(
      dataText({
        ...view({}).details,
        progress: { charPos: 5, progress: 0.634, at: 1 },
        stats: { days: 14, characters: 1, seconds: 1, lastDay: '2026-11-03' },
        audioBook: true
      })
    ).toBe(
      'place 63% · 14 reading days · last read 2026-11-03 · audiobook (stays on the old sync)'
    );
  });
});
