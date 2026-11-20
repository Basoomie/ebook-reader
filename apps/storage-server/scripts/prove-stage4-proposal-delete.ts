/**
 * WP20d: the per-book delete by the book index (2026-11-20) proposes exactly what the planner's
 * own choice did. On two COPIES of the same cleanup.db, runs the analysis's own final pass over
 * the first N proposed books: one copy with the query as it was (no INDEXED BY), one with the
 * code as it is; then compares every stage-4 proposal row of the library (field, values, source,
 * evidence, class, reason, state), ids and times aside.
 *
 *   npx tsx scripts/prove-stage4-proposal-delete.ts <copy A> <copy B> <cache dir> [books]
 *
 * Writes only into the copies given.
 */
import Database from 'better-sqlite3';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';

const [fileA, fileB, cacheDir, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 500);

async function run(file: string, asBefore: boolean): Promise<Database.Database> {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  if (asBefore) {
    // The statement as it was: the planner picks proposed_changes_counts.
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) =>
      prepare(sql.replace(' INDEXED BY proposed_changes_book', ''))) as typeof db.prepare;
  }
  const a = new Stage4Analysis({
    cleanup: db,
    main: null as never,
    calibreDir: '',
    cacheDir,
    queue: null as never,
  }) as unknown as Record<string, any>;
  const p = getStage(db, 4).progress as unknown as Stage4Progress;
  a.loadSnapshot(p.libraryId);
  p.phase = 'final';
  p.finalCursor = 0;
  p.finalDone = 0;
  const t = Date.now();
  while ((p.finalDone ?? 0) < n) {
    const before = p.finalDone ?? 0;
    await a.finalStep(p);
    if ((p.finalDone ?? 0) === before) break;
  }
  console.log(
    `${asBefore ? 'as it was' : 'by the book index'}: ${p.finalDone} books, ${Date.now() - t} ms`,
  );
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN DELETE FROM proposed_changes${asBefore ? '' : ' INDEXED BY proposed_changes_book'}
       WHERE stage = 4 AND library_id = ? AND calibre_uuid = ? AND state = 'proposed' AND field = ?`,
    )
    .all('l', 'u', 'f') as { detail: string }[];
  console.log('  ', plan[0].detail);
  return db;
}

const rowsOf = (db: Database.Database) =>
  db
    .prepare(
      `SELECT calibre_uuid, field, old_json, new_json, source, evidence_json, class, review_reason, state
       FROM proposed_changes WHERE stage = 4
       ORDER BY calibre_uuid, field, new_json, source, class, evidence_json`,
    )
    .all() as Record<string, unknown>[];

void (async () => {
  const a = rowsOf(await run(fileA, true));
  const b = rowsOf(await run(fileB, false));
  let differ = 0;
  for (let k = 0; k < Math.max(a.length, b.length); k++)
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      if (differ < 5) console.log('differs:', a[k], b[k]);
      differ++;
    }
  console.log(`stage-4 proposal rows: ${a.length} / ${b.length}; rows that differ: ${differ}`);
  process.exit(differ || a.length !== b.length ? 1 : 0);
})();
