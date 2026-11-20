/**
 * WP20d: where the final pass's time per book goes. On a COPY of cleanup.db (with a copy of
 * Calibre's metadata.db as the reader's snapshot), runs the analysis's own final step over
 * proposed books and times it per book, then the parts of one book's proposals apart: the two
 * evidence reads, the rules, the name lookup copy, the proposals, the write and the progress save.
 *
 *   npx tsx scripts/time-stage4-final.ts <copy of cleanup.db> <cache dir with calibre/<library>.db> [books]
 *
 * Writes only into the copy given.
 */
import Database from 'better-sqlite3';
import { performance } from 'perf_hooks';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import { spellingLookup } from '../src/cleanup/stage2-snapshot';

const [file, cacheDir, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 300);
const db = new Database(file);
db.pragma('journal_mode = WAL');
const a = new Stage4Analysis({
  cleanup: db,
  main: null as never,
  calibreDir: '',
  cacheDir,
  queue: null as never,
}) as unknown as Record<string, any>;
const p = getStage(db, 4).progress as unknown as Stage4Progress;
console.log(
  `progress_json: ${(JSON.stringify(p).length / 1024).toFixed(0)} KB; phase ${p.phase}; ` +
    `propose: book ${JSON.stringify(p.times?.['propose: book'])}`,
);
let t = performance.now();
const snap = a.loadSnapshot(p.libraryId);
console.log(`snapshot: ${snap.books.size} books, ${(performance.now() - t).toFixed(0)} ms`);
console.log(
  `names: author ${snap.names.author.size}, publisher ${snap.names.publisher.size}, illustrator ${snap.names.illustrator.size}`,
);

// 1. The final step itself (its own code), from the start of the proposed books.
p.phase = 'final';
p.finalCursor = 0;
p.finalDone = 0;
const runFinal = async () => {
  t = performance.now();
  while ((p.finalDone ?? 0) < n) {
    const before = p.finalDone ?? 0;
    await a.finalStep(p);
    if ((p.finalDone ?? 0) === before) break;
  }
  return (performance.now() - t) / (p.finalDone ?? 1);
};
void (async () => {
  const perBook = await runFinal();
  console.log(`final step: ${p.finalDone} books, ${perBook.toFixed(1)} ms per book`);

  // 2. The parts, on the same books.
  const rows = db
    .prepare(
      `SELECT calibre_uuid FROM stage4_books WHERE analysis_id = ? AND state = 'proposed' ORDER BY calibre_id LIMIT ?`,
    )
    .all(p.analysisId, n) as { calibre_uuid: string }[];
  const parts: Record<string, number> = {};
  const add = (k: string, ms: number) => (parts[k] = (parts[k] ?? 0) + ms);
  const settings = (await import('../src/cleanup/settings')).getSettings(db);
  for (const r of rows) {
    let t0 = performance.now();
    const ref = a.loadRef(p.libraryId, r.calibre_uuid);
    add('read file evidence', performance.now() - t0);
    t0 = performance.now();
    const ev = a.loadOnline(p.libraryId, r.calibre_uuid);
    add('read online evidence', performance.now() - t0);
    const book = a.book(r.calibre_uuid);
    if (!book || !ref?.file || !ev) continue;
    t0 = performance.now();
    decideStage4(a.record(book, ref.file, ev));
    add('rules (decideStage4)', performance.now() - t0);
    t0 = performance.now();
    spellingLookup(snap.names);
    add('name lookup copy', performance.now() - t0);
    t0 = performance.now();
    const res = a.proposalsFor(p, r.calibre_uuid, settings);
    add('proposalsFor (all of it)', performance.now() - t0);
    t0 = performance.now();
    db.transaction(() => {
      a.writeProposals(p, book, res.proposals, new Set(['identifiers', 'author_sort']));
    })();
    add('write two fields (own transaction)', performance.now() - t0);
    t0 = performance.now();
    a.save(p);
    add('progress save', performance.now() - t0);
  }
  for (const [k, v] of Object.entries(parts))
    console.log(`  ${k}: ${(v / rows.length).toFixed(2)} ms per book`);
})();
