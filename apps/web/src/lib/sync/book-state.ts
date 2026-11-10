/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * Book state (WP8a): status, favorite, cover blur and read-throughs. Pure
 * rules, free of Svelte, DOM and IndexedDB so they can be unit tested; the
 * service turns the planned writes into records.
 *
 * Records (server: `apps/storage-server/src/sync/kinds.ts`):
 * - `book-status`   id <bookId>     { status, auto }   no record = unread
 * - `book-favorite` id <bookId>     { favorite }
 * - `book-blur`     id <bookId>     { blur }           stored only until WP7a
 * - `read-through`  id <bookId>:<n> { number, origin, startedOn, finished,
 *                                     finishedOn, manual, charCount }
 *
 * Read-throughs never copy or rewrite statistics or positions:
 * - A book without read-through records has an implicit read-through #1. Every
 *   existing position (readThroughId null) and stat day belongs to it, so a
 *   null readThroughId means <bookId>:1.
 * - The current read-through is the live one with the highest number.
 * - Stat days belong to a read-through by date: from its startedOn (null =
 *   from the beginning) to the next read-through's startedOn.
 */

export const BOOK_STATUS_KIND = 'book-status';
export const BOOK_FAVORITE_KIND = 'book-favorite';
export const BOOK_BLUR_KIND = 'book-blur';
export const READ_THROUGH_KIND = 'read-through';
export const BOOK_STATE_KINDS = [
  BOOK_STATUS_KIND,
  BOOK_FAVORITE_KIND,
  BOOK_BLUR_KIND,
  READ_THROUGH_KIND
] as const;

export const BOOK_STATUSES = ['unread', 'reading', 'completed', 'dropped'] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];
export const BOOK_BLURS = ['inherit', 'always', 'never'] as const;
export type BookBlur = (typeof BOOK_BLURS)[number];
export type ReadThroughOrigin = 'start-over' | 'completion';

export const STATUS_LABELS: Record<BookStatus, string> = {
  unread: 'Unread',
  reading: 'Reading',
  completed: 'Completed',
  dropped: 'Dropped'
};

export interface ReadThrough {
  id: string;
  number: number;
  origin: ReadThroughOrigin;
  /** YYYY-MM-DD (the tracker's day), or null = from the book's first day. */
  startedOn: string | null;
  finished: boolean;
  /** YYYY-MM-DD, or null (unknown or not finished). */
  finishedOn: string | null;
  /** Finished with "Mark completed" (not the reader's Complete Book). */
  manual: boolean;
  /** The catalog's character count when it was marked completed. */
  charCount: number | null;
}

export interface BookState {
  bookId: string;
  status: BookStatus;
  /** The status was set automatically (first page turn). */
  statusAuto: boolean;
  favorite: boolean;
  blur: BookBlur;
  /** Live read-throughs, by number. */
  readThroughs: ReadThrough[];
  /**
   * This device's re-planned Start over (see planRefusedStartOver), if any: its own
   * position record may still carry a refused read-through id and is read as `to`.
   */
  ownMove?: OwnPositionMove;
}

export interface OwnPositionMove {
  /** This device's position record id for the book. */
  positionId: string;
  /** Refused read-through ids... */
  from: string[];
  /** ...and the read-through they became. */
  to: string;
}

/** One record write the service carries out. */
export type BookStateWrite =
  | { kind: string; id: string; bookId: string; data: Record<string, unknown> }
  | { kind: string; id: string; bookId: string; deleted: true };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value);
}

export function readThroughRecordId(bookId: string, number: number): string {
  return `${bookId}:${number}`;
}

/** The server's code for an open read-through that would replace a finished one. */
export const READ_THROUGH_FINISHED = 'read_through_finished';
/** Highest read-through number the server accepts. */
export const MAX_READ_THROUGH_NUMBER = 9999;

/** The book and number of a read-through record id (<bookId>:<n>), or null. */
export function parseReadThroughRecordId(id: string): { bookId: string; number: number } | null {
  const at = id.lastIndexOf(':');
  if (at <= 0) return null;
  const number = Number(id.slice(at + 1));
  if (!Number.isInteger(number) || number < 1 || number > MAX_READ_THROUGH_NUMBER) return null;
  return { bookId: id.slice(0, at), number };
}

/** A position's read-through id with null meaning the first read-through. */
export function normalizeReadThroughId(bookId: string, id: unknown): string {
  return typeof id === 'string' && id ? id : readThroughRecordId(bookId, 1);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function toReadThrough(record: LocalRecord): ReadThrough | null {
  const number = Number(record.id.split(':')[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  const d = record.data ?? {};
  const charCount = d.charCount;
  return {
    id: record.id,
    number,
    origin: d.origin === 'completion' ? 'completion' : 'start-over',
    startedOn: isDateKey(d.startedOn) ? d.startedOn : null,
    finished: d.finished === true,
    finishedOn: isDateKey(d.finishedOn) ? d.finishedOn : null,
    manual: d.manual === true,
    charCount:
      typeof charCount === 'number' && Number.isInteger(charCount) && charCount >= 0
        ? charCount
        : null
  };
}

/** The state of one book from its mirrored records (any kinds; others are ignored). */
export function bookStateFrom(bookId: string, records: LocalRecord[]): BookState {
  const state: BookState = {
    bookId,
    status: 'unread',
    statusAuto: false,
    favorite: false,
    blur: 'inherit',
    readThroughs: []
  };
  for (const record of records) {
    if (record.deletedAt !== null) continue;
    switch (record.kind) {
      case BOOK_STATUS_KIND:
        if (record.id !== bookId) break;
        state.status = oneOf(record.data?.status, BOOK_STATUSES, 'unread');
        state.statusAuto = record.data?.auto === true;
        break;
      case BOOK_FAVORITE_KIND:
        if (record.id === bookId) state.favorite = record.data?.favorite === true;
        break;
      case BOOK_BLUR_KIND:
        if (record.id === bookId) state.blur = oneOf(record.data?.blur, BOOK_BLURS, 'inherit');
        break;
      case READ_THROUGH_KIND: {
        if (!record.id.startsWith(`${bookId}:`)) break;
        const rt = toReadThrough(record);
        if (rt) state.readThroughs.push(rt);
        break;
      }
    }
  }
  state.readThroughs.sort((a, b) => a.number - b.number);
  return state;
}

/** The states of every book with at least one state record, from all mirrored records. */
export function bookStatesFrom(records: LocalRecord[]): Map<string, BookState> {
  const byBook = new Map<string, LocalRecord[]>();
  for (const record of records) {
    if (!record.bookId) continue;
    const list = byBook.get(record.bookId) ?? [];
    list.push(record);
    byBook.set(record.bookId, list);
  }
  const out = new Map<string, BookState>();
  for (const [bookId, list] of byBook) out.set(bookId, bookStateFrom(bookId, list));
  return out;
}

export function currentReadThrough(state: BookState): ReadThrough | null {
  return state.readThroughs[state.readThroughs.length - 1] ?? null;
}

/** The id new position records carry: the current read-through's, or null without any. */
export function positionReadThroughId(state: BookState): string | null {
  return currentReadThrough(state)?.id ?? null;
}

export function finishedReadThroughs(state: BookState): number {
  return state.readThroughs.filter((r) => r.finished).length;
}

function statusWrite(bookId: string, status: BookStatus, auto: boolean): BookStateWrite {
  return { kind: BOOK_STATUS_KIND, id: bookId, bookId, data: { status, auto } };
}

function readThroughWrite(bookId: string, rt: Omit<ReadThrough, 'id'>): BookStateWrite {
  return {
    kind: READ_THROUGH_KIND,
    id: readThroughRecordId(bookId, rt.number),
    bookId,
    data: {
      number: rt.number,
      origin: rt.origin,
      startedOn: rt.startedOn,
      finished: rt.finished,
      finishedOn: rt.finished ? rt.finishedOn : null,
      manual: rt.manual,
      charCount: rt.charCount
    }
  };
}

/** First real page turn of a book load: Unread (or no record) becomes Reading. */
export function planFirstPageTurn(state: BookState): BookStateWrite[] {
  return state.status === 'unread' ? [statusWrite(state.bookId, 'reading', true)] : [];
}

/** Unread, Reading or Dropped: only the status changes. Completed goes through planMarkCompleted. */
export function planSetStatus(state: BookState, status: BookStatus): BookStateWrite[] {
  if (status === 'completed') throw new Error('Use planMarkCompleted for Completed');
  if (state.status === status && !state.statusAuto) return [];
  return [statusWrite(state.bookId, status, false)];
}

export interface CompletionInput {
  /** YYYY-MM-DD or null (blank). */
  finishedOn: string | null;
  /** "Mark completed" (true) or the reader's Complete Book (false). */
  manual: boolean;
  /** The catalog's character count, kept for character totals. */
  charCount: number | null;
}

/**
 * Status Completed, plus the read-through:
 * - none yet: a finished #1 (origin completion);
 * - the current one is open: it is finished;
 * - the current one is finished already: only the status changes.
 */
export function planMarkCompleted(state: BookState, input: CompletionInput): BookStateWrite[] {
  const writes: BookStateWrite[] = [];
  if (state.status !== 'completed' || state.statusAuto) {
    writes.push(statusWrite(state.bookId, 'completed', false));
  }
  const finishedOn = isDateKey(input.finishedOn) ? input.finishedOn : null;
  const current = currentReadThrough(state);
  if (!current) {
    writes.push(
      readThroughWrite(state.bookId, {
        number: 1,
        origin: 'completion',
        startedOn: null,
        finished: true,
        finishedOn,
        manual: input.manual,
        charCount: input.manual ? input.charCount : null
      })
    );
  } else if (!current.finished) {
    writes.push(
      readThroughWrite(state.bookId, {
        ...current,
        finished: true,
        finishedOn,
        manual: input.manual,
        charCount: input.manual ? input.charCount : null
      })
    );
  }
  return writes;
}

/**
 * A new open read-through (number after the current one; the implicit first
 * read-through counts as #1) and status Unread. Earlier read-throughs stay as
 * they are.
 */
export function planStartOver(state: BookState, today: string): BookStateWrite[] {
  const number = Math.max(1, currentReadThrough(state)?.number ?? 1) + 1;
  return [
    readThroughWrite(state.bookId, {
      number,
      origin: 'start-over',
      startedOn: isDateKey(today) ? today : null,
      finished: false,
      finishedOn: null,
      manual: false,
      charCount: null
    }),
    statusWrite(state.bookId, 'unread', false)
  ];
}

/** Changes the finish date of a finished read-through (null = blank). */
export function planEditFinishDate(
  state: BookState,
  readThroughId: string,
  finishedOn: string | null
): BookStateWrite[] {
  const rt = state.readThroughs.find((r) => r.id === readThroughId);
  if (!rt || !rt.finished) return [];
  return [
    readThroughWrite(state.bookId, { ...rt, finishedOn: isDateKey(finishedOn) ? finishedOn : null })
  ];
}

/** Only read-throughs made by a completion can be removed (to undo a mistaken mark). */
export function canRemoveReadThrough(rt: ReadThrough): boolean {
  return rt.origin === 'completion';
}

export function planRemoveReadThrough(state: BookState, readThroughId: string): BookStateWrite[] {
  const rt = state.readThroughs.find((r) => r.id === readThroughId);
  if (!rt || !canRemoveReadThrough(rt)) return [];
  return [{ kind: READ_THROUGH_KIND, id: rt.id, bookId: state.bookId, deleted: true }];
}

/**
 * After a Start over (here or on another device), the book opens at the start
 * on each device once: when the current read-through came from Start over,
 * this device's own position record belongs to another read-through (or there
 * is none), and the restored place is past the start. Returns the
 * read-through to announce, or null.
 */
export function startOverToApply(
  state: BookState,
  ownPosition: LocalRecord | undefined,
  restoredPos: number
): ReadThrough | null {
  const current = currentReadThrough(state);
  if (!current || current.origin !== 'start-over' || current.finished) return null;
  if (!(restoredPos > 0)) return null;
  if (ownPosition && ownPosition.deletedAt === null) {
    if (positionReadThroughOf(state, ownPosition) === current.id) return null;
  }
  return current;
}

/**
 * The read-through a position record belongs to (null = #1). This device's own
 * record is read through state.ownMove, so a re-planned Start over keeps it.
 */
export function positionReadThroughOf(state: BookState, position: LocalRecord): string {
  const id = normalizeReadThroughId(state.bookId, position.data?.readThroughId);
  const move = state.ownMove;
  return move && position.id === move.positionId && move.from.includes(id) ? move.to : id;
}

/**
 * Re-plans a Start over the server refused (READ_THROUGH_FINISHED, decided
 * 2026-11-10): this device's mirror was behind and planned a number that is
 * already finished elsewhere. With the mirror now up to date (the server's copy
 * was adopted), it becomes the next free number with the same start date. Null
 * when there is nothing to re-plan: not a Start over, or this device has changed
 * that read-through since (that edit stands).
 */
export function planRefusedStartOver(
  bookId: string,
  refused: { id: string; updatedAt: number; data: Record<string, unknown> },
  records: LocalRecord[],
  deviceId: string
): BookStateWrite | null {
  const parsed = parseReadThroughRecordId(refused.id);
  if (!parsed || parsed.bookId !== bookId) return null;
  if (refused.data?.origin !== 'start-over' || refused.data?.finished !== false) return null;
  const local = records.find((r) => r.kind === READ_THROUGH_KIND && r.id === refused.id);
  if (local && local.deviceId === deviceId && local.updatedAt > refused.updatedAt) return null;
  const highest = currentReadThrough(bookStateFrom(bookId, records))?.number ?? 1;
  const number = Math.max(parsed.number, highest) + 1;
  if (number > MAX_READ_THROUGH_NUMBER) return null;
  return readThroughWrite(bookId, {
    number,
    origin: 'start-over',
    startedOn: isDateKey(refused.data.startedOn) ? refused.data.startedOn : null,
    finished: false,
    finishedOn: null,
    manual: false,
    charCount: null
  });
}

/** Records a re-planned Start over; chains a re-plan of a re-plan. */
export function addStartOverMove(
  moves: Record<string, { from: string[]; to: string }> | undefined,
  bookId: string,
  fromId: string,
  toId: string
): Record<string, { from: string[]; to: string }> {
  const prev = moves?.[bookId];
  const from = prev && prev.to === fromId ? [...prev.from, fromId] : [fromId];
  return { ...moves, [bookId]: { from, to: toId } };
}

/** Whether a position record belongs to the book's current read-through. */
export function isCurrentReadThroughPosition(state: BookState, position: LocalRecord): boolean {
  const current = currentReadThrough(state);
  return (
    positionReadThroughOf(state, position) ===
    normalizeReadThroughId(state.bookId, current?.id ?? null)
  );
}

/**
 * The read-through a stat day belongs to: the highest-numbered one that
 * started on or before that day; null = the implicit first read-through.
 */
export function readThroughOfDay(readThroughs: ReadThrough[], dateKey: string): ReadThrough | null {
  let found: ReadThrough | null = null;
  for (const rt of readThroughs) {
    const start = rt.startedOn ?? '';
    if (start <= dateKey && (!found || rt.number > found.number)) found = rt;
  }
  return found;
}

export interface StatDayLike {
  dateKey: string;
  charactersRead: number;
  readingTime: number;
}

export interface CharacterTotals {
  /** Characters for character-based totals (tracked days plus manual completions). */
  characters: number;
  /** Characters from tracked days that are not inside a manual completion. */
  trackedCharacters: number;
  /** Reading time of all tracked days (seconds); manual completions add none. */
  readingTime: number;
  /** Finished read-throughs ("Read 2x"). */
  completed: number;
  /** Of those, finished with "Mark completed". */
  manualCompleted: number;
}

/**
 * One book's totals (decided with the user, WP8a): a manually completed
 * read-through counts the book's character count instead of the tracked
 * characters of its days, so nothing is counted twice. Time and speed always
 * use only the tracked days. Shown from WP12; tested now.
 */
export function characterTotals(
  readThroughs: ReadThrough[],
  statDays: StatDayLike[],
  catalogCount: number | null
): CharacterTotals {
  let trackedCharacters = 0;
  let readingTime = 0;
  for (const day of statDays) {
    const chars = Number.isFinite(day.charactersRead) ? Math.max(0, day.charactersRead) : 0;
    const time = Number.isFinite(day.readingTime) ? Math.max(0, day.readingTime) : 0;
    readingTime += time;
    if (!readThroughOfDay(readThroughs, day.dateKey)?.manual) trackedCharacters += chars;
  }
  let manualCharacters = 0;
  let manualCompleted = 0;
  for (const rt of readThroughs) {
    if (!rt.finished || !rt.manual) continue;
    manualCompleted += 1;
    manualCharacters += rt.charCount ?? catalogCount ?? 0;
  }
  return {
    characters: trackedCharacters + manualCharacters,
    trackedCharacters,
    readingTime,
    completed: readThroughs.filter((r) => r.finished).length,
    manualCompleted
  };
}
