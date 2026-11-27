/**
 * The storage server's event-loop stalls (2026-11-26): on copies of the live databases, each
 * step a live profile found on the main thread, the old way (one query, timed) against the new
 * way (in slices: the longest the event loop waited, and the same result).
 *   npx ts-node --transpile-only scripts/health-stalls-timing.ts <folder with ttsu.db, cleanup.db
 *     and cache/calibre/<library>.db>
 * Never point it at the live databases: it migrates the copies in place.
 */
import path from 'path';
import { isDeepStrictEqual } from 'util';
import { monitorEventLoopDelay } from 'perf_hooks';
import { openDatabase } from '../src/db/database';
import { openCleanupDatabase, primaryLibraryOf } from '../src/cleanup/cleanup-db';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { getSettings } from '../src/cleanup/settings';
import {
  StoreRatings,
  FETCHED_SITES,
  refreshAfterMs,
  type FetchedSite,
} from '../src/ratings/service';
import { SITE_ID_RE } from '../src/ratings/store';
import { libraryIndex, libraryIndexAsync, titleKey } from '../src/bookmeter/match';
import { presentBookCount } from '../src/cleanup/handoff';
import { readSnapshotBooks, readSnapshotBooksAsync } from '../src/cleanup/stage1';
import { noteCatalogWrite } from '../src/catalog/catalog-version';
import { NA } from '../src/cleanup/title-rules';

const dir = process.argv[2];
const main = openDatabase(path.join(dir, 'ttsu.db'));
const cleanup = openCleanupDatabase(path.join(dir, 'cleanup.db'), {
  primaryLibrary: (c) => primaryLibraryOf(c, main),
});
const queue = new FetchQueue(
  cleanup,
  path.join(dir, 'cache', 'cleanup'),
  () => getSettings(cleanup).fetch,
);
const DAY = 86_400_000;

const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};
/** Runs an async step with the event loop watched: total time and the longest block. */
async function watched<T>(f: () => Promise<T>): Promise<[T, number, number]> {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t = performance.now();
  const r = await f();
  const total = performance.now() - t;
  h.disable();
  return [r, total, h.max / 1e6];
}
const ms = (n: number) => `${n.toFixed(0)} ms`;
let failed = 0;
const same = (label: string, a: unknown, b: unknown) => {
  const ok = isDeepStrictEqual(a, b);
  if (!ok) failed++;
  console.log(`  ${label}: ${ok ? 'same' : 'DIFFERENT'}`);
};

(async () => {
  const ratings = new StoreRatings({ db: main, cacheDir: null, queue: () => queue });
  const s = ratings.settings();
  const now = Date.now();

  // ---- store ratings' due list: the old query (whole library) against the listed one
  console.log('Store ratings, what is due:');
  const [, listMs, listMax] = await watched(() => ratings.refreshDue());
  console.log(`  listing all sites in slices: ${ms(listMs)}, longest block ${ms(listMax)}`);
  for (const site of FETCHED_SITES) {
    const [old, oldMs] = timed(() => oldDueIds(site, Number.MAX_SAFE_INTEGER));
    const [now20, newMs] = timed(() => ratings.dueIds(site, s.queuedPerSite));
    const [all] = timed(() => ratings.dueIds(site, Number.MAX_SAFE_INTEGER));
    console.log(
      `  ${site}: old query ${ms(oldMs)}, new dueIds(${s.queuedPerSite}) ${ms(newMs)}; due ${old.length}`,
    );
    same(`${site} due ids, in order`, all, old);
    same(`${site} first ${s.queuedPerSite}`, now20, old.slice(0, s.queuedPerSite));
  }
  const [, progMs] = timed(() => ratings.progress());
  console.log(`  progress(): ${ms(progMs)}`);

  // ---- 読書メーター's library index
  console.log("読書メーター's library index:");
  noteCatalogWrite(main);
  const [oldIdx, oldIdxMs] = timed(() => oldLibraryIndex());
  noteCatalogWrite(main);
  const [idx, idxMs, idxMax] = await watched(() => libraryIndexAsync(main));
  console.log(
    `  old build ${ms(oldIdxMs)}; new build in slices ${ms(idxMs)}, longest block ${ms(idxMax)}`,
  );
  same('books (in order)', [...idx.books.entries()], [...oldIdx.books.entries()]);
  same('by saved id', [...idx.bySavedId.entries()], [...oldIdx.bySavedId.entries()]);
  same('by author', [...idx.byAuthor.entries()], [...oldIdx.byAuthor.entries()]);
  same('by title', [...idx.byTitle.entries()], [...oldIdx.byTitle.entries()]);
  noteCatalogWrite(main);
  const [, syncMs] = timed(() => libraryIndex(main));
  console.log(`  a synchronous rebuild after a catalog write (titles' keys kept): ${ms(syncMs)}`);

  // ---- presentBookCount (migration 36's index)
  console.log('Present books:');
  for (const l of main.prepare('SELECT id FROM libraries').all() as { id: string }[]) {
    noteCatalogWrite(main);
    const [n, t] = timed(() => presentBookCount(main, l.id));
    console.log(`  ${l.id}: ${n} in ${ms(t)}`);
  }

  // ---- stage 1's snapshot read
  console.log('The Calibre snapshot:');
  for (const l of main.prepare('SELECT id FROM libraries').all() as { id: string }[]) {
    const file = path.join(dir, 'cache', 'calibre', `${l.id}.db`);
    try {
      const [a, t] = timed(() => readSnapshotBooks(file));
      const [b, t2, max] = await watched(() => readSnapshotBooksAsync(file));
      console.log(
        `  ${l.id}: ${a.size} books, read whole ${ms(t)}; in slices ${ms(t2)}, longest block ${ms(max)}`,
      );
      same('books, formats and tags (in order)', [...b.entries()], [...a.entries()]);
    } catch (e) {
      console.log(`  ${l.id}: ${(e as Error).message}`);
    }
  }

  // ---- the first fill's and the search fill's id lists (sliced inside the fill)
  console.log('First fill and search fill (the ids, then the saved searches):');
  const [, fillMs, fillMax] = await watched(() => ratings.firstFill());
  console.log(`  first fill: ${ms(fillMs)}, longest block ${ms(fillMax)}`);
  const [, fill2Ms, fill2Max] = await watched(() => ratings.firstFill(true));
  console.log(
    `  the next fill (searches read already): ${ms(fill2Ms)}, longest block ${ms(fill2Max)}`,
  );

  console.log(failed ? `\n${failed} DIFFERENCES` : '\nevery result the same');
  main.close();
  cleanup.close();

  // ---------------------------------------------------------------- the old code, as it was
  function oldDueIds(site: FetchedSite, limit: number): string[] {
    const rows = main
      .prepare(
        `SELECT bi.value AS id, MIN(b.published_at) AS pub, r.checked_at AS checked, r.state AS state,
                r.fails AS fails, MIN(b.created_at) AS created
         FROM book_identifiers bi
         JOIN books b ON b.id = bi.book_id
         JOIN book_sources src ON src.book_id = bi.book_id AND src.missing_at IS NULL
         LEFT JOIN store_ratings r ON r.site = bi.type AND r.site_id = bi.value
         LEFT JOIN store_rating_requests q ON q.site = bi.type AND q.site_id = bi.value
         WHERE bi.type = ? AND q.site IS NULL
           AND (r.checked_at IS NULL OR r.checked_at < ?)
         GROUP BY bi.value
         ORDER BY r.checked_at IS NOT NULL, r.checked_at`,
      )
      .all(site, now - s.newDays * DAY) as {
      id: string;
      pub: number | null;
      checked: number | null;
      state: string | null;
      fails: number | null;
      created: number;
    }[];
    const out: string[] = [];
    for (const r of rows) {
      const id = r.id.trim();
      if (!SITE_ID_RE[site].test(id)) continue;
      if (r.checked === null) {
        if (now - r.created < s.newBookWaitHours * 3_600_000) continue;
        if (
          site !== 'bookmeter' &&
          queue.isOpen(
            site === 'amazon_jp' ? 'amazon-dp' : 'bookwalker',
            site === 'amazon_jp' ? id : `https://bookwalker.jp/de${id}/`,
          )
        )
          continue;
      }
      if (r.checked !== null) {
        const wait =
          r.state === 'error' && (r.fails ?? 0) < 3 ? DAY : refreshAfterMs(s, r.pub, now);
        if (now - r.checked < wait) continue;
      }
      out.push(id);
      if (out.length >= limit) break;
    }
    return out;
  }

  function oldLibraryIndex() {
    type B = {
      id: string;
      libraryId: string;
      title: string;
      series: string | null;
      authors: string[];
      createdAt: number;
      savedId: string | null;
      key: string;
    };
    const books = new Map<string, B>();
    for (const r of main
      .prepare(
        `SELECT b.id, b.library_id AS libraryId, b.title, s.name AS series, b.created_at AS createdAt,
                bi.value AS savedId
         FROM books b
         LEFT JOIN series s ON s.id = b.series_id
         LEFT JOIN book_identifiers bi ON bi.book_id = b.id AND bi.type = 'bookmeter'
         WHERE EXISTS (SELECT 1 FROM book_sources src WHERE src.book_id = b.id AND src.missing_at IS NULL)`,
      )
      .all() as Omit<B, 'authors' | 'key'>[]) {
      books.set(r.id, {
        ...r,
        savedId: r.savedId?.trim() || null,
        authors: [],
        key: titleKey(r.title),
      });
    }
    for (const r of main
      .prepare(
        `SELECT ba.book_id, a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
         ORDER BY ba.book_id, ba.position`,
      )
      .all() as { book_id: string; name: string }[]) {
      books.get(r.book_id)?.authors.push(r.name);
    }
    const push = (m: Map<string, B[]>, k: string, v: B) => {
      if (!k) return;
      const a = m.get(k);
      if (a) a.push(v);
      else m.set(k, [v]);
    };
    const bySavedId = new Map<string, B[]>();
    const byAuthor = new Map<string, B[]>();
    const byTitle = new Map<string, B[]>();
    for (const b of books.values()) {
      if (b.savedId) push(bySavedId, b.savedId, b);
      for (const a of b.authors) push(byAuthor, NA(a), b);
      push(byTitle, b.key, b);
    }
    return { books, bySavedId, byAuthor, byTitle };
  }
})();
