/**
 * The Natively level (2026-11-24): migration 32 and the level: filter / Level sort at the live
 * size. Works on a WORKING COPY of a live ttsu.db (it migrates and writes to it; never point it
 * at the live database). Books without Natively ids get `--seed N` random ids and levels first.
 *   npx ts-node -T scripts/natively-level-timing.ts <working copy of ttsu.db> [--seed 5232]
 */
import Database from 'better-sqlite3';
import { planBooks, planCount } from '../src/catalog/queries';
import { registerRegexp } from '../src/catalog/regexp';
import { migrate } from '../src/db/migrations';
import { NativelyLevels } from '../src/natively/levels';

const file = process.argv[2];
const seedAt = process.argv.indexOf('--seed');
const seed = seedAt > 0 ? Number(process.argv[seedAt + 1]) : 5232;
const db = new Database(file, { fileMustExist: true });
registerRegexp(db);

let t = performance.now();
migrate(db);
console.log(
  `migrate to ${db.pragma('user_version', { simple: true })}: ${(performance.now() - t).toFixed(0)} ms`,
);

const have = (
  db.prepare("SELECT COUNT(*) n FROM book_identifiers WHERE type = 'natively'").get() as {
    n: number;
  }
).n;
if (have === 0 && seed > 0) {
  t = performance.now();
  const ids = db.prepare('SELECT id FROM books ORDER BY random() LIMIT ?').all(seed) as {
    id: string;
  }[];
  const link = db.prepare(
    "INSERT OR REPLACE INTO book_identifiers (book_id, type, value) VALUES (?, 'natively', ?)",
  );
  const level = db.prepare(
    "INSERT OR REPLACE INTO natively_levels (natively_id, level, temporary, state, checked_at) VALUES (?, ?, ?, 'ok', ?)",
  );
  db.transaction(() => {
    ids.forEach((r, i) => {
      const nid = `seed${i.toString(16)}`;
      link.run(r.id, nid);
      level.run(nid, 5 + Math.floor(Math.random() * 40), Math.random() < 0.2 ? 1 : 0, Date.now());
    });
  })();
  console.log(
    `seeded ${ids.length} levels (triggers fill books): ${(performance.now() - t).toFixed(0)} ms`,
  );
}
const mirrored = (
  db.prepare('SELECT COUNT(*) n FROM books WHERE natively_level IS NOT NULL').get() as { n: number }
).n;
console.log(
  `books with a level: ${mirrored} of ${(db.prepare('SELECT COUNT(*) n FROM books').get() as { n: number }).n}`,
);

const user = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as { id: string };
const u = { id: user.id, deviceId: null };
const time = (label: string, run: () => { plan: string; n: number }) => {
  const t0 = performance.now();
  const r = run();
  console.log(
    `${label.padEnd(36)} ${(performance.now() - t0).toFixed(1).padStart(7)} ms  ${r.n} rows  plan: ${r.plan}`,
  );
};
const listRun = (opts: Parameters<typeof planBooks>[2]) => () => {
  const plan = planBooks(db, u, opts);
  const explain = (
    db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(' | ');
  const page = plan.finish(db.prepare(plan.sql).all(...plan.params));
  return { plan: explain, n: page.books.length };
};
const countRun = (query: string) => () => {
  const plan = planCount(db, u, { query });
  const explain = (
    db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join(' | ');
  return { plan: explain, n: plan.finish(db.prepare(plan.sql).all(...plan.params)).count };
};
for (let pass = 0; pass < 2; pass++) {
  console.log(pass === 0 ? '-- first run' : '-- again');
  time('sort level asc, first page', listRun({ sort: { key: 'level', dir: 'asc' }, limit: 50 }));
  time('sort level desc, first page', listRun({ sort: { key: 'level', dir: 'desc' }, limit: 50 }));
  time('level:20-29, newest first', listRun({ query: 'level:20-29', limit: 50 }));
  time('level:>=40 (few), newest first', listRun({ query: 'level:>=40', limit: 50 }));
  time('-level:<30, newest first', listRun({ query: '-level:<30', limit: 50 }));
  time(
    'level:20-29 sorted by level',
    listRun({ query: 'level:20-29', sort: { key: 'level', dir: 'asc' }, limit: 50 }),
  );
  time('count level:20-29', countRun('level:20-29'));
}
// The settings page polls the progress every 10 s; the first pass lists the ids without a level.
const levels = new NativelyLevels({ db, log: () => {} });
for (let i = 0; i < 2; i++) {
  let t1 = performance.now();
  const p = levels.progress();
  console.log(
    `progress()`.padEnd(36),
    (performance.now() - t1).toFixed(1).padStart(7),
    'ms',
    JSON.stringify({ saved: p.saved }),
  );
  t1 = performance.now();
  levels.startPass();
  console.log(
    `startPass() (lists missing ids)`.padEnd(36),
    (performance.now() - t1).toFixed(1).padStart(7),
    'ms',
    JSON.stringify(levels.progress().pass),
  );
}
db.close();
