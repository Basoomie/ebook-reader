/**
 * WP21g stop 1: stage 8's pairing on copies of the live databases (a cleanup.db and the reader's
 * Calibre snapshot copy), every recording, nothing written. Counts per class and reason, and a
 * sample of each class to read by hand.
 *
 *   npx vite-node scripts/wp21g-measure.ts -- --cleanup <cleanup.db copy> --calibre <snapshot copy>
 *     [--show auto|review|none|excluded] [--n 30] [--seed 20261122] [--json <out>]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { readEbookSnapshot } from '../src/cleanup/audio/ebook-snapshot';
import { audioFactsAll } from '../src/cleanup/audio/stage8-ebooks';
import { buildIndex, candidatesOf, pairRecording } from '../src/cleanup/audio/ebook-pair';

function arg(name: string, dflt?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (dflt !== undefined) return dflt;
  throw new Error(`--${name} is required`);
}

const cl = new Database(arg('cleanup'), { readonly: true, fileMustExist: true });
const t0 = Date.now();
const snap = readEbookSnapshot(arg('calibre'));
const t1 = Date.now();
const idx = buildIndex(snap.books.values());
const facts = audioFactsAll(cl);
const t2 = Date.now();
const settings = { titleScore: 0.9, titleMinChars: 3, titleMinShare: 0.25 };
const results = facts.map((a) => ({ a, r: pairRecording(a, candidatesOf(a, idx), settings) }));
const t3 = Date.now();
console.log(
  `snapshot ${snap.books.size} books ${t1 - t0} ms; facts ${facts.length} ${t2 - t1} ms; pairing ${t3 - t2} ms`,
);
const byClass = new Map<string, number>();
const byReason = new Map<string, number>();
for (const { r } of results) {
  byClass.set(r.class, (byClass.get(r.class) ?? 0) + 1);
  const why = `${r.class}: ${r.reason.replace(/\d[\d.,/ -]*/g, 'N').slice(0, 70)}`;
  byReason.set(why, (byReason.get(why) ?? 0) + 1);
}
console.log([...byClass].sort());
for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(v, k);

let seed = Number(arg('seed', '20261122'));
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const show = arg('show', '');
if (show) {
  const pick = results
    .filter((x) => x.r.class === show && x.r.reason.includes(arg('reason', '')))
    .map((x) => ({ x, k: rnd() }))
    .sort((p, q) => p.k - q.k)
    .slice(0, Number(arg('n', '30')))
    .map((p) => p.x);
  for (const { a, r } of pick) {
    const e = r.calibreId !== null ? snap.books.get(r.calibreId) : null;
    console.log(
      `\n[${r.class}] ${a.title} | ${a.authors.join(',')} | ${JSON.stringify(a.series)} \n   → ${e ? `${e.id} ${e.title} | ${e.authors.join(',')} | ${e.series ?? '-'} #${e.index}` : '-'}\n   ${r.reason}`,
    );
    for (const c of r.candidates.slice(0, 4))
      console.log(`     ${c.outcome} ${c.id} ${c.title}: ${c.why}`);
  }
}
const out = arg('json', '');
if (out)
  fs.writeFileSync(
    out,
    JSON.stringify(
      results.map(({ a, r }) => ({
        unit: a.unitKey,
        title: a.title,
        authors: a.authors,
        cls: r.class,
        id: r.calibreId,
        reason: r.reason,
      })),
      null,
      1,
    ),
  );
