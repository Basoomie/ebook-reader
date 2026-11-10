/**
 * Collection cards for the Collections page (WP8b): for each built-in collection and
 * each of the user's collections, how many books it has and up to four collage tiles.
 *
 * Collections span all enabled libraries (decisions.md: personal views span libraries).
 * - Built-ins (Reading, Completed, Dropped, Unread, Favorites) are fixed searches.
 * - A saved search ("smart") is its stored query, evaluated now.
 * - A manual collection's books are its live "collection-item" records.
 *
 * Collage order is the decided one, as for author and tag cards (groups.ts): books you
 * have opened (most recent first), then one lowest-index volume per series among the
 * collection's 60 newest books, then the newest books. Here it is computed from the
 * member list, since a collection is not a catalog table.
 *
 * Each card is computed on its own: a saved search that no longer parses or a pattern
 * that times out gives that card an `error`, and the others still load.
 */
import type Database from 'better-sqlite3';
import { catalogVersion } from '../catalog/catalog-version';
import type { GroupTile } from '../catalog/groups';
import {
  type CatalogUser,
  SQL_BOOK_FROM,
  SQL_CATALOG_SOURCE,
  summariesByIds,
  visibilitySql,
} from '../catalog/queries';
import { InvalidQueryError, parseOrThrow, usesRegex } from '../catalog/query-parser';
import { RegexTimeoutError } from '../catalog/search-runner';
import { querySql } from '../catalog/search-sql';
import { isPlainObject } from '../sync/kinds';

/** Built-in collections: id -> search. The web app has the same list (builtins.ts). */
export const BUILTIN_COLLECTIONS: { id: string; query: string }[] = [
  { id: 'reading', query: 'status:reading' },
  { id: 'completed', query: 'status:completed' },
  { id: 'dropped', query: 'status:dropped' },
  { id: 'unread', query: 'status:unread' },
  { id: 'favorites', query: 'favorite:yes' },
];

export interface CollectionCard {
  /** A built-in id ("reading", ...) or the collection record's id. */
  id: string;
  builtin: boolean;
  /** Built-ins and saved searches: the search that was run. */
  query?: string;
  bookCount: number;
  tiles: GroupTile[];
  error?: { code: string; message: string };
}

/** Runs one SELECT, on the main connection or (patterns) in the search worker. */
export type RunQuery = (sql: string, params: unknown[], regex: boolean) => Promise<unknown[]>;

interface Member {
  id: string;
  series_id: number | null;
  series_index: number | null;
  added_at: number;
}

const TILE_COUNT = 4;
const TILE_SCAN = 60;
const MEMBER_COLUMNS = 'b.id, b.series_id, b.series_index, b.added_at';

const cardCache = new WeakMap<
  Database.Database,
  Map<string, { changes: string; cards: CollectionCard[] }>
>();

/** Cards change with the catalog and with the user's records (collections, state, opened books). */
function userVersion(db: Database.Database, userId: string): string {
  const { rev } = db
    .prepare('SELECT MAX(rev) AS rev FROM sync_records WHERE user_id = ?')
    .get(userId) as { rev: number | null };
  return `${catalogVersion(db)}:${rev ?? 0}`;
}

export function clearCardCache(db: Database.Database): void {
  cardCache.delete(db);
}

function searchMembers(
  db: Database.Database,
  user: CatalogUser,
  query: string,
  run: RunQuery,
): Promise<unknown[]> {
  const parsed = parseOrThrow(query);
  const conds = [...visibilitySql({}), ...querySql(parsed, user.id, db)];
  const where = conds.length ? `WHERE ${conds.map((c) => c.sql).join(' AND ')}` : '';
  return run(
    `SELECT ${MEMBER_COLUMNS} ${SQL_BOOK_FROM} ${where} ORDER BY b.added_at DESC, b.id DESC`,
    conds.flatMap((c) => c.params),
    usesRegex(parsed),
  );
}

/** The visible books of a manual collection, newest first. */
export function manualMembers(
  db: Database.Database,
  userId: string,
  collectionId: string,
): Member[] {
  return db
    .prepare(
      `SELECT ${MEMBER_COLUMNS} FROM sync_records ci
         CROSS JOIN books b ON b.id = ci.book_id
         CROSS JOIN book_sources s ON s.book_id = b.id AND ${SQL_CATALOG_SOURCE}
         JOIN libraries l ON l.id = b.library_id AND l.enabled = 1
        WHERE ci.user_id = ? AND ci.kind = 'collection-item' AND ci.id >= ? AND ci.id < ?
          AND ci.deleted_at IS NULL AND s.missing_at IS NULL
        ORDER BY b.added_at DESC, b.id DESC`,
    )
    .all(userId, `${collectionId}:`, `${collectionId};`) as Member[];
}

/** Book ids you have opened (any device), most recent first. */
function openedBooks(db: Database.Database, userId: string): string[] {
  return (
    db
      .prepare(
        `SELECT book_id FROM sync_records
          WHERE user_id = ? AND kind = 'position' AND deleted_at IS NULL AND book_id IS NOT NULL
          GROUP BY book_id ORDER BY MAX(updated_at) DESC`,
      )
      .raw()
      .all(userId) as [string][]
  ).map((r) => r[0]);
}

/** Up to four ids in collage order. `members` must be newest first. */
export function collageFromMembers(members: Member[], opened: string[]): string[] {
  const inSet = new Map(members.map((m) => [m.id, m]));
  const picked: string[] = [];
  const seriesShown = new Set<number>();
  const add = (m: Member) => {
    if (picked.length >= TILE_COUNT || picked.includes(m.id)) return;
    picked.push(m.id);
    if (m.series_id !== null) seriesShown.add(m.series_id);
  };
  // 1. Opened books.
  for (const id of opened) {
    if (picked.length >= TILE_COUNT) return picked;
    const m = inSet.get(id);
    if (m) add(m);
  }
  if (picked.length >= TILE_COUNT) return picked;
  // 2. One lowest-index volume per series, newest series first.
  const firstOf = new Map<number, Member>();
  for (const m of members) {
    if (m.series_id === null) continue;
    const best = firstOf.get(m.series_id);
    if (!best || volumeBefore(m, best)) firstOf.set(m.series_id, m);
  }
  const newest = members.slice(0, TILE_SCAN);
  for (const m of newest) {
    if (picked.length >= TILE_COUNT) break;
    if (m.series_id === null || seriesShown.has(m.series_id)) continue;
    seriesShown.add(m.series_id);
    const first = firstOf.get(m.series_id);
    if (first) add(first);
  }
  // 3. The newest books.
  for (const m of newest) add(m);
  return picked;
}

/** Series order of groups.ts: IFNULL(series_index, 1e18), added_at, id. */
function volumeBefore(a: Member, b: Member): boolean {
  const ai = a.series_index ?? 1e18;
  const bi = b.series_index ?? 1e18;
  if (ai !== bi) return ai < bi;
  if (a.added_at !== b.added_at) return a.added_at < b.added_at;
  return a.id < b.id;
}

function cardError(err: unknown): { code: string; message: string } {
  if (err instanceof InvalidQueryError) return { code: 'invalid_query', message: err.message };
  if (err instanceof RegexTimeoutError) {
    return { code: 'regex_timeout', message: 'That pattern took too long.' };
  }
  return { code: 'failed', message: (err as Error)?.message ?? String(err) };
}

/** Every card, cached until the catalog or one of the user's records changes. */
export async function collectionCards(
  db: Database.Database,
  user: CatalogUser,
  run: RunQuery,
  countSpec: string | null = null,
  logError?: (message: string, err?: unknown) => void,
): Promise<CollectionCard[]> {
  const changes = userVersion(db, user.id);
  let cache = cardCache.get(db);
  if (!cache) {
    cache = new Map();
    cardCache.set(db, cache);
  }
  const hit = cache.get(user.id);
  if (hit && hit.changes === changes) return hit.cards;

  const collections = (
    db
      .prepare(
        `SELECT id, data FROM sync_records
          WHERE user_id = ? AND kind = 'collection' AND deleted_at IS NULL ORDER BY id`,
      )
      .all(user.id) as { id: string; data: string }[]
  ).map((r) => ({ id: r.id, data: JSON.parse(r.data) as unknown }));

  const opened = openedBooks(db, user.id);
  const results: { card: CollectionCard; tileIds: string[] }[] = [];
  const add = async (card: CollectionCard, members: () => Promise<Member[]> | Member[]) => {
    try {
      const list = await members();
      card.bookCount = list.length;
      results.push({ card, tileIds: collageFromMembers(list, opened) });
    } catch (err) {
      const error = cardError(err);
      if (error.code === 'failed') logError?.(`collection card ${card.id} failed`, err);
      results.push({ card: { ...card, error }, tileIds: [] });
    }
  };

  for (const b of BUILTIN_COLLECTIONS) {
    await add(
      { id: b.id, builtin: true, query: b.query, bookCount: 0, tiles: [] },
      async () => (await searchMembers(db, user, b.query, run)) as Member[],
    );
  }
  for (const c of collections) {
    const data = isPlainObject(c.data) ? c.data : {};
    if (data.type === 'smart') {
      const query = typeof data.query === 'string' ? data.query : '';
      await add(
        { id: c.id, builtin: false, query, bookCount: 0, tiles: [] },
        async () => (await searchMembers(db, user, query, run)) as Member[],
      );
    } else {
      await add({ id: c.id, builtin: false, bookCount: 0, tiles: [] }, () =>
        manualMembers(db, user.id, c.id),
      );
    }
  }

  const summaries = summariesByIds(
    db,
    user,
    [...new Set(results.flatMap((r) => r.tileIds))],
    countSpec,
  );
  const cards = results.map(({ card, tileIds }) => ({
    ...card,
    tiles: tileIds
      .map((id) => summaries.get(id))
      .filter((s) => s !== undefined)
      .map((s) => ({ bookId: s.id, thumbnail: s.thumbnail, tags: s.tags })),
  }));
  // Only cache a complete answer (a timed-out pattern may work next time).
  if (!cards.some((c) => c.error && c.error.code !== 'invalid_query')) {
    if (cache.size > 100) cache.clear();
    cache.set(user.id, { changes, cards });
  }
  return cards;
}
