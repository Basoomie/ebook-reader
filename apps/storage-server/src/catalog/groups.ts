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
  collectionMemberSql,
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
import { DEFAULT_GROUP_SORT, GROUP_FIGURE_KEYS, type GroupSort } from './sort';
import {
  authorFigures,
  figureIndex,
  figureSortValue,
  figureTerms,
  groupFigure,
  type FigureKey,
  type SeriesFigure,
} from './series-figures';

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
  /**
   * For the cover blur rules (the client decides what is blurred): tags, authors, series,
   * and the title and length a smart collection's search may test (2026-11-21).
   */
  tags: string[];
  title: string;
  authors: string[];
  /** Calibre's #illustrator names (an illustrator: search in a smart collection). */
  illustrators: string[];
  series: string | null;
  charCount: number | null;
  /** Store ratings (migration 33): a series card's cover is volume 1, so these are its figures. */
  storeRating: BookSummary['storeRating'];
  readers: number | null;
}

/** A collage tile of a book (groups and collection cards). */
export function tileOfSummary(summary: BookSummary): GroupTile {
  return {
    bookId: summary.id,
    thumbnail: summary.thumbnail,
    tags: summary.tags,
    title: summary.title,
    authors: [...new Set(summary.authors.map((a) => a.name))],
    illustrators: [...new Set(summary.illustrators)],
    series: summary.series?.name ?? null,
    charCount: summary.charCount,
    storeRating: summary.storeRating,
    readers: summary.readers,
  };
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
  /**
   * Series: volume 1's stars and readers and "Went on to vol 2"; authors: over their works
   * (series-figures.ts). Absent for tags, "No series" and groups without any figure.
   */
  figures?: SeriesFigure;
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
  /**
   * A collection's books only (2026-11-24, "Series, authors and tags in a collection"): a
   * smart collection's saved search and/or a manual collection's id. The cards then count,
   * total and show only those books.
   */
  scope?: string;
  collection?: string;
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
export function groupComparator(
  sort: GroupSort,
  figure: (r: GroupRow) => number | null = () => null,
): (a: GroupRow, b: GroupRow) => number {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const byFigure = GROUP_FIGURE_KEYS.includes(sort.key);
  return (a, b) => {
    if ((a.gid === null) !== (b.gid === null)) return a.gid === null ? 1 : -1;
    if (sort.key === 'name') return sign * compareNames(a, b);
    if (byFigure) {
      // Groups without the figure come last whichever the direction, by name.
      const fa = figure(a);
      const fb = figure(b);
      if ((fa === null) !== (fb === null)) return fa === null ? 1 : -1;
      if (fa !== null && fb !== null && fa !== fb) return sign * (fa - fb);
      return compareNames(a, b);
    }
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
  const parsed = parseOrThrow(opts.query);
  const scope = opts.scope ? parseOrThrow(opts.scope) : null;
  if (opts.collection || (scope && scope.terms.length > 0)) {
    return planScopedGroups(db, user, opts, parsed, scope);
  }
  const g = GROUPING[opts.by];
  const spec = opts.countSpec ?? null;

  // The groups with a matching book (only this part can contain a pattern).
  let sql = 'SELECT NULL AS gid WHERE 0';
  let params: unknown[] = [];
  const filtered = parsed.terms.length > 0;
  if (filtered) {
    const names = joinConds(groupNameSql(parsed, opts.by, 'gn.name'));
    const conds: SqlCondition[] = [
      ...visibilitySql(opts),
      ...querySql(
        parsed,
        user.id,
        undefined,
        user.deviceId ?? null,
        figureTerms(db, user.id, { seriesTab: opts.by === 'series', libraryId: opts.libraryId }),
      ),
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
      const all = aggregateGroups(db, opts).filter(
        (r) => (opts.by === 'series' || r.gid !== null) && (!filtered || hits.has(r.gid)),
      );
      return pageGroups(
        opts,
        all,
        (page) => describeGroups(db, user, opts, page, spec),
        figureLookup(db, user, opts),
      );
    },
  };
}

/** One page of groups in the asked sort (`rows` is in the default order). */
function pageGroups(
  opts: ListGroupsOptions,
  rows: GroupRow[],
  describe: (page: GroupRow[]) => GroupCard[],
  figureOf?: (r: GroupRow) => SeriesFigure | null,
): GroupPage {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const sort = opts.sort ?? DEFAULT_GROUP_SORT;
  // A figure sort orders by the figure's value (series-figures.ts), worked out once per row.
  const values = new Map<GroupRow, number | null>();
  const byFigure = GROUP_FIGURE_KEYS.includes(sort.key);
  if (byFigure) {
    for (const r of rows) {
      values.set(r, figureOf ? figureSortValue(figureOf(r), sort.key as FigureKey) : null);
    }
  }
  const valueOf = (r: GroupRow) => values.get(r) ?? null;
  const compare = groupComparator(sort, valueOf);
  const cursor = opts.cursor ? decodeGroupCursor(opts.cursor) : null;
  let all = rows;
  // The cached rows are in the default order; other sorts sort a copy.
  if (sort.key !== DEFAULT_GROUP_SORT.key || sort.dir !== DEFAULT_GROUP_SORT.dir) {
    all = [...all].sort(compare);
  }
  let start = 0;
  if (cursor) {
    const probe = { gid: 0, name: cursor.name, newest: cursor.newest, n: cursor.n } as GroupRow;
    values.set(probe, cursor.figure);
    start = all.findIndex((r) => compare(r, probe) > 0);
    if (start === -1) start = all.length;
  }
  const page = all.slice(start, start + limit);
  const last = page[page.length - 1];
  // A figure sort's cursor also carries the figure (-1: none; figures are never negative).
  const nextCursor =
    start + limit < all.length && last && last.name !== null
      ? byFigure
        ? encodeCursor([last.newest, last.n, last.name, valueOf(last) ?? -1])
        : encodeCursor([last.newest, last.n, last.name])
      : null;
  const groups = describe(page);
  if (figureOf) {
    page.forEach((r, i) => {
      const f = figureOf(r);
      if (f && (f.rating || f.readers !== null || f.kept !== null)) groups[i].figures = f;
    });
  }
  return { groups, nextCursor, total: all.length };
}

/** A book of a collection, in one of its groups (scoped lists). */
interface Member {
  id: string;
  seriesId: number | null;
  seriesIndex: number | null;
  addedAt: number;
}

interface ScopedData {
  /** The listed groups (those with a book matching the search), in the default order. */
  rows: GroupRow[];
  members: Map<number | null, Member[]>;
}

/** Scoped group lists per user, device and filters, until the catalog or a record changes. */
const scopedCache = new WeakMap<
  Database.Database,
  Map<string, { changes: string; data: ScopedData }>
>();
const SCOPED_CACHE_SIZE = 20;

/**
 * Groups of a collection's books (2026-11-24): every number, series list and collage
 * counts only the books inside the collection. One query lists the collection's books
 * (and whether each matches the typed search, and which group names match), so a pattern
 * in the collection's search or the typed one runs in the search worker; the links to
 * authors and tags are walked here, as aggregateGroups does.
 */
function planScopedGroups(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
  parsed: ReturnType<typeof parseOrThrow>,
  scope: ReturnType<typeof parseOrThrow> | null,
): PlannedQuery<GroupPage> {
  const spec = opts.countSpec ?? null;
  const g = GROUPING[opts.by];
  const describe = (data: ScopedData) => (page: GroupRow[]) =>
    describeScoped(db, user, opts, page, data.members, spec);
  const key = JSON.stringify([
    user.id,
    user.deviceId ?? null,
    opts.by,
    opts.libraryId ?? '',
    !!opts.includeMissing,
    spec,
    opts.scope ?? '',
    opts.collection ?? '',
    opts.query ?? '',
  ]);
  const changes = userVersion(db, user.id);
  let cache = scopedCache.get(db);
  if (!cache) {
    cache = new Map();
    scopedCache.set(db, cache);
  }
  const store = cache;
  const hit = store.get(key);
  if (hit && hit.changes === changes) {
    store.delete(key);
    store.set(key, hit);
    return {
      sql: 'SELECT NULL WHERE 0',
      params: [],
      regex: false,
      finish: () =>
        pageGroups(
          opts,
          hit.data.rows,
          describe(hit.data),
          scopedFigures(db, user, opts, hit.data),
        ),
    };
  }

  const filtered = parsed.terms.length > 0;
  // Whether each book matches the typed search (book terms only).
  let hitSql = '1';
  let hitParams: unknown[] = [];
  // In a grouped tab, terms on the grouping field also pick the groups by name.
  let names = { sql: '', params: [] as unknown[] };
  if (filtered) {
    const conds = querySql(
      parsed,
      user.id,
      undefined,
      user.deviceId ?? null,
      figureTerms(db, user.id, { seriesTab: opts.by === 'series', libraryId: opts.libraryId }),
    );
    if (conds.length > 0) {
      hitSql = `CASE WHEN ${conds.map((c) => `(${c.sql})`).join(' AND ')} THEN 1 ELSE 0 END`;
      hitParams = conds.flatMap((c) => c.params);
    }
    names = joinConds(groupNameSql(parsed, opts.by, 'gn.name'));
  }
  const inScope: SqlCondition[] = [...visibilitySql(opts)];
  if (opts.collection) inScope.push(collectionMemberSql(user.id, opts.collection));
  if (scope) {
    inScope.push(
      ...querySql(
        scope,
        user.id,
        db,
        user.deviceId ?? null,
        figureTerms(db, user.id, { seriesTab: false }),
      ),
    );
  }
  const where = joinConds(inScope);
  // One row per book of the collection (kind 0), then the groups whose name matches
  // (kind 1). The book-to-author/tag links are walked here in finish(): joining them in
  // SQL (320k rows for tags on a 66k-book collection) took 1.3 s on the live library.
  const nameRows = names.sql
    ? `UNION ALL SELECT 1, NULL, gn.id, NULL, NULL, NULL, NULL, NULL FROM ${g.table} gn ${names.sql}`
    : '';
  return {
    sql: `SELECT 0 AS kind, b.id AS id, b.series_id AS sid, b.series_index AS sidx,
                 b.added_at AS added, b.char_count AS chars, ${COUNT_STATE} AS cs, ${hitSql} AS hit
            ${SQL_BOOK_FROM}
            LEFT JOIN char_counts c ON c.book_id = b.id
            ${where.sql}
          ${nameRows}`,
    params: [spec, spec, ...hitParams, ...where.params, ...names.params],
    regex: usesRegex(parsed) || (scope !== null && usesRegex(scope)),
    finish(raw) {
      const data = scopedData(db, opts, raw as ScopedRaw[], filtered, !!names.sql);
      store.delete(key);
      store.set(key, { changes, data });
      if (store.size > SCOPED_CACHE_SIZE) store.delete(store.keys().next().value as string);
      return pageGroups(opts, data.rows, describe(data), scopedFigures(db, user, opts, data));
    },
  };
}

interface ScopedRaw {
  kind: 0 | 1;
  id: string | null;
  /** kind 1: the id of a group whose name matches the search. */
  sid: number | null;
  sidx: number | null;
  added: number;
  chars: number | null;
  cs: string;
  hit: number;
}

function scopedData(
  db: Database.Database,
  opts: ListGroupsOptions,
  raw: ScopedRaw[],
  filtered: boolean,
  byName: boolean,
): ScopedData {
  const books = new Map<string, ScopedRaw>();
  const namedHits = new Set<number | null>();
  for (const r of raw) {
    if (r.kind === 1) namedHits.add(r.sid);
    else books.set(r.id as string, r);
  }
  const byGroup = new Map<number | null, GroupRow>();
  const members = new Map<number | null, Member[]>();
  const hits = new Set<number | null>();
  const addTo = (gid: number | null, r: ScopedRaw) => {
    let row = byGroup.get(gid);
    let list = members.get(gid);
    if (!row || !list) {
      row = { gid, name: null, n: 0, newest: 0, total: 0, counted: 0, pending: 0, failed: 0 };
      list = [];
      byGroup.set(gid, row);
      members.set(gid, list);
    }
    row.n += 1;
    if (r.added > row.newest) row.newest = r.added;
    row.total = (row.total ?? 0) + (r.chars ?? 0);
    if (r.cs === 'c') row.counted += 1;
    else if (r.cs === 'p') row.pending += 1;
    else row.failed += 1;
    list.push({ id: r.id as string, seriesId: r.sid, seriesIndex: r.sidx, addedAt: r.added });
    // A group is listed when one of its books matches (and, with a name term, its name).
    if (r.hit && (!byName || gid === null || namedHits.has(gid))) hits.add(gid);
  };
  if (opts.by === 'series') {
    for (const r of books.values()) addTo(r.sid, r);
  } else {
    const link =
      opts.by === 'author'
        ? 'SELECT book_id, author_id FROM book_authors'
        : 'SELECT book_id, tag_id FROM book_tags';
    for (const [bookId, gid] of db.prepare(link).raw().iterate() as IterableIterator<
      [string, number]
    >) {
      const r = books.get(bookId);
      if (r) addTo(gid, r);
    }
  }
  const ids = [...byGroup.keys()].filter((gid): gid is number => gid !== null);
  const names = new Map<number, string>();
  const table = GROUPING[opts.by].table;
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const [id, name] of db
      .prepare(`SELECT id, name FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .raw()
      .all(...chunk) as [number, string][]) {
      names.set(id, name);
    }
  }
  const rows = [...byGroup.values()].filter(
    (r) => (opts.by === 'series' || r.gid !== null) && (!filtered || hits.has(r.gid)),
  );
  for (const row of rows) row.name = row.gid === null ? null : (names.get(row.gid) ?? null);
  rows.sort(compareGroups);
  return { rows, members };
}

function baseCard(by: GroupBy, r: GroupRow): GroupCard {
  return {
    by,
    name: r.name,
    bookCount: r.n,
    newestAddedAt: r.newest,
    chars: { total: r.total ?? 0, counted: r.counted, pending: r.pending, failed: r.failed },
  };
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Series order: IFNULL(series_index, missing), added_at, id (as the unscoped queries). */
function memberOrder(missing: number) {
  return (a: Member, b: Member) =>
    (a.seriesIndex ?? missing) - (b.seriesIndex ?? missing) ||
    a.addedAt - b.addedAt ||
    byText(a.id, b.id);
}

/** Cards of a scoped page: series volumes and collages from the collection's books only. */
function describeScoped(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
  rows: GroupRow[],
  members: Map<number | null, Member[]>,
  spec: string | null,
): GroupCard[] {
  const cards = rows.map((r) => baseCard(opts.by, r));
  const lists: string[][] = [];
  const wanted = new Set<string>();
  let opened: Map<string, number> | null = null;
  for (const r of rows) {
    const list = members.get(r.gid) ?? [];
    let ids: string[];
    if (opts.by === 'series' && r.gid !== null) {
      ids = [...list].sort(memberOrder(-1)).map((m) => m.id);
      if (ids.length) wanted.add(ids[0]);
    } else {
      opened ??= openedAt(db, user.id);
      ids = collageOf(list, opened);
      ids.forEach((id) => wanted.add(id));
    }
    lists.push(ids);
  }
  const summaries = summariesByIds(db, user, [...wanted], spec);
  rows.forEach((r, i) => {
    if (opts.by === 'series' && r.gid !== null) {
      cards[i].bookIds = lists[i];
      cards[i].cover = lists[i].length ? tileOf(summaries.get(lists[i][0])) : null;
    } else {
      cards[i].tiles = lists[i]
        .map((id) => tileOf(summaries.get(id)))
        .filter((t): t is GroupTile => t !== null);
    }
  });
  return cards;
}

/** When you last read each book (live position records). */
function openedAt(db: Database.Database, userId: string): Map<string, number> {
  return new Map(
    db
      .prepare(
        `SELECT book_id, MAX(updated_at) FROM sync_records
          WHERE user_id = ? AND kind = 'position' AND deleted_at IS NULL AND book_id IS NOT NULL
          GROUP BY book_id`,
      )
      .raw()
      .all(userId) as [string, number][],
  );
}

/** pickCollage's order over a scoped group's books: opened, first volumes, newest. */
function collageOf(list: Member[], opened: Map<string, number>): string[] {
  const picked: string[] = [];
  const seriesShown = new Set<number>();
  const add = (m: Member) => {
    if (picked.length >= TILE_COUNT || picked.includes(m.id)) return;
    picked.push(m.id);
    if (m.seriesId !== null) seriesShown.add(m.seriesId);
  };
  // 1. Books you have opened, most recent first.
  list
    .filter((m) => opened.has(m.id))
    .sort((a, b) => (opened.get(b.id) ?? 0) - (opened.get(a.id) ?? 0))
    .slice(0, TILE_COUNT)
    .forEach(add);
  if (picked.length >= TILE_COUNT) return picked;
  const newest = [...list]
    .sort((a, b) => b.addedAt - a.addedAt || byText(b.id, a.id))
    .slice(0, TILE_SCAN);
  // 2. One lowest-index volume per series (among the group's books), newest series first.
  const firstOrder = memberOrder(1e18);
  for (const m of newest) {
    if (picked.length >= TILE_COUNT) break;
    if (m.seriesId === null || seriesShown.has(m.seriesId)) continue;
    const first = list.filter((x) => x.seriesId === m.seriesId).sort(firstOrder)[0];
    seriesShown.add(m.seriesId);
    if (first) add(first);
  }
  // 3. The newest books.
  for (const m of newest) add(m);
  return picked;
}

/**
 * [newest, count, name] (a figure sort adds the figure, -1 for none); the pre-WP19
 * [newest, name] still works (newest-first order).
 */
function decodeGroupCursor(cursor: string): {
  newest: number;
  n: number;
  name: string;
  figure: number | null;
} {
  try {
    const [newest, n, name, figure] = decodeCursor(cursor, [
      'number',
      'number',
      'string',
      'number',
    ]);
    const f = figure as number;
    return {
      newest: newest as number,
      n: n as number,
      name: name as string,
      figure: f < 0 ? null : f,
    };
  } catch {
    // One of the shorter shapes below.
  }
  try {
    const [newest, n, name] = decodeCursor(cursor, ['number', 'number', 'string']);
    return { newest: newest as number, n: n as number, name: name as string, figure: null };
  } catch {
    const [newest, name] = decodeCursor(cursor, ['number', 'string']);
    return { newest: newest as number, n: 0, name: name as string, figure: null };
  }
}

/**
 * A group's figures (series-figures.ts): a series' (the library asked for, else the one whose
 * volume 1 has the most readers), an author's over their works. None for tags.
 */
function figureLookup(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
  books?: ReadonlySet<string>,
): ((r: GroupRow) => SeriesFigure | null) | undefined {
  if (opts.by === 'tag') return undefined;
  let index: ReturnType<typeof figureIndex> | null = null;
  const idx = () => (index ??= figureIndex(db, user.id));
  if (opts.by === 'series') return (r) => groupFigure(idx(), r.gid, opts.libraryId);
  let authors: Map<number, SeriesFigure> | null = null;
  return (r) => {
    if (r.gid === null) return null;
    authors ??= authorFigures(db, idx(), opts, books);
    return authors.get(r.gid) ?? null;
  };
}

/**
 * A collection's groups: a series' figures are the series' own (volume 1 may be outside the
 * collection); an author's works are only the collection's books.
 */
function scopedFigures(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
  data: ScopedData,
): ((r: GroupRow) => SeriesFigure | null) | undefined {
  if (opts.by !== 'author') return figureLookup(db, user, opts);
  const books = new Set<string>();
  for (const list of data.members.values()) for (const m of list) books.add(m.id);
  return figureLookup(db, user, opts, books);
}

function tileOf(summary: BookSummary | undefined): GroupTile | null {
  return summary ? tileOfSummary(summary) : null;
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
  const cards: GroupCard[] = rows.map((r) => baseCard(opts.by, r));

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
