/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { RecapCoverage, RecapStaleWhy, SeriesRecapRecord } from './summary-api';
import type { SummaryBlur } from './settings';
import { minutesSince, summaryDate, type MakingProgress } from './summary-page';

/**
 * The series recap, "story so far", on the series page (book summaries session 5): the words
 * and decisions its panel shows, kept pure so they are tested on their own.
 */

/** "vol. 2", or the title when the volume has no number. */
export function volumeWord(v: { label: string | null; title: string }): string {
  return v.label !== null ? `vol. ${v.label}` : v.title;
}

/** "Vol. 2 · <title>", or the title alone without a number. */
export function volumeHeading(v: { label: string | null; title: string }): string {
  return v.label !== null ? `Vol. ${v.label} · ${v.title}` : v.title;
}

/** "vols. 1–5" from the first and last volume (a volume without a number: its title). */
export function volumeRange(vols: { label: string | null; title: string }[]): string {
  if (!vols.length) return '';
  const first = vols[0];
  const last = vols[vols.length - 1];
  if (vols.length === 1) return volumeWord(first);
  if (first.label !== null && last.label !== null) return `vols. ${first.label}–${last.label}`;
  return `${volumeWord(first)} to ${volumeWord(last)}`;
}

/** "Built from the summaries of vols. 1–5 · updated 23 Nov 2026" (no model name: approved). */
export function recapMeta(
  r: { volumes: { label: string | null; title: string }[]; madeAt: number },
  locale?: string
): string {
  return `Built from the summaries of ${volumeRange(r.volumes)} · updated ${summaryDate(r.madeAt, locale)}`;
}

function list(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * Where a character or term first appears ("from vol. 2"), or since when a thread is open
 * ("since vol. 2"). When an earlier covered volume has no summary, it can't be known that it
 * appears no earlier: "in the summaries from vol. 2".
 */
export function sinceText(
  since: { label: string | null; title: string; gap: boolean },
  kind: 'from' | 'since' = 'from'
): string {
  const v = volumeWord(since);
  if (since.gap) return `in the summaries ${kind === 'since' ? 'since' : 'from'} ${v}`;
  return `${kind} ${v}`;
}

/**
 * The recap starts blurred (decided with the user 2026-11-23): with "Completed books", unless
 * every volume it covers has the status Completed now.
 */
export function recapHidden(blur: SummaryBlur | string, statuses: (string | undefined)[]): boolean {
  if (blur === 'always') return true;
  if (blur === 'never') return false;
  return statuses.some((s) => s !== 'completed');
}

const STALE_WORDS: Record<RecapStaleWhy, (v: string) => string> = {
  not_in_recap: (v) => `${v} isn’t in it yet`,
  left: (v) => `${v} is no longer one of its volumes`,
  summary_added: (v) => `${v}’s summary isn’t in it yet`,
  summary_deleted: (v) => `${v}’s summary was deleted since`,
  changed: (v) => `${v}’s summary changed since`
};

/**
 * The note of what the recap covers (user, 2026-11-23): which volumes, which of them have no
 * summary (linked), and what isn't in it yet.
 */
export interface CoverageNote {
  /** "Covers vols. 1–5." (the recap's volumes when there is one, else the series' now). */
  covers: string;
  /** "Built from the summaries of vols. 1, 2, 4 and 5." when some have none. */
  builtFrom: string | null;
  /** The volumes without a summary, each to be linked to its book page. */
  missing: { bookId: string; word: string }[];
  /** "Not in it yet: vol. 6 isn’t in it yet; vol. 2’s summary changed since." */
  stale: string[];
}

export function coverageNote(
  recapVolumes: { bookId: string; label: string | null; title: string; missing: boolean }[] | null,
  coverage: RecapCoverage
): CoverageNote {
  const vols = recapVolumes ?? coverage.volumes.map((v) => ({ ...v, missing: !v.hasSummary }));
  const missing = vols
    .filter((v) => v.missing)
    .map((v) => ({ bookId: v.bookId, word: volumeWord(v) }));
  const withSummary = vols.filter((v) => !v.missing);
  const stale = recapVolumes
    ? [
        ...coverage.stale.map((s) => STALE_WORDS[s.why](volumeWord(s))),
        ...(coverage.orderChanged ? ['the order of the volumes changed since'] : [])
      ]
    : [];
  return {
    covers: vols.length ? `Covers ${volumeRange(vols)}.` : '',
    builtFrom:
      missing.length && withSummary.length
        ? `Built from the summaries of ${withSummary.length > 1 ? 'vols.' : 'vol.'} ${list(
            withSummary.map((v) => (v.label !== null ? v.label : v.title))
          )}.`
        : null,
    missing,
    stale
  };
}

/** The panel's state, in the order it is decided. */
export type RecapStateKind =
  | 'nothing_completed'
  | 'too_few'
  | 'none'
  | 'making'
  | 'waiting'
  | 'failed'
  | 'offline_none'
  | 'shown';

export function recapState(o: {
  hasRecap: boolean;
  record: Pick<SeriesRecapRecord, 'making' | 'outcome'> | null;
  coverage: Pick<RecapCoverage, 'volumes' | 'enough'> | null;
  offline: boolean;
}): RecapStateKind[] {
  const out: RecapStateKind[] = [];
  if (o.record?.making === 'running') out.push('making');
  else if (o.record?.making === 'queued') out.push('waiting');
  else if (o.record?.outcome === 'failed') out.push('failed');
  if (o.hasRecap) out.push('shown');
  else if (!o.record?.making) {
    if (o.offline || !o.coverage) out.push('offline_none');
    else if (!o.coverage.volumes.length) out.push('nothing_completed');
    else if (!o.coverage.enough) out.push('too_few');
    else if (o.record?.outcome !== 'failed') out.push('none');
  }
  return out;
}

const STEPS: { phase: string; text: string; value: number }[] = [
  { phase: 'writing', text: 'Step 1 of 2: writing from the volume summaries', value: 30 },
  { phase: 'checking', text: 'Step 2 of 2: checking every point against them', value: 75 }
];

/** While the recap is being made: the step, a bar by step and the time so far. */
export function recapProgress(
  r: Pick<SeriesRecapRecord, 'making' | 'phase' | 'since' | 'due'>,
  now: number
): MakingProgress | null {
  if (!r.making) return null;
  if (r.making === 'queued') {
    const mins = r.due ? Math.ceil((r.due - now) / 60_000) : 0;
    return mins > 0
      ? {
          text: `Updates in about ${mins} min`,
          waiting: null,
          value: 0,
          time: '',
          note: 'It waits until the volume summaries stop changing.'
        }
      : { text: 'Waiting to start', waiting: null, value: 0, time: '', note: '' };
  }
  const step = STEPS.find((s) => s.phase === r.phase) ?? STEPS[0];
  const mins = minutesSince(r.since, now);
  return {
    text: step.text,
    waiting: null,
    value: step.value,
    time: mins === null ? '' : mins < 1 ? 'just started' : `${mins} min`,
    note: ''
  };
}
