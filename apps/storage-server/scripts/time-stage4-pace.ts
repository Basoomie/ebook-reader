/**
 * Stage 4's pace per site and for Amazon's shared slot on a copy of the live cleanup.db, as the
 * status computes it (cleanup-service.ts with stage4/eta.ts paceSeconds), with the queries'
 * plans and times. Usage: npx tsx scripts/time-stage4-pace.ts <cleanup.db>
 */
import Database from 'better-sqlite3';
import { paceSeconds } from '../src/cleanup/stage4/eta';

const db = new Database(process.argv[2], { readonly: true });
const idleMs = (900 + 60) * 1000;
const rowsSql = `SELECT a.at, r.created_at AS created FROM fetch_attempts a
  JOIN fetch_requests r ON r.id = a.request_id WHERE a.site = ? ORDER BY a.at DESC LIMIT 501`;
const openSql = `SELECT MIN(created_at) AS m FROM fetch_requests
  WHERE site = ? AND state IN ('queued', 'leased')`;
for (const sql of [rowsSql, openSql]) {
  console.log(
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('amazon-dp')
      .map((r: any) => r.detail)
      .join(' | '),
  );
}
const last = db.prepare(rowsSql);
const oldest = db.prepare(openSql);
const groups = [
  ...[
    'amazon-dp',
    'amazon-search',
    'amazon-img',
    'ranobedb',
    'bookwalker',
    'bookmeter',
    'natively',
  ].map((s) => [s]),
  ['amazon-dp', 'amazon-search'],
];
let total = 0;
for (const g of groups) {
  const t0 = performance.now();
  const rows = g
    .flatMap((s) => last.all(s) as { at: number; created: number }[])
    .sort((a, b) => b.at - a.at)
    .slice(0, 501);
  let asked = false;
  const p = paceSeconds(
    rows,
    () => {
      asked = true;
      const ms = g
        .map((s) => (oldest.get(s) as { m: number | null }).m)
        .filter((m) => m !== null) as number[];
      return ms.length ? Math.min(...ms) : null;
    },
    idleMs,
  );
  const ms = performance.now() - t0;
  total += ms;
  console.log(
    g.join('+').padEnd(26),
    p === null ? 'not measured (set pace)' : `${p.toFixed(1)} s`,
    `· ${ms.toFixed(1)} ms${asked ? ' (open requests read)' : ''}`,
  );
}
console.log(`all: ${total.toFixed(1)} ms`);
