/**
 * WP21f-2: EXPLAIN QUERY PLAN and timing of every query the library changes poll, claim or run
 * once per book, on a live-size working copy (wp21f2-preview.ts's out/cleanup.db).
 *
 *   npx vite-node scripts/wp21f2-explain.ts -- --db <cleanup.db>
 */
import Database from 'better-sqlite3';
import { performance } from 'perf_hooks';

const i = process.argv.indexOf('--db');
const db = new Database(process.argv[i + 1], { readonly: true });
const queries: [string, string, unknown[]][] = [
  [
    'preflight left (polled)',
    `SELECT COUNT(*) AS n FROM audio_library_ops WHERE run_id = ? AND preflight IS NULL`,
    [1],
  ],
  [
    'apply counts (polled)',
    `SELECT state, COUNT(*) AS n FROM audio_library_ops WHERE run_id = ? GROUP BY state`,
    [1],
  ],
  [
    'in flight (polled)',
    `SELECT 1 FROM audio_library_batches WHERE state = 'claimed' AND lease_until >= ? LIMIT 1`,
    [0],
  ],
  [
    'expired leases (polled)',
    `SELECT id FROM audio_library_batches WHERE state = 'claimed' AND lease_until < ?`,
    [0],
  ],
  [
    'claim (polled)',
    `SELECT * FROM audio_library_ops WHERE run_id = ? AND state = 'planned' ORDER BY seq LIMIT ?`,
    [1, 50],
  ],
  [
    'claim preflight (polled)',
    `SELECT * FROM audio_library_ops WHERE run_id = ? AND preflight IS NULL ORDER BY seq LIMIT ?`,
    [1, 500],
  ],
  [
    'report (per op)',
    `UPDATE audio_library_ops SET state = state WHERE id = ? AND batch_id = ?`,
    [1, 1],
  ],
  [
    'list changes (page)',
    `SELECT id FROM audio_library_changes WHERE run_id = ? AND state <> 'skipped' ORDER BY folder_from LIMIT 50 OFFSET 0`,
    [1],
  ],
  [
    'list review (page)',
    `SELECT id FROM audio_library_changes WHERE run_id = ? AND reviews_json <> '[]' ORDER BY folder_from LIMIT 50`,
    [1],
  ],
  [
    'ledger sync: a build book’s links (per book)',
    `SELECT dst, src_file_id FROM audio_build_ops WHERE analysis_id = ? AND book_id = ? AND kind = 'link' ORDER BY id`,
    ['x', 1],
  ],
  [
    'ledger sync: an arrival book’s links (per book)',
    `SELECT dst, src_file_id FROM audio_arrival_ops WHERE run_id = ? AND book_folder = ? AND kind = 'link' ORDER BY id`,
    [1, 'x'],
  ],
  [
    'plan: a link’s inode (per file)',
    `SELECT ino FROM audio_files WHERE root = 'library' AND rel_path = ? AND gone_at IS NULL`,
    ['x'],
  ],
  ['plan: a file’s inode (per file)', `SELECT ino FROM audio_files WHERE id = ?`, [1]],
  ['plan: tags (per book read)', `SELECT tags_json FROM audio_file_health WHERE file_id = ?`, [1]],
  [
    'plan: choices (per book read)',
    `SELECT field, choice FROM audio_library_choices WHERE book_id = ?`,
    [1],
  ],
  [
    'ledger update: open ops (per change)',
    `SELECT COUNT(*) AS n FROM audio_library_ops WHERE change_id = ? AND state <> 'done'`,
    [1],
  ],
];
for (const [name, sql, args] of queries) {
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ');
  let ms = 0;
  if (!/^UPDATE/.test(sql)) {
    const st = db.prepare(sql);
    const t = performance.now();
    for (let k = 0; k < 20; k++) st.all(...args);
    ms = (performance.now() - t) / 20;
  }
  console.log(`${/SCAN/.test(plan) ? 'SCAN' : 'ok  '} ${name}: ${plan} (${ms.toFixed(3)} ms)`);
}
