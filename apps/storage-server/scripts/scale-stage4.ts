/**
 * WP20d scale check (lessons 3): on a COPY of the live cleanup.db, migrate to v9 (timed), fill it to
 * the library's size with synthetic stage-4 rows, and show EXPLAIN QUERY PLAN and the time of every
 * query the page polls or a hot path runs (claim, report, the analysis's steps, the status).
 *
 *   node -r ts-node/register/transpile-only scripts/scale-stage4.ts <copy of cleanup.db>
 *
 * Writes only into the copy given.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { migrateCleanup, cleanupSchemaVersion } from '../src/cleanup/cleanup-db';
import { getSettings } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';

const file = process.argv[2];
if (!file) {
  console.error('usage: scale-stage4.ts <copy of cleanup.db>');
  process.exit(2);
}
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log(
  `quick_check: ${String(db.pragma('quick_check', { simple: true }))}; schema ${cleanupSchemaVersion(db)}`,
);
let t = Date.now();
migrateCleanup(db);
console.log(`migration to v${cleanupSchemaVersion(db)}: ${Date.now() - t} ms`);

const SITES = [
  'amazon-dp',
  'amazon-search',
  'amazon-img',
  'ranobedb',
  'bookwalker',
  'bookmeter',
  'natively',
  'ndl',
];
const BOOKS = 52_000;
const REQUESTS = 500_000;
const now = Date.now();
t = Date.now();
db.transaction(() => {
  const r = db.prepare(
    `INSERT INTO fetch_requests (site, key, url, priority, state, attempts, next_at, created_at, updated_at, finished_at, outcome, status, cache_file)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, 200, 'x')`,
  );
  for (let i = 0; i < REQUESTS; i++) {
    const site = SITES[i % SITES.length];
    const state = i % 10 === 0 ? 'queued' : i % 97 === 0 ? 'failed' : 'done';
    r.run(
      site,
      `k${i}`,
      `https://x/${i}`,
      i % 50 === 0 ? 10 : 0,
      state,
      now,
      now,
      state === 'done' ? now - i : null,
      state === 'done' ? 'ok' : null,
    );
  }
  const a = db.prepare(
    'INSERT INTO fetch_attempts (request_id, site, at, ms, status, bytes, outcome, pace, labeled) VALUES (?, ?, ?, 900, 200, 1000, ?, ?, 0)',
  );
  for (let i = 0; i < 600_000; i++)
    a.run(
      i + 1,
      SITES[i % SITES.length],
      now - (600_000 - i) * 4000,
      i % 77 === 0 ? 'challenge' : 'ok',
      'separate',
    );
  const b = db.prepare(
    `INSERT INTO stage4_books (library_id, calibre_uuid, calibre_id, analysis_id, labeled, state, pending, updated_at) VALUES ('L', ?, ?, 'A', ?, ?, 0, ?)`,
  );
  for (let i = 0; i < BOOKS; i++)
    b.run(`u${i}`, i + 1, i < 800 ? 1 : 0, i % 3 === 0 ? 'waiting' : 'proposed', now);
  const w = db.prepare(
    `INSERT INTO fetch_waiters (request_id, library_id, calibre_uuid, step, ready) VALUES (?, 'L', ?, 'amazon-dp', ?)`,
  );
  for (let i = 0; i < BOOKS; i += 3) w.run(i + 1, `u${i}`, i % 300 === 0 ? 1 : 0);
  const n = db.prepare(
    'INSERT INTO natively_books (natively_id, url, listed_at, queued_at, read_at, isbn13) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < 50_000; i++)
    n.run(
      `n${i}`,
      `https://n/${i}`,
      now,
      i < 40_000 ? now : null,
      i < 30_000 ? now : null,
      i % 2 ? `978${String(i).padStart(10, '0')}` : null,
    );
  const ar = db.prepare('INSERT INTO author_readings (name, state, updated_at) VALUES (?, ?, ?)');
  for (let i = 0; i < 20_000; i++)
    ar.run(`name${i}`, ['found', 'queued', 'asked', 'not_found', 'generated'][i % 5], now);
  const pc = db.prepare(
    `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source, evidence_json, class, state, analysis_id, created_at, updated_at)
     VALUES (4, 'L', ?, ?, ?, '"a"', '"b"', 'amazon-asin', '{}', ?, 'proposed', 'A', ?, ?)`,
  );
  const fields = ['title', 'authors', 'illustrator', 'series', 'format', 'kind'];
  for (let i = 0; i < 300_000; i++)
    pc.run(i % BOOKS, `u${i % BOOKS}`, fields[i % 6], i % 4 ? 'auto' : 'review', now, now);
})();
db.prepare(
  `INSERT OR REPLACE INTO fetch_sites (site, last_claim_at, updated_at) VALUES ('amazon', 0, 0)`,
).run();
console.log(`synthetic rows: ${Date.now() - t} ms`);
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('ANALYZE');

function check(label: string, sql: string, args: unknown[] = []): void {
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map(
    (r) => r.detail,
  );
  const stmt = db.prepare(sql);
  const t0 = process.hrtime.bigint();
  const reps = 5;
  for (let i = 0; i < reps; i++) {
    if (stmt.reader) stmt.all(...args);
    else stmt.run(...args);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / reps;
  const scan = plan.some((d) => /^SCAN /.test(d) && !/USING (COVERING )?INDEX/.test(d));
  console.log(
    `${scan ? 'SCAN' : 'ok  '} ${ms.toFixed(2).padStart(8)} ms  ${label}\n        ${plan.join(' | ')}`,
  );
}

console.log('\n-- the fetcher (every second) --');
check(
  'claim: next due request of a site',
  `SELECT id, site, method, url, body, accept FROM fetch_requests WHERE site = ? AND state = 'queued' AND next_at <= ? ORDER BY priority DESC, next_at LIMIT 1`,
  ['amazon-dp', now],
);
check(
  'claim: open lease of a site',
  `SELECT 1 FROM fetch_requests WHERE site = ? AND state = 'leased' LIMIT 1`,
  ['amazon-dp'],
);
check(
  'claim: soonest next_at of a site',
  `SELECT MIN(next_at) AS t FROM fetch_requests WHERE site = ? AND state = 'queued'`,
  ['amazon-dp'],
);
check(
  'claim: expire leases',
  `UPDATE fetch_requests SET state = 'queued', lease_token = NULL, lease_until = NULL, updated_at = ? WHERE state = 'leased' AND lease_until < ?`,
  [now, now],
);
check('pace row', 'SELECT * FROM fetch_sites WHERE site = ?', ['amazon']);
check(
  'trial: labeled Amazon requests answered',
  `SELECT COUNT(*) AS total, SUM(state IN ('done', 'gone', 'failed')) AS finished FROM fetch_requests WHERE site IN ('amazon-dp', 'amazon-search') AND priority >= ?`,
  [10],
);
console.log('\n-- an answer --');
check('report: the request', 'SELECT * FROM fetch_requests WHERE id = ?', [12345]);
check('report: its waiters ready', 'UPDATE fetch_waiters SET ready = 1 WHERE request_id = ?', [
  12345,
]);
check(
  'slow-down: last 100 Amazon attempts',
  `SELECT outcome FROM fetch_attempts WHERE site IN ('amazon-dp', 'amazon-search', 'amazon-img') ORDER BY at DESC LIMIT ?`,
  [100],
);
console.log('\n-- the analysis (each step) --');
check(
  'books to plan',
  `SELECT calibre_uuid, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'read' ORDER BY labeled DESC LIMIT ?`,
  ['A', 500],
);
check(
  'ready waiters',
  'SELECT request_id, library_id, calibre_uuid, step FROM fetch_waiters WHERE ready = 1 LIMIT ?',
  [200],
);
check(
  'books to propose',
  `SELECT calibre_uuid, labeled FROM stage4_books WHERE analysis_id = ? AND state = 'ready' ORDER BY labeled DESC LIMIT ?`,
  ['A', 100],
);
check(
  'labeled books open',
  `SELECT COUNT(*) AS n FROM stage4_books WHERE analysis_id = ? AND labeled = 1 AND state IN ('read', 'waiting', 'ready')`,
  ['A'],
);
check(
  'books open',
  `SELECT COUNT(*) AS n FROM stage4_books WHERE analysis_id = ? AND state IN ('read', 'waiting', 'ready')`,
  ['A'],
);
check(
  'Natively: the sitemap',
  "SELECT id, state, finished_at FROM fetch_requests WHERE site = 'natively' AND key = 'sitemap'",
);
check(
  'Natively: pages not queued',
  'SELECT natively_id, url FROM natively_books WHERE queued_at IS NULL LIMIT ?',
  [2000],
);
check(
  'Natively: open requests',
  "SELECT COUNT(*) AS n FROM fetch_requests WHERE site = 'natively' AND state IN ('queued', 'leased')",
);
check(
  'Natively: match by ISBN',
  'SELECT natively_id FROM natively_books WHERE isbn13 = ? LIMIT 1',
  ['9780000000001'],
);
check('Natively: match by ASIN', 'SELECT natively_id FROM natively_asins WHERE asin = ? LIMIT 1', [
  'B000000000',
]);
check(
  'readings: NDL answers',
  `SELECT DISTINCT a.request_id AS id, f.state FROM author_readings a JOIN fetch_requests f ON f.id = a.request_id WHERE a.state = 'asked' AND f.state IN ('done', 'gone', 'failed') LIMIT 20`,
);
check(
  'readings: next NDL batch',
  `SELECT name FROM author_readings WHERE state = 'queued' ORDER BY name LIMIT ?`,
  [50],
);
check('readings: one name', 'SELECT reading, state FROM author_readings WHERE name = ?', ['name5']);
check(
  'readings: done?',
  `SELECT COUNT(*) AS n FROM author_readings WHERE state IN ('queued', 'asked', 'generating') OR state = 'not_found'`,
);
check(
  'proposals: replace a book field',
  `DELETE FROM proposed_changes WHERE stage = 4 AND library_id = ? AND calibre_uuid = ? AND state = 'proposed' AND field = ?`,
  ['L', 'u5', 'title'],
);
check(
  'applied values of a book',
  'SELECT field, value_json FROM applied_values WHERE library_id = ? AND calibre_uuid = ?',
  ['L', 'u5'],
);
console.log('\n-- the page (status every 5 s, cached 30 s; lists on demand) --');
check(
  'status: requests per site and state',
  'SELECT site, state, COUNT(*) AS n FROM fetch_requests GROUP BY site, state',
);
check(
  'status: attempts in the last 20 min',
  `SELECT site, COUNT(*) AS n, SUM(outcome = 'challenge') AS challenges, SUM(outcome = 'error') AS errors, AVG(ms) AS ms, MIN(at) AS first FROM fetch_attempts WHERE at >= ? GROUP BY site`,
  [now - 20 * 60_000],
);
check(
  'status: attempts in total (counters)',
  'SELECT site, attempts AS n, challenges, errors, busy FROM fetch_sites',
);
check(
  'status: books',
  'SELECT state, labeled, COUNT(*) AS n FROM stage4_books WHERE analysis_id = ? GROUP BY state, labeled',
  ['A'],
);
check('status: readings', 'SELECT state, COUNT(*) AS n FROM author_readings GROUP BY state');
check(
  'status: Natively',
  'SELECT COUNT(*) AS listed, SUM(read_at IS NOT NULL) AS read, SUM(isbn13 IS NOT NULL) AS withIsbn FROM natively_books',
);
check(
  'status: proposals per field',
  `SELECT field, class, COUNT(*) AS n FROM proposed_changes WHERE stage = 4 AND library_id = ? AND state = 'proposed' AND analysis_id = ? GROUP BY field, class`,
  ['L', 'A'],
);
check(
  'list: proposals of a field',
  `SELECT id FROM proposed_changes WHERE stage = 4 AND library_id = ? AND state = 'proposed' AND analysis_id = ? AND field = ? AND class = ? ORDER BY calibre_id, field LIMIT 50 OFFSET 0`,
  ['L', 'A', 'title', 'review'],
);

// The real claim path, end to end.
const q = new FetchQueue(db, path.join(path.dirname(file), 'cache'), () => getSettings(db).fetch);
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) q.claim(now + i * 1000 * 60);
console.log(
  `\nFetchQueue.claim (all sites): ${(Number(process.hrtime.bigint() - t0) / 1e6 / 20).toFixed(2)} ms per call`,
);
db.close();
