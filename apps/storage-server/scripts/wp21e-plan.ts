/**
 * WP21e-1 stop 1: stage 6's plan on a working copy of the live cleanup.db, nothing written
 * anywhere but --out. Runs the stage's own plan phase (the same code the server runs), then
 * reports the counts, the labeled books' check, 30 random books (the stage's fixed-seed sample),
 * the move list, timing and EXPLAIN of every polled query.
 *
 *   npx vite-node scripts/wp21e-plan.ts -- --db <copy of cleanup.db> --labels <labels.json>
 *     --out <dir> [--library-folder japanese]
 *
 * The working database is a fresh one at the current schema, filled from the copy's audio_*,
 * ai_values and settings tables (read-only; the copy is never changed), as the WP21d scripts do.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { AiRunner } from '../src/cleanup/ai/runner';
import type { SecretStore } from '../src/cleanup/secrets';
import { AudioStage5, stage5RulesKey } from '../src/cleanup/audio/stage5-meta';
import { AudioStage6 } from '../src/cleanup/audio/stage6-build';
import { DiskLock } from '../src/cleanup/disk-lock';
import { stageIds, gatesPassed } from '../src/cleanup/audio/build-inputs';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const src = arg('db');
const out = arg('out');
const labelsFile = arg('labels');
const libraryFolder = arg('library-folder', 'japanese');
fs.mkdirSync(out, { recursive: true });
const dbFile = path.join(out, 'cleanup.db');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });

// 1. The working copy.
const t0 = Date.now();
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
migrateCleanup(db);
const from = new Database(src, { readonly: true, fileMustExist: true });
db.pragma('foreign_keys = OFF');
const tables = (
  db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
)
  .map((r) => r.name)
  .filter(
    (t) =>
      (/^audio_/.test(t) && !/^audio_build_/.test(t) && t !== 'audio_fetch_waiters') ||
      /^ai_/.test(t) ||
      t === 'settings',
  );
for (const t of tables) {
  const have = new Set(
    (from.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name),
  );
  if (have.size === 0) continue;
  const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[])
    .map((c) => c.name)
    .filter((c) => have.has(c));
  const list = cols.map((c) => `"${c}"`).join(', ');
  db.prepare(`DELETE FROM "${t}"`).run();
  const ins = db.prepare(
    `INSERT OR REPLACE INTO "${t}" (${list}) VALUES (${cols.map(() => '?').join(', ')})`,
  );
  const it = from.prepare(`SELECT ${list} FROM "${t}"`).raw().iterate() as Iterable<unknown[]>;
  let batch: unknown[][] = [];
  const flush = () => {
    const rows = batch;
    batch = [];
    db.transaction(() => {
      for (const r of rows) ins.run(...r);
    })();
  };
  for (const r of it) {
    batch.push(r);
    if (batch.length >= 5000) flush();
  }
  flush();
}
from.close();
// The copy predates stage 6: its row is added again (the copy's audio_stages replaced it).
db.prepare('INSERT OR IGNORE INTO audio_stages (stage, updated_at) VALUES (6, 0)').run();
db.pragma('foreign_keys = ON');
const fk = db.pragma('foreign_key_check') as unknown[];
db.pragma('wal_checkpoint(TRUNCATE)');
const copyMs = Date.now() - t0;

// 2. The real plan phase.
const log = (m: string) => console.log(m);
const runner = new AiRunner({
  db,
  secrets: { read: () => null } as unknown as SecretStore,
  log,
});
const labelsText = fs.readFileSync(labelsFile, 'utf8');
const stage5 = new AudioStage5({
  db,
  runner,
  readLabels: () => ({ text: labelsText, error: null }),
  log,
});
const stage6 = new AudioStage6({
  db,
  roots: {
    torrents: '/nonexistent/torrents',
    library: `/nonexistent/${libraryFolder}`,
    media: null,
  },
  lock: new DiskLock(),
  stage5,
  readerWritten: () => [],
  log,
});
// Stage 5 decided with older rules than this code's (e.g. a rules change not yet deployed): decided
// again from the stored answers first (no provider, no key, no request), as the server would.
const p5 = stage5.progress()!;
const rulesBefore = p5.rulesKey;
let redecided = false;
if (p5.rulesKey !== stage5RulesKey(db)) {
  console.log(
    `stage 5 rules key ${p5.rulesKey} is not this code's ${stage5RulesKey(db)}: deciding again`,
  );
  stage5.redecide();
  for (let i = 0; i < 100000; i++) {
    const r = await stage5.step(() => false, p5.stage4Id!);
    if (r === 'done') break;
  }
  redecided = true;
}
const { ids, problem } = stageIds(db);
if (!ids) throw new Error(`Stages 1-5 not usable: ${problem}`);
let longestLag = 0;
let last = performance.now();
const lagTimer = setInterval(() => {
  const now = performance.now();
  longestLag = Math.max(longestLag, now - last - 10);
  last = now;
}, 10);
const t1 = Date.now();
let p = stage6.restart();
await stage6.plan(p, ids);
const planMs = Date.now() - t1;
clearInterval(lagTimer);
p = stage6.progress()!;

// 3. The labeled books, the sample, the move list.
const labels = stage6.labelCheck();
const sample = stage6.list('sample', { limit: 30 }).items;
const collisions = stage6.list('collisions', { limit: 500 });
const pending = stage6.list('pending', { limit: 50 });
const unplaced = stage6.list('unplaced_pdfs', { limit: 1000 });
const moveCounts = db
  .prepare(
    `SELECT outcome, COUNT(*) AS n FROM audio_build_moves WHERE analysis_id = ? GROUP BY outcome`,
  )
  .all(p.analysisId);
const unaccounted = stage6.list('moves:unaccounted', { limit: 100 });
fs.writeFileSync(path.join(out, 'moves.csv'), stage6.movesCsv());
fs.writeFileSync(path.join(out, 'plan.csv'), stage6.planCsv());

// 4. EXPLAIN of every polled query (the claim, the report, the status, the lists).
const a = p.analysisId;
const queries: [string, string, unknown[]][] = [
  ['stage row', 'SELECT * FROM audio_stages WHERE stage = ?', [6]],
  ['sidecar status', 'SELECT * FROM link_sidecar_status WHERE id = 1', []],
  [
    'expire leases',
    `SELECT id FROM audio_build_batches WHERE analysis_id = ? AND state = 'claimed' AND lease_until < ?`,
    [a, Date.now()],
  ],
  [
    'in flight',
    `SELECT 1 FROM audio_build_batches WHERE analysis_id = ? AND state = 'claimed' AND lease_until >= ? LIMIT 1`,
    [a, Date.now()],
  ],
  [
    'claim preflight',
    `SELECT * FROM audio_build_ops INDEXED BY audio_build_ops_preflight WHERE analysis_id = ? AND preflight IS NULL AND kind IN ('link', 'pdf') ORDER BY id LIMIT 500`,
    [a],
  ],
  [
    'claim build',
    `SELECT * FROM audio_build_ops WHERE analysis_id = ? AND state = 'planned' ORDER BY id LIMIT 50`,
    [a],
  ],
  [
    'preflight counts',
    `SELECT preflight, COUNT(*) AS n FROM audio_build_ops WHERE analysis_id = ? AND kind IN ('link', 'pdf') GROUP BY preflight`,
    [a],
  ],
  [
    'build counts',
    `SELECT state, COUNT(*) AS n FROM audio_build_ops WHERE analysis_id = ? GROUP BY state`,
    [a],
  ],
  ['metadata of a book', 'SELECT metadata FROM audio_build_books WHERE id = ?', [1]],
  [
    'sample list',
    `SELECT * FROM audio_build_books WHERE analysis_id = ? AND sample = 1 ORDER BY id LIMIT 50 OFFSET 0`,
    [a],
  ],
  [
    'book files',
    `SELECT kind, dst, src_rel FROM audio_build_ops INDEXED BY audio_build_ops_book WHERE book_id = ? AND kind IN ('link', 'pdf') ORDER BY id`,
    [1],
  ],
  [
    'moves page',
    `SELECT file_id, old_path, outcome FROM audio_build_moves INDEXED BY audio_build_moves_outcome WHERE analysis_id = ? AND outcome = ? ORDER BY outcome, file_id LIMIT 50 OFFSET 0`,
    [a, 'dropped'],
  ],
  [
    'moves counts',
    `SELECT outcome, COUNT(*) AS n FROM audio_build_moves WHERE analysis_id = ? GROUP BY outcome`,
    [a],
  ],
];
const explain: string[] = [];
for (const [name, sql, args] of queries) {
  const plan = (db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args) as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ');
  const st = db.prepare(sql);
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) st.all(...args);
  const ms = Number(process.hrtime.bigint() - t) / 20 / 1e6;
  explain.push(`${name}: ${ms.toFixed(3)} ms -- ${plan}`);
}

const report = {
  copyMs,
  foreignKeyProblems: fk.length,
  stage5: {
    rulesBefore,
    rulesNow: stage5.progress()!.rulesKey,
    redecided,
    gate: stage5.progress()!.gate?.passed,
  },
  ids,
  gates: gatesPassed(db),
  planMs,
  planLongestSyncMs: p.planLongestMs,
  longestEventLoopLagMs: Math.round(longestLag),
  counts: p.counts,
  archives: p.archives,
  libraryOther: p.libraryOther,
  moveCounts,
  unaccounted: unaccounted.items,
  labels,
  collisions: collisions.total,
  pending: pending.items.map((b) => ({ folder: b.folder, files: b.files })),
  unplacedPdfs: unplaced.items,
  explain,
};
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(out, 'sample.json'), JSON.stringify(sample, null, 2));
fs.writeFileSync(path.join(out, 'collisions.json'), JSON.stringify(collisions.items, null, 2));
console.log(
  JSON.stringify(
    {
      ...report,
      unplacedPdfs: report.unplacedPdfs.length,
      labels: { ...labels, valuesWrong: labels.valuesWrong.length },
    },
    null,
    2,
  ),
);
db.close();
