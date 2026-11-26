/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Bookmeter links: the card's types and words on /cleanup. The server's pass is
 * stage4/bookmeter-listing.ts (GET /cleanup/bookmeter-links, its lists and the spot check).
 */
import { etaText, n, type ProgressBar } from './cleanup-text';

export type ListingsMode = 'off' | 'analyse' | 'on';
export type ListingsPhase = 'search' | 'propose' | 'spot' | 'write' | 'done';
export type ListingState =
  | 'search'
  | 'keep'
  | 'change'
  | 'adaptation'
  | 'unseen'
  | 'unsearched'
  | 'ai'
  | 'nofacts'
  | 'yours';

export interface ListingsStatus {
  mode: ListingsMode;
  pausedReason: string | null;
  pausedDetail: string | null;
  stage4Done: boolean;
  progress: {
    run: number;
    phase: ListingsPhase;
    books: number;
    search: {
      looked: number;
      asked: number;
      answered: number;
      enqueued: boolean;
      failed: number;
      gone?: number;
      noAuthor?: number;
      /** Second look: authors to walk, walks ended, pages read, books decided after their walk. */
      authors?: number;
      walked?: number;
      pages?: number;
      decided?: number;
    };
    propose: {
      total: number;
      done: number;
      proposed: number;
      held: number;
      yours: number;
      gone: number;
      removed?: number;
    };
    spot: { drawnAt: number | null; size: number };
    write: { rebuilt: boolean; batches: string[]; waiting: string | null };
    labeled: { changes: number; flagged: { calibreId: number; why: string[] }[] } | null;
    finishedAt: number | null;
  };
  bar: { phase: ListingsPhase; done: number; total: number | null; leftMs: number | null };
  /** Books by state. */
  books: Record<string, number>;
  /** Books whose search Bookmeter refused and that wait to be asked again. */
  refusedOpen?: number;
  proposals: Record<string, number>;
  spot: { size: number; right: number; wrong: number; open: number };
  spotPassed: boolean;
  spotSize: number;
  /** Why Bookmeter's requests wait now (a pause after refusals), else null. */
  siteWait: string | null;
}

export interface ListingRef {
  id: string;
  url: string;
  title?: string;
  authors?: string[];
  registrations?: number | null;
}

export interface ListingItem {
  uuid: string;
  calibreId: number;
  labeled: boolean;
  state: ListingState;
  book: { title: string | null; authors: string[]; decidedTitle: string | null };
  saved: ListingRef;
  pick: ListingRef | null;
  savedGuard: 'comic' | 'adaptation' | null;
  proposal: string | null;
  verdict?: 'right' | 'wrong' | null;
}

export const LISTINGS_MODE_LABELS: Record<ListingsMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const LISTINGS_HINTS: Record<ListingsMode, string> = {
  off: 'Off: nothing is looked at.',
  analyse:
    'Preview: reads the 読書メーター listings of the author of every book with a saved link (most registered first, at its usual pace) and proposes the listing most readers registered, where it is the same book. Nothing is written.',
  on: 'On: the changed links are written to Calibre in batches through stage 4. Only the 読書メーター id changes; every other id stays as it is.'
};

export const LISTINGS_PHASES: Record<ListingsPhase, string> = {
  search: 'Reading the authors’ listings on 読書メーター',
  propose: 'Preparing the changes',
  spot: 'The spot check waits for you',
  write: 'Writing the links to Calibre',
  done: 'Done'
};

/** The folded lists on the card, in order, with their headings. */
export const LISTING_LISTS: { state: ListingState; label: string; note: string }[] = [
  {
    state: 'change',
    label: 'Links to change',
    note: 'The saved listing, and the one the link goes to instead.'
  },
  {
    state: 'adaptation',
    label: 'Saved links to a comic or an adaptation',
    note: 'No listing of the book itself was found. Nothing here is changed: open the listing, and to fix one, edit the book’s details.'
  },
  {
    state: 'unsearched',
    label: 'Books 読書メーター could not search',
    note: 'It answered their search "not found". Nothing here is changed; "Look again from the start" asks again.'
  },
  {
    state: 'unseen',
    label: 'Saved listings the searches did not show',
    note: 'Their reader count is not known, so nothing is changed.'
  }
];

export const GUARD_TEXT: Record<'comic' | 'adaptation', string> = {
  comic: 'the saved listing is a comic edition',
  adaptation: 'the saved listing is an adaptation (the author named as 原作)'
};

/** "123 registered" or "registered count not shown". */
export function registeredText(r: ListingRef | null | undefined): string {
  if (!r) return '';
  return typeof r.registrations === 'number'
    ? `${n(r.registrations)} registered`
    : 'registered count not shown';
}

/** The step's bar: "Step 1 of 2: … (1,200 of 36,000)" with the time left. */
export function listingsBar(s: ListingsStatus | null): ProgressBar | null {
  const b = s?.bar;
  if (!s || !b || s.mode === 'off') return null;
  if (b.phase === 'spot' || b.phase === 'done') return null;
  const order: ListingsPhase[] = ['search', 'propose'];
  const step = order.indexOf(b.phase);
  const queuing = b.phase === 'search' && !s.progress.search.enqueued;
  const label =
    (step < 0
      ? LISTINGS_PHASES[b.phase]
      : `Step ${step + 1} of ${order.length}: ${queuing ? 'Queuing the books by author' : LISTINGS_PHASES[b.phase]}`) +
    (b.total ? ` (${n(b.done)} of ${n(b.total)})` : b.done ? ` (${n(b.done)})` : '');
  return {
    label,
    fraction: b.total ? Math.min(1, b.done / b.total) : 0,
    eta: b.leftMs === null ? null : etaText(b.leftMs)
  };
}

/** The card's lines: what was looked at, what changes, what is left alone and why. */
export function listingsLines(s: ListingsStatus | null): string[] {
  if (!s) return [];
  const p = s.progress;
  const c = (k: ListingState) => s.books[k] ?? 0;
  const out: string[] = [];
  if (!s.stage4Done && s.mode !== 'off')
    out.push('Waits for stage 4 (its analysis and the AI check) to finish.');
  if (s.siteWait && p.phase === 'search') out.push(`読書メーター's requests wait: ${s.siteWait}.`);
  if (p.search.looked > 0)
    out.push(
      `Looked at ${n(p.search.looked)} of ${n(p.books)} books with a saved link; ${n(p.search.asked)} wait for their author’s listings, ${n(p.search.decided ?? 0)} decided.`
    );
  if (p.search.enqueued && p.search.authors)
    out.push(
      `Read the listings of ${n(p.search.walked ?? 0)} of ${n(p.search.authors)} authors (${n(p.search.pages ?? 0)} ${p.search.pages === 1 ? 'page' : 'pages'}).`
    );
  if (s.refusedOpen)
    out.push(
      `${n(s.refusedOpen)} ${s.refusedOpen === 1 ? 'author’s page was' : 'authors’ pages were'} refused by 読書メーター and ${s.refusedOpen === 1 ? 'waits' : 'wait'} to be asked again (10 minutes, then longer each time). No book is decided until its author’s listings are read.`
    );
  if (p.search.noAuthor)
    out.push(
      `${n(p.search.noAuthor)} ${p.search.noAuthor === 1 ? 'book has' : 'books have'} no author to search with: decided from the earlier searches.`
    );
  const decided = c('keep') + c('change') + c('adaptation') + c('unseen') + c('unsearched');
  if (decided > 0)
    out.push(
      `Decided: ${n(c('change'))} to change, ${n(c('keep'))} already the listing most readers registered` +
        (c('adaptation') ? `, ${n(c('adaptation'))} saved to a comic or an adaptation` : '') +
        (c('unseen') ? `, ${n(c('unseen'))} whose saved listing the searches did not show` : '') +
        (c('unsearched') ? `, ${n(c('unsearched'))} 読書メーター could not search` : '') +
        '.'
    );
  const left = [
    c('ai') ? `${n(c('ai'))} the AI check matched` : null,
    c('yours') ? `${n(c('yours'))} with store links you edited` : null,
    c('nofacts') ? `${n(c('nofacts'))} without stage 4's answers` : null
  ].filter((x): x is string => x !== null);
  if (left.length) out.push(`Left alone: ${left.join(', ')}.`);
  const pr = s.proposals;
  if ((pr.proposed ?? 0) + (pr.applied ?? 0) + (pr.queued ?? 0) > 0)
    out.push(
      `Links: ${n((pr.proposed ?? 0) + (pr.queued ?? 0))} to write, ${n(pr.applied ?? 0)} written` +
        ((pr.skipped ?? 0) ? `, ${n(pr.skipped)} set aside` : '') +
        ((pr.undone ?? 0) ? `, ${n(pr.undone)} undone` : '') +
        '.'
    );
  if (p.propose.held)
    out.push(`${n(p.propose.held)} wait: another change of their store links is still open.`);
  if (p.propose.gone)
    out.push(`${n(p.propose.gone)} not changed: their saved link changed since the search.`);
  if (p.propose.removed)
    out.push(
      `${n(p.propose.removed)} not changed: no longer in Calibre (removed since the search).`
    );
  if (p.labeled)
    out.push(
      `Labeled books: ${n(p.labeled.changes)} links change; ${n(p.labeled.flagged.length)} flagged by the checker for a look.`
    );
  return out;
}

/** The spot check's line. */
export function listingsSpotLine(s: ListingsStatus | null): string {
  if (!s || s.spot.size === 0) return '';
  const marked = s.spot.size - s.spot.open;
  const base = `Spot check: ${n(marked)} of ${n(s.spot.size)} marked, ${n(s.spot.wrong)} wrong.`;
  if (s.spot.wrong > 0)
    return `${base} A wrong change was found: On stays off (the rules are looked at again).`;
  if (s.spot.open > 0) return `${base} On needs every book marked and none wrong.`;
  return s.mode === 'on' ? `${base} Passed.` : `${base} Passed: On can be switched on.`;
}
