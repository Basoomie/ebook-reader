/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Replaced books on /cleanup (the server's inherit/pass.ts): a new arrival kept over a library
 * book of the same text gets the old record's values it lacks (series, store ids, publisher,
 * languages, illustrators, custom tags). The card's words and lines.
 */
import { etaText, n } from './cleanup-text';

export type InheritMode = 'off' | 'analyse' | 'on';

export interface InheritItem {
  id: number;
  calibreId: number;
  title: string;
  field: string;
  before: unknown;
  value: unknown;
  state: string;
  reason: string | null;
}

export interface InheritStatus {
  mode: InheritMode;
  waiting: string | null;
  counts: Record<string, number>;
  bar: {
    label: string;
    done: number;
    total: number;
    startedAt: number | null;
    base: number;
    leftMs: number | null;
  } | null;
  books: Record<string, number>;
  fields: { field: string; state: string; n: number }[];
  items: InheritItem[];
  total: number;
}

export const INHERIT_MODE_LABELS: Record<InheritMode, string> = {
  off: 'Off',
  analyse: 'Preview',
  on: 'On'
};

export const INHERIT_HINTS: Record<InheritMode, string> = {
  off: 'Off: replaced books are not looked at.',
  analyse:
    'Preview: each library book a new arrival replaced is looked at, and the values its new copy lacks are listed. Nothing is written.',
  on: 'On: the listed values are written to the new copies (Undo per batch in the batches list), and each On new-arrivals run gives its own replacements theirs before its stages read them.'
};

export const INHERIT_FIELDS: Record<string, string> = {
  series: 'Series',
  identifiers: 'Store ids',
  publisher: 'Publisher',
  languages: 'Languages',
  illustrator: 'Illustrators',
  tags: 'Your tags'
};

const STATES: Record<string, string> = {
  proposed: 'to write',
  review: 'to look at (the replaced books disagree)',
  queued: 'being written',
  applied: 'written',
  skipped: 'not written',
  undone: 'undone',
  kept: 'kept'
};

/** The card's summary lines: books looked at, then each field's values by state. */
export function inheritLines(s: InheritStatus | null): string[] {
  if (!s) return [];
  const looked = (s.books.proposed ?? 0) + (s.books.nothing ?? 0) + (s.books.gone ?? 0);
  const out = [
    `${n(looked)} replaced books looked at: ${n(s.books.proposed ?? 0)} with values to take over, ${n(
      s.books.nothing ?? 0
    )} with nothing missing${s.books.gone ? `, ${n(s.books.gone)} whose new copy is gone` : ''}.`
  ];
  const byField = new Map<string, string[]>();
  for (const f of s.fields) {
    const l = byField.get(f.field) ?? [];
    l.push(`${n(f.n)} ${STATES[f.state] ?? f.state}`);
    byField.set(f.field, l);
  }
  for (const [field, parts] of byField)
    out.push(`${INHERIT_FIELDS[field] ?? field}: ${parts.join(', ')}`);
  return out;
}

/** The write's bar with the time left (On only). */
export function inheritBar(
  s: InheritStatus | null
): { label: string; fraction: number; eta: string | null } | null {
  const b = s?.bar;
  if (!b || b.total <= 0) return null;
  return {
    label: `Writing the values: ${n(b.done)} of ${n(b.total)}`,
    fraction: Math.min(1, b.done / b.total),
    eta: b.leftMs === null ? null : etaText(b.leftMs)
  };
}

/** A value as the list shows it. */
export function inheritValue(field: string, v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (field === 'series') {
    const s = v as { name?: string | null; index?: number | null };
    if (!s.name) return '—';
    return s.index === null || s.index === undefined ? s.name : `${s.name} #${s.index}`;
  }
  if (field === 'identifiers') {
    const keys = Object.keys(v as Record<string, string>);
    return keys.length ? keys.sort().join(', ') : '—';
  }
  if (field === 'tags') {
    const t = v as { add?: string[] } | string[];
    return Array.isArray(t) ? t.join(', ') || '—' : `+ ${(t.add ?? []).join(', ')}`;
  }
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  return String(v) || '—';
}

/** An item's line: the field, what the new copy has and what it gets. */
export function inheritItemLine(i: InheritItem): string {
  const field = INHERIT_FIELDS[i.field] ?? i.field;
  if (i.field === 'identifiers') {
    const before = new Set(Object.keys((i.before ?? {}) as Record<string, string>));
    const added = Object.keys((i.value ?? {}) as Record<string, string>).filter(
      (k) => !before.has(k)
    );
    return `${field}: + ${added.sort().join(', ')}`;
  }
  return `${field}: ${inheritValue(i.field, i.before)} → ${inheritValue(i.field, i.value)}`;
}

/** An item's state as the list says it. */
export function inheritState(i: InheritItem): string {
  const s = STATES[i.state] ?? i.state;
  return i.reason && i.state === 'skipped' ? `${s}: ${i.reason}` : s;
}
