/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { timeAgo } from '$lib/audio/audio-link';
import type { SentenceClip, SentencePc } from '$lib/audio/tts-types';
import { LibraryApiError, type LibraryApi } from '$lib/library/api';
import type { LibraryClipSource, PcClipSource, PendingClip } from './pending-clip';
import { RetryLater, type MadeClip } from './pending-runner';

/**
 * Season 2 Phase 12: a waiting clip the PC reads (a book without an audiobook; decided with
 * the user, 2026-11-14/15). The server is asked once to queue it (the record then keeps the
 * server's clip id), then asked how it is doing at every retry (no timer of its own); a
 * finished clip is fetched, and the server lets it go once its bytes are kept here (the
 * runner's `onReady`). Writing it into the card is the waiting clip's own step (Phase 8).
 */

export const WAITING_FOR_PC = 'Waiting for the PC';

/** "it would be longer than N seconds", as for a clip of an audiobook. */
export const tooLong = (max: number) => `it would be longer than ${max} seconds`;

/** The media file's name in Anki: the book and the server's clip (never reused). */
export function pcClipFileName(bookId: string, clipId: string): string {
  const key = bookId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return `ttsu-${key}-tts-${clipId.slice(0, 12)}.mp3`;
}

/** Why a clip still waits, from what the server last heard from the PC ("Last try: …"). */
export function pcWaitText(clip: Pick<SentenceClip, 'state'>, pc: SentencePc, now: number): string {
  if (clip.state === 'running') return 'the PC is reading it';
  if (pc.paused) return 'the PC is paused (Settings > Audiobooks)';
  if (!pc.online) {
    return pc.lastSeenAt
      ? `the PC is off (last seen ${timeAgo(pc.lastSeenAt, now)})`
      : "the program on the PC hasn't checked in yet";
  }
  if (pc.problem) return `the PC can't read it now: ${pc.problem.replace(/\.$/, '')}`;
  if (pc.readsClips === false) {
    return "the PC's program can't read sentence audio yet: update it (install-local) and start it again";
  }
  if (pc.ahead) {
    const book = pc.ahead.bookTitle ? `「${pc.ahead.bookTitle}」` : 'a book';
    if (pc.ahead.makesWay) return `queued: the PC finishes a chapter of ${book}'s audiobook first`;
    if (pc.ahead.kind === 'sync_subtitles')
      return `queued: the PC makes subtitles for ${book} first`;
    return 'queued: the PC finishes another job first';
  }
  return 'queued on the PC';
}

export interface PcSourceDeps {
  api: Pick<
    LibraryApi,
    'queueSentenceAudio' | 'sentenceAudioStatus' | 'sentenceAudioFile' | 'dropSentenceAudio'
  >;
  /** Changes the record's source (the clip id, or back to the audiobook). */
  saveSource: (source: PcClipSource | LibraryClipSource) => Promise<void>;
  now?: () => number;
}

/** What the record turns into when the book got an audiobook meanwhile. */
export interface UseLibrary {
  library: LibraryClipSource;
}

/**
 * Whether the PC reads this book's sentences: a voice is chosen for it or for every book.
 * null: the server can't (an older one, or PC voices not set up there). No answer is thrown.
 */
export async function pcVoiceChosen(
  api: Pick<LibraryApi, 'bookVoiceChoice'>,
  bookId: string
): Promise<boolean | null> {
  try {
    return !!(await api.bookVoiceChoice(bookId)).effective;
  } catch (error) {
    if (error instanceof LibraryApiError && (error.status === 404 || error.status === 503)) {
      return null;
    }
    throw error;
  }
}

/** The banner's reason when the PC could read the sentence but no voice is chosen. */
export const CHOOSE_PC_VOICE =
  'the book has no linked audiobook (to have the PC read it, choose a voice in Settings > Anki)';

const apiCode = (error: unknown) => (error instanceof LibraryApiError ? error.code : undefined);

/**
 * Asks the server about a PC clip: made (its bytes), can't be made (skip), or still waiting
 * (RetryLater, with what it waits for). A book that has an audiobook now gets its clip from
 * it (`library`). Server errors not handled here are thrown as they are.
 */
export async function resolvePcClip(
  clip: PendingClip & { source: PcClipSource },
  deps: PcSourceDeps,
  again = false
): Promise<MadeClip | UseLibrary> {
  const now = deps.now ?? Date.now;
  let source = clip.source;

  if (!source.clipId) {
    let queued: SentenceClip;

    try {
      queued = await deps.api.queueSentenceAudio(clip.bookId, {
        text: source.text,
        position: source.position,
        pauses: source.pauses
      });
    } catch (error) {
      const code = apiCode(error);
      if (code === 'has_audiobook') {
        const library: LibraryClipSource = {
          kind: 'library',
          text: source.text,
          position: source.position,
          cueIds: [],
          bookCharacters: source.bookCharacters
        };
        await deps.saveSource(library);
        return { library };
      }
      // Switched off or the chosen voice is gone: it waits until that is put right.
      if (code === 'voice_choice_off' || code === 'bad_choice') {
        throw new RetryLater((error as Error).message, false, WAITING_FOR_PC);
      }
      throw error;
    }

    source = { ...source, clipId: queued.id };
    await deps.saveSource(source);
  }

  let status: { clip: SentenceClip; pc: SentencePc };

  try {
    status = await deps.api.sentenceAudioStatus(source.clipId!);
  } catch (error) {
    if (gone(error)) return askAgain(clip, source, deps, again);
    throw error;
  }

  const made = status.clip;

  if (made.state === 'queued' || made.state === 'running') {
    throw new RetryLater(pcWaitText(made, status.pc, now()), false, WAITING_FOR_PC);
  }

  if (made.state === 'failed') return { skip: made.error ?? 'the PC could not read it' };
  if (made.state === 'cancelled') return { skip: 'it was cancelled' };

  if ((made.durationMs ?? 0) > source.maxSeconds * 1000) {
    await deps.api.dropSentenceAudio(made.id).catch(() => undefined);
    return { skip: tooLong(source.maxSeconds) };
  }

  let data: ArrayBuffer;

  try {
    data = await deps.api.sentenceAudioFile(made.id);
  } catch (error) {
    if (gone(error)) return askAgain(clip, source, deps, again);
    throw error;
  }

  return { fileName: pcClipFileName(clip.bookId, made.id), data };
}

const gone = (error: unknown) => error instanceof LibraryApiError && error.status === 404;

/** Forgotten on the server (kept too long): asked for again, once per try. */
async function askAgain(
  clip: PendingClip & { source: PcClipSource },
  source: PcClipSource,
  deps: PcSourceDeps,
  again: boolean
): Promise<MadeClip | UseLibrary> {
  const { clipId: _gone, ...rest } = source;
  await deps.saveSource(rest);
  if (again) throw new RetryLater('the server no longer had the clip', false, WAITING_FOR_PC);
  return resolvePcClip({ ...clip, source: rest }, deps, true);
}
