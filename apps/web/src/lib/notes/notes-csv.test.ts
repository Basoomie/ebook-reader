/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { HighlightItem, NoteItem } from './highlights';
import {
  buildNotesCsv,
  csvCell,
  NOTES_CSV_COLUMNS,
  notesCsvBlob,
  notesCsvFileName
} from './notes-csv';
import { formatCsvDate, formatDate, formatWhen } from './notes-format';
import { loadOpenBooks, NOTES_OPEN_KEY, NOTES_OPEN_MAX, saveOpenBooks } from './notes-open';
import type { NotesBookGroup } from './notes-view';

const BOM = String.fromCharCode(0xfeff);
const at = (y: number, m: number, d: number, h: number, min: number) =>
  new Date(y, m - 1, d, h, min).getTime();

const highlight = (over: Partial<HighlightItem> = {}): HighlightItem => ({
  id: 'b1:h1',
  bookId: 'b1',
  start: 250,
  end: 260,
  text: '宮と外で適当',
  before: '',
  after: '',
  color: 4,
  chapter: '第一章',
  createdAt: at(2026, 11, 11, 7, 25),
  updatedAt: at(2026, 11, 11, 7, 25),
  ...over
});

const bookNote = (over: Partial<NoteItem> = {}): NoteItem => ({
  id: 'b1:n1',
  bookId: 'b1',
  body: '感想',
  highlightId: null,
  quote: null,
  createdAt: at(2026, 11, 12, 9, 5),
  updatedAt: at(2026, 11, 12, 9, 5),
  ...over
});

const group = (over: Partial<NotesBookGroup> = {}): NotesBookGroup => ({
  info: {
    id: 'b1',
    title: '週に一度クラスメイトを買う話５',
    series: { name: '週に一度', index: 5 },
    charCount: 1000,
    authors: ['羽田宇佐', 'U35']
  },
  highlights: [{ item: highlight(), unplaced: false }],
  notes: [],
  lastChange: 0,
  ...over
});

function rows(csv: string) {
  expect(csv.startsWith(BOM)).toBe(true);
  expect(csv.endsWith('\r\n')).toBe(true);
  return csv.slice(1, -2).split('\r\n');
}

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('cr\r\nlf')).toBe('"cr\r\nlf"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(5)).toBe('5');
  });

  it('keeps spreadsheets from running text as a formula', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
    // Numbers are data, not text a person typed.
    expect(csvCell(-3)).toBe('-3');
    // Japanese long vowel marks and dashes are not formula signs.
    expect(csvCell('ー')).toBe('ー');
  });
});

describe('buildNotesCsv', () => {
  it('writes a header and one row per highlight with its note', () => {
    const note = bookNote({
      id: 'b1:h:1',
      highlightId: 'b1:h1',
      body: 'line one\nline "two"',
      updatedAt: at(2026, 11, 13, 10, 0)
    });
    const csv = buildNotesCsv([
      group({ highlights: [{ item: highlight({ note }), unplaced: false }] })
    ]);
    const lines = rows(csv);
    expect(lines[0]).toBe(NOTES_CSV_COLUMNS.join(','));
    expect(csv).toContain(
      'Highlight,週に一度クラスメイトを買う話５,羽田宇佐 & U35,週に一度,5,第一章,25.0%,Pink,宮と外で適当,' +
        '"line one\nline ""two""",2026-11-11 07:25,2026-11-13 10:00'
    );
  });

  it('adds notes about the book and leaves unknown details empty', () => {
    const csv = buildNotesCsv([
      group({
        info: { id: 'x', title: 'Unknown book', series: null, charCount: null, unknown: true },
        highlights: [{ item: highlight({ chapter: null }), unplaced: true }],
        notes: [bookNote({ quote: '引用' })]
      })
    ]);
    const lines = rows(csv);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      'Highlight,Unknown book,,,,,,Pink,宮と外で適当,,2026-11-11 07:25,2026-11-11 07:25'
    );
    expect(lines[2]).toBe(
      'Book note,Unknown book,,,,,,,引用,感想,2026-11-12 09:05,2026-11-12 09:05'
    );
  });

  it('writes only the header for nothing', () => {
    expect(rows(buildNotesCsv([]))).toEqual([NOTES_CSV_COLUMNS.join(',')]);
  });

  it('makes a UTF-8 CSV blob', () => {
    expect(notesCsvBlob([group()]).type).toBe('text/csv;charset=utf-8');
  });
});

describe('notesCsvFileName', () => {
  const now = new Date(2026, 10, 11, 7, 5);

  it('stamps the date and time', () => {
    expect(notesCsvFileName(now)).toBe('ttsu-highlights-2026-11-11-0705.csv');
  });

  it('adds a safe, short book title', () => {
    expect(notesCsvFileName(now, ' a/b: c?*d ')).toBe(
      'ttsu-highlights-a-b-c-d-2026-11-11-0705.csv'
    );
    expect(notesCsvFileName(now, 'あ'.repeat(60))).toBe(
      `ttsu-highlights-${'あ'.repeat(40)}-2026-11-11-0705.csv`
    );
    expect(notesCsvFileName(now, '///')).toBe('ttsu-highlights-2026-11-11-0705.csv');
  });
});

describe('notes dates', () => {
  it('shows date and time', () => {
    const when = formatWhen(at(2026, 11, 11, 7, 25), 'en-US');
    expect(when).toContain('Nov 11, 2026');
    expect(when).toMatch(/7:25/);
    expect(formatDate(at(2026, 11, 11, 7, 25), 'en-US')).toBe('Nov 11, 2026');
  });

  it('writes sortable CSV dates', () => {
    expect(formatCsvDate(at(2026, 1, 2, 3, 4))).toBe('2026-01-02 03:04');
  });

  it('shows nothing for a missing time', () => {
    expect(formatWhen(0)).toBe('');
    expect(formatDate(Number.NaN)).toBe('');
    expect(formatCsvDate(0)).toBe('');
  });
});

describe('remembered open books', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v)
    };
  };

  it('round-trips through storage', () => {
    const storage = memory();
    saveOpenBooks(new Set(['a', 'b']), storage);
    expect(storage.data.get(NOTES_OPEN_KEY)).toBe('["a","b"]');
    expect(loadOpenBooks(storage)).toEqual(new Set(['a', 'b']));
  });

  it('keeps only the newest entries', () => {
    const storage = memory();
    const ids = Array.from({ length: NOTES_OPEN_MAX + 5 }, (_, i) => `b${i}`);
    saveOpenBooks(new Set(ids), storage);
    const loaded = loadOpenBooks(storage);
    expect(loaded.size).toBe(NOTES_OPEN_MAX);
    expect(loaded.has('b0')).toBe(false);
    expect(loaded.has(`b${NOTES_OPEN_MAX + 4}`)).toBe(true);
  });

  it('starts empty when storage is missing, broken or throws', () => {
    expect(loadOpenBooks(undefined)).toEqual(new Set());
    const broken = memory();
    broken.data.set(NOTES_OPEN_KEY, '{not json');
    expect(loadOpenBooks(broken)).toEqual(new Set());
    broken.data.set(NOTES_OPEN_KEY, '[1,"a",null]');
    expect(loadOpenBooks(broken)).toEqual(new Set(['a']));
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      }
    };
    expect(loadOpenBooks(throwing)).toEqual(new Set());
    expect(() => saveOpenBooks(new Set(['a']), throwing)).not.toThrow();
  });
});
