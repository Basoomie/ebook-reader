/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The "Reads as" line under the library search box (search palette step 1, 2026-11-24): a
 * search in plain words, built from the parser's own result so it can never disagree with
 * what the search does. Pure code.
 *
 *   tag:SF,BL chars:<100k -status:completed
 *   → tag contains SF or BL, under 100,000 characters and not completed
 */

import { parseQuery, type Matcher, type QueryErrorInfo, type QueryTerm } from './parse';

const BOOKMETER_LIST_NAMES = {
  read: '読んだ本',
  reading: '読んでる本',
  stacked: '積読本',
  wish: '読みたい本'
} as const;

export type QueryReading =
  /** Nothing to say: empty, or only plain words (they need no explanation). */
  { kind: 'none' } | { kind: 'reads'; text: string } | { kind: 'error'; error: QueryErrorInfo };

const NUMBER = new Intl.NumberFormat('en-US');

function quoteValue(value: string): string {
  return /[\s,]/.test(value) ? `"${value}"` : value;
}

function matcherText(m: Matcher): string {
  return m.kind === 'regex' ? `/${m.source}/${m.ignoreCase ? 'i' : ''}` : quoteValue(m.value);
}

function orList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function andList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A name field: "author contains 日向 or 夏", "no tag is exactly SF". */
function describeField(term: Extract<QueryTerm, { type: 'field' }>): string {
  const all = term.matchers;
  const verb = all.every((m) => m.kind === 'regex')
    ? 'matches'
    : all.every((m) => m.kind === 'text' && m.exact)
      ? 'is exactly'
      : 'contains';
  const values = orList(all.map(matcherText));
  if (term.negated) return `no ${term.field} ${verb} ${values}`;
  return `${term.field} ${verb} ${values}`;
}

/** chars: and level: from the text as typed ("<100k" reads "under 100,000", not "at most 99,999"). */
function describeRange(raw: string, unit: 'characters' | 'level'): string {
  const value = raw.replace(/^[^:：]*[:：]/, '');
  const num = (s: string) => {
    const k = /^(\d+(?:\.\d+)?)k$/i.exec(s);
    const n = k ? Math.round(Number(k[1]) * 1000) : Number(s.replace(/[,_]/g, ''));
    return NUMBER.format(n);
  };
  const range = /^([^-]+)-([^-]+)$/.exec(value);
  const op = /^(<=|>=|<|>|=)?(.*)$/.exec(value)!;
  if (unit === 'level') {
    if (range) return `Natively level ${num(range[1])} to ${num(range[2])}`;
    const n = num(op[2]);
    switch (op[1]) {
      case '<':
        return `Natively level under ${n}`;
      case '<=':
        return `Natively level ${n} or lower`;
      case '>':
        return `Natively level over ${n}`;
      case '>=':
        return `Natively level ${n} or higher`;
      default:
        return `Natively level ${n}`;
    }
  }
  if (range) return `${num(range[1])} to ${num(range[2])} characters`;
  const n = num(op[2]);
  switch (op[1]) {
    case '<':
      return `under ${n} characters`;
    case '<=':
      return `${n} characters or fewer`;
    case '>':
      return `over ${n} characters`;
    case '>=':
      return `${n} characters or more`;
    default:
      return `exactly ${n} characters`;
  }
}

/** rating:/myrating: from the text as typed ("rated 4 or higher by readers"). */
function describeStars(raw: string, own: boolean): string {
  const value = raw.replace(/^[^:：]*[:：]/, '');
  const who = own ? 'you rated it' : 'readers rated it';
  const range = /^([^-]+)-([^-]+)$/.exec(value);
  if (range) return `${who} ${range[1]} to ${range[2]} stars`;
  const op = /^(<=|>=|<|>|=)?(.*)$/.exec(value)!;
  const n = op[2];
  switch (op[1]) {
    case '<':
      return `${who} under ${n} stars`;
    case '<=':
      return `${who} ${n} stars or lower`;
    case '>':
      return `${who} over ${n} stars`;
    case '>=':
      return `${who} ${n} stars or higher`;
    case '=':
      return `${who} exactly ${n} stars`;
    default:
      if (n.includes('.')) return `${who} exactly ${n} stars`;
      return n === '5' ? `${who} 5 stars` : `${who} ${n}.0 to ${n}.9 stars`;
  }
}

/** ratings:/readers: ("at least 100 ratings", "under 50 readers on 読書メーター"). */
function describeCount(raw: string, unit: 'ratings' | 'readers'): string {
  const value = raw.replace(/^[^:：]*[:：]/, '');
  const num = (s: string) => {
    const k = /^(\d+(?:\.\d+)?)k$/i.exec(s);
    const n = k ? Math.round(Number(k[1]) * 1000) : Number(s.replace(/[,_]/g, ''));
    return NUMBER.format(n);
  };
  const what = unit === 'ratings' ? 'ratings' : 'readers on 読書メーター';
  const range = /^([^-]+)-([^-]+)$/.exec(value);
  if (range) return `${num(range[1])} to ${num(range[2])} ${what}`;
  const op = /^(<=|>=|<|>|=)?(.*)$/.exec(value)!;
  const n = num(op[2]);
  switch (op[1]) {
    case '<':
      return `under ${n} ${what}`;
    case '<=':
      return `${n} ${what} or fewer`;
    case '>':
      return `over ${n} ${what}`;
    case '>=':
      return `at least ${n} ${what}`;
    default:
      return `exactly ${n} ${what}`;
  }
}

/** kept: ("went on to vol 2: at least 70 %"). */
function describeKept(raw: string): string {
  const value = raw.replace(/^[^:：]*[:：]/, '').replace(/[%％]/g, '');
  const what = 'went on to vol 2:';
  const range = /^([^-]+)-([^-]+)$/.exec(value);
  if (range) return `${what} ${range[1]} to ${range[2]} %`;
  const op = /^(<=|>=|<|>|=)?(.*)$/.exec(value)!;
  const n = op[2];
  switch (op[1]) {
    case '<':
      return `${what} under ${n} %`;
    case '<=':
      return `${what} ${n} % or less`;
    case '>':
      return `${what} over ${n} %`;
    case '>=':
      return `${what} at least ${n} %`;
    default:
      return `${what} exactly ${n} %`;
  }
}

function describeTerm(term: QueryTerm, text: string): string {
  const raw = text.slice(term.start, term.end).replace(/^-/, '');
  switch (term.type) {
    case 'any': {
      if (term.matcher.kind === 'regex') {
        const re = matcherText(term.matcher);
        return term.negated ? `not matching ${re}` : `matching ${re}`;
      }
      const what = `“${term.matcher.value}”`;
      return term.negated ? `without ${what}` : `with ${what}`;
    }
    case 'field':
      return describeField(term);
    case 'chars': {
      const d = describeRange(raw, 'characters');
      return term.negated ? `not ${d}` : d;
    }
    case 'level': {
      const d = describeRange(raw, 'level');
      return term.negated ? `not ${d}` : d;
    }
    case 'rating':
    case 'myrating': {
      const d = describeStars(raw, term.type === 'myrating');
      return term.negated ? `not: ${d}` : d;
    }
    case 'ratings':
    case 'readers': {
      const d = describeCount(raw, term.type);
      return term.negated ? `not ${d}` : d;
    }
    case 'kept': {
      const d = describeKept(raw);
      return term.negated ? `not: ${d}` : d;
    }
    case 'status': {
      const d = orList(
        term.values.map((v) => (v === 'next' ? 'the next volume of a series you are reading' : v))
      );
      return term.negated ? `not ${d}` : d;
    }
    case 'favorite':
      return term.value !== term.negated ? 'a favorite' : 'not a favorite';
    case 'device':
      return term.negated ? 'not on this device' : 'on this device';
    case 'deviceAudio':
      return term.negated ? 'audio not on this device' : 'audio on this device';
    case 'bookmeter': {
      const d = `on your 読書メーター ${orList(term.values.map((v) => BOOKMETER_LIST_NAMES[v]))}`;
      return term.negated ? `not ${d}` : d;
    }
  }
}

/**
 * Describes `text`. `cursor` (where the caret is) keeps an error in the term still being
 * typed at the end of the box quiet ("tag:" alone): that is typing, not a mistake.
 */
export function describeQuery(text: string, cursor = -1): QueryReading {
  const parsed = parseQuery(text);
  if (!parsed.ok) {
    const { error } = parsed;
    const typing = cursor === text.length && !/\s$/.test(text) && error.end >= text.length;
    if (typing) return { kind: 'none' };
    return { kind: 'error', error };
  }
  const { terms } = parsed.query;
  if (!terms.some((t) => t.type !== 'any')) return { kind: 'none' };
  return { kind: 'reads', text: andList(terms.map((t) => describeTerm(t, text))) };
}
