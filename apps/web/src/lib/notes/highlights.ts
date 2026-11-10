/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';
import type { TextAnchor } from './anchor';

/**
 * WP11a: highlights and notes as records (pure; the service writes them).
 *
 * - "highlight": id `<bookId>:<uuid>`, data { start, end, text, before, after, color,
 *   chapter, createdAt }. Only `color` changes after it is made.
 * - "note": id `<bookId>:<uuid>` (a note about the book) or `<bookId>:h:<uuid>` (the note
 *   on highlight `<bookId>:<uuid>`), data { body, highlightId, quote, createdAt }.
 *
 * Both belong to the book (never to a read-through), are lww per record and deletable.
 */
export const HIGHLIGHT_KIND = 'highlight';
export const NOTE_KIND = 'note';

export const HIGHLIGHT_COLORS = [1, 2, 3, 4, 5] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

/** Names for screen readers and tooltips; the colors have no fixed meaning. */
export const HIGHLIGHT_COLOR_NAMES: Record<HighlightColor, string> = {
  1: 'Yellow',
  2: 'Green',
  3: 'Blue',
  4: 'Pink',
  5: 'Orange'
};

export const MAX_NOTE_BODY = 20_000;
export const MAX_NOTE_QUOTE = 300;
export const MAX_CHAPTER_NAME = 200;

export interface NoteItem {
  id: string;
  bookId: string;
  body: string;
  /** The highlight this note is on (it may have been deleted on another device). */
  highlightId: string | null;
  /** The start of the highlight's text, kept with the note. */
  quote: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface HighlightItem extends TextAnchor {
  id: string;
  bookId: string;
  color: HighlightColor;
  chapter: string | null;
  createdAt: number;
  updatedAt: number;
  note?: NoteItem;
}

export interface BookNotes {
  /** In book order. */
  highlights: HighlightItem[];
  /**
   * Notes about the book, plus notes whose highlight is gone (deleted on another
   * device); oldest first.
   */
  notes: NoteItem[];
}

export function isHighlightColor(value: unknown): value is HighlightColor {
  return HIGHLIGHT_COLORS.includes(value as HighlightColor);
}

export function highlightRecordId(bookId: string, uuid: string) {
  return `${bookId}:${uuid}`;
}

/** The id of the note on a highlight. */
export function noteIdForHighlight(highlightId: string) {
  const [bookId, uuid] = highlightId.split(':');
  return `${bookId}:h:${uuid}`;
}

export function bookIdOfRecordId(id: string) {
  return id.split(':')[0];
}

/** The quote a note keeps of its highlight. */
export function quoteOf(text: string) {
  const chars = Array.from(text.replace(/\s+/gu, ' '));
  return chars.length > MAX_NOTE_QUOTE
    ? chars.slice(0, MAX_NOTE_QUOTE - 1).join('') + '…'
    : chars.join('');
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function highlightFrom(record: LocalRecord): HighlightItem | undefined {
  if (record.kind !== HIGHLIGHT_KIND || record.deletedAt !== null || !record.data) {
    return undefined;
  }

  const d = record.data;
  const color = isHighlightColor(d.color) ? d.color : 1;
  const text = str(d.text);

  if (!text) {
    return undefined;
  }

  return {
    id: record.id,
    bookId: record.bookId ?? bookIdOfRecordId(record.id),
    start: num(d.start),
    end: num(d.end),
    text,
    before: str(d.before),
    after: str(d.after),
    color,
    chapter: typeof d.chapter === 'string' ? d.chapter : null,
    createdAt: num(d.createdAt, record.updatedAt),
    updatedAt: record.updatedAt
  };
}

export function noteFrom(record: LocalRecord): NoteItem | undefined {
  if (record.kind !== NOTE_KIND || record.deletedAt !== null || !record.data) {
    return undefined;
  }

  const d = record.data;
  const body = str(d.body);

  if (!body) {
    return undefined;
  }

  return {
    id: record.id,
    bookId: record.bookId ?? bookIdOfRecordId(record.id),
    body,
    highlightId: typeof d.highlightId === 'string' ? d.highlightId : null,
    quote: typeof d.quote === 'string' ? d.quote : null,
    createdAt: num(d.createdAt, record.updatedAt),
    updatedAt: record.updatedAt
  };
}

export function byBookOrder(a: HighlightItem, b: HighlightItem) {
  return a.start - b.start || a.end - b.end || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

/** Highlights and notes per book, from records of both kinds (others are ignored). */
export function notesByBook(records: readonly LocalRecord[]): Map<string, BookNotes> {
  const highlights = new Map<string, HighlightItem>();
  const notes: NoteItem[] = [];

  for (const record of records) {
    const highlight = highlightFrom(record);

    if (highlight) {
      highlights.set(highlight.id, highlight);
      continue;
    }

    const note = noteFrom(record);

    if (note) {
      notes.push(note);
    }
  }

  const out = new Map<string, BookNotes>();
  const bookOf = (bookId: string) => {
    let entry = out.get(bookId);

    if (!entry) {
      entry = { highlights: [], notes: [] };
      out.set(bookId, entry);
    }

    return entry;
  };

  for (const note of notes) {
    const highlight = note.highlightId ? highlights.get(note.highlightId) : undefined;

    if (highlight) {
      highlight.note = note;
    } else {
      bookOf(note.bookId).notes.push(note);
    }
  }

  for (const highlight of highlights.values()) {
    bookOf(highlight.bookId).highlights.push(highlight);
  }

  for (const entry of out.values()) {
    entry.highlights.sort(byBookOrder);
    entry.notes.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  }

  return out;
}

export function emptyBookNotes(): BookNotes {
  return { highlights: [], notes: [] };
}

/** The newest change among a book's highlights and notes (for ordering books). */
export function lastChangeOf(entry: BookNotes) {
  let last = 0;

  for (const h of entry.highlights) {
    last = Math.max(last, h.updatedAt, h.note?.updatedAt ?? 0);
  }

  for (const n of entry.notes) {
    last = Math.max(last, n.updatedAt);
  }

  return last;
}

/** Highlight ids that overlap a span of positions (for "Highlighted" in the bar). */
export function overlapping(highlights: readonly HighlightItem[], start: number, end: number) {
  return highlights.filter((h) => h.start < end && start < h.end);
}
