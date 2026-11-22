/**
 * Series-order follow-up, stop 1 tool: the series order (series-order.ts) over the whole library
 * from a copy of the live cleanup.db and the reader's snapshot of metadata.db, read-only. Writes
 * every book's number after On and the step's choice as JSON for scoring (the measurement's
 * score script) and the library-wide checks.
 *
 *   npx ts-node --transpile-only scripts/series-order-run.ts --db <copy/cleanup.db>
 *     --main <copy/ttsu.db> --cache <folder holding calibre/<library>.db> --out <result.json>
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import path from 'path';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import {
  addSeriesChecks,
  emptyChecks,
  orderLibrary,
  type SeriesBook,
} from '../src/cleanup/stage4/series-order';
import { seriesKey } from '../src/cleanup/stage4/series-spelling';
import type { FetchQueue } from '../src/cleanup/stage4/queue';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const t = () => new Date().toLocaleTimeString();
const log = (m: string) => console.log(`${t()} ${m}`);

import { readFileSync } from 'fs';
if (arg('from-facts')) {
  // Fast loop: the rules alone on facts saved by an earlier run.
  const books = JSON.parse(readFileSync(arg('from-facts')!, 'utf8')) as SeriesBook[];
  const t1 = Date.now();
  const choices = orderLibrary(books);
  log(`order: ${choices.length} choices (${Date.now() - t1} ms)`);
  // The library-wide checks (gate 2), per series as the server's step counts them.
  const checks = emptyChecks();
  const groups = new Map<string, SeriesBook[]>();
  for (const b of books) {
    const k = seriesKey(b.name);
    if (k) groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  const cBy = new Map(choices.map((c) => [c.uuid, c]));
  for (const g of groups.values())
    addSeriesChecks(
      checks,
      g,
      g.map((b) => cBy.get(b.uuid)).filter((c): c is NonNullable<typeof c> => !!c),
    );
  log(`checks: ${JSON.stringify({ ...checks, examples: undefined })}`);
  for (const x of checks.examples) console.log(`   ${x}`);
  const choiceBy = new Map(choices.map((c) => [c.uuid, c]));
  const byId: Record<string, unknown> = {};
  for (const b of books)
    byId[String(b.calibreId)] = {
      name: b.name,
      before: b.index,
      indexFrom: b.indexFrom,
      title: b.title,
      choice: choiceBy.get(b.uuid) ?? null,
    };
  writeFileSync(arg('out')!, JSON.stringify(byId));
  const only = arg('show');
  if (only)
    for (const b of books.filter((x) => x.name === only))
      console.log(JSON.stringify({ ...b, pool: b.pool.length, choice: choiceBy.get(b.uuid) }));
  process.exit(0);
}
const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
const analysis = new Stage4Analysis({
  cleanup: db,
  main,
  calibreDir: '',
  cacheDir: path.resolve(arg('cache')!),
  dbDir: null,
  queue: {} as FetchQueue,
  log,
});
const p = getStage(db, 4).progress as unknown as Stage4Progress;
let t0 = Date.now();
const after = analysis.seriesStateAfterOn(p);
log(`after On: ${after.size} books (${Date.now() - t0} ms)`);
t0 = Date.now();
const books: SeriesBook[] = [];
let n = 0;
let longest = 0;
for (const [uuid, a] of after) {
  if (!a.name) continue;
  const s = Date.now();
  const b = analysis.seriesBook(p, uuid, a);
  longest = Math.max(longest, Date.now() - s);
  if (b) books.push(b);
  if (++n % 5000 === 0) log(`facts: ${n}`);
}
log(`facts: ${books.length} books (${Date.now() - t0} ms, longest ${longest} ms)`);
if (arg('facts')) writeFileSync(arg('facts')!, JSON.stringify(books));
t0 = Date.now();
const choices = orderLibrary(books);
log(`order: ${choices.length} choices (${Date.now() - t0} ms)`);
const byId: Record<string, unknown> = {};
const choiceBy = new Map(choices.map((c) => [c.uuid, c]));
for (const b of books) {
  const c = choiceBy.get(b.uuid);
  byId[String(b.calibreId)] = {
    name: b.name,
    before: b.index,
    indexFrom: b.indexFrom,
    title: b.title,
    choice: c ?? null,
  };
}
writeFileSync(arg('out')!, JSON.stringify(byId));
log('written');
