/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { browser } from '$app/environment';
import { LibraryApi, LibraryApiError } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { bookIdForLocalBook } from '$lib/sync/sync-service';
import { AnkiConnect } from './anki-connect';
import { coverFileName, coverJpegBase64 } from './cover';
import {
  describeResult,
  EnrichError,
  enrichLastCard,
  WaitError,
  type EnrichResult,
  type MediaFile,
  type Unavailable,
  type Waiting
} from './enrich';
import { arrayBufferToBase64 } from './base64';
import { cutLibraryClip, planLibraryClip, type LibraryClipRequest } from './library-clip';
import { parseMapping } from './mapping';
import { readerLinkPath, titleTag } from './reader-link';
import type { LookupSentence } from './lookup-capture';
import {
  ankiConnectKey$,
  ankiConnectTimeoutSeconds$,
  ankiConnectUrl$,
  ankiFieldMapping$,
  ankiLookBackDays$,
  ankiTagPrefix$
} from './settings';

/**
 * WP14: "Enrich last card" from the reader. Loaded on first use. Everything that can fail
 * is caught here and comes back as a message for the reader's banner; reading is never
 * touched.
 *
 * Enrich while offline (Season 2 §3): when the library server can't be reached (or doesn't
 * answer in time), the sentence audio waits on this device and is added to the card later
 * (`pending/`); everything else is added now. If it can't be kept, it is left out with the
 * reason.
 */

export interface ReaderEnrichContext {
  localId: number;
  /** The book's own title (the key of whispersync's rows). */
  localTitle: string;
  coverImage: Blob | string | undefined;
  /** The sentence: the last lookup, else the current selection, else null. */
  sentence: LookupSentence | null;
  /** Where the reader is (for the link when there is no sentence). */
  readingPosition: number;
  bookCharacters: number;
}

export interface ReaderEnrichOutcome {
  ok: boolean;
  message: string;
  /** The note type has no fields set up. */
  unmapped?: boolean;
}

/** "Sentence audio will be added …" */
export const WAIT_FOR_SERVER = 'when the library server can be reached';
export const NOT_KEPT = "the library server can't be reached, and it couldn't be kept for later";
const SERVER_UNREACHABLE = "the library server can't be reached";

function timeoutSeconds(): number {
  return Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
}

async function libraryApi(): Promise<LibraryApi | null> {
  const connection = await getLibraryStore().getConnection();
  return connection
    ? new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds())
    : null;
}

/** The server gave no answer (offline, down, or too slow): the clip can wait. */
export function serverUnreachable(error: unknown): boolean {
  return (
    error instanceof LibraryApiError && (error.kind === 'unreachable' || error.kind === 'timeout')
  );
}

/** False when the browser knows it has no network (then there is no point in asking). */
function browserOnline(): boolean {
  return !browser || typeof navigator === 'undefined' || navigator.onLine !== false;
}

async function sentenceAudio(
  api: LibraryApi | null,
  bookId: string | null,
  ctx: ReaderEnrichContext,
  sentence: LookupSentence
): Promise<MediaFile | Unavailable | Waiting> {
  if (!api || !bookId) {
    return { skip: 'the book is not in the library' };
  }

  if (!browserOnline()) {
    return { wait: WAIT_FOR_SERVER };
  }

  const request: LibraryClipRequest = {
    bookId,
    localId: ctx.localId,
    localTitle: ctx.localTitle,
    text: sentence.text,
    position: sentence.position,
    cueIds: sentence.cueIds ?? [],
    bookCharacters: ctx.bookCharacters,
    useLoadedLines: true
  };
  let plan: Awaited<ReturnType<typeof planLibraryClip>>;

  try {
    plan = await planLibraryClip(api, request);
  } catch (error) {
    if (serverUnreachable(error)) return { wait: WAIT_FOR_SERVER };
    throw error;
  }

  if ('skip' in plan) return plan;

  const clip = plan;

  return {
    fileName: clip.fileName,
    load: async () => {
      try {
        return arrayBufferToBase64(await cutLibraryClip(api, bookId, clip));
      } catch (error) {
        if (serverUnreachable(error)) throw new WaitError(WAIT_FOR_SERVER);
        throw error;
      }
    }
  };
}

/** The cover the offline Library keeps for the book (Season 2 §2), or null. */
async function offlineCover(bookId: string): Promise<Blob | null> {
  try {
    const { getOfflineStore } = await import('$lib/library/offline/offline-db');
    const copy = await getOfflineStore().get(bookId);
    return copy?.thumbnail && copy.thumbnail.size ? copy.thumbnail : null;
  } catch {
    return null;
  }
}

async function coverBlob(
  api: LibraryApi | null,
  bookId: string | null,
  coverImage: Blob | string | undefined
): Promise<Blob | null> {
  if (coverImage instanceof Blob && coverImage.size) return coverImage;

  if (typeof coverImage === 'string' && coverImage) {
    try {
      const response = await fetch(coverImage);
      if (response.ok) return await response.blob();
    } catch {
      // Fall back to the server's thumbnail.
    }
  }

  if (api && bookId) {
    try {
      if (!browserOnline()) {
        throw new LibraryApiError('unreachable', SERVER_UNREACHABLE);
      }

      const book = await api.book(bookId);
      const thumbnail = (book as { thumbnail?: string | null }).thumbnail;

      if (thumbnail) {
        const response = await fetch(api.absolute(thumbnail));
        if (response.ok) return await response.blob();
      }
    } catch (error) {
      if (!serverUnreachable(error)) throw error;

      const copy = await offlineCover(bookId);
      if (copy) return copy;
      throw new Error(SERVER_UNREACHABLE);
    }
  }

  return null;
}

/**
 * Keeps the waiting clip on this device. A newer tap whose sentence audio overwrites drops
 * the card's older waiting clips first. False when it couldn't be kept.
 */
async function keepWaitingClip(
  result: EnrichResult,
  ctx: ReaderEnrichContext,
  bookId: string,
  bookTitle: string,
  sentence: LookupSentence
): Promise<boolean> {
  const waiting = result.waiting!;

  try {
    const { getPendingStore } = await import('./pending/pending-db');
    const { newPendingId } = await import('./pending/pending-clip');
    const now = Date.now();
    await getPendingStore().add({
      id: newPendingId(now),
      createdAt: now,
      state: 'waiting',
      noteId: result.noteId,
      noteType: result.noteType,
      word: result.word,
      field: waiting.field,
      mode: waiting.mode,
      fieldAtTap: waiting.fieldAtTap,
      ...(waiting.shared ? { shared: waiting.shared } : {}),
      bookId,
      localId: ctx.localId,
      localTitle: ctx.localTitle,
      bookTitle,
      source: {
        kind: 'library',
        text: sentence.text,
        position: sentence.position,
        cueIds: sentence.cueIds ?? [],
        bookCharacters: ctx.bookCharacters
      }
    });
    return true;
  } catch {
    return false;
  }
}

/** Under Overwrite the newest tap decides the field: older waiting clips for it go. */
async function dropSuperseded(noteId: number, field: string): Promise<void> {
  try {
    const { getPendingStore } = await import('./pending/pending-db');
    const { supersededBy } = await import('./pending/pending-clip');
    const store = getPendingStore();

    for (const clip of supersededBy(await store.all(), noteId, field)) {
      await store.delete(clip.id);
    }
  } catch {
    // Nothing kept, or the store can't be opened: nothing to drop.
  }
}

/** Tries the waiting clips (older ones may go in now). Never rejects. */
function runWaitingClips(): void {
  import('./pending/pending-service')
    .then(({ runPendingClipsSoon }) => runPendingClipsSoon())
    .catch(() => undefined);
}

export async function enrichFromReader(ctx: ReaderEnrichContext): Promise<ReaderEnrichOutcome> {
  try {
    const bookId = await bookIdForLocalBook(ctx.localId, ctx.localTitle).catch(() => null);
    const api = await libraryApi().catch(() => null);
    const libraryLink = bookId
      ? await getLibraryStore()
          .getLink(bookId)
          .catch(() => undefined)
      : undefined;
    const title = libraryLink?.calibreTitle || ctx.localTitle;
    const sentence = ctx.sentence;
    const mapping = parseMapping(ankiFieldMapping$.getValue());
    const anki = new AnkiConnect({
      url: ankiConnectUrl$.getValue(),
      key: ankiConnectKey$.getValue(),
      timeoutSeconds: Number(ankiConnectTimeoutSeconds$.getValue()) || 10
    });

    const result = await enrichLastCard(anki, {
      title,
      tagPrefix: ankiTagPrefix$.getValue(),
      sentence,
      noSentenceReason: 'look up a word or select a sentence first',
      link: bookId
        ? readerLinkPath(bookId, sentence?.position ?? ctx.readingPosition)
        : { skip: 'the book is not in the library' },
      cover: async () => {
        const blob = await coverBlob(api, bookId, ctx.coverImage);

        if (!blob) return { skip: 'the book has no cover' };

        return {
          fileName: coverFileName(bookId ?? `local-${ctx.localId}`),
          load: () => coverJpegBase64(blob)
        };
      },
      audio: (s) => sentenceAudio(api, bookId, ctx, s as LookupSentence),
      days: Math.max(1, Math.round(Number(ankiLookBackDays$.getValue()) || 1)),
      mapping,
      titleTag
    });

    const audioTarget = mapping[result.noteType]?.sentenceAudio;

    if (audioTarget?.mode === 'overwrite') {
      await dropSuperseded(result.noteId, audioTarget.field);
    }

    if (result.waiting) {
      const kept =
        !!bookId && !!sentence && (await keepWaitingClip(result, ctx, bookId, title, sentence));

      if (!kept) {
        delete result.waiting;
        result.skipped.push({ what: 'sentence audio', reason: NOT_KEPT });
      }
    }

    runWaitingClips();

    return { ok: true, message: describeResult(result), unmapped: result.unmapped };
  } catch (error) {
    const message =
      error instanceof EnrichError
        ? error.message
        : `Could not enrich the card: ${(error as Error)?.message ?? error}`;
    return { ok: false, message };
  }
}
