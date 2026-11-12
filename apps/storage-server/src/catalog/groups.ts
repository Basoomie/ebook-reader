/**
 * Library browse tabs (WP7a, decisions "Library UI"): one card per series, author or
 * tag. A group is listed when at least one of its books matches the search; the card's
 * numbers are always the whole group's (within the library picker), so a search for
 * `status:reading` in Series lists the series you are reading with their full volume
 * count and totals.
 *
 * Order: the group's newest book first ("date added", the decided default), "No series"
 * last. Groups are addressed by name: Calibre names are unique, while their integer ids
 * change when a series is deleted and created again.
 *
 * Series cards carry the lowest-index volume as cover and every book id (the client
 * computes "3/12 read" from its own book-state records, like the rows). Author, tag and
 * "No series" cards carry up to four collage tiles in the decided order: books you have
 * opened (most recent first), then one lowest-index volume per series (newest series
 * first), then the newest books.
 */
import type Database from 'better-sqlite3';
import { SQL_COUNT_SOURCE_KEY } from '../counts/count-records';
import { catalogVersion } from './catalog-version';
import { parseOrThrow, usesRegex } from './query-parser';
import {
  BookSummary,
  CatalogUser,
  DEFAULT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  GroupBy,
  groupMemberSql,
  MAX_PAGE_SIZE,
  PlannedQuery,
  SQL_BOOK_FROM,
  SQL_CATALOG_SOURCE,
  summariesByIds,
  visibilitySql,
} from './queries';
import { groupNameSql, querySql, type SqlCondition } from './search-sql';
import { DEFAULT_GROUP_SORT, type GroupSort } from './sort';

export interface GroupChars {
  /** Sum of the counts the group's books have (a book waiting for a recount adds its old count). */
  total: number;
  counted: number;
  /** Not counted yet, or waiting for a recount. */
  pending: number;
  /** Could not be counted. */
  failed: number;
}

export interface GroupTile {
  bookId: string;
  thumbnail: string | null;
  /** For tag blur rules (the client decides what is blurred). */
  tags: string[];
}

export interface GroupCard {
  by: GroupBy;
  /** null only for "No series". */
  name: string | null;
  bookCount: number;
  newestAddedAt: number;
  chars: GroupChars;
  /** Series: the lowest-index volume. */
  cover?: GroupTile | null;
  /** Series: every book, in series order. */
  bookIds?: string[];
  /** Authors, tags, "No series": up to four tiles in collage order. */
  tiles?: GroupTile[];
}

export interface GroupPage {
  groups: GroupCard[];
  nextCursor: string | null;
  /** How many groups the whole list has (WP19a: "312 series"). */
  total: number;
}

export interface ListGroupsOptions {
  by: GroupBy;
  libraryId?: string;
  query?: string;
  /** WP19a. Absent: newest group first. "No series" is always last. */
  sort?: GroupSort;
  limit?: number;
  cursor?: string;
  includeMissing?: boolean;
  countSpec?: string | null;
}

export interface GroupRow {
  gid: number | null;
  name: string | null;
  n: number;
  newest: number;
  total: number | null;
  counted: number;
  pending: number;
  failed: number;
}

const GROUPING: Record<GroupBy, { join: string; gid: string; table: string }> = {
  series: { join: '', gid: 'b.series_id', table: 'series' },
  author: {
    join: 'JOIN book_authors ga ON ga.book_id = b.id',
    gid: 'ga.author_id',
    table: 'authors',
  },
  tag: { join: 'JOIN book_tags ga ON ga.book_id = b.id', gid: 'ga.tag_id', table: 'tags' },
};

/** charCountStatus() in SQL: 'c' counted, 'p' pending, 'e' error. Two spec parameters. */
const COUNT_STATE = `CASE
    WHEN c.status IS NULL OR IFNULL(c.source_key = ${SQL_COUNT_SOURCE_KEY}, 0) = 0
      OR (? IS NOT NULL AND c.spec IS NOT ?) THEN 'p'
    WHEN c.status = 'ok' THEN 'c' ELSE 'e' END`;

function joinConds(conds: SqlCondition[]): { sql: string; params: unknown[] } {
  return {
    sql: conds.length ? `WHERE ${conds.map((c) => c.sql).join(' AND ')}` : '',
    params: conds.flatMap((c) => c.params),
  };
}

/**
 * Whole-group numbers for every group, in page order ("No series" last). Computing them
 * reads every book (~0.15-0.4 s on 65k books on the PC), so they are cached until the
 * catalog changes (catalog-version.ts: the indexer, library records, counts, or another
 * connection such as the CLI). Reading on another device doesn't clear them.
 */
const aggregateCache = new WeakMap<
  Database.Database,
  Map<string, { changes: string; rows: GroupRow[] }>
>();

/** Collage picks per group, cached the same way (they also depend on your opened books). */
const tileCache = new WeakMap<Database.Database, Map<string, { changes: string; ids: string[] }>>();

/** Collages also change with your own records (opened books). */
function userVersion(db: Database.Database, userId: string): string {
  const { rev } = db
    .prepare('SELECT MAX(rev) AS rev FROM sync_records WHERE user_id = ?')
    .get(userId) as { rev: number | null };
  return `${catalogVersion(db)}:${rev ?? 0}`;
}

/** Forgets cached group numbers and collages (benchmarks). */
export function clearGroupCaches(db: Database.Database): void {
  aggregateCache.delete(db);
  tileCache.delete(db);
}

function compareNames(a: GroupRow, b: GroupRow): number {
  const an = a.name ?? '';
  const bn = b.name ?? '';
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** The default order (and the cache's): newest group first, then by name. */
function compareGroups(a: GroupRow, b: GroupRow): number {
  return groupComparator(DEFAULT_GROUP_SORT)(a, b);
}

/**
 * Group order for a sort (WP19a). "No series" is always last; ties go by name (A→Z),
 * so the order is total and a cursor (newest, count, name) finds its place.
 */
export function groupComparator(sort: GroupSort): (a: GroupRow, b: GroupRow) => number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return (a, b) => {
    if ((a.gid === null) !== (b.gid === null)) return a.gid === null ? 1 : -1;
    if (sort.key === 'name') return sign * compareNames(a, b);
    const diff = sort.key === 'count' ? a.n - b.n : a.newest - b.newest;
    if (diff !== 0) return sign * diff;
    return compareNames(a, b);
  };
}

export function aggregateGroups(
  db: Database.Database,
  opts: Pick<ListGroupsOptions, 'by' | 'libraryId' | 'includeMissing' | 'countSpec'>,
): GroupRow[] {
  const spec = opts.countSpec ?? null;
  const key = JSON.stringify([opts.by, opts.libraryId ?? '', !!opts.includeMissing, spec]);
  const changes = catalogVersion(db);
  let cache = aggregateCache.get(db);
  if (!cache) {
    cache = new Map();
    aggregateCache.set(db, cache);
  }
  const hit = cache.get(key);
  if (hit && hit.changes === changes) return hit.rows;
  // One pass over the visible books and one over the membership table, summed here:
  // GROUP BY over the joined rows (227k tag links on 65k books) sorts them all and
  // took ~0.9 s for tags on the PC; this takes a fraction of that (WP7a benchmark).
  const base = joinConds(visibilitySql(opts));
  const books = new Map<string, [number | null, number, number | null, string]>();
  for (const [id, seriesId, addedAt, chars, cs] of db
    .prepare(
      `SELECT b.id, b.series_id, b.added_at, b.char_count, ${COUNT_STATE} AS cs
         ${SQL_BOOK_FROM}
         LEFT JOIN char_counts c ON c.book_id = b.id
         ${base.sql}`,
    )
    .raw()
    .iterate(spec, spec, ...base.params) as IterableIterator<
    [string, number | null, number, number | null, string]
  >) {
    books.set(id, [seriesId, addedAt, chars, cs]);
  }
  const byGroup = new Map<number | null, GroupRow>();
  const addTo = (gid: number | null, book: [number | null, number, number | null, string]) => {
    let row = byGroup.get(gid);
    if (!row) {
      row = { gid, name: null, n: 0, newest: 0, total: 0, counted: 0, pending: 0, failed: 0 };
      byGroup.set(gid, row);
    }
    row.n += 1;
    if (book[1] > row.newest) row.newest = book[1];
    row.total = (row.total ?? 0) + (book[2] ?? 0);
    if (book[3] === 'c') row.counted += 1;
    else if (book[3] === 'p') row.pending += 1;
    else row.failed += 1;
  };
  if (opts.by === 'series') {
    for (const book of books.values()) addTo(book[0], book);
  } else {
    const link =
      opts.by === 'author'
        ? 'SELECT book_id, author_id FROM book_authors'
        : 'SELECT book_id, tag_id FROM book_tags';
    for (const [bookId, gid] of db.prepare(link).raw().iterate() as IterableIterator<
      [string, number]
    >) {
      const book = books.get(bookId);
      if (book) addTo(gid, book);
    }
  }
  const names = new Map(
    db.prepare(`SELECT id, name FROM ${GROUPING[opts.by].table}`).raw().all() as [number, string][],
  );
  const rows = [...byGroup.values()];
  for (const row of rows) row.name = row.gid === null ? null : (names.get(row.gid) ?? null);
  rows.sort(compareGroups);
  cache.set(key, { changes, rows });
  return rows;
}

export function planGroups(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
): PlannedQuery<GroupPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const parsed = parseOrThrow(opts.query);
  const g = GROUPING[opts.by];
  const spec = opts.countSpec ?? null;
  const sort = opts.sort ?? DEFAULT_GROUP_SORT;
  const compare = groupComparator(sort);
  const cursor = opts.cursor ? decodeGroupCursor(opts.cursor) : null;

  // The groups with a matching book (only this part can contain a pattern).
  let sql = 'SELECT NULL AS gid WHERE 0';
  let params: unknown[] = [];
  const filtered = parsed.terms.length > 0;
  if (filtered) {
    const names = joinConds(groupNameSql(parsed, opts.by, 'gn.name'));
    const conds: SqlCondition[] = [
      ...visibilitySql(opts),
      ...querySql(parsed, user.id, undefined, user.deviceId ?? null),
    ];
    if (names.sql) {
      conds.push({
        sql: `(${g.gid} IS NULL OR ${g.gid} IN (SELECT gn.id FROM ${g.table} gn ${names.sql}))`,
        params: names.params,
      });
    }
    const where = joinConds(conds);
    sql = `SELECT DISTINCT ${g.gid} AS gid ${SQL_BOOK_FROM} ${g.join} ${where.sql}`;
    params = where.params;
  }
  return {
    sql,
    params,
    regex: usesRegex(parsed),
    finish(raw) {
      const hits = new Set((raw as { gid: number | null }[]).map((r) => r.gid));
      let all = aggregateGroups(db, opts).filter(
        (r) => (opts.by === 'series' || r.gid !== null) && (!filtered || hits.has(r.gid)),
      );
      // The cached rows are in the default order; other sorts sort a copy.
      if (sort.key !== DEFAULT_GROUP_SORT.key || sort.dir !== DEFAULT_GROUP_SORT.dir) {
        all = [...all].sort(compare);
      }
      let start = 0;
      if (cursor) {
        const probe = { gid: 0, name: cursor.name, newest: cursor.newest, n: cursor.n } as GroupRow;
        start = all.findIndex((r) => compare(r, probe) > 0);
        if (start === -1) start = all.length;
      }
      const page = all.slice(start, start + limit);
      const last = page[page.length - 1];
      const nextCursor =
        start + limit < all.length && last && last.name !== null
          ? encodeCursor([last.newest, last.n, last.name])
          : null;
      return {
        groups: describeGroups(db, user, opts, page, spec),
        nextCursor,
        total: all.length,
      };
    },
  };
}

/** [newest, count, name]; the pre-WP19 [newest, name] still works (newest-first order). */
function decodeGroupCursor(cursor: string): { newest: number; n: number; name: string } {
  try {
    const [newest, n, name] = decodeCursor(cursor, ['number', 'number', 'string']);
    return { newest: newest as number, n: n as number, name: name as string };
  } catch {
    const [newest, name] = decodeCursor(cursor, ['number', 'string']);
    return { newest: newest as number, n: 0, name: name as string };
  }
}

function tileOf(summary: BookSummary | undefined): GroupTile | null {
  return summary ? { bookId: summary.id, thumbnail: summary.thumbnail, tags: summary.tags } : null;
}

const TILE_COUNT = 4;
/** Newest books looked at for the "one volume per series" step of a collage. */
const TILE_SCAN = 60;

function describeGroups(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
  rows: GroupRow[],
  spec: string | null,
): GroupCard[] {
  const visible = visibilitySql(opts);
  const cards: GroupCard[] = rows.map((r) => ({
    by: opts.by,
    name: r.name,
    bookCount: r.n,
    newestAddedAt: r.newest,
    chars: { total: r.total ?? 0, counted: r.counted, pending: r.pending, failed: r.failed },
  }));

  const wanted = new Set<string>();
  const seriesMembers = new Map<number, string[]>();
  const named = rows.filter((r) => r.gid !== null);
  if (opts.by === 'series' && named.length > 0) {
    const cond = joinConds([
      ...visible,
      {
        sql: `b.series_id IN (${named.map(() => '?').join(',')})`,
        params: named.map((r) => r.gid),
      },
    ]);
    for (const m of db
      .prepare(
        `SELECT b.id, b.series_id ${SQL_BOOK_FROM} ${cond.sql}
          ORDER BY b.series_id, IFNULL(b.series_index, -1), b.added_at, b.id`,
      )
      .all(...cond.params) as { id: string; series_id: number }[]) {
      const list = seriesMembers.get(m.series_id) ?? [];
      list.push(m.id);
      seriesMembers.set(m.series_id, list);
    }
    for (const list of seriesMembers.values()) wanted.add(list[0]);
  }

  const tiles = new Map<GroupRow, string[]>();
  for (const r of rows) {
    if (opts.by === 'series' && r.gid !== null) continue;
    const ids = collageIds(db, user, opts, r);
    tiles.set(r, ids);
    ids.forEach((id) => wanted.add(id));
  }

  const summaries = summariesByIds(db, user, [...wanted], spec);
  rows.forEach((r, i) => {
    if (opts.by === 'series' && r.gid !== null) {
      const ids = seriesMembers.get(r.gid) ?? [];
      cards[i].bookIds = ids;
      cards[i].cover = ids.length ? tileOf(summaries.get(ids[0])) : null;
    } else {
      cards[i].tiles = (tiles.get(r) ?? [])
        .map((id) => tileOf(summaries.get(id)))
        .filter((t): t is GroupTile => t !== null);
    }
  });
  return cards;
}

/** Up to four book ids in the decided collage order (cached until the next write). */
function collageIds(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
  row: GroupRow,
): string[] {
  const key = JSON.stringify([
    user.id,
    opts.by,
    row.gid,
    opts.libraryId ?? '',
    !!opts.includeMissing,
  ]);
  const changes = userVersion(db, user.id);
  let cache = tileCache.get(db);
  if (!cache) {
    cache = new Map();
    tileCache.set(db, cache);
  }
  const hit = cache.get(key);
  if (hit && hit.changes === changes) return hit.ids;
  if (cache.size > 5000) cache.clear();
  const ids = pickCollage(db, user, opts, row);
  cache.set(key, { changes, ids });
  return ids;
}

function pickCollage(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
  row: GroupRow,
): string[] {
  const member =
    opts.by === 'series'
      ? groupMemberSql({ by: 'series', name: null })
      : opts.by === 'author'
        ? {
            sql: 'EXISTS (SELECT 1 FROM book_authors x WHERE x.book_id = b.id AND x.author_id = ?)',
            params: [row.gid],
          }
        : {
            sql: 'EXISTS (SELECT 1 FROM book_tags x WHERE x.book_id = b.id AND x.tag_id = ?)',
            params: [row.gid],
          };
  const visible = visibilitySql(opts);
  const picked: string[] = [];
  const seriesShown = new Set<number>();
  const add = (id: string, seriesId: number | null) => {
    if (picked.length >= TILE_COUNT || picked.includes(id)) return;
    picked.push(id);
    if (seriesId !== null) seriesShown.add(seriesId);
  };

  // 1. Books you have opened (live position records), most recent first.
  const opened = joinConds([
    { sql: "p.user_id = ? AND p.kind = 'position' AND p.deleted_at IS NULL", params: [user.id] },
    member,
    ...visible,
  ]);
  for (const r of db
    .prepare(
      `SELECT b.id, b.series_id FROM sync_records p
         CROSS JOIN books b ON b.id = p.book_id
         CROSS JOIN book_sources s ON s.book_id = b.id AND ${SQL_CATALOG_SOURCE}
         JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
         ${opened.sql}
        GROUP BY b.id ORDER BY MAX(p.updated_at) DESC LIMIT ${TILE_COUNT}`,
    )
    .all(...opened.params) as { id: string; series_id: number | null }[]) {
    add(r.id, r.series_id);
  }
  if (picked.length >= TILE_COUNT) return picked;

  // The group's newest books (for steps 2 and 3).
  const memberDriven =
    opts.by === 'author'
      ? 'FROM book_authors gm CROSS JOIN books b ON b.id = gm.book_id'
      : opts.by === 'tag'
        ? 'FROM book_tags gm CROSS JOIN books b ON b.id = gm.book_id'
        : 'FROM books b';
  const newestCond = joinConds([
    opts.by === 'series'
      ? member
      : { sql: `gm.${opts.by === 'author' ? 'author_id' : 'tag_id'} = ?`, params: [row.gid] },
    ...visible,
  ]);
  const newest = db
    .prepare(
      `SELECT b.id, b.series_id ${memberDriven}
         CROSS JOIN book_sources s ON s.book_id = b.id AND ${SQL_CATALOG_SOURCE}
         JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
         ${newestCond.sql}
        ORDER BY b.added_at DESC, b.id DESC LIMIT ${TILE_SCAN}`,
    )
    .all(...newestCond.params) as { id: string; series_id: number | null }[];

  // 2. One lowest-index volume per series (among the group's books), newest series first.
  const firstCond = joinConds([{ sql: 'b.series_id = ?', params: [] }, member, ...visible]);
  const firstVolume = db.prepare(
    `SELECT b.id ${SQL_BOOK_FROM} ${firstCond.sql}
      ORDER BY IFNULL(b.series_index, 1e18), b.added_at, b.id LIMIT 1`,
  );
  for (const r of newest) {
    if (picked.length >= TILE_COUNT) break;
    if (r.series_id === null || seriesShown.has(r.series_id)) continue;
    const first = firstVolume.get(r.series_id, ...firstCond.params) as { id: string } | undefined;
    seriesShown.add(r.series_id);
    if (first) add(first.id, r.series_id);
  }

  // 3. The newest books.
  for (const r of newest) add(r.id, r.series_id);
  return picked;
}
