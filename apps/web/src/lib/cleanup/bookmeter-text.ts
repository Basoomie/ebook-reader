/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * More Bookmeter coverage (step 2): the card's types and words on /cleanup. The server's pass is
 * stage4/bookmeter-more.ts (GET /cleanup/bookmeter, its lists and the spot check).
 */
import { etaText, n, type ProgressBar } from './cleanup-text';

export type BookmeterMode = 'off' | 'analyse' | 'on';
export type BookmeterPhase =
  | 'match'
  | 'ai'
  | 'second'
  | 'stores'
  | 'propose'
  | 'spot'
  | 'write'
  | 'done';
export type BookmeterSource = 'rules' | 'ai' | 'second';

export interface BookmeterStatus {
  mode: BookmeterMode;
  pausedReason: string | null;
  pausedDetail: string | null;
  /** Stage 4's analysis and AI check are done (the pass waits for them). */
  stage4Done: boolean;
  progress: {
    run: number;
    phase: BookmeterPhase;
    books: number;
    counts: {
      looked: number;
      before: number;
      yours: number;
      hasId: number;
      notSearched: number;
      leftOut: number;
      rules: number;
      near: number;
      second: number;
      none: number;
    };
    ai: {
      items: number;
      accepted: number;
      notAccepted: number;
      wait: string | null;
      costUsd: number;
    };
    second: { books: number; asked: number; found: number };
    stores: { asked: number; answered: number; failed: number };
    propose: { proposed: number; held: number; nothing: number; yours: number };
    spot: { drawnAt: number | null; size: number };
    write: { waiting: string | null; batches: string[]; finishedAt: number | null };
    labeled: { matches: number; flagged: { calibreId: number; why: string[] }[] } | null;
    finishedAt: number | null;
  };
  bar: {
    phase: BookmeterPhase;
    done: number;
    total: number | null;
    leftMs: number | null;
    measured: boolean;
  } | null;
  books: Record<string, number>;
  proposals: Record<string, number>;
  spot: { size: number; right: number; wrong: number; open: number };
  spotPassed: boolean;
  /** Why Bookmeter can't be asked now (paused, backing off), else null. */
  siteWait: string | null;
}

export interface BookmeterMatch {
  uuid: string;
  calibreId: number;
  labeled: boolean;
  source: BookmeterSource | null;
  book: {
    calibreTitle: string | null;
    calibreAuthors: string[];
    title: string | null;
    authors: string[];
    series: string | null;
    number: number | null;
    format: string | null;
  };
  result: {
    id: string;
    title: string;
    listTitle: string | null;
    authors: string[];
    pages: number | null;
    url: string;
    query: string;
  };
  reason: string | null;
  ai: { model: string | null; answer: string | null; reason: string | null }[] | null;
  storesFailed: boolean;
  proposal: { state: string; added: Record<string, string>; reason: string | null } | null;
  verdict?: 'right' | 'wrong' | null;
}

export const BOOKMETER_MODE_LABELS: Record<BookmeterMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const BOOKMETER_HINTS: Record<BookmeterMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Preview: finds the new matches, asks the AI check, searches again and reads the store lists. Nothing is changed in Calibre.',
  on: 'Writes the new store links to Calibre in batches (Undo per batch in the batches list).'
};

export const BOOKMETER_PHASES: Record<BookmeterPhase, string> = {
  match: 'Deciding the stored search answers again',
  ai: 'The AI check on the near misses',
  second: 'Searching again for books with no results',
  stores: 'Reading the store lists',
  propose: 'Proposing the store links',
  spot: 'The spot check',
  write: 'Writing to Calibre',
  done: 'Done'
};

export const SOURCE_LABELS: Record<BookmeterSource, string> = {
  rules: 'the rules',
  ai: 'the AI check',
  second: 'the second search'
};

/** The phase's bar: done of total, and the time left (counted at most until measured). */
export function bookmeterBar(s: BookmeterStatus | null): ProgressBar | null {
  const b = s?.bar;
  if (!s || !b || s.mode === 'off') return null;
  const order: BookmeterPhase[] = ['match', 'ai', 'second', 'stores', 'propose'];
  const step = order.indexOf(b.phase);
  const label =
    `Step ${step + 1} of ${order.length}: ${BOOKMETER_PHASES[b.phase]}` +
    (b.total ? ` (${n(b.done)} of ${n(b.total)})` : b.done ? ` (${n(b.done)})` : '');
  const fraction = b.total ? Math.min(1, b.done / b.total) : 0;
  const eta =
    b.leftMs === null
      ? null
      : b.measured
        ? etaText(b.leftMs)
        : `${etaText(b.leftMs)} (counted at Bookmeter's pace until measured)`;
  return { label, fraction, eta };
}

/** The card's lines: what was found, by source, and what is left alone. */
export function bookmeterLines(s: BookmeterStatus | null): string[] {
  if (!s) return [];
  const p = s.progress;
  const c = p.counts;
  const out: string[] = [];
  if (!s.stage4Done && s.mode !== 'off')
    out.push('Waits for stage 4 (its analysis and the AI check) to finish.');
  if (c.looked > 0)
    out.push(
      `Looked at ${n(c.looked)} of ${n(p.books)} books: ${n(c.before)} already matched (kept), ` +
        `${n(c.rules)} new by the rules, ${n(c.near)} near misses for the AI check, ` +
        `${n(c.second)} with no results to search again, ${n(c.none)} without a match.`
    );
  const left = [
    c.yours ? `${n(c.yours)} with store links you edited` : null,
    c.hasId ? `${n(c.hasId)} with a Bookmeter id already` : null,
    c.leftOut ? `${n(c.leftOut)} bonus stories or omnibus editions (not searched again)` : null,
    c.notSearched ? `${n(c.notSearched)} never searched` : null
  ].filter((x): x is string => x !== null);
  if (left.length) out.push(`Left alone: ${left.join(', ')}.`);
  if (p.ai.items > 0)
    out.push(
      `AI check: ${n(p.ai.accepted)} of ${n(p.ai.items)} accepted (both models said yes)` +
        (p.ai.costUsd ? `, $${p.ai.costUsd.toFixed(2)} so far` : '') +
        '.'
    );
  if (p.second.asked > 0)
    out.push(`Second search: ${n(p.second.found)} found with ${n(p.second.asked)} searches.`);
  if (p.stores.asked > 0)
    out.push(
      `Store lists: ${n(p.stores.answered)} of ${n(p.stores.asked)} read` +
        (p.stores.failed ? ` (${n(p.stores.failed)} failed: the Bookmeter id alone)` : '') +
        '.'
    );
  const pr = s.proposals;
  if ((pr.proposed ?? 0) + (pr.applied ?? 0) + (pr.queued ?? 0) > 0)
    out.push(
      `Store links: ${n(pr.proposed ?? 0)} books to write, ${n(pr.applied ?? 0)} written` +
        ((pr.skipped ?? 0) ? `, ${n(pr.skipped)} set aside` : '') +
        ((pr.undone ?? 0) ? `, ${n(pr.undone)} undone` : '') +
        '.'
    );
  if (p.propose.held)
    out.push(`${n(p.propose.held)} wait: another change of their store links is still open.`);
  if (p.labeled)
    out.push(
      `Labeled books: ${n(p.labeled.matches)} new matches; ${n(p.labeled.flagged.length)} flagged by the checker for a look.`
    );
  return out;
}

/** The spot check's line. */
export function spotLine(s: BookmeterStatus | null): string {
  if (!s || s.spot.size === 0) return '';
  const marked = s.spot.size - s.spot.open;
  const base = `Spot check: ${n(marked)} of ${n(s.spot.size)} marked, ${n(s.spot.wrong)} wrong.`;
  if (s.spot.open > 0) return `${base} On needs every book marked and at most 1 wrong.`;
  return s.spotPassed
    ? `${base} Passed: On can be switched on.`
    : `${base} More than 1 wrong: On stays off (the rules are looked at again).`;
}

/** "the rules", "the AI check (both models said yes)", "the second search (Q2)". */
export function sourceText(m: BookmeterMatch): string {
  if (!m.source) return '';
  if (m.source === 'second')
    return `${SOURCE_LABELS.second} (${m.result.query === 'q2' ? 'title and author' : 'title without its subtitle'})`;
  return SOURCE_LABELS[m.source];
}

/** The ids the match adds, as "bookmeter 123, isbn 978…". */
export function addedText(m: BookmeterMatch): string {
  const a = m.proposal?.added ?? {};
  const keys = Object.keys(a);
  return keys.length ? keys.map((k) => `${k} ${a[k]}`).join(', ') : 'nothing to add';
}
