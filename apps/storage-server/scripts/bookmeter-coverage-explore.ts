/**
 * More Bookmeter coverage, step 1: which of the four checks the closest result failed, for the
 * books whose search had results but no accepted match (reads books.jsonl from
 * bookmeter-coverage-extract.ts; reads only).
 *
 *   npx ts-node --transpile-only scripts/bookmeter-coverage-explore.ts --in books.jsonl
 *     [--examples 10] [--seed 1] [--out groups.json]
 */
import fs from 'fs';
import { BASE, closest, groupName, type BookRow } from './lib/bookmeter-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
export function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const books = fs
  .readFileSync(arg('in')!, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as BookRow);
const groups = new Map<string, { n: number; labeled: number; rows: unknown[] }>();
for (const b of books) {
  if (b.base || !b.hits.length) continue;
  const c = closest(BASE, b)!;
  const g = groupName(c.failed);
  const e = groups.get(g) ?? { n: 0, labeled: 0, rows: [] };
  e.n++;
  if (b.gid) e.labeled++;
  e.rows.push({
    cid: b.cid,
    gid: b.gid,
    t: b.t,
    au: b.au.join(' & '),
    se: b.se,
    ix: b.ix,
    hit: `${c.hit.id} #${c.index + 1} ${c.hit.title} / ${c.hit.authors.join(' & ')}`,
  });
  groups.set(g, e);
}
const rand = mulberry32(Number(arg('seed') ?? 1));
const k = Number(arg('examples') ?? 10);
const report: Record<string, unknown> = {};
for (const [g, e] of [...groups].sort((x, y) => y[1].n - x[1].n)) {
  const pool = [...e.rows];
  const ex = [];
  for (let i = 0; i < Math.min(k, pool.length); i++)
    ex.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  report[g] = { n: e.n, labeled: e.labeled, examples: ex };
  console.log(`${g}\t${e.n}\t(labeled ${e.labeled})`);
}
if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
