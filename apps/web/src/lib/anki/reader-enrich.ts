/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { get } from 'svelte/store';
import { database } from '$lib/data/store';
import { LibraryApi } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
import { bookIdForLocalBook } from '$lib/sync/sync-service';
import { AnkiConnect } from './anki-connect';
import { coverFileName, coverJpegBase64 } from './cover';
import { cuesById, findCues, type Cue } from './cue-match';
import {
  describeResult,
  EnrichError,
  enrichLastCard,
  type MediaFile,
  type Unavailable
} from './enrich';
import { parseMapping } from './mapping';
import { readerLinkPath, titleTag } from './reader-link';
import type { LookupSentence } from './lookup-capture';
import {
  ankiAudioMatchThreshold$,
  ankiAudioMaxSeconds$,
  ankiConnectKey$,
  ankiConnectTimeoutSeconds$,
  ankiConnectUrl$,
  ankiFieldMapping$,
  ankiLookBackDays$,
  ankiTagPrefix$
} from './settings';
import { cuesFromFile, cuesFromSaved, type Padding, type SavedSubtitle } from './subtitle-cues';

/**
 * WP14: "Enrich last card" from the reader. Loaded on first use. Everything that can fail
 * is caught here and comes back as a message for the reader's banner; reading is never
 * touched.
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

function timeoutSeconds(): number {
  return Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
}

async function libraryApi(): Promise<LibraryApi | null> {
  const connection = await getLibraryStore().getConnection();
  return connection
    ? new LibraryApi(connection.serverUrl, connection.token, timeoutSeconds())
    : null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

async function whispersyncPadding(): Promise<Padding> {
  try {
    const { settings$ } = await import('$lib/whispersync/lib/stores');
    return {
      startMs: Number(get(settings$.subtitlesGlobalStartPadding$)) || 0,
      endMs: Number(get(settings$.subtitlesGlobalEndPadding$)) || 0
    };
  } catch {
    return { startMs: 0, endMs: 0 };
  }
}

/** whispersync's loaded lines, else its saved lines, else the linked subtitle file. */
async function loadCues(
  api: LibraryApi,
  bookId: string,
  localTitle: string,
  subtitleLinked: boolean
): Promise<Cue[]> {
  try {
    const { currentSubtitles$ } = await import('$lib/whispersync/lib/stores');
    const loaded = get(currentSubtitles$);

    if (loaded?.size) {
      return [...loaded.values()].map((s) => ({
        id: String(s.id),
        start: s.startSeconds,
        end: s.endSeconds,
        text: s.text
      }));
    }
  } catch {
    // whispersync not loaded: try its saved lines.
  }

  const padding = await whispersyncPadding();

  try {
    const saved = (await database.getSubtitleData(localTitle)) as
      | { subtitleData?: { subtitles?: SavedSubtitle[] }; subtitles?: SavedSubtitle[] }
      | undefined;
    const rows = saved?.subtitleData?.subtitles ?? saved?.subtitles;

    if (rows?.length) return cuesFromSaved(rows, padding);
  } catch {
    // No saved lines.
  }

  if (!subtitleLinked) return [];

  const file = await api.linkedSubtitleFile(bookId);

  return file ? cuesFromFile(file.name, await file.text(), padding) : [];
}

async function sentenceAudio(
  api: LibraryApi | null,
  bookId: string | null,
  ctx: ReaderEnrichContext,
  sentence: LookupSentence
): Promise<MediaFile | Unavailable> {
  if (!api || !bookId) {
    return { skip: 'the book is not in the library' };
  }

  const link = await api.audioLink(bookId);

  if (!link || link.state !== 'linked') {
    return { skip: 'the book has no linked audiobook' };
  }

  if (!link.playable) {
    return { skip: "the linked audiobook can't play (several files, missing or changed)" };
  }

  const subtitleLinked = link.subtitleState === 'linked' && link.subtitleStatus === 'ok';
  const cues = await loadCues(api, bookId, ctx.localTitle, subtitleLinked);

  if (!cues.length) {
    return { skip: 'the audiobook has no subtitles' };
  }

  const duration = link.file?.durationSeconds ?? null;
  const expectedSeconds =
    duration && ctx.bookCharacters > 0 ? (sentence.position / ctx.bookCharacters) * duration : null;
  const match =
    cuesById(cues, sentence.cueIds) ??
    findCues(cues, sentence.text, {
      expectedSeconds,
      threshold: Math.min(1, Math.max(0, Number(ankiAudioMatchThreshold$.getValue()) || 0.6))
    });

  if (!match) {
    return { skip: "the sentence wasn't found in the subtitles" };
  }

  const max = Math.max(1, Number(ankiAudioMaxSeconds$.getValue()) || 30);

  if (match.end - match.start > max) {
    return { skip: `it would be longer than ${max} seconds` };
  }

  const start = Math.max(0, match.start);
  const end = match.end;
  const key = bookId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);

  return {
    fileName: `ttsu-${key}-${Math.round(start * 1000)}-${Math.round(end * 1000)}.mp3`,
    load: async () =>
      arrayBufferToBase64(await api.audioClip(bookId, start, end, { timeoutSeconds: 0 }))
  };
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
    const book = await api.book(bookId);
    const thumbnail = (book as { thumbnail?: string | null }).thumbnail;

    if (thumbnail) {
      const response = await fetch(api.absolute(thumbnail));
      if (response.ok) return await response.blob();
    }
  }

  return null;
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
      mapping: parseMapping(ankiFieldMapping$.getValue()),
      titleTag
    });

    return { ok: true, message: describeResult(result), unmapped: result.unmapped };
  } catch (error) {
    const message =
      error instanceof EnrichError
        ? error.message
        : `Could not enrich the card: ${(error as Error)?.message ?? error}`;
    return { ok: false, message };
  }
}
