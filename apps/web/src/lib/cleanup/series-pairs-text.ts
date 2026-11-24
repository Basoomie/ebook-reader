/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Series under a short and a full name on /cleanup (tier 4, Part 3): the card's words and the
 * review list's lines. Pure: the server's answers in, text out.
 */

export type SeriesPairsMode = 'off' | 'analyse' | 'on';
export type SeriesPairsPhase = 'pairs' | 'signals' | 'propose' | 'write' | 'done';
export type SeriesPairsView = 'review' | 'merge' | 'separate' | 'decided';
export type SeriesPairChoice = 'merge' | 'separate' | 'clear';
export type SeriesPairAnswer = 'merge' | 'separate' | 'review';

export interface SeriesPairsStatus {
  mode: SeriesPairsMode;
  pausedReason: string | null;
  stage4Done: boolean;
  analysisId: string;
  progress: {
    run: number;
    phase: SeriesPairsPhase;
    pairs: number;
    done: number;
    counts: Record<SeriesPairAnswer, number>;
    propose: { books: number; pairs: number; yours: number };
    write: { batches: string[]; waiting: string | null; repointed: number; closed: number };
    finishedAt: number | null;
    error: string | null;
  };
  bar: { label: string; done: number; total: number; leftMs: number | null } | null;
  proposals: Record<string, number>;
}

export interface SeriesPairBook {
  uuid: string;
  calibreId: number;
  title: string;
  authors: string[];
  index: number | null;
  kind: string;
  links: { site: string; url: string }[];
}

export interface SeriesPairSignals {
  collisions: number;
  collisionsWithin: number;
  collisionExamples: string[];
  sharedAuthors: string[];
  longWithShortAuthor: number;
  ranobedb: 'same' | 'different' | 'none';
  amazon: 'same' | 'different' | 'none';
  storeNamesOther: boolean;
  spinoff: string | null;
  mixed: 'short' | 'long' | 'both' | null;
}

export interface SeriesPair {
  id: number;
  short: string;
  long: string;
  group: string;
  added: string;
  kept: string;
  shortBooks: number;
  longBooks: number;
  answer: SeriesPairAnswer | null;
  rule: string | null;
  held: string | null;
  note: string | null;
  signals: SeriesPairSignals | null;
  books: { short: SeriesPairBook[]; long: SeriesPairBook[] };
  decision: {
    decision: 'different' | 'merged';
    by: string;
    note: string | null;
    at: number;
  } | null;
  merge: Record<string, number>;
}

export const SERIES_PAIRS_MODE_LABELS: Record<SeriesPairsMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const SERIES_PAIRS_HINTS: Record<SeriesPairsMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Preview: finds the series under two names, answers each pair and lists the merges. Nothing is changed in Calibre.',
  on: 'Writes the merges to Calibre in batches through stage 4 (Undo per batch in the batches list).'
};

export const SERIES_PAIRS_PHASES: Record<SeriesPairsPhase, string> = {
  pairs: 'Finding the pairs',
  signals: 'Reading each pair’s books and stores',
  propose: 'Listing the merges',
  write: 'Writing the merges',
  done: 'Done'
};

export const SERIES_PAIRS_VIEWS: { view: SeriesPairsView; label: string }[] = [
  { view: 'review', label: 'To decide' },
  { view: 'merge', label: 'Merged' },
  { view: 'separate', label: 'Kept separate' },
  { view: 'decided', label: 'Your choices' }
];

const n = (x: number) => x.toLocaleString('en-US');

/** The card's lines: what Preview found and what On wrote. */
export function seriesPairsLines(s: SeriesPairsStatus | null): string[] {
  if (!s || s.mode === 'off') return [];
  const p = s.progress;
  const out: string[] = [];
  if (p.error) out.push(`Stopped: ${p.error}`);
  if (p.phase !== 'pairs' && p.pairs > 0) {
    const c = p.counts;
    out.push(
      `${n(p.pairs)} pairs: ${n(c.merge)} to merge, ${n(c.separate)} kept separate, ${n(c.review)} for you to decide.`
    );
  }
  const written = (s.proposals.applied ?? 0) + (s.proposals.skipped ?? 0);
  const left = (s.proposals.proposed ?? 0) + (s.proposals.queued ?? 0);
  if (written + left > 0)
    out.push(
      `Books moved into the kept name: ${n(written)} written, ${n(left)} to write${(s.proposals.undone ?? 0) > 0 ? `, ${n(s.proposals.undone ?? 0)} undone` : ''}.`
    );
  if (p.write.closed + p.write.repointed > 0)
    out.push(
      `Stage 4’s open series changes of those books: ${n(p.write.closed)} done by the merge, ${n(p.write.repointed)} now name the kept series.`
    );
  return out;
}

/** The bar: label, fraction and the time left. */
export function seriesPairsBar(
  s: SeriesPairsStatus | null
): { label: string; fraction: number; eta: string | null } | null {
  const b = s?.bar;
  if (!b || b.total <= 0) return null;
  const mins = b.leftMs === null ? null : Math.ceil(b.leftMs / 60000);
  return {
    label: `${SERIES_PAIRS_PHASES[s!.progress.phase]}: ${n(b.done)} of ${n(b.total)} ${b.label}`,
    fraction: Math.min(1, b.done / b.total),
    eta: mins === null ? null : mins <= 1 ? 'about a minute left' : `about ${n(mins)} minutes left`
  };
}

const RULE_TEXT: Record<string, string> = {
  'ranobedb-different': 'RanobeDB lists them as two series',
  'no-shared-author': 'No author in common',
  'spinoff-not-omnibus': 'The full name adds a spin-off word',
  'store-same': 'A store lists both as one series',
  'series-word': 'Only シリーズ added, same author',
  'spelled-series-word': 'Only シリーズ and brackets added, same author',
  subtitle: 'Only a 〜subtitle〜 added, same author'
};

const HELD_TEXT: Record<string, string> = {
  collision: 'Not merged: a book of each name has the same number',
  mixed: 'Not merged: the stores file one name’s books under more than one series',
  yours: 'Not merged: you edited a series of one of these books',
  check: 'Not merged: the check could not confirm it'
};

/** Why the pair has its answer, in a line. */
export function pairReason(p: SeriesPair): string {
  if (p.decision?.by === 'you')
    return p.decision.decision === 'merged' ? 'You chose: merge' : 'You chose: keep separate';
  if (p.held)
    return `${HELD_TEXT[p.held] ?? p.held}${p.rule && RULE_TEXT[p.rule] ? ` (${RULE_TEXT[p.rule]})` : ''}`;
  if (p.rule?.startsWith('decided:'))
    return p.decision?.decision === 'different'
      ? 'Not the same series (series editor)'
      : 'Merged before';
  if (p.rule) return RULE_TEXT[p.rule] ?? p.rule;
  return 'No rule decides this pair';
}

/** The evidence, one short line. */
export function pairSignalsLine(p: SeriesPair): string {
  const s = p.signals;
  if (!s) return '';
  const store = (v: 'same' | 'different' | 'none', name: string) =>
    v === 'same' ? `${name}: one series` : v === 'different' ? `${name}: two series` : null;
  return [
    s.sharedAuthors.length
      ? `Same author (${s.sharedAuthors.slice(0, 2).join(', ')})`
      : 'No author in common',
    store(s.ranobedb, 'RanobeDB'),
    store(s.amazon, 'Amazon'),
    s.spinoff ? `「${s.spinoff}」` : null,
    s.collisions ? `${n(s.collisions)} number${s.collisions > 1 ? 's' : ''} both names use` : null
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Merge is refused where two books would share a number; the button says why. */
export function mergeBlocked(p: SeriesPair): string | null {
  if (!p.signals) return 'Not read yet';
  if (p.signals.collisions > 0)
    return 'Two books would share a number: set their numbers in the series editor first';
  return null;
}

/** A book's line in the list: number, title, authors. */
export function bookLine(b: SeriesPairBook): string {
  const num =
    b.index === null ? '' : `#${Number.isInteger(b.index) ? b.index : b.index.toFixed(1)} `;
  return `${num}${b.title}${b.authors.length ? ` — ${b.authors.slice(0, 2).join(', ')}` : ''}`;
}

/** The Library search for one series name, or null when the name can't be put in quotes. */
export function seriesQuery(name: string): string | null {
  return name.includes('"') ? null : `series:"${name}"`;
}
