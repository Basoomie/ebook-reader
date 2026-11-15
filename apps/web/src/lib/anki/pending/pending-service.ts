/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { LibraryApi, LibraryApiError } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { AnkiConnect } from '../anki-connect';
import { ankiConnectKey$, ankiConnectTimeoutSeconds$, ankiConnectUrl$ } from '../settings';
import { newPendingId, type PendingClip } from './pending-clip';
import { getPendingStore } from './pending-db';
import { RetryLater, runPendingOnce, type MadeClip, type RunReport } from './pending-runner';

/**
 * Season 2 §3: tries this device's waiting sentence-audio clips again. No timer of its own:
 * at app start, after every sync cycle that reached the server (so whenever the connection
 * returns, the app comes to the front, the periodic sync runs or "Sync now" is tapped),
 * on the browser's `online` and coming-to-the-front events (also when sync is off), after
 * each Enrich tap and on "Try now". Loaded separately from the rest of the app; every
 * failure is caught (reading is never touched).
 */

const SERVER_UNREACHABLE = "the library server can't be reached";
const NOT_CONNECTED = 'this device is not connected to a library server';
const SUBTITLES_GONE = "the book's subtitles are no longer on this device";

const tabId = newPendingId(Date.now());

function warn(message: string): void {
  console.warn(`Anki: ${message}`);
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

async function libraryApi(): Promise<LibraryApi | null> {
  const connection = await getLibraryStore().getConnection();
  const timeout = Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
  return connection ? new LibraryApi(connection.serverUrl, connection.token, timeout) : null;
}

/** A server problem that passes (waits), or a final answer (the clip can't be made). */
function serverProblem(error: unknown): RetryLater | { skip: string } {
  if (error instanceof LibraryApiError) {
    if (error.kind === 'unreachable' || error.kind === 'timeout' || error.kind === 'aborted') {
      return new RetryLater(SERVER_UNREACHABLE, true);
    }

    if (error.kind === 'unauthorized') {
      return new RetryLater(
        'the library server refused this device (Settings > Data: connect again)',
        true
      );
    }

    const status = error.status ?? 0;

    if (status === 429 || status >= 500) {
      return new RetryLater(`the library server is busy (${error.message})`);
    }

    return { skip: error.message };
  }

  return new RetryLater((error as Error)?.message ?? String(error));
}

async function onThisDevice(localId: number): Promise<boolean> {
  try {
    const { database } = await import('$lib/data/store');
    return (await (await database.db).getKey('data', localId)) !== undefined;
  } catch {
    return true;
  }
}

/** The library source: the same lines and cut as an Enrich tap (library-clip.ts). */
async function resolveClip(clip: PendingClip): Promise<MadeClip> {
  if (!browserOnline()) throw new RetryLater(SERVER_UNREACHABLE, true);

  const api = await libraryApi();
  if (!api) throw new RetryLater(NOT_CONNECTED, true);

  const [{ planLibraryClip, cutLibraryClip }, { isOpenInReader }] = await Promise.all([
    import('../library-clip'),
    import('$lib/library/offline/open-in-reader')
  ]);

  try {
    const plan = await planLibraryClip(api, {
      bookId: clip.bookId,
      localId: clip.localId,
      localTitle: clip.localTitle,
      text: clip.source.text,
      position: clip.source.position,
      cueIds: clip.source.cueIds,
      bookCharacters: clip.source.bookCharacters,
      useLoadedLines: isOpenInReader(clip.localId)
    });

    if ('skip' in plan) {
      if (plan.skip === 'the audiobook has no subtitles' && !(await onThisDevice(clip.localId))) {
        return { skip: SUBTITLES_GONE };
      }
      return plan;
    }

    return { fileName: plan.fileName, data: await cutLibraryClip(api, clip.bookId, plan) };
  } catch (error) {
    const problem = serverProblem(error);
    if (problem instanceof RetryLater) throw problem;
    return problem;
  }
}

function ankiClient(): AnkiConnect {
  return new AnkiConnect({
    url: ankiConnectUrl$.getValue(),
    key: ankiConnectKey$.getValue(),
    timeoutSeconds: Number(ankiConnectTimeoutSeconds$.getValue()) || 10
  });
}

let running: Promise<RunReport | null> | null = null;
let rerun = false;

async function runOnce(): Promise<RunReport | null> {
  try {
    const store = getPendingStore();
    const clips = await store.all();
    if (!clips.some((c) => c.state !== 'failed')) return null;

    return await runPendingOnce({ store, resolve: resolveClip, anki: ankiClient, tabId });
  } catch (error) {
    warn(`waiting sentence audio: ${(error as Error)?.message ?? error}`);
    return null;
  }
}

/** Tries the waiting clips now (or right after the pass that is running). Never rejects. */
export function runPendingClipsSoon(): Promise<RunReport | null> {
  if (!browser) return Promise.resolve(null);

  if (running) {
    rerun = true;
    return running;
  }

  running = runOnce().finally(() => {
    running = null;
    if (rerun) {
      rerun = false;
      void runPendingClipsSoon();
    }
  });

  return running;
}

let started = false;

/** Starts the triggers for this tab (root layout). Never throws. */
export function startPendingClips(): void {
  if (!browser || started) return;
  started = true;

  try {
    window.addEventListener('online', () => void runPendingClipsSoon());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void runPendingClipsSoon();
    });

    void import('$lib/sync/sync-service')
      .then(({ getSyncRunner }) => {
        let lastSyncAt: number | null | undefined;

        getSyncRunner()?.status$.subscribe((status) => {
          // A cycle that reached the server: it answers again.
          if (status.state === 'idle' && status.lastSyncAt && status.lastSyncAt !== lastSyncAt) {
            const first = lastSyncAt === undefined;
            lastSyncAt = status.lastSyncAt;
            if (!first) void runPendingClipsSoon();
          }
        });
      })
      .catch((error) => warn(`waiting sentence audio not tied to sync: ${error}`));

    void runPendingClipsSoon();
  } catch (error) {
    warn(`waiting sentence audio not started: ${(error as Error)?.message ?? error}`);
  }
}

// ---- Settings > Anki ----------------------------------------------------------------

/** This device's waiting and failed clips, oldest first. */
export async function listPendingClips(): Promise<PendingClip[]> {
  const clips = await getPendingStore().all();
  return clips.sort((a, b) => a.createdAt - b.createdAt);
}

/** Cancel (a waiting one) or Dismiss (a failed one). */
export async function removePendingClip(id: string): Promise<void> {
  await getPendingStore().delete(id);
}

export function onPendingClipsChange(listener: () => void): () => void {
  return getPendingStore().onChange(listener);
}
