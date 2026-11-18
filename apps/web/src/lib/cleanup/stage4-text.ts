/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { Stage4Gate, Stage4Site, Stage4Status, StageMode } from './cleanup-api';
import { n } from './cleanup-text';

/** Plain wording for stage 4 on the /cleanup page (WP20d): the online sources, Preview only. */

export const STAGE4_MODE_HINTS: Record<StageMode, string> = {
  off: 'Nothing runs.',
  analyse:
    'Looks every book up online through the VPN and lists what it would change, with where each value came from; nothing in Calibre is changed.',
  on: 'Not available yet: stage 4 writes come with the AI check.'
};

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
  rules: 'The rules'
};

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
  if (s.challenges) parts.push(`${n(s.challenges)} challenge page${s.challenges === 1 ? '' : 's'}`);
  if (s.errors) parts.push(`${n(s.errors)} network error${s.errors === 1 ? '' : 's'}`);
  if (s.queued + s.leased > 0) {
    parts.push(`${s.secondsPerRequest} s per request · about ${duration(s.secondsLeft)} left`);
  }
  if (s.pausedReason) parts.push(`paused: ${s.pausedReason}`);
  else if (s.backoffUntil && s.backoffUntil > now) {
    parts.push(
      `${s.backoffReason ?? 'waiting'} (until ${new Date(s.backoffUntil).toLocaleTimeString()})`
    );
  }
  if (s.slowFactor > 1) parts.push(`slowed down ×${s.slowFactor} (many challenge pages)`);
  return parts.join(' · ');
}

export function booksLine(status: Stage4Status): string {
  const by = (states: string[]) =>
    status.books.filter((b) => states.includes(b.state)).reduce((a, b) => a + b.n, 0);
  const total = by(['read', 'waiting', 'ready', 'proposed', 'error']);
  if (!total) return '';
  return `${n(by(['proposed']))} of ${n(total)} books looked up${by(['error']) ? ` · ${n(by(['error']))} couldn’t be read` : ''}`;
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
