/**
 * Manga part B, stop 1: migration v38 on a one-step copy of the live cleanup.db (the server's own
 * snapshot), as the server would run it. Reports the time, quick_check, the rows of every table
 * the migration rebuilds before and after, the state of the arrivals' current run (run 7), and the
 * plan and time of every new query a page polls or a step runs per book (WP20 lessons 3-4: no
 * SCAN of a table that grows with the library).
 *
 *   npx ts-node --transpile-only scripts/manga-b-copy-run.ts --db <copy of cleanup.db> [--primary <reader library id>]
 *
 * The copy is changed (migrated); make a new one for another try.
 */
import Database from 'better-sqlite3';
import { CLEANUP_SCHEMA_VERSION, migrateCleanup } from '../src/cleanup/cleanup-db';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = arg('db');
if (!file) throw new Error('--db <copy of cleanup.db>');
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const TABLES = [
  'stages',
  'stage_field_pauses',
  'preflight',
  'bookmeter_more_state',
  'series_pairs_state',
  'link_discovery_state',
  'bookmeter_listing_state',
  'calibre_arrivals_state',
  'calibre_arrival_runs',
  'calibre_arrival_files',
  'calibre_arrival_batch_items',
  'calibre_arrival_reviews',
  'calibre_arrival_books',
  'calibre_known_books',
];
const count = (t: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

const version = db.pragma('user_version', { simple: true }) as number;
console.log(`cleanup.db v${version} → v${CLEANUP_SCHEMA_VERSION}`);
const before = Object.fromEntries(TABLES.map((t) => [t, count(t)]));
const stagesBefore = db
  .prepare('SELECT stage, mode, state, pause_reason FROM stages ORDER BY stage')
  .all();
const arrivalsBefore = db.prepare('SELECT * FROM calibre_arrivals_state').get() as Record<
  string,
  unknown
>;
const primary =
  arg('primary') ??
  (
    db.prepare('SELECT library_id FROM calibre_move_state WHERE id = 1').get() as {
      library_id: string | null;
    }
  )?.library_id ??
  null;
console.log('primary library:', primary);

let t = performance.now();
migrateCleanup(db, { primaryLibrary: () => primary });
console.log(`migration: ${((performance.now() - t) / 1000).toFixed(1)} s`);
t = performance.now();
console.log(
  'quick_check:',
  db.pragma('quick_check', { simple: true }),
  `(${((performance.now() - t) / 1000).toFixed(1)} s)`,
);
console.log('foreign_key_check rows:', (db.pragma('foreign_key_check') as unknown[]).length);

console.log('\nrows (before → after):');
for (const tb of TABLES) {
  const a = count(tb);
  console.log(`  ${tb}: ${before[tb]} → ${a}${before[tb] === a ? '' : '   ← changed'}`);
}
console.log('\nstages before:', JSON.stringify(stagesBefore));
console.log(
  'stages after:',
  JSON.stringify(
    db
      .prepare('SELECT stage, library_id, mode, state, pause_reason FROM stages ORDER BY stage')
      .all(),
  ),
);
console.log(
  'field pauses after:',
  JSON.stringify(db.prepare('SELECT * FROM stage_field_pauses').all()),
);
console.log(
  'pass states after:',
  JSON.stringify(
    [
      'bookmeter_more_state',
      'series_pairs_state',
      'link_discovery_state',
      'bookmeter_listing_state',
    ].map((tb) => [tb, db.prepare(`SELECT library_id, mode FROM ${tb}`).all()]),
  ),
);
const arrivalsAfter = db.prepare('SELECT * FROM calibre_arrivals_state').all();
console.log('\narrivals state before:', JSON.stringify(arrivalsBefore));
console.log('arrivals state after: ', JSON.stringify(arrivalsAfter));
const runId = arrivalsBefore.current_run as number | null;
if (runId) {
  const run = db
    .prepare(
      `SELECT id, mode, state, phase, library_id, json_extract(progress_json, '$.libraryId') AS p
       FROM calibre_arrival_runs WHERE id = ?`,
    )
    .get(runId);
  console.log('current run:', JSON.stringify(run));
}
console.log(
  'files with a Calibre book, by library:',
  JSON.stringify(
    db
      .prepare(
        'SELECT calibre_library_id, COUNT(*) AS n FROM calibre_arrival_files WHERE calibre_id IS NOT NULL GROUP BY calibre_library_id',
      )
      .all(),
  ),
);
console.log(
  'files with a Calibre book and no library:',
  (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM calibre_arrival_files WHERE calibre_id IS NOT NULL AND calibre_library_id IS NULL',
      )
      .get() as { n: number }
  ).n,
);

// The new queries: plan and time on the migrated copy (at the live size).
const lib = primary ?? '';
const queries: [string, string, unknown[]][] = [
  ['stage row', 'SELECT * FROM stages WHERE stage = ? AND library_id = ?', [4, lib]],
  ['stages of a library', 'SELECT * FROM stages WHERE library_id = ? ORDER BY stage', [lib]],
  [
    'field pauses (own and shared)',
    `SELECT field, reason, detail, paused_at FROM stage_field_pauses WHERE stage = ? AND library_id IN (?, '') ORDER BY field, library_id = ''`,
    [4, lib],
  ],
  [
    'sidecar checks of a library',
    `SELECT * FROM preflight WHERE source = 'sidecar' AND library_id IN ('', ?)`,
    [lib],
  ],
  [
    'ready waiters (stage 4, per answer)',
    `SELECT request_id, library_id, calibre_uuid, step FROM fetch_waiters INDEXED BY fetch_waiters_ready WHERE ready = 1 AND library_id IN (?, 'natively') LIMIT 200`,
    [lib],
  ],
  [
    'stage 4 has work',
    `SELECT 1 FROM fetch_waiters WHERE ready = 1 AND library_id IN (?, 'natively') LIMIT 1`,
    [lib],
  ],
  [
    "AI items of a library (stage 4's ask)",
    `SELECT item_key FROM ai_items WHERE stage = 'calibre4' AND item_key >= ? AND item_key < ? ORDER BY labeled DESC, item_key`,
    [`${lib}:`, `${lib}:￿`],
  ],
  [
    'AI values of a library (counts)',
    `SELECT item_key, field, source, flagged FROM ai_values WHERE stage = ? AND item_key >= ? AND item_key < ?`,
    ['calibre4', `${lib}:`, `${lib}:￿`],
  ],
  [
    'applied value of a book (write path)',
    'SELECT value_json FROM applied_values WHERE library_id = ? AND calibre_uuid = ? AND field = ?',
    [lib, 'x', 'title'],
  ],
  [
    'arrivals state of a library',
    'SELECT * FROM calibre_arrivals_state WHERE library_id = ?',
    [lib],
  ],
  [
    'the run going on',
    'SELECT current_run FROM calibre_arrivals_state WHERE current_run IS NOT NULL LIMIT 1',
    [],
  ],
  [
    "a library's last run (card)",
    `SELECT id, trigger, mode, state, started_at, finished_at, report_json, error FROM calibre_arrival_runs INDEXED BY calibre_arrival_runs_library WHERE library_id = ? AND state <> 'running' ORDER BY id DESC LIMIT 1`,
    [lib],
  ],
  [
    "a library's open reviews (card)",
    `SELECT COUNT(*) AS n FROM calibre_arrival_reviews INDEXED BY calibre_arrival_reviews_open WHERE decision IS NULL AND (run_id IS NULL OR run_id IN (SELECT id FROM calibre_arrival_runs WHERE library_id = ?))`,
    [lib],
  ],
  [
    'added files of a library (removed by you)',
    `SELECT id, calibre_id, calibre_uuid FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome WHERE outcome = 'added' AND (calibre_library_id = ? OR calibre_library_id IS NULL)`,
    [lib],
  ],
  [
    'gate parts of a stage',
    'SELECT library_id, data_json FROM stage_gate_parts WHERE stage = ? AND part = ? ORDER BY library_id',
    [4, 'rules'],
  ],
  [
    'stage 5 written batches of a library',
    `SELECT id, claimed_at AS claimedAt, finished_at AS finishedAt, item_count AS items FROM batches WHERE stage = 5 AND library_id = ? AND kind = 'apply' AND state IN ('applied', 'partial') ORDER BY created_at DESC`,
    [lib],
  ],
  [
    'stage 2 pace of a library',
    `SELECT COUNT(DISTINCT c.calibre_id) AS n, MIN(i.updated_at) AS first FROM batch_items i JOIN batches b ON b.id = i.batch_id JOIN proposed_changes c ON c.id = i.change_id WHERE b.kind = 'apply' AND b.stage = 2 AND b.library_id = ? AND i.state = 'written' AND i.updated_at >= ?`,
    [lib, Date.now() - 20 * 60_000],
  ],
  [
    'review list of a library',
    `SELECT COUNT(*) AS n FROM proposed_changes WHERE class = 'review' AND state = 'proposed' AND decided_by IS NULL AND library_id = ?`,
    [lib],
  ],
  [
    'labeled books moved out of the primary library',
    `SELECT from_library_id, from_calibre_id, to_library_id, to_calibre_id FROM calibre_moves WHERE state = 'moved' AND from_library_id = ?`,
    [lib],
  ],
];
console.log('\nqueries:');
for (const [name, sql, params] of queries) {
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ');
  const t0 = performance.now();
  db.prepare(sql).all(...params);
  const ms = performance.now() - t0;
  const scan = /\bSCAN\b/.test(plan) ? '  ← SCAN' : '';
  console.log(`  ${name}: ${ms.toFixed(1)} ms${scan}\n      ${plan}`);
}
db.close();
