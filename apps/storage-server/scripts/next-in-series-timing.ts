/**
 * Next in your series (2026-11-25): how long the rule takes on a copy of the live ttsu.db,
 * its query plan, and what it finds (counts and a sample).
 *   npx ts-node --transpile-only scripts/next-in-series-timing.ts <copy of ttsu.db>
 * Opens the copy read-only; never point it at the live database.
 */
import Database from 'better-sqlite3';
import { nextInSeriesIds, nextInSeriesSelect } from '../src/catalog/next-in-series';
import { querySql } from '../src/catalog/search-sql';
import { parseQuery } from '../src/catalog/query-parser';
import { registerRegexp } from '../src/catalog/regexp';

const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
registerRegexp(db);
// The account with the most reading records (the owner may not be the one reading).
const user = db
  .prepare(
    `SELECT user_id AS id FROM sync_records WHERE kind = 'book-status'
      GROUP BY user_id ORDER BY COUNT(*) DESC LIMIT 1`,
  )
  .get() as { id: string };
const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
console.log(
  `books ${count('SELECT COUNT(*) n FROM books')}; status records ${count(
    "SELECT COUNT(*) n FROM sync_records WHERE user_id = ? AND kind = 'book-status'",
    user.id,
  )}; finished read-throughs ${count(
    "SELECT COUNT(*) n FROM sync_records WHERE user_id = ? AND kind = 'read-through' AND json_extract(data, '$.finished') = 1",
    user.id,
  )}`,
);

const { sql, params } = nextInSeriesSelect(user.id);
console.log('\nQUERY PLAN');
for (const row of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]) {
  console.log(`  ${row.detail}`);
}

const times: number[] = [];
let ids: string[] = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  ids = nextInSeriesIds(db, user.id);
  times.push(performance.now() - t0);
}
console.log(
  `\nnextInSeriesIds: ${ids.length} books; ms ${times.map((t) => t.toFixed(1)).join(', ')}`,
);

// The search term as the list uses it (the copy may predate later list columns).
const parsed = parseQuery('status:next');
if (!parsed.ok) throw new Error(parsed.error.message);
const [cond] = querySql(parsed.query, user.id, db, null);
const t1 = performance.now();
const n = count(`SELECT COUNT(*) n FROM books b WHERE ${cond.sql}`, ...cond.params);
console.log(`search status:next: ${n} books in ${(performance.now() - t1).toFixed(1)} ms`);

const sample = db
  .prepare(
    `SELECT b.title, se.name AS series, b.series_index AS idx, b.library_id AS lib FROM books b
       LEFT JOIN series se ON se.id = b.series_id WHERE b.id IN (SELECT value FROM json_each(?))`,
  )
  .all(JSON.stringify(ids.slice(0, 15))) as {
  title: string;
  series: string;
  idx: number;
  lib: string;
}[];
console.log('\nfirst 15 (row order not kept here):');
for (const r of sample) console.log(`  [${r.lib}] ${r.series} #${r.idx}: ${r.title}`);

// --stress N: N made-up completions (volume 1 of N series, plus a reread read-through each)
// inside a transaction that is rolled back, to time the rule at a heavy reader's size.
const stress = process.argv.indexOf('--stress');
if (stress > 0) {
  const n = Number(process.argv[stress + 1] ?? 3000);
  const rw = new Database(process.argv[2], { fileMustExist: true });
  const firsts = rw
    .prepare(
      `SELECT b.id FROM books b WHERE b.series_index = 1 AND b.series_id IS NOT NULL
        ORDER BY b.id LIMIT ?`,
    )
    .all(n) as { id: string }[];
  rw.exec('BEGIN');
  try {
    let rev = (rw.prepare('SELECT MAX(rev) r FROM sync_records').get() as { r: number }).r + 1;
    const ins = rw.prepare(
      `INSERT OR REPLACE INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
       VALUES (?, ?, ?, ?, 'stress', ?, NULL, ?, ?, 0)`,
    );
    for (const { id } of firsts) {
      ins.run(
        user.id,
        'book-status',
        id,
        id,
        Date.now(),
        rev++,
        '{"status":"completed","auto":false}',
      );
      ins.run(
        user.id,
        'read-through',
        `${id}:1`,
        id,
        Date.now(),
        rev++,
        JSON.stringify({ number: 1, finished: true, finishedOn: '2026-11-01' }),
      );
    }
    const ts: number[] = [];
    let found = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      found = nextInSeriesIds(rw, user.id).length;
      ts.push(performance.now() - t0);
    }
    const [c] = querySql(parsed.query, user.id, rw, null);
    const t2 = performance.now();
    const listed = (
      rw.prepare(`SELECT COUNT(*) n FROM books b WHERE ${c.sql}`).get(...c.params) as { n: number }
    ).n;
    console.log(
      `\nstress: ${firsts.length} series with volume 1 finished -> ${found} next; rule ms ${ts
        .map((t) => t.toFixed(0))
        .join(', ')}; search ${listed} in ${(performance.now() - t2).toFixed(0)} ms`,
    );
  } finally {
    rw.exec('ROLLBACK');
    rw.close();
  }
}
