/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { logger } from '$lib/data/logger';
import { canUseWebLocks } from '$lib/functions/secure-context';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import {
  findPositionPrompt,
  markPositionPromptHandled,
  onPositionsChanged,
  promptBookId,
  type PositionPromptDeps
} from '$lib/sync/position-prompt-service';
import type { PromptApi } from '$lib/sync/reader-position-prompt';
import { recordPosition, type BookmarkLike } from '$lib/sync/record-position';
import { applyGlobalSettingValue } from '$lib/sync/settings-apply';
import {
  positionPromptEnabled$,
  positionPromptMinChars$,
  recordSyncEnabled$,
  syncDebounceSeconds$,
  syncIntervalMinutes$
} from '$lib/sync/settings';
import { applyGlobalSettings, publishSettings } from '$lib/sync/settings-sync';
import { SyncApi } from '$lib/sync/sync-api';
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
      await publishSettings(engine, window.localStorage);
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
      .then((engine) =>
        engine.onRemoteChange((records) => {
          void applyGlobalSettings(engine, records, applyGlobalSettingValue).catch((error) =>
            warn(`Sync: applying settings failed: ${(error as Error)?.message ?? error}`)
          );
        })
      )
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
      warn
    });
  } catch (error) {
    warn(`Sync: could not record the position: ${(error as Error)?.message ?? error}`);
  }
}

const promptDeps: PositionPromptDeps = {
  getEngine: getSyncEngine,
  linksForLocalId: (id) => getLibraryStore().getLinksForLocalId(id),
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
