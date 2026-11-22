/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Book summaries: a summary as the server stores it (apps/storage-server/src/summaries/types.ts).
 * Session 2 shows it on the accuracy test's pages; session 4 on the book page.
 */

export interface SummaryItem {
  ref: string;
  text: string;
  /** Characters and Terms: the bold heading. */
  heading?: string;
  /** Relationships: the two people. */
  between?: [string, string];
  cites: string[];
  quote: string | null;
  position: number | null;
  showQuote: boolean;
}

export type SummarySectionKey =
  | 'overview'
  | 'chapters'
  | 'characters'
  | 'relationships'
  | 'terms'
  | 'threads';

export interface SummarySection {
  key: SummarySectionKey;
  groups: { chapter?: number; title?: string; items: SummaryItem[] }[];
}

export interface Summary {
  lang: string;
  bookTitle: string;
  models: string[];
  madeAt: number;
  sections: SummarySection[];
  alsoMentioned: string[];
}

/** The tabs of a summary, in the approved order (only those with content are shown). */
export const SUMMARY_TABS: { key: SummarySectionKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'chapters', label: 'Chapter by chapter' },
  { key: 'characters', label: 'Characters' },
  { key: 'relationships', label: 'Relationships' },
  { key: 'terms', label: 'Terms' },
  { key: 'threads', label: 'Open threads' }
];

/** The accuracy test's marks on a summary item (session 2). */
export type ItemMark = 'right' | 'mistake' | 'not_needed' | 'unsure';
export const ITEM_MARKS: { value: ItemMark; label: string }[] = [
  { value: 'right', label: 'Right' },
  { value: 'mistake', label: 'Has a mistake' },
  { value: 'not_needed', label: 'Not needed' },
  { value: 'unsure', label: 'Unsure' }
];

/** "Chapter 3 · 41 %": where a quote is, from its reader position. */
export function quotePlace(
  position: number,
  chapters: { index: number; title?: string; start: number }[],
  characters: number
): string {
  const ch = [...chapters].reverse().find((c) => c.start <= position);
  const percent = characters ? Math.round((position / characters) * 100) : 0;
  return ch ? `${ch.title || `Chapter ${ch.index + 1}`} · ${percent} %` : `${percent} %`;
}
