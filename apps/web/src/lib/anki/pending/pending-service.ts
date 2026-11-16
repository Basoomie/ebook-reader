/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { LibraryApi, LibraryApiError } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { currentPauses } from '$lib/audio/tts-settings';
import { AnkiConnect } from '../anki-connect';
import {
  ankiAudioMaxSeconds$,
  ankiConnectKey$,
  ankiConnectTimeoutSeconds$,
  ankiConnectUrl$
} from '../settings';
import { pcVoiceChosen, resolvePcClip } from './pc-source';
import {
  newPendingId,
  type ClipSource,
  type LibraryClipSource,
  type PcClipSource,
  type PendingClip
} from './pending-clip';
import { getPendingStore } from './pending-db';
import { RetryLater, runPendingOnce, type MadeClip, type RunReport } from './pending-runner';

/**
 * Season 2 §3: tries this device's waiting sentence-audio clips again. No timer of its own:
 * at app start, after every sync cycle that reached the server (so whenever the connection
 * returns, the app comes to the front, the periodic sync runs or "Sync now" is tapped),
 * on the browser's `online` and coming-to-the-front events (also when sync is off), after
 * each Enrich tap and on "Try now". Loaded separately from the rest of the app; every
 * failure is caught (reading is never touched).
 *
 * Season 2 Phase 12: a clip the PC reads (a book without an audiobook) is asked for and
 * checked on at the same moments (pc-source.ts); no timer of its own either.
 */

const SERVER_UNREACHABLE = "the library server can't be reached";
const NOT_CONNECTED = 'this device is not connected to a library server';
const SUBTITLES_GONE = "the book's subtitles are no longer on this device";
const WAITING_FOR_SERVER = 'Waiting for the library server';

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
      return new RetryLater(SERVER_UNREACHABLE, true, WAITING_FOR_SERVER);
    }

    if (error.kind === 'unauthorized') {
      return new RetryLater(
        'the library server refused this device (Settings > Data: connect again)',
        true,
        WAITING_FOR_SERVER
      );
    }

    const status = error.status ?? 0;

    if (status === 429 || status >= 500) {
      return new RetryLater(
        `the library server is busy (${error.message})`,
        false,
        WAITING_FOR_SERVER
      );
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
async function resolveLibraryClip(
  api: LibraryApi,
  clip: PendingClip,
  source: LibraryClipSource
): Promise<MadeClip> {
  const [{ planLibraryClip, cutLibraryClip }, { isOpenInReader }] = await Promise.all([
    import('../library-clip'),
    import('$lib/library/offline/open-in-reader')
  ]);
  const plan = await planLibraryClip(api, {
    bookId: clip.bookId,
    localId: clip.localId,
    localTitle: clip.localTitle,
    text: source.text,
    position: source.position,
    cueIds: source.cueIds,
    bookCharacters: source.bookCharacters,
    useLoadedLines: isOpenInReader(clip.localId)
  });

  if ('skip' in plan) {
    if (plan.skip === 'the audiobook has no subtitles' && !(await onThisDevice(clip.localId))) {
      return { skip: SUBTITLES_GONE };
    }
    return plan;
  }

  return { fileName: plan.fileName, data: await cutLibraryClip(api, clip.bookId, plan) };
}

async function saveSource(id: string, source: ClipSource): Promise<void> {
  await getPendingStore().update(id, (r) => ({ ...r, source }));
}

/** The PC source (Season 2 Phase 12): read on the PC for a book without an audiobook. */
async function resolveOnPc(
  api: LibraryApi,
  clip: PendingClip,
  source: PcClipSource
): Promise<MadeClip> {
  const made = await resolvePcClip(
    { ...clip, source },
    { api, saveSource: (s) => saveSource(clip.id, s) }
  );
  // The book has an audiobook now: its clip comes from it.
  if ('library' in made) return resolveLibraryClip(api, clip, made.library);
  return made;
}

/**
 * Makes a waiting clip from its source. A clip that waited for the library server (an
 * offline tap) for a book that turns out to have no audiobook is read by the PC instead,
 * when a PC voice is chosen (Season 2 Phase 12).
 */
export async function resolveClip(clip: PendingClip): Promise<MadeClip> {
  if (!browserOnline()) throw new RetryLater(SERVER_UNREACHABLE, true, WAITING_FOR_SERVER);

  const api = await libraryApi();
  if (!api) throw new RetryLater(NOT_CONNECTED, true, WAITING_FOR_SERVER);

  try {
    const source = clip.source;

    if (source.kind === 'pc') return await resolveOnPc(api, clip, source);

    const made = await resolveLibraryClip(api, clip, source);
    const { NO_LINKED_AUDIOBOOK } = await import('../library-clip');

    if (
      'skip' in made &&
      made.skip === NO_LINKED_AUDIOBOOK &&
      (await pcVoiceChosen(api, clip.bookId)) === true
    ) {
      const pc: PcClipSource = {
        kind: 'pc',
        text: source.text,
        position: source.position,
        bookCharacters: source.bookCharacters,
        maxSeconds: Math.max(1, Number(ankiAudioMaxSeconds$.getValue()) || 30),
        pauses: currentPauses()
      };
      await saveSource(clip.id, pc);
      return await resolveOnPc(api, clip, pc);
    }

    return made;
  } catch (error) {
    if (error instanceof RetryLater) throw error;
    const problem = serverProblem(error);
    if (problem instanceof RetryLater) throw problem;
    return problem;
  }
}

/** The server may let go of a PC clip (its bytes are kept here now, or it was cancelled). */
async function dropOnServer(clip: PendingClip | undefined): Promise<void> {
  if (!clip || clip.source.kind !== 'pc' || !clip.source.clipId) return;
  try {
    const api = await libraryApi();
    await api?.dropSentenceAudio(clip.source.clipId);
  } catch (error) {
    // The server forgets it by itself after TTS_CLIP_KEEP_DAYS.
    warn(`sentence audio not let go on the server: ${(error as Error)?.message ?? error}`);
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

    return await runPendingOnce({
      store,
      resolve: resolveClip,
      anki: ankiClient,
      tabId,
      onReady: dropOnServer
    });
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

/** Cancel (a waiting one) or Dismiss (a failed one). A PC clip is let go on the server too. */
export async function removePendingClip(id: string): Promise<void> {
  const store = getPendingStore();
  const clip = await store.get(id).catch(() => undefined);
  await store.delete(id);
  void dropOnServer(clip);
}

export function onPendingClipsChange(listener: () => void): () => void {
  return getPendingStore().onChange(listener);
}
