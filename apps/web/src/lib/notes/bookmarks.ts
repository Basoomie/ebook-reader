/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { BookTextIndex } from '$lib/components/book-reader/book-search';
import { randomId } from '$lib/functions/secure-context';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import { ANCHOR_CONTEXT, anchorOfSpan, placeAnchor } from './anchor';
import { bookIdOfRecordId, MAX_CHAPTER_NAME } from './highlights';
import { NotesError, type NotesDeps, type Undo } from './notes-service';

/**
 * WP11b: named bookmarks. Record kind "bookmark", id `<bookId>:<uuid>` (the book is in the
 * id so a deletion marker still names it), lww, deletable; data { pos, text, before, after,
 * name, chapter, createdAt }. A bookmark is a named place, separate from the reading
 * position: making, renaming or using one never saves the place. `text` is the start of
 * the text at `pos`; with its context it finds the place again in a changed copy of the
 * book (per device, never written back), like a highlight.
 */
export const BOOKMARK_KIND = 'bookmark';

export const MAX_BOOKMARK_NAME = 200;

/** Characters of text kept at the bookmark's place. */
const BOOKMARK_TEXT = 20;

/** Longest default name (the first sentence of the page is cut). */
const DEFAULT_NAME_SENTENCE = 40;

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '．', '…']);

export interface BookmarkPlace {
  pos: number;
  text: string;
  before: string;
  after: string;
}

export interface BookmarkItem extends BookmarkPlace {
  id: string;
  bookId: string;
  name: string;
  chapter: string | null;
  createdAt: number;
  updatedAt: number;
}

function str(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function bookmarkFrom(record: LocalRecord): BookmarkItem | undefined {
  if (record.kind !== BOOKMARK_KIND || record.deletedAt !== null || !record.data) {
    return undefined;
  }

  const d = record.data;
  const name = str(d.name).trim();

  if (!name) {
    return undefined;
  }

  return {
    id: record.id,
    bookId: record.bookId ?? bookIdOfRecordId(record.id),
    pos: num(d.pos),
    text: str(d.text),
    before: str(d.before),
    after: str(d.after),
    name,
    chapter: typeof d.chapter === 'string' ? d.chapter : null,
    createdAt: num(d.createdAt, record.updatedAt),
    updatedAt: record.updatedAt
  };
}

/** A book's bookmarks in book order. */
export function bookmarksFrom(records: readonly LocalRecord[], bookId?: string) {
  return records
    .map(bookmarkFrom)
    .filter((b): b is BookmarkItem => !!b && (!bookId || b.bookId === bookId))
    .sort((a, b) => a.pos - b.pos || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

const OPENING = new Set(['「', '『', '（', '(', '【', '〈', '《', '"', '“', '‘']);

/**
 * Where the text at a reader position starts: the first counted character at or after it
 * (the position is shared by the uncounted characters before it, such as the 。 ending the
 * previous paragraph), together with opening brackets just before it in the same paragraph.
 */
function displayAt(index: BookTextIndex, position: number) {
  let lo = 0;
  let hi = index.countBefore.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (index.countBefore[mid] < position) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  const counted = (i: number) =>
    (i + 1 < index.countBefore.length ? index.countBefore[i + 1] : index.total) >
    index.countBefore[i];
  let i = lo;

  while (i < index.display.length && !counted(i)) {
    i += 1;
  }

  if (i >= index.display.length) {
    // Nothing counted after it: the first visible character.
    i = lo;

    while (i < index.display.length && /\s/u.test(index.display[i])) {
      i += 1;
    }

    return i;
  }

  while (i > lo && OPENING.has(index.display[i - 1])) {
    i -= 1;
  }

  return i;
}

/** The place to keep for a bookmark at a reader position (the start of the page). */
export function bookmarkPlaceAt(index: BookTextIndex, position: number): BookmarkPlace {
  const start = displayAt(index, position);
  const anchor = anchorOfSpan(index, {
    displayStart: start,
    displayEnd: Math.min(index.display.length, start + BOOKMARK_TEXT)
  });

  if (!anchor) {
    return { pos: position, text: '', before: '', after: '' };
  }

  return {
    pos: position,
    text: anchor.text,
    before: anchor.before.slice(-ANCHOR_CONTEXT),
    after: anchor.after.slice(0, ANCHOR_CONTEXT)
  };
}

/** A name for a new bookmark: the first sentence of the page, cut if long. */
export function defaultBookmarkName(index: BookTextIndex, position: number) {
  let i = displayAt(index, position);
  let out = '';

  while (i < index.display.length && Array.from(out).length < DEFAULT_NAME_SENTENCE) {
    const ch = index.display[i];

    if (ch === '\n') {
      if (out) break;
    } else {
      out += ch;

      if (SENTENCE_END.has(ch)) break;
    }

    i += 1;
  }

  out = out.trim();
  const cut = i < index.display.length && !SENTENCE_END.has(out[out.length - 1] ?? '');
  return out ? out + (cut && Array.from(out).length >= DEFAULT_NAME_SENTENCE ? '…' : '') : '';
}

/**
 * Where a bookmark sits in this device's copy of a book: its own position when the text
 * is still there, else where the text is found again, else null (kept, flagged).
 */
export function placeBookmark(index: BookTextIndex, item: BookmarkPlace, maxDistance: number) {
  if (!item.text) {
    return Math.min(item.pos, index.total);
  }

  const placed = placeAnchor(
    index,
    { start: item.pos, end: item.pos, text: item.text, before: item.before, after: item.after },
    maxDistance
  );

  if (placed.status === 'unplaced') {
    return null;
  }

  // The kept text starts at the first character after the position; keep the offset.
  const textStart = index.countBefore[displayAt(index, item.pos)] ?? item.pos;
  return placed.status === 'exact' ? item.pos : Math.max(0, placed.start - (textStart - item.pos));
}

function cleanName(name: string) {
  const trimmed = name.trim();

  if (!trimmed) {
    throw new NotesError('A bookmark needs a name.');
  }

  if (Array.from(trimmed).length > MAX_BOOKMARK_NAME) {
    throw new NotesError(`A bookmark name can be at most ${MAX_BOOKMARK_NAME} characters.`);
  }

  return trimmed;
}

function bookmarkData(item: Omit<BookmarkItem, 'id' | 'bookId' | 'updatedAt'>) {
  return {
    pos: item.pos,
    text: item.text,
    before: item.before,
    after: item.after,
    name: item.name,
    chapter: item.chapter,
    createdAt: item.createdAt
  };
}

async function putOrThrow(engine: SyncEngine, id: string, data: object, bookId: string) {
  if (!(await engine.put(BOOKMARK_KIND, id, data as Record<string, unknown>, { bookId }))) {
    throw new NotesError('Could not save the bookmark.');
  }
}

export async function getBookmarks(bookId: string, deps: NotesDeps) {
  const engine = await deps.getEngine();
  return bookmarksFrom(await engine.getForBook(bookId), bookId);
}

export async function addBookmark(
  bookId: string,
  place: BookmarkPlace,
  name: string,
  chapter: string | null | undefined,
  deps: NotesDeps
): Promise<BookmarkItem> {
  const engine = await deps.getEngine();
  const id = `${bookId}:${(deps.newId ?? randomId)()}`;
  const createdAt = (deps.now ?? Date.now)();
  const trimmedChapter = chapter?.trim()
    ? Array.from(chapter.trim()).slice(0, MAX_CHAPTER_NAME).join('')
    : null;
  const item = { ...place, name: cleanName(name), chapter: trimmedChapter, createdAt };
  await putOrThrow(engine, id, bookmarkData(item), bookId);
  return { ...item, id, bookId, updatedAt: createdAt };
}

async function liveBookmark(engine: SyncEngine, id: string) {
  const record = await engine.get(BOOKMARK_KIND, id);
  const item = record && bookmarkFrom(record);

  if (!item) {
    throw new NotesError('This bookmark was removed.');
  }

  return item;
}

export async function renameBookmark(id: string, name: string, deps: NotesDeps) {
  const engine = await deps.getEngine();
  const item = await liveBookmark(engine, id);
  const next = cleanName(name);

  if (next !== item.name) {
    await putOrThrow(engine, id, bookmarkData({ ...item, name: next }), item.bookId);
  }
}

/** Removes a bookmark; the returned undo puts it back. */
export async function removeBookmark(id: string, deps: NotesDeps): Promise<Undo> {
  const engine = await deps.getEngine();
  const item = await liveBookmark(engine, id);

  if (!(await engine.remove(BOOKMARK_KIND, id))) {
    throw new NotesError('Could not remove the bookmark.');
  }

  return async () => putOrThrow(engine, id, bookmarkData(item), item.bookId);
}
