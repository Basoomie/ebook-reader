/**
 * Series under a short and a full name (tier 4, Part 3), measuring only: every pair of series
 * names in the library (src/cleanup/series-pairs/pairs.ts), its group, both sides' books and the
 * signals, from one-step copies of cleanup.db and the reader's Calibre snapshot (metadata.db).
 * Both are opened read-only; nothing is fetched and nothing is written but the output folder.
 * Each book's kind, own titles and stored store answers come from stage 4's own code
 * (Stage4Analysis.seriesBook and loadOnline), as the series order sees them.
 *
 *   npx ts-node --transpile-only scripts/series-pairs-extract.ts --db <copy/cleanup.db>
 *     --metadata <copy of cache/calibre/<library>.db> --out <folder>
 *
 * Writes <folder>/pairs.jsonl (one pair per line) and <folder>/counts.json.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { readStage2Snapshot } from '../src/cleanup/stage2-snapshot';
import { readStage4Extras } from '../src/cleanup/stage4/snapshot4';
import {
  PAIR_GROUPS,
  answerPair,
  commonName,
  libraryPairs,
  pairSignals,
  type PairBook,
} from '../src/cleanup/series-pairs/pairs';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const t0 = performance.now();
const outDir = arg('out')!;
fs.mkdirSync(outDir, { recursive: true });
const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const p = getStage(db, 4).progress as unknown as Stage4Progress;
const lib = p.libraryId;
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'series-pairs-'));
const snapFile = path.join(cacheDir, SNAPSHOT_DIRNAME, `${lib}.db`);
fs.mkdirSync(path.dirname(snapFile), { recursive: true });
fs.copyFileSync(arg('metadata')!, snapFile);

const snap = readStage2Snapshot(snapFile);
const extras = readStage4Extras(snapFile);
const analysis = new Stage4Analysis({
  cleanup: db,
  // Never read for these calls.
  main: null as never,
  calibreDir: '',
  cacheDir,
  dbDir: null,
  queue: null as never,
});
analysis.loadSnapshot(lib);

// The series as Calibre holds them now.
const booksOf = new Map<string, number[]>();
for (const b of snap.books.values()) {
  const s = extras.get(b.calibreId)?.series;
  if (!s) continue;
  const list = booksOf.get(s);
  if (list) list.push(b.calibreId);
  else booksOf.set(s, [b.calibreId]);
}
const series = [...booksOf].map(([name, ids]) => ({ name, books: ids.length }));
const tPairs = performance.now();
const pairs = libraryPairs(series);
const pairsMs = performance.now() - tPairs;

const decided = new Map<string, string>();
try {
  for (const r of db
    .prepare(`SELECT name_a, name_b, decision FROM series_pair_decisions WHERE library_id = ?`)
    .all(lib) as { name_a: string; name_b: string; decision: string }[])
    decided.set(`${r.name_a}\u0000${r.name_b}`, r.decision);
} catch {
  // A copy from before v29 has no decisions.
}

const cache = new Map<number, PairBook>();
function pairBook(calibreId: number): PairBook {
  const hit = cache.get(calibreId);
  if (hit) return hit;
  const b = snap.books.get(calibreId)!;
  const ex = extras.get(calibreId);
  const name = ex?.series ?? null;
  const index = ex?.seriesIndex ?? null;
  const sb = analysis.seriesBook(p, b.uuid, { name, index, title: b.title, proposedSeries: true });
  const ev = analysis.loadOnline(lib, b.uuid);
  const product = ev?.amazon.product ?? null;
  const rdb = ev?.ranobedb.series ?? null;
  const rdbId = ev?.ranobedb.book?.series?.id;
  const links: PairBook['links'] = [];
  const asin = b.identifiers.amazon_jp ?? b.identifiers.amazon ?? product?.asin ?? null;
  if (asin) links.push({ site: 'amazon', url: `https://www.amazon.co.jp/dp/${asin}` });
  if (b.identifiers.bookwalker)
    links.push({ site: 'bookwalker', url: `https://bookwalker.jp/de${b.identifiers.bookwalker}/` });
  else if (ev?.bookwalker.detail?.url)
    links.push({ site: 'bookwalker', url: ev.bookwalker.detail.url });
  if (rdbId !== undefined && rdbId !== null)
    links.push({ site: 'ranobedb', url: `https://ranobedb.org/series/${String(rdbId)}` });
  if (b.identifiers.bookmeter)
    links.push({
      site: 'bookmeter',
      url: `https://bookmeter.com/books/${b.identifiers.bookmeter}`,
    });
  const amazonSeries = product?.series
    ? product.series.replace(/^全\d+冊中\d+番目の本\s*/u, '').trim() || null
    : null;
  const out: PairBook = {
    uuid: b.uuid,
    calibreId,
    title: b.title,
    authors: b.authors,
    index,
    kind: sb?.kind ?? 'full',
    own: sb?.own ?? [b.title],
    amazonSeries,
    ranobedbSeries:
      rdbId !== undefined && rdbId !== null
        ? {
            id: String(rdbId),
            name:
              typeof rdb?.title_orig === 'string'
                ? rdb.title_orig
                : typeof ev?.ranobedb.book?.series?.title_orig === 'string'
                  ? (ev.ranobedb.book.series.title_orig as string)
                  : null,
          }
        : null,
    links,
  };
  cache.set(calibreId, out);
  return out;
}

const out = fs.createWriteStream(path.join(outDir, 'pairs.jsonl'));
const counts: Record<string, { pairs: number; books: number; answers: Record<string, number> }> =
  Object.fromEntries(PAIR_GROUPS.map((g) => [g, { pairs: 0, books: 0, answers: {} }]));
let n = 0;
const tSignals = performance.now();
for (const pair of pairs) {
  const short = booksOf.get(pair.short)!.map(pairBook);
  const long = booksOf.get(pair.long)!.map(pairBook);
  const signals = pairSignals(pair, short, long);
  const { answer, rule, held } = answerPair(pair, signals);
  const [a, b] = pair.short < pair.long ? [pair.short, pair.long] : [pair.long, pair.short];
  const row = {
    ...pair,
    common: commonName(pair.short, pair.long),
    decided: decided.get(`${a}\u0000${b}`) ?? null,
    signals,
    answer,
    rule,
    held: held ?? null,
    shortSide: short,
    longSide: long,
  };
  out.write(JSON.stringify(row) + '\n');
  const c = counts[pair.group];
  c.pairs++;
  c.books += short.length + long.length;
  c.answers[answer] = (c.answers[answer] ?? 0) + 1;
  n++;
}
out.end();
const report = {
  library: lib,
  series: series.length,
  pairs: n,
  groups: counts,
  ms: {
    total: Math.round(performance.now() - t0),
    pairFinder: Math.round(pairsMs),
    signals: Math.round(performance.now() - tSignals),
  },
};
fs.writeFileSync(path.join(outDir, 'counts.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
fs.rmSync(cacheDir, { recursive: true, force: true });
