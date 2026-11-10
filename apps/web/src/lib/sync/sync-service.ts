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
import { canUseWebLocks } from '$lib/functions/secure-context';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { MigrationApi } from '$lib/migration/api';
import { localBookmarkForTitle, localTitleSummaries } from '$lib/migration/local-summary';
import { applyReadingGoals, applyStatDays } from '$lib/sync/apply-records';
import type { BookBlur, BookStatus, ReadThrough } from '$lib/sync/book-state';
import {
  editReadThroughFinish,
  getAllBookStates,
  getBookState,
  markBooksCompleted,
  noteFirstPageTurn,
  noteReaderCompletion,
  onBookStatesChanged,
  pendingStartOver,
  removeReadThrough,
  setBookBlur,
  setBookFavorite,
  setBookStatus,
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

/**
 * The app's record sync (WP4): one engine and one background runner per tab.
 * Everything here is best effort: failures are logged and shown in the
 * Library page's Connection panel, never raised into the reader.
 */

const warn = (message: string) => logger.warn(message);

let enginePromise: Promise<SyncEngine> | null = null;

export function getSyncEngine(): Promise<SyncEngine> {
  if (!enginePromise) {
    enginePromise = SyncEngine.open({ warn });
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
    calibreLinks: links.map((l) => ({
      title: l.title,
      bookId: l.bookId,
      calibreUuid: l.calibreUuid
    })),
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

/** The reader's Complete Book. Fire and forget. */
export function noteReaderBookCompleted(localId: number, title: string): void {
  void bookIdForLocalBook(localId, title).then((bookId) =>
    bookId ? noteReaderCompletion(bookId, bookStateDeps) : undefined
  );
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
