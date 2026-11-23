/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { descriptionParagraphs } from '$lib/library/description';
import { formatSeriesIndex } from '$lib/library/format';
import type { EditValues, HistoryEntry } from './types';

/** Field names as the form and the history show them. */
export const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  sort: 'Title sort',
  authors: 'Authors',
  author_sort: 'Author sort',
  illustrator: 'Illustrators',
  series: 'Series',
  series_index: 'Number in the series',
  publisher: 'Publisher',
  pubdate: 'Published',
  languages: 'Language',
  rating: 'Rating',
  description: 'Description',
  tags: 'Tags',
  identifiers: 'Store and site ids',
  cover: 'Cover'
};

export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;

/** The languages the form offers (Calibre's codes); a book's own others are kept. */
export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'jpn', label: 'Japanese (jpn)' },
  { code: 'eng', label: 'English (eng)' },
  { code: 'zho', label: 'Chinese (zho)' },
  { code: 'kor', label: 'Korean (kor)' }
];

/** "4.5" for 9, "No rating" for none. */
export function ratingText(rating: number | null): string {
  return rating && rating > 0 ? `${rating / 2} of 5` : 'No rating';
}

/** The five stars' looks for a rating (1-10 half stars). */
export function starGlyphs(rating: number | null): ('full' | 'half' | 'empty')[] {
  const r = rating ?? 0;
  return [1, 2, 3, 4, 5].map((n) => (r >= n * 2 ? 'full' : r === n * 2 - 1 ? 'half' : 'empty'));
}

/** Tapping star `n`: n stars; tapping the full star again: half of it (design 2026-11-23). */
export function tapStar(rating: number | null, n: number): number {
  return rating === n * 2 ? n * 2 - 1 : n * 2;
}

/** A published date (ms, noon UTC) as an <input type="date"> value, "" for none. */
export function dateInputValue(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The description as the form edits it: its paragraphs, a blank line between them. */
export function descriptionText(raw: string | null): string {
  return descriptionParagraphs(raw).join('\n\n');
}

/** A value of a history entry or the form, as one line of text. */
export function valueText(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '(none)';
  if (field === 'cover') return v === 'picture' || v === true ? 'A picture' : '(none)';
  if (field === 'rating') return typeof v === 'number' ? `${v / 2} of 5` : '(none)';
  if (field === 'pubdate') return typeof v === 'number' ? dateInputValue(v) || '(none)' : '(none)';
  if (field === 'series' || field === 'series_index') {
    const s = v as { name?: string | null; index?: number | null };
    if (typeof v === 'number') return `#${formatSeriesIndex(v)}`;
    if (typeof v === 'string') return v;
    if (!s.name) return '(none)';
    return s.index !== null && s.index !== undefined
      ? `${s.name} · #${formatSeriesIndex(s.index)}`
      : s.name;
  }
  if (field === 'identifiers' && typeof v === 'object') {
    const e = Object.entries(v as Record<string, string>);
    return e.length ? e.map(([k, x]) => `${k}:${x}`).join(', ') : '(none)';
  }
  if (field === 'tags' && v && typeof v === 'object' && !Array.isArray(v)) {
    const c = v as { added?: string[]; removed?: string[] };
    if (c.added) return `+ ${c.added.join(', ')}`;
    if (c.removed) return `− ${c.removed.join(', ')}`;
  }
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)';
  if (field === 'description') {
    const t = descriptionText(String(v));
    return t.length > 140 ? `${t.slice(0, 140)}…` : t;
  }
  return String(v);
}

/** Who made a history entry, as the panel shows it. */
export function whoText(e: HistoryEntry): string {
  switch (e.who) {
    case 'you':
      return e.via === 'undo'
        ? 'You · undo'
        : e.via === 'carried'
          ? 'You · copied from the old copy'
          : 'You';
    case 'cleanup':
      return e.via === 'arrivals'
        ? `Cleanup · new arrivals${e.stage ? ` (stage ${e.stage})` : ''}`
        : e.via === 'title-fit'
          ? 'Cleanup · title shortened'
          : `Cleanup · stage ${e.stage ?? '?'}`;
    case 'calibre':
      return 'Changed in Calibre';
    case 'shared_rename':
      return `Renamed with your edit of ${e.cause ?? 'another book'}`;
    case 'confirm':
      return 'You · confirmed as right';
    case 'copied':
      return 'Cleanup · tags copied from a removed copy';
  }
}

/** The form's fields in the order they are compared, sent and shown. */
export const FORM_FIELDS: (keyof EditValues)[] = [
  'title',
  'sort',
  'authors',
  'author_sort',
  'illustrator',
  'series',
  'publisher',
  'pubdate',
  'languages',
  'rating',
  'description',
  'tags',
  'identifiers'
];

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields whose value differs from the form's start (what a save sends). */
export function changedFields(start: EditValues, now: EditValues): (keyof EditValues)[] {
  return FORM_FIELDS.filter((f) => {
    if (f === 'tags')
      return (
        [...start.tags]
          .map((t) => t.toLowerCase())
          .sort()
          .join('|') !==
        [...now.tags]
          .map((t) => t.toLowerCase())
          .sort()
          .join('|')
      );
    if (f === 'identifiers') {
      const clean = (m: Record<string, string>) =>
        Object.entries(m)
          .filter(([, v]) => v.trim() !== '')
          .sort(([a], [b]) => (a < b ? -1 : 1));
      return !sameJson(clean(start.identifiers), clean(now.identifiers));
    }
    // A date is the day (the server compares days too).
    if (f === 'pubdate') return dateInputValue(start.pubdate) !== dateInputValue(now.pubdate);
    return !sameJson(start[f] ?? null, now[f] ?? null);
  });
}
