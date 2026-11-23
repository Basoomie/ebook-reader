/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type {
  Stage4AiStatus,
  Stage4Gate,
  Stage4Site,
  Stage4Status,
  Stage4Write,
  StageMode
} from './cleanup-api';
import { etaText, n, type ProgressBar } from './cleanup-text';

/** Plain wording for stage 4 on the /cleanup page (WP20d): the online sources, Preview only. */

export const STAGE4_MODE_HINTS: Record<StageMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Looks every book up online through the VPN and lists what it would change, with where each value came from; nothing in Calibre is changed.',
  on: 'Writes the confirmed values into Calibre in batches, after the AI check; best guesses wait in Review; format and edition wait for stage 5.'
};

const AI_PHASES: Record<string, string> = {
  evidence: 'gathering what the models read',
  models: 'asking both models',
  decide: 'deciding every field',
  spelling: 'giving each series one spelling',
  series: 'putting each series in order',
  gate: 'checking the labeled books',
  done: 'done'
};

const AI_BAR_LABELS: Record<string, string> = {
  evidence: 'Gathering what the models read',
  models: 'Asking both models',
  decide: 'Deciding every field',
  spelling: 'Giving each series one spelling',
  series: 'Putting each series in order',
  gate: 'Checking the labeled books'
};

/**
 * Stage 4 On's progress bar (WP20e): changes written of all, the books written, and the time
 * left at the pace of the last batches. Only while On and something is left to write: a finished
 * or stopped run is a plain line (writtenLine), as the other stages show their results.
 */
export function writeBar(
  w: Stage4Write | null | undefined,
  mode: StageMode | undefined
): ProgressBar | null {
  if (!w || w.changes.total <= 0 || mode !== 'on') return null;
  if (w.changes.done >= w.changes.total) return null;
  return {
    label: `Writing to Calibre: ${n(w.changes.done)} of ${n(w.changes.total)} changes · ${n(w.books.done)} books written`,
    fraction: Math.min(1, w.changes.done / w.changes.total),
    eta:
      w.secondsLeft !== null && w.secondsLeft > 0
        ? `${etaText(w.secondsLeft * 1000)} (estimate)`
        : null
  };
}

/** What stage 4 has written, when no bar shows: "Written to Calibre: 206,111 changes in 51,988 books". */
export function writtenLine(
  w: Stage4Write | null | undefined,
  mode: StageMode | undefined
): string | null {
  if (!w || w.changes.done <= 0 || writeBar(w, mode)) return null;
  const all = w.changes.done >= w.changes.total;
  return all
    ? `Written to Calibre: ${n(w.changes.done)} changes in ${n(w.books.done)} books`
    : `Written to Calibre: ${n(w.changes.done)} of ${n(w.changes.total)} changes in ${n(w.books.done)} books`;
}

/** The AI check's progress bar with the time left (as the audiobook card's). */
export function aiBar(ai: Stage4AiStatus | null | undefined): ProgressBar | null {
  const b = ai?.bar;
  if (!ai || !b || ai.phase === 'done') return null;
  // The series step counts reading the books, ordering each series and the proposals together,
  // and the gate the labeled books and its counting steps: steps, not books.
  const what =
    b.phase === 'models'
      ? 'answers in'
      : b.phase === 'series' || b.phase === 'gate'
        ? 'steps'
        : 'books';
  return {
    label: b.total
      ? `${AI_BAR_LABELS[b.phase] ?? b.phase}: ${n(b.done)} of ${n(b.total)} ${what}`
      : (AI_BAR_LABELS[b.phase] ?? b.phase),
    fraction: b.total ? Math.min(1, b.done / b.total) : 0,
    eta:
      b.secondsLeft !== null && b.secondsLeft > 0
        ? `${etaText(b.secondsLeft * 1000)} (estimate)`
        : null
  };
}

/** The AI check's progress in one line (WP20e). */
export function aiLine(ai: Stage4AiStatus): string {
  const a = ai.answers;
  const asked = a ? a.answered + a.failed + a.blocked + a.invalid : 0;
  const all = a ? asked + a.queued + a.sent : 0;
  const parts = [`AI check: ${AI_PHASES[ai.phase] ?? ai.phase}`];
  if (a && all > 0) parts.push(`${n(a.answered)} of ${n(all)} answers in`);
  if (a && a.failed > 0) parts.push(`${n(a.failed)} given up`);
  if (ai.phase === 'decide') parts.push(`${n(ai.decided)} of ${n(ai.items)} books decided`);
  if (ai.costUsd !== null) parts.push(`$${ai.costUsd.toFixed(2)} spent`);
  return parts.join(' · ');
}

/** The AI check's gate per field: confirmed values against the bar, every value with no review. */
export function aiGateRows(ai: Stage4AiStatus): {
  field: string;
  confirmed: string;
  all: string;
  checkD: string;
  below: boolean;
}[] {
  const g = ai.gate;
  if (!g) return [];
  return Object.entries(g.all.fields).map(([f, s]) => ({
    field: GATE_LABELS[FIELD_KEY[f] ?? f] ?? f,
    confirmed: `${pct(s.autoPercent)} of ${n(s.auto)} confirmed right`,
    all: `${pct(s.allPercent)} right with no review (${n(s.scored)})`,
    checkD: `check D: ${pct(g.checkD.fields[f]?.allPercent ?? null)}`,
    below: g.below.includes(FIELD_KEY[f] ?? f)
  }));
}

/** The gate's short field ids (score.ts) and the gate's names. */
const FIELD_KEY: Record<string, string> = {
  t: 'title',
  au: 'authors',
  il: 'illustrators',
  se: 'series',
  ix: 'number',
  fmt: 'format'
};

/** "Books with every field right" for the 600 and check D. */
export function aiBooksLine(ai: Stage4AiStatus): string | null {
  const g = ai.gate;
  if (!g) return null;
  return `Books with every field right, no review: the 600 ${pct(g.the600.everyFieldPercent)} (${n(g.the600.books)}), check D ${pct(g.checkD.everyFieldPercent)} (${n(g.checkD.books)})`;
}

export const SITE_NAMES: Record<string, string> = {
  'amazon-dp': 'Amazon product pages',
  'amazon-search': 'Amazon Kindle search',
  'amazon-img': 'Amazon cover pictures',
  ranobedb: 'RanobeDB',
  bookwalker: 'BOOK☆WALKER',
  bookmeter: 'Bookmeter',
  natively: 'Natively',
  ndl: 'Web NDL Authorities (author readings)',
  sudachi: 'Generated readings (Sudachi)'
};

export const FIELD_NAMES: Record<string, string> = {
  title: 'Title',
  authors: 'Authors',
  illustrator: 'Illustrators',
  series: 'Series and number',
  format: 'Format',
  kind: 'Edition',
  description: 'Description',
  cover: 'Cover',
  identifiers: 'Store links',
  author_sort: 'Author reading'
};

export const SOURCE_NAMES: Record<string, string> = {
  'amazon-asin': 'Amazon (the file’s ASIN)',
  'amazon-search': 'Amazon (search)',
  ranobedb: 'RanobeDB',
  bookwalker: 'BOOK☆WALKER',
  'bookwalker(=amazon)': 'BOOK☆WALKER (same text as Amazon)',
  amazon: 'Amazon (the file’s ASIN)',
  'amazon(search)': 'Amazon (search)',
  bookmeter: 'Bookmeter',
  colophon: 'The book’s colophon',
  file: 'The file',
  ndl: 'Web NDL Authorities',
  generated: 'Generated (spot check)',
  rules: 'The rules',
  spelling: 'The series’ spelling on most books',
  'series-order': 'The order of the series'
};

/** The AI check's names for the fields a best guess is in. */
export const GUESS_FIELDS: Record<string, string> = {
  t: 'Title',
  au: 'Authors',
  il: 'Illustrators',
  fmt: 'Format',
  se: 'Series',
  ix: 'Number'
};

/** A series number as Calibre shows it (no number shows as 1). */
export function seriesNumberText(index: number | null): string {
  if (index === null) return 'no number (Calibre shows 1)';
  return String(Math.round(index * 100) / 100);
}

/** The series step in one line: what it put in order, and what to look at. */
export function seriesOrderLine(
  so:
    | {
        series: number;
        changed: number;
        guesses: number;
        reviews: number;
      }
    | null
    | undefined
): string | null {
  if (!so) return null;
  const parts = [`Series order: ${n(so.series)} series`, `${n(so.changed)} books changed`];
  parts.push(`${n(so.guesses)} best guesses`);
  if (so.reviews) parts.push(`${n(so.reviews)} for review`);
  return parts.join(' · ');
}

export function sourceName(source: string): string {
  if (SOURCE_NAMES[source]) return SOURCE_NAMES[source];
  // Store links: the keys that were added.
  return source
    .split(',')
    .map((s) => SOURCE_NAMES[s] ?? s)
    .join(', ');
}

/** "3 h 20 min", "45 min", "under a minute". */
export function duration(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} days ${h % 24} h`;
}

/** One line per site: what is done, what is left at the measured pace, and any wait. */
export function siteLine(s: Stage4Site, now = Date.now()): string {
  if (!s.enabled) return 'Switched off';
  const parts = [`${n(s.done + s.gone)} answered`];
  if (s.queued + s.leased) parts.push(`${n(s.queued + s.leased)} to ask`);
  if (s.failed) parts.push(`${n(s.failed)} given up`);
  if (s.challenges) parts.push(`${n(s.challenges)} refused`);
  if (s.errors) parts.push(`${n(s.errors)} network error${s.errors === 1 ? '' : 's'}`);
  if (s.sharedSlot && s.secondsLeft > 0) {
    // Product pages and searches take turns in one slot: its pace, and the time for both.
    const other = s.site === 'amazon-dp' ? 'Kindle search' : 'product pages';
    parts.push(
      `${s.secondsPerRequest} s per request in the slot shared with ${other} · about ${duration(s.secondsLeft)} left for both`
    );
  } else if (s.queued + s.leased > 0) {
    parts.push(`${s.secondsPerRequest} s per request · about ${duration(s.secondsLeft)} left`);
  }
  if (s.pausedReason) parts.push(`paused: ${s.pausedReason}`);
  else if (s.backoffUntil && s.backoffUntil > now) {
    parts.push(
      `${s.backoffReason ?? 'waiting'} (until ${new Date(s.backoffUntil).toLocaleTimeString()})`
    );
  }
  if (s.slowFactor > 1) parts.push(`slowed down ×${s.slowFactor} (many refusals)`);
  return parts.join(' · ');
}

/** The reading: each book once, out of the books with an EPUB, with its pace and time left. */
export function readingLine(status: Stage4Status): string {
  const r = status.read;
  if (!r || !r.total || r.done >= r.total) return '';
  const parts = [`Reading the files: ${n(r.done)} of ${n(r.total)}`];
  const left = status.timeLeft?.read;
  if (r.perSecond && left !== null && left !== undefined) {
    parts.push(`${r.perSecond.toFixed(1)} books a second · about ${duration(left)} left`);
  } else parts.push('measuring the speed');
  return parts.join(' · ');
}

/** The lookups, out of every book with an EPUB (not only the books read so far). */
export function booksLine(status: Stage4Status): string {
  const by = (states: string[]) =>
    status.books.filter((b) => states.includes(b.state)).reduce((a, b) => a + b.n, 0);
  const total = status.read?.total ?? by(['read', 'waiting', 'ready', 'proposed', 'error']);
  if (!total) return '';
  const parts = [`${n(by(['proposed']))} of ${n(total)} books looked up`];
  const open = by(['read', 'waiting', 'ready']);
  if (open) parts.push(`${n(open)} waiting for the sites`);
  if (by(['error'])) parts.push(`${n(by(['error']))} couldn’t be read`);
  return parts.join(' · ');
}

/**
 * The lookups' progress bar (books looked up of every book that can be read, with the time left
 * for the whole Preview): while any book waits for the sites. The lookups never had a bar, only
 * booksLine (the user, 2026-11-22: "why do I not see the progress?").
 */
export function lookupBar(status: Stage4Status): ProgressBar | null {
  const by = (states: string[]) =>
    status.books.filter((b) => states.includes(b.state)).reduce((a, b) => a + b.n, 0);
  const total = status.read?.total ?? by(['read', 'waiting', 'ready', 'proposed', 'error']);
  const open = by(['read', 'waiting', 'ready']);
  const unreadable = by(['error']);
  const all = total - unreadable;
  if (!total || !open || all <= 0) return null;
  const done = by(['proposed']);
  const parts = [`Looking up: ${n(done)} of ${n(all)} books`, `${n(open)} waiting for the sites`];
  if (unreadable) parts.push(`${n(unreadable)} couldn’t be read`);
  const t = status.timeLeft?.total;
  return {
    label: parts.join(' · '),
    fraction: Math.min(1, done / all),
    eta: t !== null && t !== undefined && t > 0 ? `${etaText(t * 1000)} (estimate)` : null
  };
}

/** The whole Preview's time left: the reading, the slowest site, then the final pass. */
export function timeLeftLine(status: Stage4Status, now = Date.now()): string {
  const t = status.timeLeft;
  if (!t) return '';
  if (t.total === null) return 'Time left for the whole Preview: measuring…';
  if (t.total < 60) return 'Time left for the whole Preview: less than a minute';
  const parts = [`Time left for the whole Preview: about ${duration(t.total)}`];
  if (t.slowest && t.slowest.seconds > 0) {
    const name =
      t.slowest.site === 'amazon'
        ? 'Amazon (product pages and searches share one slot)'
        : (SITE_NAMES[t.slowest.site] ?? t.slowest.site);
    parts.push(`the slowest site is ${name}, about ${duration(t.slowest.seconds)}`);
  }
  if (t.final) parts.push(`then the final pass, about ${duration(t.final)}`);
  // A site held up by refusals (or paused) right now: the estimate assumes it answers again.
  const held = new Set(
    (status.sites ?? [])
      .filter(
        (s) =>
          s.enabled &&
          (s.pausedReason ||
            (s.backoffUntil && s.backoffUntil > now && /^refused/.test(s.backoffReason ?? '')))
      )
      .map((s) => (s.site.startsWith('amazon') ? 'Amazon' : (SITE_NAMES[s.site] ?? s.site)))
  );
  for (const name of held) {
    parts.push(
      `${name} is held up by refusals right now; this assumes it answers again at its pace`
    );
  }
  const perBook =
    t.basis === 'labeled'
      ? "requests per book measured on this run's labeled books (Amazon's measured on the same books with today's rules)"
      : 'requests per book from the reference run until the labeled books are done; shared series pages make it an upper bound';
  // An older server: requests per book for every book.
  if (t.notStarted === undefined) parts.push(perBook);
  else if (t.notStarted > 0) parts.push(`${n(t.notStarted)} books not started yet at ${perBook}`);
  if (t.followUps === 'measured')
    parts.push('what the open lookups ask next at the rates measured in this run');
  else if (t.followUps === 'bound')
    parts.push('what the open lookups ask next counted at most until measured');
  return parts.join(' · ');
}

export function readingsLine(status: Stage4Status): string {
  const c = (s: string) => status.readings.find((r) => r.state === s)?.n ?? 0;
  const total = status.readings.reduce((a, r) => a + r.n, 0);
  if (!total) return '';
  return `Author readings: ${n(c('found'))} from Web NDL Authorities · ${n(c('generated'))} generated (spot check) · ${n(c('none'))} without a reading · ${n(c('queued') + c('asked') + c('not_found') + c('generating'))} to look up`;
}

export function nativelyLine(status: Stage4Status): string {
  const x = status.natively;
  if (!x.listed) return '';
  return `Natively: ${n(x.read ?? 0)} of ${n(x.listed)} book pages read · ${n(x.asins)} Kindle ASINs, ${n(x.withIsbn ?? 0)} ISBNs to match`;
}

export interface GateRow {
  field: string;
  percent: string;
  auto: string;
  the600: string;
  checkD: string;
  below: boolean;
}

const GATE_LABELS: Record<string, string> = {
  title: 'Title',
  authors: 'Authors',
  illustrators: 'Illustrators',
  series: 'Series',
  number: 'Number',
  format: 'Format'
};

const pct = (v: number | null) => (v === null ? '–' : `${v.toFixed(1)} %`);

export function gateRows(gate: Stage4Gate): GateRow[] {
  return Object.entries(gate.fields).map(([field, f]) => ({
    field: GATE_LABELS[field] ?? field,
    percent: `${pct(f.percent)} right (bar ${f.bar} %)`,
    auto: `${n(f.auto)} of ${n(f.scored)} applied automatically`,
    the600: `the 600: ${pct(f.the600.percent)} (measured ${f.the600.measured} %)`,
    checkD: `check D: ${pct(f.checkD.percent)} (measured ${f.checkD.measured} %)`,
    below: f.below
  }));
}

export function fieldCounts(
  status: Stage4Status
): { field: string; label: string; auto: number; review: number }[] {
  const fields = [...new Set(status.fields.map((f) => f.field))];
  return fields.map((field) => ({
    field,
    label: FIELD_NAMES[field] ?? field,
    auto: status.fields.find((f) => f.field === field && f.class === 'auto')?.n ?? 0,
    review: status.fields.find((f) => f.field === field && f.class === 'review')?.n ?? 0
  }));
}

/** A proposal's value as one line of text. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(none)';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('name' in o && 'index' in o)
      return o.name
        ? `${String(o.name)}${o.index !== null ? ` · ${String(o.index)}` : ''}`
        : '(no series)';
    if ('url' in o && 'side' in o) return `the store’s picture, ${String(o.side)} px`;
    return Object.entries(o)
      .map(([k, x]) => `${k}: ${String(x)}`)
      .join(', ');
  }
  if (typeof v === 'boolean') return v ? 'has a cover' : 'no cover';
  return String(v);
}
