/** WP20f: times the pieces of stage 5's slow first steps on a working copy (reads only). */
import Database from 'better-sqlite3';
import path from 'path';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { mapLabeledIds } from '../src/cleanup/stage2-gate';

const work = process.argv[2];
const db = new Database(work);
const main = new Database(process.argv[3], { readonly: true });
const p4 = getStage(db, 4).progress as unknown as Stage4Progress;
const cacheDir = path.join(path.dirname(work), 'cache');
const queue = new FetchQueue(
  db,
  path.join(cacheDir, 'cleanup'),
  () => getSettings(db).fetch,
  () => {},
);
const a = new Stage4Analysis({
  cleanup: db,
  main,
  calibreDir: path.dirname(work),
  cacheDir,
  dbDir: null,
  queue,
});
const time = (n: string, f: () => unknown) => {
  const t = performance.now();
  const r = f();
  console.log(`${n}: ${Math.round(performance.now() - t)} ms`);
  return r;
};
time('loadSnapshot', () => a.loadSnapshot(p4.libraryId));
time('loadSnapshot again', () => a.loadSnapshot(p4.libraryId));
const rows = time('stage4 books', () =>
  db
    .prepare(
      `SELECT calibre_uuid, calibre_id FROM stage4_books WHERE analysis_id = ? AND state = 'proposed'`,
    )
    .all(p4.analysisId),
) as { calibre_uuid: string; calibre_id: number }[];
time('formats', () =>
  db
    .prepare(
      `SELECT calibre_uuid, new_json FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 4 AND library_id = ? AND state = 'proposed' AND field = 'format' AND analysis_id = ?`,
    )
    .all(p4.libraryId, p4.analysisId),
);
time('mapLabeledIds', () => mapLabeledIds(db, p4.libraryId, ['1', '2']));
time('extrasAll x52k', () => {
  const m = a.extrasAll(p4);
  for (const r of rows) m.get(r.calibre_id);
});
let worst = 0;
time('aiInputs x500', () => {
  for (const r of rows.slice(0, 500)) {
    const t = performance.now();
    a.aiInputs(p4, r.calibre_uuid);
    worst = Math.max(worst, performance.now() - t);
  }
});
console.log(`worst aiInputs ${Math.round(worst)} ms`);
time('own terms', () => {
  const x = db
    .prepare(
      `SELECT item_key, value_json FROM ai_values WHERE stage = 'calibre5' AND field = 'own'`,
    )
    .all() as { value_json: string }[];
  for (const r of x) JSON.parse(r.value_json);
});
