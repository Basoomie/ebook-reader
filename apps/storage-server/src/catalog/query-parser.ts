/**
 * The library search parser (WP7a): vendor/library-query.cjs, built by
 * `pnpm build:server-query` in apps/web from the web app's own parser, so both sides
 * read a query the same way. A web test fails when the committed file is out of date.
 * The types below mirror apps/web/src/lib/library/query/parse.ts; the server tests run
 * the real bundle, so a mismatch shows up there.
 */
import path from 'path';

export type QueryStatus = 'unread' | 'reading' | 'completed' | 'dropped';
export type TextField = 'author' | 'series' | 'tag';

export type Matcher =
  | { kind: 'text'; value: string; exact: boolean }
  | { kind: 'regex'; source: string; ignoreCase: boolean };

interface TermBase {
  negated: boolean;
  start: number;
  end: number;
}

export type QueryTerm =
  | (TermBase & { type: 'any'; matcher: Matcher })
  | (TermBase & { type: 'field'; field: TextField; matchers: Matcher[] })
  | (TermBase & { type: 'chars'; min: number | null; max: number | null })
  | (TermBase & { type: 'status'; values: QueryStatus[] })
  | (TermBase & { type: 'favorite'; value: boolean })
  | (TermBase & { type: 'device' });

export interface ParsedQuery {
  terms: QueryTerm[];
}

export interface QueryErrorInfo {
  message: string;
  start: number;
  end: number;
}

export type ParseResult = { ok: true; query: ParsedQuery } | { ok: false; error: QueryErrorInfo };

interface QueryBundle {
  parseQuery(text: string): ParseResult;
  usesRegex(query: ParsedQuery): boolean;
  usesBookState(query: ParsedQuery): boolean;
  QUERY_LIMITS: { maxLength: number; maxTerms: number; maxRegexes: number; maxRegexLength: number };
}

/** From src/catalog (ts-node) and dist/catalog (Docker) alike: <package>/vendor. */
export const QUERY_BUNDLE = path.resolve(__dirname, '..', '..', 'vendor', 'library-query.cjs');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(QUERY_BUNDLE) as QueryBundle;

export const parseQuery = bundle.parseQuery;
export const usesRegex = bundle.usesRegex;
export const usesBookState = bundle.usesBookState;
export const QUERY_LIMITS = bundle.QUERY_LIMITS;

export class InvalidQueryError extends Error {
  constructor(readonly info: QueryErrorInfo) {
    super(info.message);
  }
}

/** Parses or throws InvalidQueryError. An empty or missing query has no terms. */
export function parseOrThrow(text: string | undefined): ParsedQuery {
  const result = parseQuery(text ?? '');
  if (!result.ok) throw new InvalidQueryError(result.error);
  return result.query;
}
