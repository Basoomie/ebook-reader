/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { logger } from '$lib/data/logger';
import { MergeMode } from '$lib/data/merge-mode';
import { database, startDayHoursForTracker$ } from '$lib/data/store';
import { getDateKey } from '$lib/functions/statistic-util';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
import { canUseWebLocks, randomId } from '$lib/functions/secure-context';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { MigrationApi } from '$lib/migration/api';
import { localBookmarkForTitle, localTitleSummaries } from '$lib/migration/local-summary';
import { applyReadingGoals, applyStatDays } from '$lib/sync/apply-records';
import {
  bookStateFrom,
  positionReadThroughId,
  type BookBlur,
  type BookStatus,
  type ReadThrough
} from '$lib/sync/book-state';
import {
  readingSpeed,
  statEntriesFromRecords,
  totalsByDay,
  totalsOf,
  type StatEntry
} from '$lib/stats/aggregate';
import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
import { LibraryApi } from '$lib/library/api';
import { SessionRecorder, type RecordSideDeps } from '$lib/stats/session-recorder';
import { STAT_SESSION_FIX_KIND, STAT_SESSION_KIND } from '$lib/stats/stat-records';
import {
  editReadThroughFinish,
  getAllBookStates,
  getBookState,
  markBooksCompleted,
  noteFirstPageTurn,
  noteReaderCompletion,
  onBookStatesChanged,
  pendingStartOver,
  registerBookStateSync,
  removeReadThrough,
  setBookBlur,
  setBookFavorite,
  setBookStatus,
  setBooksBlur,
  setBooksFavorite,
  setBooksStatus,
  startBookOver,
  type BookStateDeps,
  type MarkCompletedBook
} from '$lib/sync/book-state-service';
import {
  bookIdForTitle,
  legacyBookIdForTitle,
  titlesByBookId,
  type BookIdDeps
} from '$lib/sync/book-ids';
import {
  LEGACY_SYNC_RECORD,
  legacyReadingSyncOff$,
  legacySyncEnabledFrom
} from '$lib/sync/legacy-switch';
import {
  findPositionPrompt,
  markPositionPromptHandled,
  onPositionsChanged,
  promptBookId,
  type PositionPromptDeps
} from '$lib/sync/position-prompt-service';
import type { PromptApi } from '$lib/sync/reader-position-prompt';
import {
  mirroredReadingGoals,
  publishReadingGoals,
  READING_GOAL_KIND
} from '$lib/sync/record-goals';
import { recordPosition, resolveLinkedBookId, type BookmarkLike } from '$lib/sync/record-position';
import { recordStatistics, STAT_DAY_KIND } from '$lib/sync/record-statistics';
import { applyGlobalSettingValue } from '$lib/sync/settings-apply';
import { otherDevicesAppearance, type DeviceAppearance } from '$lib/sync/copy-device-settings';
import type { TextAnchor } from '$lib/notes/anchor';
import type { BookNotes, HighlightColor } from '$lib/notes/highlights';
import {
  addHighlight,
  getAllNotes,
  getBookNotes,
  getUnplacedHighlights,
  onNotesChanged,
  removeHighlight,
  removeNote,
  saveNote,
  setHighlightColor,
  setUnplacedHighlights,
  type NoteTarget,
  type NotesDeps
} from '$lib/notes/notes-service';
import {
  addBookmark,
  getBookmarks,
  removeBookmark,
  renameBookmark,
  type BookmarkItem,
  type BookmarkPlace
} from '$lib/notes/bookmarks';
import {
  positionPromptEnabled$,
  positionPromptMinChars$,
  recordSyncEnabled$,
  syncDebounceSeconds$,
  syncIntervalMinutes$
} from '$lib/sync/settings';
import {
  becomeSettingsSource,
  onPulledSettings,
  publishAllSettings,
  settingsSourceDeviceId,
  type GlobalSettingsDeps
} from '$lib/sync/settings-source';
import { SyncApi } from '$lib/sync/sync-api';
import type { LocalRecord } from '$lib/sync/sync-db';
import { SyncEngine } from '$lib/sync/sync-engine';
import { SyncRunner, type RunnerEnv } from '$lib/sync/sync-runner';
import { getTagBlurRules, setTagBlur, TAG_BLUR_KIND } from '$lib/sync/tag-blur';
import {
  addBooks,
  collectionsOfBook,
  createCollection,
  deleteCollection,
  getCollectionsView,
  moveBookBy,
  moveBooks,
  onCollectionsChanged,
  removeBooks,
  renameCollection,
  setCollectionQuery,
  type CollectionsDeps
} from '$lib/collections/collections-service';
import type { CollectionType } from '$lib/collections/collections';

/**
 * The app's record sync (WP4): one engine and one background runner per tab.
 * Everything here is best effort: failures are logged and shown in the
 * Library page's Connection panel, never raised into the reader.
 */

const warn = (message: string) => logger.warn(message);

let enginePromise: Promise<SyncEngine> | null = null;

export function getSyncEngine(): Promise<SyncEngine> {
  if (!enginePromise) {
    enginePromise = SyncEngine.open({ warn }).then((engine) => {
      registerBookStateSync(engine);
      return engine;
    });
    enginePromise.catch(() => {
      enginePromise = null; // try again next time
    });
  }
  return enginePromise;
}

let transport: { key: string; api: SyncApi } | null = null;

async function getTransport(): Promise<SyncApi | null> {
  const connection = await getLibraryStore().getConnection();
  if (!connection) {
    transport = null;
    return null;
  }
  const timeout = libraryRequestTimeoutSeconds$.getValue();
  const key = `${connection.serverUrl}\n${connection.token}\n${timeout}`;
  // One transport per connection, so the engine registers the device once.
  if (transport?.key !== key) {
    transport = { key, api: new SyncApi(connection.serverUrl, connection.token, timeout) };
  }
  return transport.api;
}

function browserEnv(): RunnerEnv {
  return {
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    isVisible: () => document.visibilityState === 'visible',
    onWake(listener) {
      const onVisible = () => {
        if (document.visibilityState === 'visible') listener();
      };
      window.addEventListener('online', listener);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        window.removeEventListener('online', listener);
        document.removeEventListener('visibilitychange', onVisible);
      };
    },
    // Web Locks exist only in a secure context; without them the engine is
    // still safe across tabs (idempotent pushes, seq-checked acknowledgements).
    withLock: canUseWebLocks()
      ? async <T>(fn: () => Promise<T>): Promise<T | null> => {
          let result: T | null = null;
          // ifAvailable: when another tab holds the lock it is syncing already; skip.
          await navigator.locks.request('ttsu-sync', { ifAvailable: true }, async (lock) => {
            if (lock) result = await fn();
          });
          return result;
        }
      : undefined
  };
}

let runner: SyncRunner | null = null;

export function getSyncRunner(): SyncRunner | null {
  if (!browser) return null;
  runner ??= new SyncRunner({
    getEngine: getSyncEngine,
    getTransport,
    beforeSync: async (engine) => {
      await publishAllSettings(engine, window.localStorage, globalSettingsDeps());
    },
    settings: {
      enabled: () => recordSyncEnabled$.getValue(),
      debounceSeconds: () => syncDebounceSeconds$.getValue(),
      intervalMinutes: () => syncIntervalMinutes$.getValue()
    },
    env: browserEnv(),
    warn
  });
  return runner;
}

let started = false;

/** Starts background sync for this tab (root layout). Never throws. */
export function startSync(): void {
  if (!browser || started) return;
  started = true;
  try {
    const r = getSyncRunner();
    void r?.start();
    void getSyncEngine()
      .then((engine) => {
        engine.onRemoteChange((records) => {
          void onPulledSettings(engine, records, globalSettingsDeps()).catch((error) =>
            warn(`Sync: applying settings failed: ${(error as Error)?.message ?? error}`)
          );
          void onPulledMigrationRecords(engine, records);
        });
        void refreshLegacySwitch();
        void reportDeviceSoon();
      })
      .catch((error) => warn(`Sync: not started: ${(error as Error)?.message ?? error}`));
  } catch (error) {
    warn(`Sync: not started: ${(error as Error)?.message ?? error}`);
  }
}

/** After the Library page connects, disconnects or re-pairs. */
export function notifySyncConnectionChanged(): void {
  try {
    getSyncRunner()?.connectionChanged();
  } catch (error) {
    warn(`Sync: ${(error as Error)?.message ?? error}`);
  }
}

/**
 * Called by the reader right after it saved its bookmark. Fire and forget:
 * returns immediately and can never fail the bookmark save.
 */
export function recordReaderPosition(localId: number, title: string, bookmark: BookmarkLike): void {
  if (!browser) return;
  try {
    void recordPosition(localId, title, bookmark, {
      getEngine: getSyncEngine,
      linksForLocalId: (id) => getLibraryStore().getLinksForLocalId(id),
      legacyBookId,
      warn
    });
  } catch (error) {
    warn(`Sync: could not record the position: ${(error as Error)?.message ?? error}`);
  }
}

const promptDeps: PositionPromptDeps = {
  getEngine: getSyncEngine,
  linksForLocalId: (id) => getLibraryStore().getLinksForLocalId(id),
  legacyBookId,
  isActive: async () =>
    positionPromptEnabled$.getValue() &&
    recordSyncEnabled$.getValue() &&
    !!(await getLibraryStore().getConnection()),
  minChars: () => positionPromptMinChars$.getValue(),
  warn
};

/**
 * "Continue from...?" (WP9) for the reader, which loads this module on demand.
 * Every call is best effort and never rejects.
 */
export function positionPromptApi(): PromptApi {
  return {
    bookId: (localId, title) =>
      browser ? promptBookId(localId, title, promptDeps).catch(() => null) : Promise.resolve(null),
    find: (bookId, place) => findPositionPrompt(bookId, place, promptDeps),
    markHandled: (bookId, answered) => markPositionPromptHandled(bookId, answered, promptDeps),
    onChanged: (bookId, callback) => onPositionsChanged(bookId, callback, promptDeps),
    syncSoon: async () => {
      try {
        return (await getSyncRunner()?.syncSoon()) ?? null;
      } catch {
        return null;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// WP5: migration off the old file sync
// ---------------------------------------------------------------------------

async function legacyBookId(title: string): Promise<string | null> {
  return legacyBookIdForTitle(await getSyncEngine(), title);
}

const bookIdDeps: BookIdDeps = {
  getEngine: getSyncEngine,
  allLinks: () => getLibraryStore().getAllLinks(),
  warn
};

function globalSettingsDeps(): GlobalSettingsDeps {
  return {
    apply: applyGlobalSettingValue,
    readStored: (key) => window.localStorage.getItem(key)
  };
}

/**
 * Side by side with the old sync: after this device saved statistics for a
 * title, write its changed days as records. Fire and forget; never throws.
 * `pruneMissing` after the user deleted statistics on this device.
 */
export function recordBookStatistics(
  title: string,
  options: { pruneMissing?: boolean } = {}
): void {
  if (!browser || !title) return;
  try {
    void recordStatistics(
      title,
      {
        getEngine: getSyncEngine,
        bookIdForTitle: (t) => bookIdForTitle(t, bookIdDeps),
        statisticsForTitle: (t) => database.getStatisticsForBook(t),
        warn
      },
      options
    );
  } catch (error) {
    warn(`Sync: could not record statistics: ${(error as Error)?.message ?? error}`);
  }
}

/**
 * After the user edited reading goals on this device. Before the old sync is
 * switched off only the settings-source device publishes goals.
 */
export function recordReadingGoalEdits(): void {
  if (!browser) return;
  void (async () => {
    try {
      const engine = await getSyncEngine();
      const source = await settingsSourceDeviceId(engine);
      if (!source) return;
      if (source !== engine.deviceId && !legacyReadingSyncOff$.getValue()) return;
      await publishReadingGoals(engine, await database.getReadingGoals(), warn);
    } catch (error) {
      warn(`Sync: could not record reading goals: ${(error as Error)?.message ?? error}`);
    }
  })();
}

/** Reads the old-sync switch from the mirror. Unknown (no mirror) means on. */
export async function refreshLegacySwitch(): Promise<boolean> {
  try {
    const engine = await getSyncEngine();
    const off = !legacySyncEnabledFrom(
      await engine.get(LEGACY_SYNC_RECORD.kind, LEGACY_SYNC_RECORD.id)
    );
    const wasOff = legacyReadingSyncOff$.getValue();
    if (off !== wasOff) legacyReadingSyncOff$.next(off);
    if (off && !wasOff) await applyAllFromMirror(engine);
    return off;
  } catch (error) {
    warn(`Sync: could not read the old-sync switch: ${(error as Error)?.message ?? error}`);
    return legacyReadingSyncOff$.getValue();
  }
}

/**
 * The reader asks before using the old sync. Waits at most `timeoutMs` for
 * the mirror; when it can't tell, the old sync runs (it was on before WP5).
 */
export async function isLegacyReadingSyncOff(timeoutMs = 2000): Promise<boolean> {
  if (!browser) return false;
  return Promise.race([
    refreshLegacySwitch(),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(legacyReadingSyncOff$.getValue()), timeoutMs)
    )
  ]);
}

/** The user's switch on the migration page. Throws when it can't be saved. */
export async function setLegacySyncEnabled(enabled: boolean): Promise<void> {
  const engine = await getSyncEngine();
  await engine.write(LEGACY_SYNC_RECORD.kind, LEGACY_SYNC_RECORD.id, { enabled });
  await refreshLegacySwitch();
  await getSyncRunner()?.syncNow();
}

/** "Use this device's shared settings" (the desktop). Throws when it can't be saved. */
export async function becomeSettingsSourceHere(): Promise<void> {
  const engine = await getSyncEngine();
  await becomeSettingsSource(engine, window.localStorage, await database.getReadingGoals(), warn);
  await getSyncRunner()?.syncNow();
}

/** This device's id and whether it is the settings source (for the migration page). */
export async function settingsSourceState(): Promise<{
  deviceId: string;
  sourceId: string | null;
}> {
  const engine = await getSyncEngine();
  return { deviceId: engine.deviceId, sourceId: await settingsSourceDeviceId(engine) };
}

function applyDeps() {
  return {
    titlesByBookId: () => titlesByBookId(bookIdDeps),
    statisticsForTitle: (title: string) => database.getStatisticsForBook(title),
    putStatistics: (title: string, rows: Parameters<typeof database.storeStatistics>[1]) =>
      database.storeStatistics(
        title,
        rows,
        ReplicationSaveBehavior.Overwrite,
        MergeMode.LOCAL,
        Math.max(...rows.map((r) => r.lastStatisticModified))
      ),
    localGoals: () => database.getReadingGoals(),
    replaceGoals: async (goals: Awaited<ReturnType<typeof database.getReadingGoals>>) => {
      await database.storeReadingGoals(
        goals,
        ReplicationSaveBehavior.Overwrite,
        MergeMode.REPLACE,
        Math.max(0, ...goals.map((g) => g.lastGoalModified))
      );
    }
  };
}

/** Catch-up when the old sync was just switched off: apply everything in the mirror. */
async function applyAllFromMirror(engine: SyncEngine) {
  try {
    const deps = applyDeps();
    await applyStatDays(await engine.getAll(STAT_DAY_KIND), deps);
    await applyReadingGoals(await mirroredReadingGoals(engine), deps);
  } catch (error) {
    warn(`Sync: applying synced statistics failed: ${(error as Error)?.message ?? error}`);
  }
}

/** After a pull: the switch, and (only while the old sync is off) statistics and goals. */
async function onPulledMigrationRecords(engine: SyncEngine, records: LocalRecord[]) {
  try {
    if (records.some((r) => r.kind === LEGACY_SYNC_RECORD.kind)) {
      const wasOff = legacyReadingSyncOff$.getValue();
      const off = await refreshLegacySwitch();
      if (!off || !wasOff) return; // just turned off: everything was applied already
    }
    if (!legacyReadingSyncOff$.getValue()) return;
    const deps = applyDeps();
    await applyStatDays(records, deps);
    if (records.some((r) => r.kind === READING_GOAL_KIND)) {
      await applyReadingGoals(await mirroredReadingGoals(engine), deps);
    }
  } catch (error) {
    warn(`Sync: applying synced statistics failed: ${(error as Error)?.message ?? error}`);
  }
}

/** The migration API for this connection, or null when not connected. */
export async function getMigrationApi(): Promise<MigrationApi | null> {
  const connection = await getLibraryStore().getConnection();
  if (!connection) return null;
  return new MigrationApi(
    connection.serverUrl,
    connection.token,
    libraryRequestTimeoutSeconds$.getValue()
  );
}

/**
 * Tells the server what this device holds (its Calibre links and local titles
 * with reading data), so the scan can use exact Calibre identities. Needs a
 * registered device, so it syncs first. Throws on failure.
 */
export async function reportDevice(): Promise<void> {
  const api = await getMigrationApi();
  if (!api) throw new Error('Not connected to the server');
  await getSyncRunner()?.syncNow();
  const links = await getLibraryStore().getAllLinks();
  await api.report({
    // Uploaded books (WP7b) have no Calibre identity; the server ignored them anyway.
    calibreLinks: links.flatMap((l) =>
      l.calibreUuid ? [{ title: l.title, bookId: l.bookId, calibreUuid: l.calibreUuid }] : []
    ),
    localTitles: await localTitleSummaries(await database.db)
  });
}

let reported = false;

/** Once per app start, in the background, a little after the first sync. */
async function reportDeviceSoon(): Promise<void> {
  if (reported) return;
  reported = true;
  try {
    if (!recordSyncEnabled$.getValue() || !(await getLibraryStore().getConnection())) return;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await reportDevice();
  } catch (error) {
    warn(
      `Sync: could not report this device to the migration: ${(error as Error)?.message ?? error}`
    );
  }
}

export interface BookmarkComparison {
  local: { charPos: number; at: number } | null;
  own: { charPos: number; at: number } | null;
}

/** Check page: this device's bookmark vs. its own position record, per book. */
export async function compareThisDeviceBookmarks(
  books: { bookId: string; title: string }[]
): Promise<Map<string, BookmarkComparison>> {
  const engine = await getSyncEngine();
  const db = await database.db;
  const out = new Map<string, BookmarkComparison>();
  for (const { bookId, title } of books) {
    const record = await engine.get('position', `${bookId}:${engine.deviceId}`);
    out.set(bookId, {
      local: await localBookmarkForTitle(db, title),
      own:
        record && record.deletedAt === null
          ? { charPos: Number(record.data.charPos) || 0, at: record.updatedAt }
          : null
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// WP8a: book state (status, favorite, blur, read-throughs)
// ---------------------------------------------------------------------------

const bookStateDeps: BookStateDeps = {
  getEngine: getSyncEngine,
  today: () => getDateKey(startDayHoursForTracker$.getValue()),
  warn
};

/**
 * The server book id of a local book (Calibre link or migrated link), or null.
 * Book state applies only to catalog books. Never rejects.
 */
export async function bookIdForLocalBook(localId: number, title: string): Promise<string | null> {
  if (!browser) return null;
  try {
    return await resolveLinkedBookId(
      localId,
      title,
      (id) => getLibraryStore().getLinksForLocalId(id),
      warn,
      legacyBookId
    );
  } catch (error) {
    warn(`Book state: ${(error as Error)?.message ?? error}`);
    return null;
  }
}

/** The reader's first real page turn of a book load. Fire and forget. */
export function noteReaderFirstPageTurn(localId: number, title: string): void {
  void bookIdForLocalBook(localId, title).then((bookId) =>
    bookId ? noteFirstPageTurn(bookId, bookStateDeps) : undefined
  );
}

/** The reader's Complete Book. Never rejects; resolves once the read-through is saved. */
export function noteReaderBookCompleted(localId: number, title: string): Promise<void> {
  return bookIdForLocalBook(localId, title)
    .then((bookId) => (bookId ? noteReaderCompletion(bookId, bookStateDeps) : undefined))
    .catch((error) => warn(`Book state: ${(error as Error)?.message ?? error}`));
}

/** A Start over this device still has to apply for the open book, or null. Never rejects. */
export async function readerPendingStartOver(
  bookId: string,
  restoredPos: number
): Promise<ReadThrough | null> {
  return pendingStartOver(bookId, restoredPos, bookStateDeps);
}

/** The Book state dialog and the library page. User actions reject when they can't be saved. */
export function bookStateApi() {
  return {
    get: (bookId: string) => getBookState(bookId, bookStateDeps),
    getAll: () => getAllBookStates(bookStateDeps),
    setStatus: (bookId: string, status: BookStatus) => setBookStatus(bookId, status, bookStateDeps),
    setFavorite: (bookId: string, favorite: boolean) =>
      setBookFavorite(bookId, favorite, bookStateDeps),
    setBlur: (bookId: string, blur: BookBlur) => setBookBlur(bookId, blur, bookStateDeps),
    markCompleted: (books: MarkCompletedBook[], finishedOn: string | null) =>
      markBooksCompleted(books, finishedOn, bookStateDeps),
    setStatusMany: (bookIds: readonly string[], status: BookStatus) =>
      setBooksStatus(bookIds, status, bookStateDeps),
    setFavoriteMany: (bookIds: readonly string[], favorite: boolean) =>
      setBooksFavorite(bookIds, favorite, bookStateDeps),
    setBlurMany: (bookIds: readonly string[], blur: BookBlur) =>
      setBooksBlur(bookIds, blur, bookStateDeps),
    startOver: (bookId: string) => startBookOver(bookId, bookStateDeps),
    editFinish: (bookId: string, readThroughId: string, finishedOn: string | null) =>
      editReadThroughFinish(bookId, readThroughId, finishedOn, bookStateDeps),
    removeReadThrough: (bookId: string, readThroughId: string) =>
      removeReadThrough(bookId, readThroughId, bookStateDeps),
    onChanged: (callback: (bookIds: Set<string>) => void, options?: { remoteOnly?: boolean }) =>
      onBookStatesChanged(callback, bookStateDeps, options),
    today: () => bookStateDeps.today()
  };
}

export type BookStateApi = ReturnType<typeof bookStateApi>;

// ---------------------------------------------------------------------------
// WP7a: library view data (cover blur rules, progress, freshness of state filters)
// ---------------------------------------------------------------------------

/** What the library page reads from the local mirror besides book state. */
export function libraryViewApi() {
  return {
    /** Tags whose covers are blurred. Never rejects (empty on failure). */
    async tagBlurRules(): Promise<Set<string>> {
      try {
        return await getTagBlurRules(await getSyncEngine());
      } catch (error) {
        warn(`Library: ${(error as Error)?.message ?? error}`);
        return new Set();
      }
    },
    /** Rejects when the rule could not be saved. */
    async setTagBlur(tag: string, blur: boolean): Promise<void> {
      await setTagBlur(await getSyncEngine(), tag, blur);
    },
    /** Every position record (all devices), for progress. Never rejects. */
    async positions(): Promise<LocalRecord[]> {
      try {
        return await (await getSyncEngine()).getAll('position');
      } catch (error) {
        warn(`Library: ${(error as Error)?.message ?? error}`);
        return [];
      }
    },
    /** Called after local writes or pulls of tag rules or positions. */
    async onChanged(callback: () => void): Promise<() => void> {
      try {
        const engine = await getSyncEngine();
        const relevant = (r: LocalRecord) => r.kind === TAG_BLUR_KIND || r.kind === 'position';
        const offRemote = engine.onRemoteChange((records) => {
          if (records.some(relevant)) callback();
        });
        const offLocal = engine.onLocalWrite((r) => {
          if (relevant(r)) callback();
        });
        return () => {
          offRemote();
          offLocal();
        };
      } catch {
        return () => {};
      }
    },
    /**
     * Asks for a sync now, so places saved on other devices show (WP8b). Respects the
     * runner's backoff and the per-device switch. Never rejects; resolves when done.
     */
    async syncSoon(): Promise<void> {
      try {
        await getSyncRunner()?.syncSoon();
      } catch {
        // Shown in the Connection panel.
      }
    },
    /**
     * Before a search that filters by status or favorite: the server only knows changes
     * that reached it, so unsent ones are sent first (at most `timeoutSeconds`).
     * Resolves to true when changes are still unsent (offline). Never rejects.
     */
    async sendPendingChanges(timeoutSeconds: number): Promise<boolean> {
      try {
        const engine = await getSyncEngine();
        if ((await engine.status()).pending === 0) return false;
        const runner = getSyncRunner();
        if (runner && recordSyncEnabled$.getValue()) {
          const limit = Math.max(1, timeoutSeconds || 20) * 1000;
          await Promise.race([
            runner.syncNow(),
            new Promise((resolve) => setTimeout(resolve, limit))
          ]);
        }
        return (await engine.status()).pending > 0;
      } catch {
        return false;
      }
    }
  };
}

export type LibraryViewApi = ReturnType<typeof libraryViewApi>;

// ---------------------------------------------------------------------------
// WP8b: collections
// ---------------------------------------------------------------------------

const collectionsDeps: CollectionsDeps = { getEngine: getSyncEngine, warn };

/**
 * Collections for the Collections page, the Library page, the book dialog and the
 * reader. Reads never reject (empty on failure); user actions reject with a message
 * when they can't be saved; bulk actions resolve to the ids that failed.
 */
export function collectionsApi() {
  return {
    async view() {
      try {
        return await getCollectionsView(collectionsDeps);
      } catch (error) {
        warn(`Collections: ${(error as Error)?.message ?? error}`);
        return { collections: [], items: new Map() };
      }
    },
    async ofBook(bookId: string): Promise<Set<string>> {
      try {
        return await collectionsOfBook(bookId, collectionsDeps);
      } catch (error) {
        warn(`Collections: ${(error as Error)?.message ?? error}`);
        return new Set();
      }
    },
    create: (input: { name: string; type: CollectionType; query?: string | null }) =>
      createCollection(input, collectionsDeps),
    rename: (id: string, name: string) => renameCollection(id, name, collectionsDeps),
    setQuery: (id: string, query: string) => setCollectionQuery(id, query, collectionsDeps),
    remove: (id: string) => deleteCollection(id, collectionsDeps),
    addBooks: (id: string, bookIds: readonly string[]) => addBooks(id, bookIds, collectionsDeps),
    removeBooks: (id: string, bookIds: readonly string[]) =>
      removeBooks(id, bookIds, collectionsDeps),
    moveBooks: (id: string, bookIds: readonly string[], index: number) =>
      moveBooks(id, bookIds, index, collectionsDeps),
    moveBookBy: (id: string, bookId: string, delta: -1 | 1) =>
      moveBookBy(id, bookId, delta, collectionsDeps),
    onChanged: (callback: () => void) => onCollectionsChanged(callback, collectionsDeps)
  };
}

export type CollectionsApi = ReturnType<typeof collectionsApi>;

const notesDeps: NotesDeps = { getEngine: getSyncEngine, warn };

/**
 * WP11a: highlights and notes for the reader (and the Notes page in WP11c). Reads never
 * reject (empty on failure); user actions reject with a message when they can't be
 * saved; remove actions resolve to an undo.
 */
export function notesApi() {
  const empty = (): BookNotes => ({ highlights: [], notes: [] });
  return {
    async ofBook(bookId: string): Promise<BookNotes> {
      try {
        return await getBookNotes(bookId, notesDeps);
      } catch (error) {
        warn(`Notes: ${(error as Error)?.message ?? error}`);
        return empty();
      }
    },
    async all(): Promise<Map<string, BookNotes>> {
      try {
        return await getAllNotes(notesDeps);
      } catch (error) {
        warn(`Notes: ${(error as Error)?.message ?? error}`);
        return new Map();
      }
    },
    addHighlight: (
      bookId: string,
      anchor: TextAnchor,
      color: HighlightColor,
      chapter: string | null | undefined
    ) => addHighlight(bookId, anchor, color, chapter, notesDeps),
    setColor: (id: string, color: HighlightColor) => setHighlightColor(id, color, notesDeps),
    removeHighlight: (id: string) => removeHighlight(id, notesDeps),
    saveNote: (target: NoteTarget, body: string) => saveNote(target, body, notesDeps),
    removeNote: (id: string) => removeNote(id, notesDeps),
    unplaced: () => getUnplacedHighlights(notesDeps),
    setUnplaced: (bookId: string, ids: readonly string[]) =>
      setUnplacedHighlights(bookId, ids, notesDeps),
    onChanged: (callback: (bookIds: Set<string>) => void, options?: { remoteOnly?: boolean }) =>
      onNotesChanged(callback, notesDeps, options),
    // WP11b: named bookmarks
    async bookmarksOf(bookId: string): Promise<BookmarkItem[]> {
      try {
        return await getBookmarks(bookId, notesDeps);
      } catch (error) {
        warn(`Bookmarks: ${(error as Error)?.message ?? error}`);
        return [];
      }
    },
    addBookmark: (
      bookId: string,
      place: BookmarkPlace,
      name: string,
      chapter: string | null | undefined
    ) => addBookmark(bookId, place, name, chapter, notesDeps),
    renameBookmark: (id: string, name: string) => renameBookmark(id, name, notesDeps),
    removeBookmark: (id: string) => removeBookmark(id, notesDeps),
    /** WP11c: titles this device knows for catalog books (offline fallback). */
    async titles(): Promise<Map<string, string>> {
      try {
        const all = await titlesByBookId(bookIdDeps);
        return new Map([...all].map(([id, set]) => [id, [...set][0] ?? '']));
      } catch (error) {
        warn(`Notes: ${(error as Error)?.message ?? error}`);
        return new Map();
      }
    },
    async syncSoon(): Promise<void> {
      try {
        await getSyncRunner()?.syncSoon();
      } catch {
        // Shown in the Connection panel.
      }
    }
  };
}

export type NotesApi = ReturnType<typeof notesApi>;

/**
 * WP10e: other devices' appearance settings from the local mirror (works offline), for
 * "Copy from another device". Never throws: an unavailable mirror is an empty list.
 */
export async function listOtherDevicesAppearance(): Promise<DeviceAppearance[]> {
  try {
    const engine = await getSyncEngine();
    const records = await engine.getAll('setting');
    const names: Record<string, string | undefined> = {};
    for (const record of records) {
      const deviceId = /^device:([^:]+):/.exec(record.id)?.[1];
      if (!deviceId || deviceId === engine.deviceId || deviceId in names) continue;
      const device = await engine.get('device', deviceId);
      const name = device && device.deletedAt === null ? device.data?.name : undefined;
      names[deviceId] = typeof name === 'string' ? name : undefined;
    }
    return otherDevicesAppearance(records, engine.deviceId, names);
  } catch (error) {
    warn(`Copy settings: ${(error as Error)?.message ?? error}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// WP12: reading sessions (the only source of reading time and characters)
// ---------------------------------------------------------------------------

const STAT_KINDS = [STAT_SESSION_KIND, STAT_SESSION_FIX_KIND, STAT_DAY_KIND];

/** Where a reader's session recorder writes (see lazyRecorderDeps). */
export function statsRecorderDeps(localId: number, title: string): RecordSideDeps {
  return {
    resolveTarget: async () => {
      if (!browser) return null;
      const bookId = await bookIdForLocalBook(localId, title);
      if (!bookId) return null;
      return { bookId, deviceId: (await getSyncEngine()).deviceId };
    },
    readThroughId: async (bookId) => {
      const engine = await getSyncEngine();
      return positionReadThroughId(bookStateFrom(bookId, await engine.getForBook(bookId)));
    },
    put: async (kind, id, data, bookId) => (await getSyncEngine()).put(kind, id, data, { bookId })
  };
}

/** Statistics from the local mirror (works offline). Never throws. */
export function statsApi() {
  return {
    /** The recorder for a book the reader opened (one per visit). */
    recorder(localId: number, title: string): SessionRecorder {
      return new SessionRecorder({ ...statsRecorderDeps(localId, title), newId: randomId, warn });
    },
    /** One book's statistics entries (sessions with fixes, frozen days) and read-throughs. */
    async bookStats(
      bookId: string
    ): Promise<{ entries: StatEntry[]; readThroughs: ReadThrough[] }> {
      try {
        const records = await (await getSyncEngine()).getForBook(bookId);
        return {
          entries: statEntriesFromRecords(
            records.filter((r) => STAT_KINDS.includes(r.kind) && r.bookId === bookId)
          ),
          readThroughs: bookStateFrom(bookId, records).readThroughs
        };
      } catch (error) {
        warn(`Stats: ${(error as Error)?.message ?? error}`);
        return { entries: [], readThroughs: [] };
      }
    },
    /** Every statistics entry of every book. */
    async allEntries(): Promise<StatEntry[]> {
      try {
        const engine = await getSyncEngine();
        const records: LocalRecord[] = [];
        for (const kind of STAT_KINDS) records.push(...(await engine.getAll(kind)));
        return statEntriesFromRecords(records);
      } catch (error) {
        warn(`Stats: ${(error as Error)?.message ?? error}`);
        return [];
      }
    },
    /**
     * Until the new Stats page (WP12b): day totals per book as the old page's rows,
     * titled by this device, else the catalog, else "Unknown book".
     */
    async dayRowsForOldPage(): Promise<BooksDbStatistic[]> {
      const entries = await this.allEntries();
      const byBook = new Map<string, StatEntry[]>();
      for (const e of entries) byBook.set(e.bookId, [...(byBook.get(e.bookId) ?? []), e]);
      const titles = await statsTitles([...byBook.keys()]);
      const rows: BooksDbStatistic[] = [];
      for (const [bookId, list] of byBook) {
        const title = titles.get(bookId) ?? `Unknown book (${bookId.slice(0, 8)})`;
        for (const [dateKey, totals] of totalsByDay(list)) {
          const speed = readingSpeed(totals);
          rows.push({
            title,
            dateKey,
            charactersRead: totals.chars,
            readingTime: totals.seconds,
            minReadingSpeed: speed,
            altMinReadingSpeed: speed,
            lastReadingSpeed: speed,
            maxReadingSpeed: speed,
            lastStatisticModified: 0
          });
        }
      }
      return rows.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));
    },
    /** Reading time and characters of all books from `from` to `to` (day keys, inclusive). */
    async totalsBetween(from: string, to: string) {
      const entries = await this.allEntries();
      return totalsOf(entries, (e) => e.day >= from && e.day <= to);
    }
  };
}

export type StatsApi = ReturnType<typeof statsApi>;

/** Titles for book ids: this device's, then the catalog's (best effort). Never throws. */
async function statsTitles(bookIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    for (const [id, set] of await titlesByBookId(bookIdDeps)) {
      const title = [...set][0];
      if (title) out.set(id, title);
    }
    const missing = bookIds.filter((id) => !out.has(id));
    const connection = missing.length ? await getLibraryStore().getConnection() : undefined;
    if (!connection) return out;
    const api = new LibraryApi(
      connection.serverUrl,
      connection.token,
      libraryRequestTimeoutSeconds$.getValue()
    );
    for (let i = 0; i < missing.length; i += 100) {
      const { books } = await api.lookup(missing.slice(i, i + 100));
      for (const book of books) out.set(book.id, book.title);
    }
  } catch (error) {
    warn(`Stats: some titles are missing: ${(error as Error)?.message ?? error}`);
  }
  return out;
}
