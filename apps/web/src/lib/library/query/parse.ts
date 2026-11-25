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
 *   field   := author | illustrator | series | tag | chars | level | rating | ratings | readers
 *              | myrating | status | favorite | on
 *   author/illustrator/series/tag value := ["="] item ("," item)*   "=" exact; "," = any of
 *   item    := "quoted" | /regex/[i] | bare  (a quoted item is never split at commas)
 *   chars   := [<|<=|>|>=|=] N  |  N-N       N: digits, "," or "_" separators, "k" = 1000
 *   level   := [<|<=|>|>=|=] N  |  N-N       the Natively level (N: digits)
 *   rating  := [<|<=|>|>=|=] S  |  S-S       readers' stars on the stores (Amazon and BOOK☆WALKER
 *                                            pooled); S: 0-5 with one decimal; a bare whole
 *                                            number is that star's band (rating:4 = 4.0-4.9)
 *   myrating:= the same, on your own rating (Calibre's)
 *   ratings := like chars                    how many people rated it on those stores
 *   readers := like chars                    読書メーター's 登録数 (people who logged it)
 *   status  := unread|reading|completed|dropped ("," = any of)
 *   favorite:= yes|no
 *   on      := device                       the books stored on the device that searches
                                              (WP15e; the server knows it from the token)
 *   regex   := /body/ or /body/i             JavaScript syntax, Unicode mode; the body may
 *                                            contain spaces ("/" is a literal slash)
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

export type TextField = 'author' | 'illustrator' | 'series' | 'tag';

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
  /** Plain text or a bare /regex/: title, any author or illustrator name or the series name. */
  | (TermBase & { type: 'any'; matcher: Matcher })
  /** author: / illustrator: / series: / tag: with one or more alternatives (any of them). */
  | (TermBase & { type: 'field'; field: TextField; matchers: Matcher[] })
  /** chars: inclusive bounds; null = open. */
  | (TermBase & { type: 'chars'; min: number | null; max: number | null })
  /** level: the Natively level, inclusive bounds; null = open. Books without one never match. */
  | (TermBase & { type: 'level'; min: number | null; max: number | null })
  /**
   * rating: the stores' pooled stars, myrating: your own; inclusive bounds in tenths of a star
   * (4.5 = 45); null = open. Books without one never match.
   */
  | (TermBase & { type: 'rating' | 'myrating'; min: number | null; max: number | null })
  /** ratings: the stores' rating count, readers: 読書メーター's 登録数; inclusive bounds. */
  | (TermBase & { type: 'ratings' | 'readers'; min: number | null; max: number | null })
  | (TermBase & { type: 'status'; values: QueryStatus[] })
  | (TermBase & { type: 'favorite'; value: boolean })
  /** on:device: the books stored on the device that asks (WP15e). */
  | (TermBase & { type: 'device' })
  /** on:audio: the books whose audio the device that asks has downloaded (Season 2 Phase 9). */
  | (TermBase & { type: 'deviceAudio' });

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

const FIELDS = [
  'author',
  'illustrator',
  'series',
  'tag',
  'chars',
  'level',
  'rating',
  'ratings',
  'readers',
  'myrating',
  'status',
  'favorite',
  'on'
] as const;
type Field = (typeof FIELDS)[number];

const FIELD_RE =
  /^(author|illustrator|series|tag|chars|level|ratings|rating|readers|myrating|status|favorite|on)[:：]/i;
/** Characters FIELD_RE needs to see: the longest field name and its colon. */
const FIELD_LOOKAHEAD = Math.max(...FIELDS.map((f) => f.length)) + 1;

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

function parseCharsNumber(raw: string): number | null {
  const thousands = /^(\d+(?:\.\d+)?)k$/i.exec(raw);
  if (thousands) return Math.round(Number(thousands[1]) * 1000);
  if (!/^\d[\d,_]*$/.test(raw)) return null;
  const value = Number(raw.replace(/[,_]/g, ''));
  return Number.isSafeInteger(value) ? value : null;
}

const CHARS_HELP = 'Use chars:<150000, chars:>=50k or chars:50000-150000.';
const LEVEL_HELP = 'Use level:<25, level:>=30 or level:20-29.';

function parseLevelNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function parseRange(
  raw: string,
  start: number,
  end: number,
  field: 'chars' | 'level' = 'chars'
): { min: number | null; max: number | null } {
  const HELP = field === 'chars' ? CHARS_HELP : LEVEL_HELP;
  const parseNumber = field === 'chars' ? parseCharsNumber : parseLevelNumber;
  if (raw === '') throw new QueryError(`${field}: needs a number. ${HELP}`, start, end);
  const range = /^([^-]+)-([^-]+)$/.exec(raw);
  if (range) {
    const low = parseNumber(range[1]);
    const high = parseNumber(range[2]);
    if (low === null || high === null) {
      throw new QueryError(`"${raw}" isn't a number range. ${HELP}`, start, end);
    }
    if (low > high) {
      throw new QueryError('The first number of a range must be the smaller one.', start, end);
    }
    return { min: low, max: high };
  }
  const compare = /^(<=|>=|<|>|=)?(.*)$/.exec(raw)!;
  const op = compare[1] ?? '=';
  const value = parseNumber(compare[2]);
  if (value === null) throw new QueryError(`"${raw}" isn't a number. ${HELP}`, start, end);
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

const STARS_HELP = (f: string) => `Use ${f}:>=4, ${f}:<3.5 or ${f}:4-4.5.`;
const COUNT_HELP = (f: string) => `Use ${f}:>=100, ${f}:<50 or ${f}:1k-5k.`;

/** Stars as tenths ("4.5" = 45), or null. */
function parseStarsNumber(raw: string): number | null {
  const m = /^(\d)(?:\.(\d))?$/.exec(raw);
  if (!m) return null;
  const v = Number(m[1]) * 10 + Number(m[2] ?? 0);
  return v <= 50 ? v : null;
}

/** rating:/myrating: bounds in tenths of a star; a bare whole number is that star's band. */
function parseStarsRange(
  raw: string,
  start: number,
  end: number,
  field: string
): { min: number | null; max: number | null } {
  const HELP = STARS_HELP(field);
  if (raw === '') throw new QueryError(`${field}: needs a number of stars. ${HELP}`, start, end);
  const range = /^([^-]+)-([^-]+)$/.exec(raw);
  if (range) {
    const low = parseStarsNumber(range[1]);
    const high = parseStarsNumber(range[2]);
    if (low === null || high === null) {
      throw new QueryError(`"${raw}" isn't a range of stars (0 to 5). ${HELP}`, start, end);
    }
    if (low > high) {
      throw new QueryError('The first number of a range must be the smaller one.', start, end);
    }
    return { min: low, max: high };
  }
  const compare = /^(<=|>=|<|>|=)?(.*)$/.exec(raw)!;
  const value = parseStarsNumber(compare[2]);
  if (value === null)
    throw new QueryError(`"${raw}" isn't a number of stars (0 to 5). ${HELP}`, start, end);
  switch (compare[1]) {
    case '<':
      return { min: null, max: value - 1 };
    case '<=':
      return { min: null, max: value };
    case '>':
      return { min: value + 1, max: null };
    case '>=':
      return { min: value, max: null };
    case '=':
      return { min: value, max: value };
    default:
      // rating:4 = 4.0-4.9; rating:4.5 = exactly 4.5.
      return compare[2].includes('.')
        ? { min: value, max: value }
        : { min: value, max: Math.min(50, value + 9) };
  }
}

/** ratings:/readers: counts, written like chars: ("1k", "1,000"). */
function parseCountRange(
  raw: string,
  start: number,
  end: number,
  field: string
): { min: number | null; max: number | null } {
  try {
    return parseRange(raw, start, end, 'chars');
  } catch (err) {
    if (!(err instanceof QueryError)) throw err;
    const reason = raw === '' ? `${field}: needs a number.` : `"${raw}" isn't a number.`;
    throw new QueryError(
      err.message.startsWith('The first number') ? err.message : `${reason} ${COUNT_HELP(field)}`,
      start,
      end
    );
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
  if (
    field === 'chars' ||
    field === 'level' ||
    field === 'rating' ||
    field === 'ratings' ||
    field === 'readers' ||
    field === 'myrating' ||
    field === 'status' ||
    field === 'favorite' ||
    field === 'on'
  ) {
    const raw = s.readBare(false);
    const end = s.pos;
    if (field === 'chars')
      return { type: 'chars', negated, start, end, ...parseRange(raw, start, end) };
    if (field === 'level')
      return { type: 'level', negated, start, end, ...parseRange(raw, start, end, 'level') };
    if (field === 'rating' || field === 'myrating')
      return { type: field, negated, start, end, ...parseStarsRange(raw, start, end, field) };
    if (field === 'ratings' || field === 'readers')
      return { type: field, negated, start, end, ...parseCountRange(raw, start, end, field) };
    const words = parseWordList(raw);
    if (field === 'on') {
      if (words.length === 1 && words[0] === 'device') {
        return { type: 'device', negated, start, end };
      }
      if (words.length === 1 && words[0] === 'audio') {
        return { type: 'deviceAudio', negated, start, end };
      }
      throw new QueryError(
        'Use on:device (the books on this device) or on:audio (their audio is on this device).',
        start,
        end
      );
    }
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
  const fieldMatch = FIELD_RE.exec(s.text.slice(s.pos, s.pos + FIELD_LOOKAHEAD));
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

/**
 * True when the query filters by the user's own records (status:, favorite:, or on:device
 * and on:audio, which read this device's list of stored books): unsent changes are sent
 * first.
 */
export function usesBookState(query: ParsedQuery): boolean {
  return query.terms.some(
    (t) =>
      t.type === 'status' ||
      t.type === 'favorite' ||
      t.type === 'device' ||
      t.type === 'deviceAudio'
  );
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
