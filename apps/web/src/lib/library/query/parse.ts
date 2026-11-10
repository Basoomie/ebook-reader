/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The library search language (WP7a, design 4.3). One query string: plain text, field
 * filters and /regex/. Parsed here, in one place, for both sides: the web app uses it for
 * instant error messages and the status chips; the storage server runs the same code
 * from a generated bundle (apps/storage-server/vendor/library-query.cjs) and turns the
 * result into SQL. Pure code: no DOM, no Svelte, no imports.
 *
 *   query   := term (whitespace term)*        whitespace includes U+3000
 *   term    := ["-"] (filter | regex | text)  terms combine with AND; "-" negates
 *   filter  := field (":" | "：") value       field names ignore case
 *   field   := author | series | tag | chars | status | favorite
 *   author/series/tag value := ["="] item ("," item)*   "=" exact; "," = any of
 *   item    := "quoted" | /regex/[i] | bare  (a quoted item is never split at commas)
 *   chars   := [<|<=|>|>=|=] N  |  N-N       N: digits, "," or "_" separators, "k" = 1000
 *   status  := unread|reading|completed|dropped ("," = any of)
 *   favorite:= yes|no
 *   regex   := /body/ or /body/i             JavaScript syntax, Unicode mode
 *
 * Unknown field names and slashes inside a word are plain text ("Re:ゼロ", "1/2").
 */

export const QUERY_LIMITS = {
  /** Characters in the whole query. */
  maxLength: 500,
  /** Terms after parsing (empty terms don't count). */
  maxTerms: 16,
  /** Regular expressions in one query (each one costs a scan). */
  maxRegexes: 3,
  /** Characters in one regular expression body. */
  maxRegexLength: 200
} as const;

export const QUERY_STATUSES = ['unread', 'reading', 'completed', 'dropped'] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export type TextField = 'author' | 'series' | 'tag';

export type Matcher =
  | { kind: 'text'; value: string; exact: boolean }
  | { kind: 'regex'; source: string; ignoreCase: boolean };

interface TermBase {
  negated: boolean;
  /** Character span of the whole term in the query (for messages and chip edits). */
  start: number;
  end: number;
}

export type QueryTerm =
  /** Plain text or a bare /regex/: title, any author name or the series name. */
  | (TermBase & { type: 'any'; matcher: Matcher })
  /** author: / series: / tag: with one or more alternatives (any of them). */
  | (TermBase & { type: 'field'; field: TextField; matchers: Matcher[] })
  /** chars: inclusive bounds; null = open. */
  | (TermBase & { type: 'chars'; min: number | null; max: number | null })
  | (TermBase & { type: 'status'; values: QueryStatus[] })
  | (TermBase & { type: 'favorite'; value: boolean });

export interface ParsedQuery {
  terms: QueryTerm[];
}

export interface QueryErrorInfo {
  message: string;
  start: number;
  end: number;
}

export type ParseResult = { ok: true; query: ParsedQuery } | { ok: false; error: QueryErrorInfo };

class QueryError extends Error {
  constructor(
    message: string,
    readonly start: number,
    readonly end: number
  ) {
    super(message);
  }
}

const FIELDS = ['author', 'series', 'tag', 'chars', 'status', 'favorite'] as const;
type Field = (typeof FIELDS)[number];

const FIELD_RE = /^(author|series|tag|chars|status|favorite)[:：]/i;

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** Validates a regular expression the way the server will run it. */
function checkRegex(source: string, ignoreCase: boolean, start: number, end: number): Matcher {
  if (source.length > QUERY_LIMITS.maxRegexLength) {
    throw new QueryError(
      `A pattern can be at most ${QUERY_LIMITS.maxRegexLength} characters long.`,
      start,
      end
    );
  }
  try {
    new RegExp(source, ignoreCase ? 'iu' : 'u');
  } catch (error) {
    const detail =
      error instanceof Error ? error.message.replace(/^Invalid regular expression: /, '') : '';
    throw new QueryError(`That pattern isn't valid${detail ? `: ${detail}` : ''}.`, start, end);
  }
  return { kind: 'regex', source, ignoreCase };
}

class Scanner {
  pos = 0;

  regexCount = 0;

  constructor(readonly text: string) {}

  get done() {
    return this.pos >= this.text.length;
  }

  peek(offset = 0) {
    return this.text[this.pos + offset];
  }

  skipSpace() {
    while (!this.done && isSpace(this.peek())) this.pos += 1;
  }

  /** Reads until whitespace (or, with `stopAtComma`, a comma). */
  readBare(stopAtComma: boolean): string {
    const from = this.pos;
    while (!this.done && !isSpace(this.peek()) && !(stopAtComma && this.peek() === ',')) {
      this.pos += 1;
    }
    return this.text.slice(from, this.pos);
  }

  /** At a '"': reads to the closing quote or the end of the query. */
  readQuoted(): string {
    this.pos += 1;
    const from = this.pos;
    while (!this.done && this.peek() !== '"') this.pos += 1;
    const value = this.text.slice(from, this.pos);
    if (!this.done) this.pos += 1;
    return value;
  }

  /**
   * At a '/': reads /body/flags when it is a complete pattern; otherwise returns null and
   * leaves the position unchanged (then it is plain text). `stopAtComma` ends the flags
   * at a comma (field value lists).
   */
  tryReadRegex(stopAtComma: boolean): Matcher | null {
    const start = this.pos;
    let i = this.pos + 1;
    let inClass = false;
    while (i < this.text.length) {
      const ch = this.text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (isSpace(ch) && !inClass) return null;
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      i += 1;
    }
    if (i >= this.text.length) return null;
    const source = this.text.slice(start + 1, i);
    let j = i + 1;
    while (
      j < this.text.length &&
      !isSpace(this.text[j]) &&
      !(stopAtComma && this.text[j] === ',')
    ) {
      j += 1;
    }
    const flags = this.text.slice(i + 1, j);
    if (source === '') {
      // "//" is an empty term (ignored); "//x" is plain text.
      if (flags !== '') return null;
      this.pos = j;
      return { kind: 'text', value: '', exact: false };
    }
    if (flags !== '' && flags !== 'i' && flags !== 'I') {
      throw new QueryError(
        'Only the i flag (ignore case) can follow a /pattern/. To search for a slash, put the text in quotes.',
        start,
        j
      );
    }
    this.regexCount += 1;
    if (this.regexCount > QUERY_LIMITS.maxRegexes) {
      throw new QueryError(
        `A search can use at most ${QUERY_LIMITS.maxRegexes} patterns.`,
        start,
        j
      );
    }
    this.pos = j;
    return checkRegex(source, flags !== '', start, j);
  }
}

function parseNumber(raw: string): number | null {
  const thousands = /^(\d+(?:\.\d+)?)k$/i.exec(raw);
  if (thousands) return Math.round(Number(thousands[1]) * 1000);
  if (!/^\d[\d,_]*$/.test(raw)) return null;
  const value = Number(raw.replace(/[,_]/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

const CHARS_HELP = 'Use chars:<150000, chars:>=50k or chars:50000-150000.';

function parseChars(
  raw: string,
  start: number,
  end: number
): { min: number | null; max: number | null } {
  if (raw === '') throw new QueryError(`chars: needs a number. ${CHARS_HELP}`, start, end);
  const range = /^([^-]+)-([^-]+)$/.exec(raw);
  if (range) {
    const low = parseNumber(range[1]);
    const high = parseNumber(range[2]);
    if (low === null || high === null) {
      throw new QueryError(`"${raw}" isn't a number range. ${CHARS_HELP}`, start, end);
    }
    if (low > high) {
      throw new QueryError('The first number of a range must be the smaller one.', start, end);
    }
    return { min: low, max: high };
  }
  const compare = /^(<=|>=|<|>|=)?(.*)$/.exec(raw)!;
  const op = compare[1] ?? '=';
  const value = parseNumber(compare[2]);
  if (value === null) throw new QueryError(`"${raw}" isn't a number. ${CHARS_HELP}`, start, end);
  switch (op) {
    case '<':
      return { min: null, max: value - 1 };
    case '<=':
      return { min: null, max: value };
    case '>':
      return { min: value + 1, max: null };
    case '>=':
      return { min: value, max: null };
    default:
      return { min: value, max: value };
  }
}

function parseWordList(raw: string): string[] {
  return raw
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w !== '');
}

function parseField(s: Scanner, field: Field, negated: boolean, start: number): QueryTerm | null {
  const valueStart = s.pos;
  if (field === 'chars' || field === 'status' || field === 'favorite') {
    const raw = s.readBare(false);
    const end = s.pos;
    if (field === 'chars')
      return { type: 'chars', negated, start, end, ...parseChars(raw, start, end) };
    const words = parseWordList(raw);
    if (field === 'status') {
      if (words.length === 0) {
        throw new QueryError(`status: needs a value: ${QUERY_STATUSES.join(', ')}.`, start, end);
      }
      const values: QueryStatus[] = [];
      for (const w of words) {
        if (!(QUERY_STATUSES as readonly string[]).includes(w)) {
          throw new QueryError(
            `"${w}" isn't a status. Use ${QUERY_STATUSES.join(', ')}.`,
            start,
            end
          );
        }
        if (!values.includes(w as QueryStatus)) values.push(w as QueryStatus);
      }
      return { type: 'status', negated, start, end, values };
    }
    if (words.length !== 1 || (words[0] !== 'yes' && words[0] !== 'no')) {
      throw new QueryError('Use favorite:yes or favorite:no.', start, end);
    }
    return { type: 'favorite', negated, start, end, value: words[0] === 'yes' };
  }

  let exact = false;
  if (s.peek() === '=') {
    exact = true;
    s.pos += 1;
  }
  const matchers: Matcher[] = [];
  for (;;) {
    if (s.done || isSpace(s.peek())) break;
    if (s.peek() === ',') {
      s.pos += 1;
      continue;
    }
    if (s.peek() === '"') {
      const value = s.readQuoted();
      if (value !== '') matchers.push({ kind: 'text', value, exact });
      continue;
    }
    if (s.peek() === '/') {
      const regex = s.tryReadRegex(true);
      if (regex) {
        if (regex.kind === 'regex') matchers.push(regex);
        continue;
      }
    }
    const value = s.readBare(true);
    if (value !== '') matchers.push({ kind: 'text', value, exact });
  }
  if (matchers.length === 0) {
    throw new QueryError(
      `${field}: needs a value, e.g. ${field}:"name".`,
      start,
      Math.max(s.pos, valueStart)
    );
  }
  return { type: 'field', field: field as TextField, negated, start, end: s.pos, matchers };
}

function parseTerm(s: Scanner): QueryTerm | null {
  const start = s.pos;
  let negated = false;
  if (s.peek() === '-') {
    negated = true;
    s.pos += 1;
    if (s.done || isSpace(s.peek())) return null;
  }
  const fieldMatch = FIELD_RE.exec(s.text.slice(s.pos, s.pos + 9));
  if (fieldMatch) {
    s.pos += fieldMatch[0].length;
    return parseField(s, fieldMatch[1].toLowerCase() as Field, negated, start);
  }
  if (s.peek() === '"') {
    const value = s.readQuoted();
    if (value === '') return null;
    return {
      type: 'any',
      negated,
      start,
      end: s.pos,
      matcher: { kind: 'text', value, exact: false }
    };
  }
  if (s.peek() === '/') {
    const regex = s.tryReadRegex(false);
    if (regex) {
      if (regex.kind === 'text') return null;
      return { type: 'any', negated, start, end: s.pos, matcher: regex };
    }
  }
  const value = s.readBare(false);
  if (value === '') return null;
  return {
    type: 'any',
    negated,
    start,
    end: s.pos,
    matcher: { kind: 'text', value, exact: false }
  };
}

/** Parses a library search. Never throws. */
export function parseQuery(text: string): ParseResult {
  try {
    if (text.length > QUERY_LIMITS.maxLength) {
      throw new QueryError(
        `A search can be at most ${QUERY_LIMITS.maxLength} characters long.`,
        QUERY_LIMITS.maxLength,
        text.length
      );
    }
    const s = new Scanner(text);
    const terms: QueryTerm[] = [];
    for (;;) {
      s.skipSpace();
      if (s.done) break;
      const before = s.pos;
      const term = parseTerm(s);
      if (s.pos === before) s.pos += 1; // never loop on a character nothing consumed
      if (!term) continue;
      terms.push(term);
      if (terms.length > QUERY_LIMITS.maxTerms) {
        throw new QueryError(
          `A search can have at most ${QUERY_LIMITS.maxTerms} parts.`,
          term.start,
          term.end
        );
      }
    }
    return { ok: true, query: { terms } };
  } catch (error) {
    if (error instanceof QueryError) {
      return { ok: false, error: { message: error.message, start: error.start, end: error.end } };
    }
    throw error;
  }
}

/** True when the query filters by the user's own book state (status: or favorite:). */
export function usesBookState(query: ParsedQuery): boolean {
  return query.terms.some((t) => t.type === 'status' || t.type === 'favorite');
}

/** True when the query contains a /regex/ (the server runs those in a worker). */
export function usesRegex(query: ParsedQuery): boolean {
  return query.terms.some((t) =>
    t.type === 'any'
      ? t.matcher.kind === 'regex'
      : t.type === 'field' && t.matchers.some((m) => m.kind === 'regex')
  );
}

export { FIELDS as QUERY_FIELDS };
