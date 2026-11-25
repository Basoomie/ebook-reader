/**
 * Store ratings (2026-11-25): the deploy's first fill rehearsed on a WORKING COPY of a live
 * ttsu.db (it migrates and writes to it; never point it at the live database) against the real
 * cleanup cache (read only). Reports migration 33's time, the fill's counts per site and state
 * and its time, the score's middle, the timings of the sorts, the searches, the refresher's due
 * query and the progress route at the live size, a re-index of every book's identifiers (the
 * triggers' cost), the Rating sort's top 20, and an independent check of 30 random Amazon pages
 * (the visible rating block read a second way).
 *
 *   npx ts-node -T scripts/store-ratings-rehearse.ts <working copy of ttsu.db> <CACHE_DIR> [--out report.json]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { brotliDecompressSync } from 'zlib';
import { planBooks, planCount } from '../src/catalog/queries';
import { registerRegexp } from '../src/catalog/regexp';
import { listUsers } from '../src/db/users';
import { migrate } from '../src/db/migrations';
import { saveRatingSettings } from '../src/ratings/settings';
import { StoreRatings, stage4CacheFile } from '../src/ratings/service';
import { readScoreParams } from '../src/ratings/store';

const [file, cacheDir] = process.argv.slice(2);
const outAt = process.argv.indexOf('--out');
const out = outAt > 0 ? process.argv[outAt + 1] : null;
const report: Record<string, unknown> = {};
const ms = (t: number) => Math.round(performance.now() - t);

async function main() {
  const db = new Database(file, { fileMustExist: true });
  registerRegexp(db);
  let t = performance.now();
  migrate(db);
  report.migrate = { version: db.pragma('user_version', { simple: true }), ms: ms(t) };
  console.log('migrate', report.migrate);

  const ids = db
    .prepare(
      `SELECT type, COUNT(DISTINCT value) n FROM book_identifiers
       WHERE type IN ('amazon_jp', 'bookwalker', 'bookmeter', 'natively') GROUP BY type`,
    )
    .all();
  report.ids = ids;

  const s = new StoreRatings({ db, cacheDir, queue: () => null, log: (l) => console.log(l) });
  const ticker = setInterval(() => {
    const f = s.progress().fill;
    console.log(`  fill ${f.done}/${f.total} found ${f.found}, ${f.secondsLeft}s left`);
  }, 30_000);
  t = performance.now();
  await s.firstFill();
  clearInterval(ticker);
  report.fill = { ...s.progress().fill, ms: ms(t) };
  report.states = db
    .prepare(
      'SELECT site, state, COUNT(*) n FROM store_ratings GROUP BY site, state ORDER BY site, state',
    )
    .all();
  report.books = db
    .prepare(
      `SELECT COUNT(*) total, COUNT(rating_x10) rated, SUM(rating_count >= 20) rated20,
              COUNT(readers) withReaders FROM books`,
    )
    .get();
  report.score = readScoreParams(db);
  console.log('fill', report.fill, report.states, report.books, report.score);

  // Timings at the live size.
  const user = listUsers(db)[0];
  const timing: Record<string, number> = {};
  for (const key of ['rating', 'ratings', 'readers'] as const) {
    for (const dir of ['desc', 'asc'] as const) {
      t = performance.now();
      const plan = planBooks(db, user, { sort: { key, dir }, limit: 60 });
      plan.finish(db.prepare(plan.sql).all(...plan.params));
      timing[`sort ${key} ${dir}`] = ms(t);
    }
  }
  for (const q of [
    'rating:>=4.5',
    'ratings:>=100',
    '-rating:<3',
    'rating:>=4 ratings:>=50 status:unread',
    'myrating:>=4',
  ]) {
    t = performance.now();
    const plan = planBooks(db, user, { query: q, limit: 60 });
    plan.finish(db.prepare(plan.sql).all(...plan.params));
    const count = planCount(db, user, { query: q });
    const n = count.finish(db.prepare(count.sql).all(...count.params)).count;
    timing[`search ${q} (${n})`] = ms(t);
  }
  saveRatingSettings(db, { refresh: true });
  for (const site of ['amazon_jp', 'bookwalker'] as const) {
    t = performance.now();
    const due = s.dueIds(site, 1_000_000).length;
    timing[`due ${site} (${due})`] = ms(t);
  }
  t = performance.now();
  s.progress();
  timing['progress route'] = ms(t);
  saveRatingSettings(db, { refresh: false });
  // The ingest rewrites a book's identifiers on every change (delete all, insert again): every
  // book at once, as after a library-wide Calibre change.
  t = performance.now();
  db.transaction(() => {
    const rows = db.prepare('SELECT book_id, type, value FROM book_identifiers').all() as {
      book_id: string;
      type: string;
      value: string;
    }[];
    db.prepare('DELETE FROM book_identifiers').run();
    const ins = db.prepare('INSERT INTO book_identifiers (book_id, type, value) VALUES (?, ?, ?)');
    for (const r of rows) ins.run(r.book_id, r.type, r.value);
  })();
  timing['re-index every identifier'] = ms(t);
  report.timing = timing;
  console.log('timing', timing);

  report.top = db
    .prepare(
      `SELECT title, rating_x10 / 10.0 avg, rating_count n, rating_score score FROM books
       ORDER BY IFNULL(rating_score, -1) DESC, id DESC LIMIT 20`,
    )
    .all();
  console.log('top', report.top);

  // 30 random Amazon pages read a second way: the visible rating block's text.
  const sample = db
    .prepare(
      `SELECT site_id, avg, count, state FROM store_ratings WHERE site = 'amazon_jp'
       ORDER BY random() LIMIT 30`,
    )
    .all() as { site_id: string; avg: number | null; count: number | null; state: string }[];
  const checks: unknown[] = [];
  let agree = 0;
  for (const r of sample) {
    const html = brotliDecompressSync(
      fs.readFileSync(path.join(cacheDir, 'cleanup', stage4CacheFile('amazon_jp', r.site_id))),
    ).toString('utf8');
    // The visible text, not the attributes the parser reads: "<span …a-color-base> 4.7 </span>"
    // and "(217)" inside the review-count link.
    const at = html.indexOf('id="averageCustomerReviews"');
    const block = at >= 0 ? html.slice(at, at + 4000) : '';
    const avg = /a-size-small a-color-base">\s*([0-9.]+)\s*</.exec(block);
    const n = /id="acrCustomerReviewText"[^>]*>\s*\(([\d,]+)\)\s*</.exec(block);
    const seen = {
      avg: avg ? Number(avg[1]) : null,
      count: n ? Number(n[1].replace(/,/g, '')) : null,
    };
    const ok =
      r.state === 'ok'
        ? seen.avg === r.avg && seen.count === r.count
        : seen.avg === null && seen.count === null;
    if (ok) agree += 1;
    checks.push({
      asin: r.site_id,
      saved: { avg: r.avg, count: r.count, state: r.state },
      seen,
      ok,
    });
  }
  report.amazonCheck = { agree, of: sample.length, checks };
  console.log(`amazon second reading: ${agree}/${sample.length} agree`);
  for (const c of checks as { ok: boolean }[]) if (!c.ok) console.log('  differs', c);

  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
