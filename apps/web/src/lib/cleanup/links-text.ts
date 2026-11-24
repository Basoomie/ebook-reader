/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * More direct links: the card's types and words on /cleanup. The server's pass is
 * stage4/link-discovery.ts (GET /cleanup/links, its lists and the spot check).
 */
import { etaText, n, type ProgressBar } from './cleanup-text';

export type LinksMode = 'off' | 'analyse' | 'on';
export type LinksPhase = 'record' | 'series' | 'settle' | 'propose' | 'spot' | 'write' | 'done';
export type LinkSite = 'amazon' | 'ranobedb' | 'bookwalker';
export type LinkHow = 'record' | 'series';
export type LinkState = 'ok' | 'clash' | 'differs' | 'saved';

type PerSite = Record<LinkSite, number>;

export interface LinksStatus {
  mode: LinksMode;
  pausedReason: string | null;
  pausedDetail: string | null;
  stage4Done: boolean;
  progress: {
    run: number;
    phase: LinksPhase;
    books: number;
    record: { looked: number; yours: number; noFacts: number; picked: PerSite; taken: number };
    series: {
      total: number;
      done: number;
      picked: PerSite;
      agree: number;
      differ: number;
      saved: number;
    };
    settle: { clash: number };
    propose: {
      total: number;
      done: number;
      proposed: number;
      held: number;
      nothing: number;
      yours: number;
      natively: number;
    };
    spot: { drawnAt: number | null; size: number };
    write: { rebuilt: boolean; batches: string[]; waiting: string | null };
    labeled: {
      links: number;
      flagged: { calibreId: number; site: LinkSite; why: string[] }[];
    } | null;
    finishedAt: number | null;
  };
  bar: { phase: LinksPhase; done: number; total: number | null; leftMs: number | null };
  /** Picks by "state:site:how". */
  picks: Record<string, number>;
  proposals: Record<string, number>;
  spot: { size: number; right: number; wrong: number; open: number };
  spotPassed: boolean;
  spotSize: number;
}

export interface LinkItem {
  uuid: string;
  calibreId: number;
  labeled: boolean;
  site: LinkSite;
  how: LinkHow;
  state: LinkState;
  book: {
    title: string | null;
    authors: string[];
    series: string | null;
    number: number | null;
    decidedTitle: string | null;
  };
  store: { id: string; title: string; url: string };
  saved: { id: string; url: string } | null;
  proposal: string | null;
  verdict?: 'right' | 'wrong' | null;
}

export const LINKS_MODE_LABELS: Record<LinksMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const LINKS_HINTS: Record<LinksMode, string> = {
  off: 'Off: nothing is looked at.',
  analyse:
    'Preview: looks through the store pages the cleanup already found for books without a direct link, and proposes the ones that are the same book. Nothing is fetched and nothing is written.',
  on: 'On: the links are written to Calibre in batches through stage 4. An id Calibre already has is never replaced.'
};

export const SITE_LABELS: Record<LinkSite, string> = {
  amazon: 'Amazon',
  ranobedb: 'RanobeDB',
  bookwalker: 'BOOK☆WALKER'
};

export const HOW_LABELS: Record<LinkHow, string> = {
  record: 'the page found for this book',
  series: 'the list of its series'
};

export const LINKS_PHASES: Record<LinksPhase, string> = {
  record: 'Checking the page found for each book',
  series: 'Checking the lists of each series',
  settle: 'Setting aside pages two books claim',
  propose: 'Preparing the links',
  spot: 'The spot check waits for you',
  write: 'Writing the links to Calibre',
  done: 'Done'
};

const SITES: LinkSite[] = ['amazon', 'ranobedb', 'bookwalker'];

/** The picks of one state, per site, both rules together. */
export function picksOf(s: LinksStatus, state: LinkState): PerSite & { all: number } {
  const out = { amazon: 0, ranobedb: 0, bookwalker: 0, all: 0 };
  for (const [k, v] of Object.entries(s.picks)) {
    const [st, site] = k.split(':') as [LinkState, LinkSite];
    if (st !== state || !(site in out)) continue;
    out[site] += v;
    out.all += v;
  }
  return out;
}

/** The step's bar: "Step 1 of 3: … (1,200 of 52,120)" with the time left. */
export function linksBar(s: LinksStatus | null): ProgressBar | null {
  const b = s?.bar;
  if (!s || !b || s.mode === 'off') return null;
  if (b.phase === 'spot' || b.phase === 'done' || b.phase === 'settle') return null;
  const order: LinksPhase[] = ['record', 'series', 'propose'];
  const step = order.indexOf(b.phase);
  const label =
    (step < 0
      ? LINKS_PHASES[b.phase]
      : `Step ${step + 1} of ${order.length}: ${LINKS_PHASES[b.phase]}`) +
    (b.total ? ` (${n(b.done)} of ${n(b.total)})` : b.done ? ` (${n(b.done)})` : '');
  return {
    label,
    fraction: b.total ? Math.min(1, b.done / b.total) : 0,
    eta: b.leftMs === null ? null : etaText(b.leftMs)
  };
}

const perSiteText = (c: PerSite) => SITES.map((x) => `${SITE_LABELS[x]} ${n(c[x])}`).join(', ');

/** The card's lines: what was found, what was set aside and why, what was written. */
export function linksLines(s: LinksStatus | null): string[] {
  if (!s) return [];
  const p = s.progress;
  const out: string[] = [];
  if (!s.stage4Done && s.mode !== 'off')
    out.push('Waits for stage 4 (its analysis and the AI check) to finish.');
  if (p.record.looked > 0)
    out.push(
      `Looked at ${n(p.record.looked)} of ${n(p.books)} books. From the page found for the book: ${perSiteText(p.record.picked)}.`
    );
  if (p.series.done > 0)
    out.push(
      `Looked at ${n(p.series.done)} of ${n(p.series.total)} series. From a series' list: ${perSiteText(p.series.picked)}` +
        (p.series.agree
          ? ` (and ${n(p.series.agree)} the same as the page found for the book)`
          : '') +
        '.'
    );
  const aside = [
    p.series.differ ? `${n(p.series.differ)} where the two ways disagree` : null,
    p.settle.clash ? `${n(p.settle.clash)} where two books claim one page` : null,
    p.record.taken ? `${n(p.record.taken)} whose page another book already has` : null
  ].filter((x): x is string => x !== null);
  if (aside.length) out.push(`Set aside, no link: ${aside.join(', ')}.`);
  const left = [
    p.record.yours ? `${n(p.record.yours)} with store links you edited` : null,
    p.record.noFacts ? `${n(p.record.noFacts)} without stored answers` : null
  ].filter((x): x is string => x !== null);
  if (left.length) out.push(`Left alone: ${left.join(', ')}.`);
  const pr = s.proposals;
  if ((pr.proposed ?? 0) + (pr.applied ?? 0) + (pr.queued ?? 0) > 0)
    out.push(
      `Links: ${n((pr.proposed ?? 0) + (pr.queued ?? 0))} books to write, ${n(pr.applied ?? 0)} written` +
        ((pr.skipped ?? 0) ? `, ${n(pr.skipped)} set aside` : '') +
        ((pr.undone ?? 0) ? `, ${n(pr.undone)} undone` : '') +
        (p.propose.natively
          ? `; ${n(p.propose.natively)} of them also ${p.propose.natively === 1 ? 'gets' : 'get'} a Natively link`
          : '') +
        '.'
    );
  if (p.propose.held)
    out.push(`${n(p.propose.held)} wait: another change of their store links is still open.`);
  if (p.series.saved)
    out.push(
      p.series.saved === 1
        ? `1 saved link differs from what its series' list says. It is listed below and never changed.`
        : `${n(p.series.saved)} saved links differ from what their series' list says. They are listed below and never changed.`
    );
  if (p.labeled)
    out.push(
      `Labeled books: ${n(p.labeled.links)} new links; ${n(p.labeled.flagged.length)} flagged by the checker for a look.`
    );
  return out;
}

/** The spot check's line. */
export function linksSpotLine(s: LinksStatus | null): string {
  if (!s || s.spot.size === 0) return '';
  const marked = s.spot.size - s.spot.open;
  const base = `Spot check: ${n(marked)} of ${n(s.spot.size)} marked, ${n(s.spot.wrong)} wrong.`;
  if (s.spot.wrong > 0)
    return `${base} A wrong link was found: On stays off (the rules are looked at again).`;
  if (s.spot.open > 0) return `${base} On needs every link marked and none wrong.`;
  return s.mode === 'on' ? `${base} Passed.` : `${base} Passed: On can be switched on.`;
}

/** "Series 3" or "". */
export function seriesText(m: LinkItem): string {
  return m.book.series
    ? `${m.book.series}${m.book.number !== null ? ` ${m.book.number}` : ''}`
    : '';
}
