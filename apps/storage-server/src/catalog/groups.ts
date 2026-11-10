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
  summariesByIds,
  visibilitySql,
} from './queries';
import { groupNameSql, querySql, type SqlCondition } from './search-sql';

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
}

export interface ListGroupsOptions {
  by: GroupBy;
  libraryId?: string;
  query?: string;
  limit?: number;
  cursor?: string;
  includeMissing?: boolean;
  countSpec?: string | null;
}

interface GroupRow {
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

export function planGroups(
  db: Database.Database,
  user: CatalogUser,
  opts: ListGroupsOptions,
): PlannedQuery<GroupPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const parsed = parseOrThrow(opts.query);
  const g = GROUPING[opts.by];
  const spec = opts.countSpec ?? null;
  const visible = visibilitySql(opts);

  // All groups with their whole-group numbers.
  const base = joinConds(visible);
  const agg = `SELECT ${g.gid} AS gid, COUNT(*) AS n, MAX(b.added_at) AS newest,
                      SUM(b.char_count) AS total, SUM(cs = 'c') AS counted,
                      SUM(cs = 'p') AS pending, SUM(cs = 'e') AS failed
                 FROM (SELECT b.*, ${COUNT_STATE} AS cs, s.missing_at
                         ${SQL_BOOK_FROM}
                         LEFT JOIN char_counts c ON c.book_id = b.id
                         ${base.sql}) b
                 ${g.join}
                GROUP BY ${g.gid}`;
  const params: unknown[] = [spec, spec, ...base.params];

  const outer: SqlCondition[] = [];
  // Only "No series" has no group row; authors and tags always have one.
  if (opts.by !== 'series') outer.push({ sql: 'agg.gid IS NOT NULL', params: [] });
  if (parsed.terms.length > 0) {
    const hits = joinConds([...visible, ...querySql(parsed, user.id)]);
    const hitIds = `SELECT ${g.gid} ${SQL_BOOK_FROM} ${g.join} ${hits.sql}`;
    outer.push(
      opts.by === 'series'
        ? {
            // "No series" is listed when a matching book has no series.
            sql: `(agg.gid IN (${hitIds}) OR (agg.gid IS NULL AND EXISTS (${hitIds}
                     ${hits.sql ? 'AND' : 'WHERE'} b.series_id IS NULL)))`,
            params: [...hits.params, ...hits.params],
          }
        : { sql: `agg.gid IN (${hitIds})`, params: hits.params },
    );
    outer.push(...groupNameSql(parsed, opts.by, 'gn.name'));
  }
  if (opts.cursor) {
    const [newest, name] = decodeCursor(opts.cursor, ['number', 'string']);
    // "No series" comes after every named group, so it is always past a cursor.
    outer.push({
      sql: '(agg.gid IS NULL OR agg.newest < ? OR (agg.newest = ? AND gn.name > ?))',
      params: [newest, newest, name],
    });
  }
  const where = joinConds(outer);
  const sql = `SELECT agg.*, gn.name AS name
                 FROM (${agg}) agg
                 LEFT JOIN ${g.table} gn ON gn.id = agg.gid
                 ${where.sql}
                ORDER BY agg.gid IS NULL, agg.newest DESC, gn.name
                LIMIT ?`;
  return {
    sql,
    params: [...params, ...where.params, limit + 1],
    regex: usesRegex(parsed),
    finish(raw) {
      const rows = raw as GroupRow[];
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > limit && last && last.name !== null
          ? encodeCursor([last.newest, last.name])
          : null;
      return { groups: describeGroups(db, user, opts, page, spec), nextCursor };
    },
  };
}

function tileOf(summary: BookSummary | undefined): GroupTile | null {
  return summary ? { bookId: summary.id, thumbnail: summary.thumbnail, tags: summary.tags } : null;
}

const TILE_COUNT = 4;
/** Newest books looked at for the "one volume per series" step of a collage. */
const TILE_SCAN = 200;

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

/** Up to four book ids in the decided collage order. */
function collageIds(
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
         CROSS JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre'
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
         CROSS JOIN book_sources s ON s.book_id = b.id AND s.kind = 'calibre'
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
