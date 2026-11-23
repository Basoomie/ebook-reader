/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Texts of the Audiobooks tab's stage 8 card (WP21g: the second pass from the Calibre ebooks).
 * Pure.
 */
import type { AudioStage8Progress, EbookGate } from './cleanup-api';
import { eta, n, type ProgressBar } from './cleanup-text';

export const STAGE8_HINTS: Record<'off' | 'analyse' | 'on', string> = {
  off: 'Off: nothing runs. In Preview, each daily run (stage 7) pairs every audiobook with its exact Calibre volume and lists what would change; nothing is written.',
  analyse:
    'Preview: each daily run pairs the audiobooks with their Calibre volumes (by title, author and printed volume) and lists the genres, tags and series each would get. Calibre is only read; nothing changes in the library or Audiobookshelf.',
  on: 'On: each daily run gives the paired audiobooks their ebooks’ genres and tags, and Calibre’s series where an audiobook has none from a store; a book that gains a series moves into its series folder, never while someone is listening to it. Your Audiobookshelf edits stay yours.'
};

export const MODE_LABEL_ON_8 = 'On (write)';

const PHASES: Record<string, string> = {
  check: 'Checking whether Calibre or the recordings changed',
  read: 'Reading the Calibre library (its snapshot copy)',
  pair: 'Pairing the recordings with their ebooks',
  values: 'Genres, tags and series of the pairs',
  covers: 'Reading the paired ebooks’ covers',
  gate: 'Checking the labeled recordings',
  preview: 'What would change in the library',
  done: 'Done'
};

export const SOURCE_LABELS: Record<string, string> = {
  audible: 'Audible',
  audiobookjp: 'audiobook.jp',
  kikubon: 'kikubon',
  no_record: 'No store record',
  ai: 'AI books',
  radio: 'Radio clips'
};

export function stage8PhaseLabel(phase: string): string {
  return PHASES[phase] ?? phase;
}

/** The pass's bar (with time left), or null when it isn't running. */
export function stage8Bar(
  p: AudioStage8Progress | null | undefined,
  now: number
): ProgressBar | null {
  if (!p || p.phase === 'done' || p.finishedAt) return null;
  const label = stage8PhaseLabel(p.phase);
  if (p.waiting)
    return { label: `${label}: ${p.waiting}`, fraction: p.total ? p.done / p.total : 0, eta: null };
  const unit =
    p.phase === 'read'
      ? 'pages'
      : p.phase === 'pair'
        ? 'recordings'
        : p.phase === 'covers'
          ? 'covers'
          : p.phase === 'preview'
            ? 'books'
            : '';
  return {
    label: `${label}${p.total ? `: ${n(p.done)} of ${n(p.total)}${unit ? ` ${unit}` : ''}` : ''}`,
    fraction: p.total ? Math.min(1, p.done / p.total) : 0,
    eta: p.total ? eta(p.done, p.total, p.phaseStartedAt, 0, now) : null
  };
}

/** The card's summary line. */
export function stage8Summary(p: AudioStage8Progress | null | undefined): string {
  if (!p) return 'Not run yet: it runs with stage 7’s daily run (or Run now).';
  const c = p.counts;
  const parts = [
    `${n(c.auto)} paired`,
    `${n(c.review)} to review`,
    `${n(c.none)} without their volume in Calibre`,
    `${n(c.excluded)} not paired (AI books, radio clips, drama CDs)`
  ];
  return parts.join(' · ');
}

/** What the pairs give (genres, tags, series). */
export function valueLines(p: AudioStage8Progress | null | undefined): string[] {
  if (!p) return [];
  const v = p.values;
  const out = [
    `Genres for ${n(v.genres)} recordings, tags for ${n(v.tags)}${v.noTerms ? ` (${n(v.noTerms)} paired ebooks have none)` : ''}.`,
    `Series from Calibre: ${n(v.series)} filled, ${n(v.seriesReview)} to review${v.seriesDisagree ? `, ${n(v.seriesDisagree)} where the store’s series differs (shown only)` : ''}.`
  ];
  if (p.covers.read || p.covers.missing)
    out.push(
      `Covers kept in cleanup.db (path and SHA-256): ${n(p.covers.read)}${p.covers.missing ? `, ${n(p.covers.missing)} without a cover` : ''}.`
    );
  if (p.ebooks.total)
    out.push(
      `Calibre: ${n(p.ebooks.total)} books${p.ebooks.new || p.ebooks.changed || p.ebooks.removed ? ` (since the last pass: ${n(p.ebooks.new)} new, ${n(p.ebooks.changed)} changed, ${n(p.ebooks.removed)} removed)` : ''}.`
    );
  if (p.reason) out.push(`This pass: ${p.reason}.`);
  return out;
}

/** The Preview's lines (what would change in the library). */
export function previewLines(p: AudioStage8Progress | null | undefined): string[] {
  const v = p?.preview;
  if (!v) return [];
  return [
    `Would change ${n(v.changes)} books in the library: ${n(v.metadata)} metadata.json, ${n(v.moves)} moved into a series folder${v.held ? `, ${n(v.held)} moves held while someone listens` : ''}${v.reviews ? `; ${n(v.reviews)} with something to look at` : ''}.`
  ];
}

/** The gate's lines: found and right per kind of recording. */
export function gateLines(g: EbookGate | null | undefined): string[] {
  if (!g) return ['The labeled recordings are checked at the end of each pass.'];
  if (g.error) return [`The gate can’t be checked: ${g.error}`];
  const out = [
    g.passed
      ? `Gate passed: no wrong automatic pair on ${n(g.labels)} labeled recordings.`
      : `Gate failed: ${n(g.wrong.length)} wrong automatic pair${g.wrong.length === 1 ? '' : 's'}${g.notFound.length ? `, ${n(g.notFound.length)} labeled recordings not found` : ''} (${n(g.labels)} labeled).`
  ];
  for (const [kind, k] of Object.entries(g.kinds))
    out.push(
      `${SOURCE_LABELS[kind] ?? kind}: ${n(k.found)} of ${n(k.withEbook)} found, ${n(k.right)} right${k.wrong ? `, ${n(k.wrong)} wrong` : ''}; ${n(k.noneRight)} of ${n(k.none)} without an ebook left unpaired${k.review ? `; ${n(k.review)} to review` : ''}`
    );
  return out;
}

export const EBOOK_LISTS: { id: string; label: string }[] = [
  { id: 'review', label: 'Pairs to review' },
  { id: 'series-review', label: 'Series to review' },
  { id: 'auto', label: 'Paired' },
  { id: 'terms', label: 'Genres and tags per book' },
  { id: 'series-fill', label: 'Series from Calibre' },
  { id: 'series-disagree', label: 'Store series that differ from Calibre’s' },
  { id: 'preview', label: 'What would change in the library' },
  { id: 'none', label: 'No volume in Calibre' },
  { id: 'excluded', label: 'Not paired (AI books, radio, drama CDs)' }
];
