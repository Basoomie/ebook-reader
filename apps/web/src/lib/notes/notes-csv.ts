/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { fileTitle, localStamp } from '$lib/functions/download-blob';
import { HIGHLIGHT_COLOR_NAMES } from './highlights';
import { formatCsvDate } from './notes-format';
import { percentOf, type NotesBookGroup } from './notes-view';

/**
 * WP19d: highlights and notes as CSV (decisions.md "WP19d"). One row per highlight (with
 * its note) and per note about a book. RFC 4180 quoting, CRLF line ends and a UTF-8 BOM
 * so spreadsheet programs read the Japanese correctly. Text that starts like a formula
 * gets a leading apostrophe so a spreadsheet shows it instead of running it.
 */

export const NOTES_CSV_COLUMNS = [
  'Type',
  'Book',
  'Author',
  'Series',
  'Volume',
  'Chapter',
  'Position',
  'Colour',
  'Text',
  'Note',
  'Created',
  'Updated'
] as const;

const BOM = String.fromCharCode(0xfeff);
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function row(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(',');
}

export function buildNotesCsv(groups: readonly NotesBookGroup[]): string {
  const lines = [row([...NOTES_CSV_COLUMNS])];

  for (const group of groups) {
    const book = group.info;
    const authors = (book.authors ?? []).join(' & ');
    const series = book.series?.name ?? '';
    const volume = book.series?.index ?? null;

    for (const { item } of group.highlights) {
      const updated = Math.max(item.updatedAt, item.note?.updatedAt ?? 0);
      lines.push(
        row([
          'Highlight',
          book.title,
          authors,
          series,
          volume,
          item.chapter ?? '',
          percentOf(item.start, book.charCount),
          HIGHLIGHT_COLOR_NAMES[item.color],
          item.text,
          item.note?.body ?? '',
          formatCsvDate(item.createdAt),
          formatCsvDate(updated)
        ])
      );
    }

    for (const note of group.notes) {
      lines.push(
        row([
          'Book note',
          book.title,
          authors,
          series,
          volume,
          '',
          '',
          '',
          note.quote ?? '',
          note.body,
          formatCsvDate(note.createdAt),
          formatCsvDate(note.updatedAt)
        ])
      );
    }
  }

  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** `ttsu-highlights-2026-11-11-0725.csv`, or with a book's title for one book. */
export function notesCsvFileName(now: Date, bookTitle?: string): string {
  const stamp = localStamp(now, true);
  const name = fileTitle(bookTitle);
  return name ? `ttsu-highlights-${name}-${stamp}.csv` : `ttsu-highlights-${stamp}.csv`;
}

export function notesCsvBlob(groups: readonly NotesBookGroup[]): Blob {
  return new Blob([buildNotesCsv(groups)], { type: 'text/csv;charset=utf-8' });
}
