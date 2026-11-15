/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { get } from 'svelte/store';
import { database } from '$lib/data/store';
import type { LibraryApi } from '$lib/library/api';
import { cuesById, findCues, type Cue } from './cue-match';
import type { Unavailable } from './enrich';
import { ankiAudioMatchThreshold$, ankiAudioMaxSeconds$ } from './settings';
import { cuesFromFile, cuesFromSaved, type Padding, type SavedSubtitle } from './subtitle-cues';

/**
 * WP14 sentence audio from the book's linked audiobook, cut on the server. Used by an
 * Enrich tap and, for a clip that waited (Season 2 §3), by the later retry, so both find
 * the same lines and cut the same clip.
 */

export interface LibraryClipRequest {
  bookId: string;
  localId: number;
  /** The book's own title (the key of whispersync's saved lines). */
  localTitle: string;
  text: string;
  position: number;
  cueIds: string[];
  bookCharacters: number;
  /**
   * whispersync's loaded lines belong to this book (the reader has it open). Otherwise its
   * saved lines are used, then the server's subtitle file.
   */
  useLoadedLines: boolean;
}

export interface LibraryClipPlan {
  fileName: string;
  start: number;
  end: number;
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
  request: LibraryClipRequest,
  subtitleLinked: boolean
): Promise<Cue[]> {
  if (request.useLoadedLines) {
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
  }

  const padding = await whispersyncPadding();

  try {
    const saved = (await database.getSubtitleData(request.localTitle)) as
      | { subtitleData?: { subtitles?: SavedSubtitle[] }; subtitles?: SavedSubtitle[] }
      | undefined;
    const rows = saved?.subtitleData?.subtitles ?? saved?.subtitles;

    if (rows?.length) return cuesFromSaved(rows, padding);
  } catch {
    // No saved lines.
  }

  if (!subtitleLinked) return [];

  const file = await api.linkedSubtitleFile(request.bookId);

  return file ? cuesFromFile(file.name, await file.text(), padding) : [];
}

/**
 * Which part of the audiobook is the sentence, or why there is none. Rejects with the
 * server's error when it can't be asked (the caller decides whether the clip waits).
 */
export async function planLibraryClip(
  api: LibraryApi,
  request: LibraryClipRequest
): Promise<LibraryClipPlan | Unavailable> {
  const { bookId } = request;
  const link = await api.audioLink(bookId);

  if (!link || link.state !== 'linked') {
    return { skip: 'the book has no linked audiobook' };
  }

  if (!link.playable) {
    return { skip: "the linked audiobook can't play (several files, missing or changed)" };
  }

  const subtitleLinked = link.subtitleState === 'linked' && link.subtitleStatus === 'ok';
  const cues = await loadCues(api, request, subtitleLinked);

  if (!cues.length) {
    return { skip: 'the audiobook has no subtitles' };
  }

  const duration = link.file?.durationSeconds ?? null;
  const expectedSeconds =
    duration && request.bookCharacters > 0
      ? (request.position / request.bookCharacters) * duration
      : null;
  const match =
    cuesById(cues, request.cueIds) ??
    findCues(cues, request.text, {
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
    start,
    end
  };
}

/** The clip's MP3 (no time limit, as WP14). */
export function cutLibraryClip(
  api: LibraryApi,
  bookId: string,
  plan: LibraryClipPlan
): Promise<ArrayBuffer> {
  return api.audioClip(bookId, plan.start, plan.end, { timeoutSeconds: 0 });
}
