/**
 * Turns a parsed library search (query-parser.ts) into SQL conditions on the book
 * query (WP7a). Every condition is a filter on `b` (books) checked while SQLite walks
 * the books in page order, so the plan stays "SCAN b USING INDEX books_added":
 *
 * - author/series/tag and plain text: the matching author, series and tag ids are
 *   computed once per term from their small tables (IN (SELECT ...)), never per book.
 * - chars: books.char_count; books without a count never match (also when negated).
 * - status/favorite: the user's own book-state records (sync_records primary key
 *   user_id, kind, id = book id). No record = unread / not a favorite.
 * - /regex/: ttu_regexp() (regexp.ts). Queries that use it run in the search worker.
 */
import type Database from 'better-sqlite3';
import type { Matcher, ParsedQuery, QueryStatus, QueryTerm, TextField } from './query-parser';

/**
 * Up to this many books, an author: or tag: filter lets SQLite start from those books
 * (and sort them); above it SQLite walks all books in date order and stops at the page.
 * Measured on the real library (WP7a): starting from the ~20k "Unknown" books took
 * ~225 ms, walking takes ~30 ms; for a handful of books starting from them takes ~1 ms
 * against ~50 ms for a walk that finds nothing early.
 */
export const SMALL_SET = 2000;

/**
 * How many books an author/tag filter names, counted through the index (cheap), or
 * Infinity when unknown (no database, or a pattern: never run a user pattern on the main
 * thread).
 */
function linkCount(
  db: Database.Database | undefined,
  field: 'author' | 'tag',
  matchers: Matcher[],
): number {
  if (!db || matchers.some((m) => m.kind === 'regex')) return Infinity;
  const name = anyMatcherSql('name', matchers);
  const sql =
    field === 'author'
      ? `SELECT COUNT(*) AS n FROM book_authors WHERE author_id IN (SELECT id FROM authors WHERE ${name.sql})`
      : `SELECT COUNT(*) AS n FROM book_tags WHERE tag_id IN (SELECT id FROM tags WHERE ${name.sql})`;
  return (db.prepare(sql).get(...name.params) as { n: number }).n;
}

/** "" to let SQLite start from a small set of books, "+" to keep the date-order walk. */
export function setPrefix(count: number): '' | '+' {
  return count <= SMALL_SET ? '' : '+';
}

export interface SqlCondition {
  sql: string;
  params: unknown[];
}

/** A LIKE pattern (escape character "!") matching `term` anywhere, with %, _ and ! taken literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`;
}

/** One matcher on a text column. LIKE and NOCASE ignore case for ASCII only. */
export function matcherSql(column: string, m: Matcher): SqlCondition {
  if (m.kind === 'regex') {
    return { sql: `ttu_regexp(?, ?, ${column})`, params: [m.source, m.ignoreCase ? 'i' : ''] };
  }
  if (m.exact) return { sql: `${column} = ? COLLATE NOCASE`, params: [m.value] };
  return { sql: `${column} LIKE ? ESCAPE '!'`, params: [likePattern(m.value)] };
}

/** Any of the matchers on one column. */
export function anyMatcherSql(column: string, matchers: Matcher[]): SqlCondition {
  const parts = matchers.map((m) => matcherSql(column, m));
  return {
    sql: parts.length === 1 ? parts[0].sql : `(${parts.map((p) => p.sql).join(' OR ')})`,
    params: parts.flatMap((p) => p.params),
  };
}

function fieldSql(field: TextField, matchers: Matcher[], db?: Database.Database): SqlCondition {
  const name = anyMatcherSql('name', matchers);
  switch (field) {
    case 'author':
      return {
        sql: `${setPrefix(linkCount(db, 'author', matchers))}b.id IN (SELECT ba.book_id FROM book_authors ba
                        WHERE ba.author_id IN (SELECT id FROM authors WHERE ${name.sql}))`,
        params: name.params,
      };
    case 'series':
      return {
        sql: `IFNULL(b.series_id IN (SELECT id FROM series WHERE ${name.sql}), 0)`,
        params: name.params,
      };
    case 'tag':
      return {
        sql: `${setPrefix(linkCount(db, 'tag', matchers))}b.id IN (SELECT bt.book_id FROM book_tags bt
                        WHERE bt.tag_id IN (SELECT id FROM tags WHERE ${name.sql}))`,
        params: name.params,
      };
  }
}

/** Plain text and bare patterns: the title, any author name or the series name. */
function anySql(m: Matcher): SqlCondition {
  const title = matcherSql('b.title', m);
  const series = fieldSql('series', [m]);
  const author = fieldSql('author', [m]);
  return {
    sql: `(${title.sql} OR ${series.sql} OR ${author.sql})`,
    params: [...title.params, ...series.params, ...author.params],
  };
}

const REAL_STATUSES: QueryStatus[] = ['unread', 'reading', 'completed', 'dropped'];

function statusRecords(userId: string, statuses: QueryStatus[]): SqlCondition {
  return {
    sql: `SELECT id FROM sync_records
           WHERE user_id = ? AND kind = 'book-status' AND deleted_at IS NULL
             AND json_extract(data, '$.status') IN (${statuses.map(() => '?').join(',')})`,
    params: [userId, ...statuses],
  };
}

function statusSql(userId: string, values: QueryStatus[]): SqlCondition {
  // No record means unread, so "unread or X" is "none of the other statuses".
  if (values.includes('unread')) {
    const others = REAL_STATUSES.filter((s) => !values.includes(s));
    if (others.length === 0) return { sql: '1', params: [] };
    const sub = statusRecords(userId, others);
    return { sql: `b.id NOT IN (${sub.sql})`, params: sub.params };
  }
  const sub = statusRecords(userId, values);
  return { sql: `b.id IN (${sub.sql})`, params: sub.params };
}

function favoriteSql(userId: string, value: boolean): SqlCondition {
  return {
    sql: `b.id ${value ? 'IN' : 'NOT IN'} (SELECT id FROM sync_records
           WHERE user_id = ? AND kind = 'book-favorite' AND deleted_at IS NULL
             AND json_extract(data, '$.favorite') = 1)`,
    params: [userId],
  };
}

function charsSql(min: number | null, max: number | null): SqlCondition {
  const parts = ['b.char_count IS NOT NULL'];
  const params: unknown[] = [];
  if (min !== null) {
    parts.push('b.char_count >= ?');
    params.push(min);
  }
  if (max !== null) {
    parts.push('b.char_count <= ?');
    params.push(max);
  }
  return { sql: `(${parts.join(' AND ')})`, params };
}

/**
 * One term as SQL. With `db`, author:/tag: filters pick their plan by size (SMALL_SET);
 * without it they always walk books in date order.
 */
export function termSql(term: QueryTerm, userId: string, db?: Database.Database): SqlCondition {
  if (term.type === 'chars') {
    const range = charsSql(term.min, term.max);
    // A book without a count is never included, negated or not.
    return term.negated
      ? { sql: `(b.char_count IS NOT NULL AND NOT ${range.sql})`, params: range.params }
      : range;
  }
  let cond: SqlCondition;
  switch (term.type) {
    case 'any':
      cond = anySql(term.matcher);
      break;
    case 'field':
      cond = fieldSql(term.field, term.matchers, term.negated ? undefined : db);
      break;
    case 'status':
      cond = statusSql(userId, term.values);
      break;
    case 'favorite':
      cond = favoriteSql(userId, term.value);
      break;
  }
  return term.negated ? { sql: `NOT IFNULL(${cond.sql}, 0)`, params: cond.params } : cond;
}

/** All terms, ANDed. */
export function querySql(
  query: ParsedQuery,
  userId: string,
  db?: Database.Database,
): SqlCondition[] {
  return query.terms.map((t) => termSql(t, userId, db));
}

/**
 * In a grouped tab, the terms on the grouping field also filter the groups by name:
 * in Authors, `author:日向` lists 日向夏 and not every co-author of their books.
 */
export function groupNameSql(query: ParsedQuery, field: TextField, column: string): SqlCondition[] {
  return query.terms
    .filter(
      (t): t is Extract<QueryTerm, { type: 'field' }> => t.type === 'field' && t.field === field,
    )
    .map((t) => {
      const cond = anyMatcherSql(column, t.matchers);
      return t.negated ? { sql: `NOT IFNULL(${cond.sql}, 0)`, params: cond.params } : cond;
    });
}
