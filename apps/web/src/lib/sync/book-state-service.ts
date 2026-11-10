/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  addStartOverMove,
  BOOK_STATE_KINDS,
  bookStateFrom,
  parseReadThroughRecordId,
  planRefusedStartOver,
  READ_THROUGH_FINISHED,
  READ_THROUGH_KIND,
  bookStatesFrom,
  planEditFinishDate,
  planFirstPageTurn,
  planMarkCompleted,
  planRemoveReadThrough,
  planSetStatus,
  planStartOver,
  startOverToApply,
  type BookBlur,
  type BookState,
  type BookStateWrite,
  type BookStatus,
  type ReadThrough,
  BOOK_BLUR_KIND,
  BOOK_FAVORITE_KIND
} from '$lib/sync/book-state';
import { positionRecordId } from '$lib/sync/record-position';
import type { LocalRecord, SyncMeta } from '$lib/sync/sync-db';
import type { RefusalHandler, SyncEngine } from '$lib/sync/sync-engine';

/**
 * Book state (WP8a) on top of the sync engine: reads come from the local
 * mirror (works offline), writes are local records queued for the server.
 * Nothing here touches stat-day or existing position records.
 */

export interface BookStateDeps {
  getEngine(): Promise<SyncEngine>;
  /** Today's date key on the tracker's day boundary (YYYY-MM-DD). */
  today(): string;
  warn(message: string): void;
}

/** A user action could not be saved locally. */
export class BookStateError extends Error {}

const STATE_KINDS = new Set<string>(BOOK_STATE_KINDS);

/** Adds this device's re-planned Start over (if any) to a book's state. */
function withOwnMove(state: BookState, meta: SyncMeta, deviceId: string): BookState {
  const move = meta.startOverMoves?.[state.bookId];
  if (move) state.ownMove = { positionId: positionRecordId(state.bookId, deviceId), ...move };
  return state;
}

export async function getBookState(bookId: string, deps: BookStateDeps): Promise<BookState> {
  const engine = await deps.getEngine();
  const [records, meta] = await Promise.all([engine.getForBook(bookId), engine.getMeta()]);
  return withOwnMove(bookStateFrom(bookId, records), meta, engine.deviceId);
}

/** Every book with a state record (books without one are Unread with defaults). */
export async function getAllBookStates(deps: BookStateDeps): Promise<Map<string, BookState>> {
  const engine = await deps.getEngine();
  const lists = await Promise.all(BOOK_STATE_KINDS.map((kind) => engine.getAll(kind)));
  const meta = await engine.getMeta();
  const states = bookStatesFrom(lists.flat());
  for (const state of states.values()) withOwnMove(state, meta, engine.deviceId);
  return states;
}

/**
 * Re-plans a Start over the server refused because that number is already finished
 * elsewhere (a device whose mirror was behind). Runs after the sync's pull, in the
 * same local transaction that clears the refusal; the new read-through syncs next.
 */
export const startOverRefusalHandler: RefusalHandler = {
  code: READ_THROUGH_FINISHED,
  kind: READ_THROUGH_KIND,
  bookIdOf: (change) => parseReadThroughRecordId(change.id)?.bookId ?? null,
  resolve(entry, records, deviceId) {
    const bookId = parseReadThroughRecordId(entry.change.id)?.bookId;
    const write = bookId && planRefusedStartOver(bookId, entry.change, records, deviceId);
    if (!bookId || !write || 'deleted' in write) return { writes: [] };
    return {
      writes: [{ kind: write.kind, id: write.id, data: write.data, bookId }],
      meta: (meta) => {
        meta.startOverMoves = addStartOverMove(
          meta.startOverMoves,
          bookId,
          entry.change.id,
          write.id
        );
      }
    };
  }
};

/** Book-state hooks on the sync engine (call once per engine). */
export function registerBookStateSync(engine: SyncEngine): () => void {
  return engine.handleRefusals(startOverRefusalHandler);
}

/** Writes in order; throws BookStateError when one could not be saved. */
async function applyWrites(engine: SyncEngine, writes: BookStateWrite[]): Promise<void> {
  for (const w of writes) {
    const ok =
      'deleted' in w
        ? await engine.remove(w.kind, w.id)
        : await engine.put(w.kind, w.id, w.data, { bookId: w.bookId });
    if (!ok) throw new BookStateError(`Could not save ${w.kind} for this book`);
  }
}

async function plan(
  bookId: string,
  deps: BookStateDeps,
  make: (state: BookState) => BookStateWrite[]
): Promise<void> {
  const engine = await deps.getEngine();
  const state = bookStateFrom(bookId, await engine.getForBook(bookId));
  await applyWrites(engine, make(state));
}

// ---- user actions (throw on failure so the UI can say so) -------------------

export function setBookStatus(bookId: string, status: BookStatus, deps: BookStateDeps) {
  return plan(bookId, deps, (s) => planSetStatus(s, status));
}

export async function setBookFavorite(bookId: string, favorite: boolean, deps: BookStateDeps) {
  const engine = await deps.getEngine();
  await applyWrites(engine, [{ kind: BOOK_FAVORITE_KIND, id: bookId, bookId, data: { favorite } }]);
}

export async function setBookBlur(bookId: string, blur: BookBlur, deps: BookStateDeps) {
  const engine = await deps.getEngine();
  await applyWrites(engine, [{ kind: BOOK_BLUR_KIND, id: bookId, bookId, data: { blur } }]);
}

/**
 * The same change for many books (library bulk actions, WP7a). Each book is saved on its
 * own; returns the ids that failed (the others are saved).
 */
async function forEachBook(
  bookIds: readonly string[],
  deps: BookStateDeps,
  save: (bookId: string) => Promise<void>
): Promise<string[]> {
  const failed: string[] = [];
  for (const bookId of bookIds) {
    try {
      await save(bookId);
    } catch (error) {
      deps.warn(`Book state: ${(error as Error)?.message ?? error}`);
      failed.push(bookId);
    }
  }
  return failed;
}

/** Unread, Reading or Dropped for many books (Completed goes through markBooksCompleted). */
export function setBooksStatus(
  bookIds: readonly string[],
  status: BookStatus,
  deps: BookStateDeps
) {
  return forEachBook(bookIds, deps, (id) => setBookStatus(id, status, deps));
}

export function setBooksFavorite(
  bookIds: readonly string[],
  favorite: boolean,
  deps: BookStateDeps
) {
  return forEachBook(bookIds, deps, (id) => setBookFavorite(id, favorite, deps));
}

export function setBooksBlur(bookIds: readonly string[], blur: BookBlur, deps: BookStateDeps) {
  return forEachBook(bookIds, deps, (id) => setBookBlur(id, blur, deps));
}

export interface MarkCompletedBook {
  bookId: string;
  /** The catalog's character count (null while not counted). */
  charCount: number | null;
}

/**
 * "Mark completed" for one or many books with one optional finish date.
 * Returns the ids that failed (the others are saved).
 */
export async function markBooksCompleted(
  books: MarkCompletedBook[],
  finishedOn: string | null,
  deps: BookStateDeps
): Promise<string[]> {
  const failed: string[] = [];
  for (const book of books) {
    try {
      await plan(book.bookId, deps, (s) =>
        planMarkCompleted(s, { finishedOn, manual: true, charCount: book.charCount })
      );
    } catch (error) {
      deps.warn(`Book state: ${(error as Error)?.message ?? error}`);
      failed.push(book.bookId);
    }
  }
  return failed;
}

export function startBookOver(bookId: string, deps: BookStateDeps) {
  return plan(bookId, deps, (s) => planStartOver(s, deps.today()));
}

export function editReadThroughFinish(
  bookId: string,
  readThroughId: string,
  finishedOn: string | null,
  deps: BookStateDeps
) {
  return plan(bookId, deps, (s) => planEditFinishDate(s, readThroughId, finishedOn));
}

export function removeReadThrough(bookId: string, readThroughId: string, deps: BookStateDeps) {
  return plan(bookId, deps, (s) => planRemoveReadThrough(s, readThroughId));
}

// ---- reader hooks (never throw) ---------------------------------------------

/** First real page turn of a book load. Never throws. */
export async function noteFirstPageTurn(bookId: string, deps: BookStateDeps): Promise<void> {
  try {
    await plan(bookId, deps, planFirstPageTurn);
  } catch (error) {
    deps.warn(`Book state: could not set Reading: ${(error as Error)?.message ?? error}`);
  }
}

/** The reader's Complete Book: Completed, as a tracked read-through. Never throws. */
export async function noteReaderCompletion(bookId: string, deps: BookStateDeps): Promise<void> {
  try {
    await plan(bookId, deps, (s) =>
      planMarkCompleted(s, { finishedOn: deps.today(), manual: false, charCount: null })
    );
  } catch (error) {
    deps.warn(`Book state: could not mark completed: ${(error as Error)?.message ?? error}`);
  }
}

/** The Start over this device has not applied yet, or null. Never throws. */
export async function pendingStartOver(
  bookId: string,
  restoredPos: number,
  deps: BookStateDeps
): Promise<ReadThrough | null> {
  try {
    const engine = await deps.getEngine();
    const [records, meta] = await Promise.all([engine.getForBook(bookId), engine.getMeta()]);
    const own = records.find(
      (r) => r.kind === 'position' && r.id === positionRecordId(bookId, engine.deviceId)
    );
    const state = withOwnMove(bookStateFrom(bookId, records), meta, engine.deviceId);
    return startOverToApply(state, own, restoredPos);
  } catch (error) {
    deps.warn(`Book state: ${(error as Error)?.message ?? error}`);
    return null;
  }
}

/**
 * Calls back with the book ids whose state changed (local writes and pulls).
 * Returns an unsubscribe function. Never throws.
 */
export async function onBookStatesChanged(
  callback: (bookIds: Set<string>) => void,
  deps: Pick<BookStateDeps, 'getEngine' | 'warn'>,
  options: { remoteOnly?: boolean } = {}
): Promise<() => void> {
  try {
    const engine = await deps.getEngine();
    const notify = (records: LocalRecord[]) => {
      const ids = new Set(
        records.filter((r) => STATE_KINDS.has(r.kind) && r.bookId).map((r) => r.bookId as string)
      );
      if (ids.size) callback(ids);
    };
    const offRemote = engine.onRemoteChange(notify);
    const offLocal = options.remoteOnly ? () => {} : engine.onLocalWrite((r) => notify([r]));
    return () => {
      offRemote();
      offLocal();
    };
  } catch (error) {
    deps.warn(`Book state: ${(error as Error)?.message ?? error}`);
    return () => {};
  }
}
