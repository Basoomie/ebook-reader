/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { randomId } from '$lib/functions/secure-context';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';
import type { TextAnchor } from './anchor';
import {
  emptyBookNotes,
  HIGHLIGHT_KIND,
  highlightFrom,
  highlightRecordId,
  MAX_CHAPTER_NAME,
  MAX_NOTE_BODY,
  NOTE_KIND,
  noteFrom,
  noteIdForHighlight,
  notesByBook,
  quoteOf,
  type BookNotes,
  type HighlightColor,
  type HighlightItem,
  type NoteItem
} from './highlights';

/**
 * WP11a: highlights and notes on top of the sync engine. Reads come from the local
 * mirror (offline, local changes at once); writes are local records queued for the
 * server. User actions throw NotesError when something could not be saved. Nothing here
 * touches stat-day or position records.
 */
export interface NotesDeps {
  getEngine(): Promise<SyncEngine>;
  warn(message: string): void;
  newId?: () => string;
  now?: () => number;
}

export class NotesError extends Error {}

/** Puts back what an action removed. */
export type Undo = () => Promise<void>;

const isNotesRecord = (r: LocalRecord) => r.kind === HIGHLIGHT_KIND || r.kind === NOTE_KIND;

/** Changes worth telling the reader and the Notes page about (WP11b: bookmarks too). */
const isWatchedRecord = (r: LocalRecord) => isNotesRecord(r) || r.kind === 'bookmark';

export async function getBookNotes(bookId: string, deps: NotesDeps): Promise<BookNotes> {
  const engine = await deps.getEngine();
  const records = (await engine.getForBook(bookId)).filter(isNotesRecord);
  return notesByBook(records).get(bookId) ?? emptyBookNotes();
}

export async function getAllNotes(deps: NotesDeps): Promise<Map<string, BookNotes>> {
  const engine = await deps.getEngine();
  const records = [...(await engine.getAll(HIGHLIGHT_KIND)), ...(await engine.getAll(NOTE_KIND))];
  return notesByBook(records);
}

async function putOrThrow(
  engine: SyncEngine,
  kind: string,
  id: string,
  data: Record<string, unknown>,
  bookId: string,
  what: string
) {
  if (!(await engine.put(kind, id, data, { bookId }))) {
    throw new NotesError(`Could not save the ${what}.`);
  }
}

async function removeOrThrow(engine: SyncEngine, kind: string, id: string, what: string) {
  if (!(await engine.remove(kind, id))) {
    throw new NotesError(`Could not remove the ${what}.`);
  }
}

function chapterName(chapter: string | null | undefined) {
  const trimmed = chapter?.trim();
  return trimmed ? Array.from(trimmed).slice(0, MAX_CHAPTER_NAME).join('') : null;
}

function highlightData(item: Omit<HighlightItem, 'id' | 'bookId' | 'updatedAt' | 'note'>) {
  return {
    start: item.start,
    end: item.end,
    text: item.text,
    before: item.before,
    after: item.after,
    color: item.color,
    chapter: item.chapter,
    createdAt: item.createdAt
  };
}

function noteData(note: Pick<NoteItem, 'body' | 'highlightId' | 'quote' | 'createdAt'>) {
  return {
    body: note.body,
    highlightId: note.highlightId,
    quote: note.quote,
    createdAt: note.createdAt
  };
}

export async function addHighlight(
  bookId: string,
  anchor: TextAnchor,
  color: HighlightColor,
  chapter: string | null | undefined,
  deps: NotesDeps
): Promise<HighlightItem> {
  const engine = await deps.getEngine();
  const id = highlightRecordId(bookId, (deps.newId ?? randomId)());
  const createdAt = (deps.now ?? Date.now)();
  const item = {
    start: anchor.start,
    end: anchor.end,
    text: anchor.text,
    before: anchor.before,
    after: anchor.after,
    color,
    chapter: chapterName(chapter),
    createdAt
  };
  await putOrThrow(engine, HIGHLIGHT_KIND, id, highlightData(item), bookId, 'highlight');
  const saved = await engine.get(HIGHLIGHT_KIND, id);
  return (saved && highlightFrom(saved)) ?? { ...item, id, bookId, updatedAt: createdAt };
}

async function liveHighlight(engine: SyncEngine, id: string) {
  const record = await engine.get(HIGHLIGHT_KIND, id);
  const item = record && highlightFrom(record);

  if (!item) {
    throw new NotesError('This highlight was removed.');
  }

  return item;
}

export async function setHighlightColor(id: string, color: HighlightColor, deps: NotesDeps) {
  const engine = await deps.getEngine();
  const item = await liveHighlight(engine, id);

  if (item.color === color) {
    return;
  }

  await putOrThrow(
    engine,
    HIGHLIGHT_KIND,
    id,
    highlightData({ ...item, color }),
    item.bookId,
    'highlight'
  );
}

/** Removes a highlight and its note; the returned undo puts both back. */
export async function removeHighlight(id: string, deps: NotesDeps): Promise<Undo> {
  const engine = await deps.getEngine();
  const item = await liveHighlight(engine, id);
  const noteRecord = await engine.get(NOTE_KIND, noteIdForHighlight(id));
  const note = noteRecord && noteFrom(noteRecord);

  if (note) {
    await removeOrThrow(engine, NOTE_KIND, note.id, 'note');
  }

  await removeOrThrow(engine, HIGHLIGHT_KIND, id, 'highlight');

  return async () => {
    await putOrThrow(engine, HIGHLIGHT_KIND, id, highlightData(item), item.bookId, 'highlight');

    if (note) {
      await putOrThrow(engine, NOTE_KIND, note.id, noteData(note), note.bookId, 'note');
    }
  };
}

export interface NoteTarget {
  bookId: string;
  /** The note on this highlight; omit for a note about the book. */
  highlight?: Pick<HighlightItem, 'id' | 'text'>;
  /** An existing note to change. */
  noteId?: string;
}

/**
 * Saves a note's text: creates it, changes it, or (an empty text) removes it. Returns
 * the note id, or null when it was removed.
 */
export async function saveNote(
  target: NoteTarget,
  body: string,
  deps: NotesDeps
): Promise<string | null> {
  const engine = await deps.getEngine();
  const id =
    target.noteId ??
    (target.highlight
      ? noteIdForHighlight(target.highlight.id)
      : highlightRecordId(target.bookId, (deps.newId ?? randomId)()));
  const trimmed = body.trim();
  const existingRecord = await engine.get(NOTE_KIND, id);
  const existing = existingRecord && noteFrom(existingRecord);

  if (!trimmed) {
    if (existing) {
      await removeOrThrow(engine, NOTE_KIND, id, 'note');
    }

    return null;
  }

  if (Array.from(body).length > MAX_NOTE_BODY) {
    throw new NotesError(`A note can be at most ${MAX_NOTE_BODY.toLocaleString()} characters.`);
  }

  if (existing?.body === body) {
    return id;
  }

  const highlightId = existing ? existing.highlightId : (target.highlight?.id ?? null);
  const quote = existing
    ? existing.quote
    : target.highlight
      ? quoteOf(target.highlight.text)
      : null;
  await putOrThrow(
    engine,
    NOTE_KIND,
    id,
    noteData({
      body,
      highlightId,
      quote,
      createdAt: existing?.createdAt ?? (deps.now ?? Date.now)()
    }),
    target.bookId,
    'note'
  );
  return id;
}

/** Removes a note; the returned undo puts it back. */
export async function removeNote(id: string, deps: NotesDeps): Promise<Undo> {
  const engine = await deps.getEngine();
  const record = await engine.get(NOTE_KIND, id);
  const note = record && noteFrom(record);

  if (!note) {
    return async () => {};
  }

  await removeOrThrow(engine, NOTE_KIND, id, 'note');
  return async () => {
    await putOrThrow(engine, NOTE_KIND, id, noteData(note), note.bookId, 'note');
  };
}

/**
 * Calls back with the books whose highlights, notes or bookmarks changed (local writes and pulls;
 * `remoteOnly` for pulls only).
 */
export async function onNotesChanged(
  callback: (bookIds: Set<string>) => void,
  deps: NotesDeps,
  options: { remoteOnly?: boolean } = {}
): Promise<() => void> {
  try {
    const engine = await deps.getEngine();
    const bookOf = (r: LocalRecord) => r.bookId ?? r.id.split(':')[0];
    const offRemote = engine.onRemoteChange((records) => {
      const books = new Set(records.filter(isWatchedRecord).map(bookOf));
      if (books.size) callback(books);
    });
    const offLocal = options.remoteOnly
      ? () => {}
      : engine.onLocalWrite((r) => {
          if (isWatchedRecord(r)) callback(new Set([bookOf(r)]));
        });
    return () => {
      offRemote();
      offLocal();
    };
  } catch (error) {
    deps.warn(`Notes: ${(error as Error)?.message ?? error}`);
    return () => {};
  }
}

/**
 * Highlights this device could not place in its copy of the book (local only, per
 * device: two devices may hold different copies). Never rejects.
 */
export async function getUnplacedHighlights(deps: NotesDeps): Promise<Set<string>> {
  try {
    const engine = await deps.getEngine();
    return new Set(Object.keys((await engine.getMeta()).highlightPlacement ?? {}));
  } catch (error) {
    deps.warn(`Notes: ${(error as Error)?.message ?? error}`);
    return new Set();
  }
}

/**
 * Records which highlights of a book this device could not place (replacing the book's
 * earlier result). Never rejects.
 */
export async function setUnplacedHighlights(
  bookId: string,
  unplacedIds: readonly string[],
  deps: NotesDeps
): Promise<void> {
  try {
    const engine = await deps.getEngine();
    const before = (await engine.getMeta()).highlightPlacement ?? {};
    const same =
      Object.entries(before).filter(([, v]) => v.bookId === bookId).length === unplacedIds.length &&
      unplacedIds.every((id) => before[id]?.bookId === bookId);

    if (same) {
      return;
    }

    const now = (deps.now ?? Date.now)();
    await engine.updateMeta((meta) => {
      const next: NonNullable<typeof meta.highlightPlacement> = {};

      for (const [id, value] of Object.entries(meta.highlightPlacement ?? {})) {
        if (value.bookId !== bookId) next[id] = value;
      }

      for (const id of unplacedIds) {
        next[id] = { bookId, checkedAt: now };
      }

      meta.highlightPlacement = next;
    });
  } catch (error) {
    deps.warn(`Notes: ${(error as Error)?.message ?? error}`);
  }
}
