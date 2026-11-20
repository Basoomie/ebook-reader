/**
 * WP21e-2 stop 1: the reader's link remap as a dry run on copies of the live databases.
 * Nothing is written anywhere but --out (the copies are opened read-only; ttsu.db is worked on
 * in memory, migrated to this code's schema first).
 *
 *   npx vite-node scripts/wp21e2-remap.ts -- --ttsu <copy of ttsu.db> --cleanup <copy of
 *     cleanup.db with stage 6's build> --out <dir> [--library-folder japanese]
 *
 * Runs the switch's own remap (switch-remap.ts, fed by the same queries the switch uses) and
 * reports every link it would change, the counts per outcome, the links it can't map, whether
 * each new path is one the build made, what each link resolves to now, and EXPLAIN + timing of
 * the switch's polled queries.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { migrate } from '../src/db/migrations';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { resolveLink, type AudioLink } from '../src/audio/audio-links';
import { readerBusy } from '../src/cleanup/audio/switch-reader';
import {
  afterRenames,
  remapCounts,
  remapLinks,
  type SwitchLink,
  type SwitchMove,
} from '../src/cleanup/audio/switch-remap';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`--${name} is required`);
}

const out = arg('out');
const libraryFolder = arg('library-folder', 'japanese');
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now();

// ttsu.db: in memory, migrated (proves migration 27 on the live data too).
const ttsuSrc = new Database(arg('ttsu'), { readonly: true, fileMustExist: true });
const versionBefore = ttsuSrc.pragma('user_version', { simple: true }) as number;
const image = ttsuSrc.serialize();
// A WAL database's header says so (bytes 18-19 = 2); an in-memory image must be a plain one.
image[18] = 1;
image[19] = 1;
const ttsu = new Database(image);
ttsuSrc.close();
const tm = Date.now();
const versionAfter = migrate(ttsu);
const migrateMs = Date.now() - tm;
const cleanup = new Database(arg('cleanup'), { readonly: true, fileMustExist: true });

const analysis = (
  cleanup
    .prepare(
      `SELECT analysis_id FROM audio_build_moves GROUP BY analysis_id ORDER BY COUNT(*) DESC LIMIT 1`,
    )
    .get() as { analysis_id: string } | undefined
)?.analysis_id;
if (!analysis) throw new Error('The cleanup copy has no move list (stage 6 has not planned)');

const tq = Date.now();
const moves = cleanup
  .prepare(
    `SELECT old_path AS oldPath, outcome, new_path AS newPath, kept_path AS keptPath
     FROM audio_build_moves WHERE analysis_id = ?`,
  )
  .all(analysis) as SwitchMove[];
const plannedFiles = new Map<string, string[]>();
const plannedSet = new Set<string>();
for (const o of cleanup
  .prepare(`SELECT dst FROM audio_build_ops WHERE analysis_id = ? AND kind = 'link'`)
  .all(analysis) as { dst: string }[]) {
  const d = o.dst.slice(0, o.dst.lastIndexOf('/'));
  plannedFiles.set(d, [...(plannedFiles.get(d) ?? []), o.dst]);
  plannedSet.add(afterRenames(o.dst));
}
for (const m of moves)
  if (m.outcome === 'library_only_pending' && m.newPath) {
    const d = m.newPath.slice(0, m.newPath.lastIndexOf('/'));
    plannedFiles.set(d, [...(plannedFiles.get(d) ?? []), m.newPath]);
    plannedSet.add(afterRenames(m.newPath));
  }
const plannedFolders = new Set([...plannedFiles.keys()].map(afterRenames));
const links = ttsu
  .prepare(
    `SELECT user_id AS userId, book_id AS bookId, state, folder_rel_path AS folderRelPath,
            file_name AS fileName, subtitle_rel_path AS subtitleRelPath,
            subtitle_state AS subtitleState, source, confirmed_at AS confirmedAt
     FROM audio_links ORDER BY user_id, book_id`,
  )
  .all() as (SwitchLink & AudioLink)[];
const loadMs = Date.now() - tq;
const tr = Date.now();
const results = remapLinks(links, moves, { libraryFolder, plannedFiles });
const remapMs = Date.now() - tr;
const counts = remapCounts(results);

const title = ttsu.prepare('SELECT title FROM books WHERE id = ?');
const rows = results.map((r) => {
  const link = links.find((l) => l.userId === r.userId && l.bookId === r.bookId)!;
  const before = resolveLink(ttsu, link);
  const after =
    r.newFolder === null
      ? null
      : r.newFile !== null
        ? plannedSet.has(`${r.newFolder}/${r.newFile}`)
        : plannedFolders.has(r.newFolder);
  return {
    book: (title.get(r.bookId) as { title: string } | undefined)?.title ?? r.bookId,
    bookId: r.bookId,
    outcome: r.outcome,
    changed: r.changed,
    oldFolder: r.oldFolder,
    oldFile: r.oldFile,
    newFolder: r.newFolder,
    newFile: r.newFile,
    statusBefore: before.status,
    playableBefore: before.playable,
    newPathBuilt: r.outcome === 'outside' ? null : after,
    subtitle: link.subtitleRelPath,
    detail: r.detail,
  };
});

// EXPLAIN of the switch's polled and claimed queries (a fresh v15 schema: index use depends
// on the schema; the big existing tables on the copy itself).
const schema = new Database(':memory:');
migrateCleanup(schema);
const explain = (db: Database.Database, sql: string, ...params: unknown[]) => {
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map((x) => x.detail)
    .join(' | ');
  const t = process.hrtime.bigint();
  const st = db.prepare(sql);
  if (st.reader) st.all(...params);
  else st.run(...params);
  return {
    sql: sql.replace(/\s+/g, ' ').trim(),
    plan,
    ms: Number(process.hrtime.bigint() - t) / 1e6,
  };
};
const explains = [
  explain(
    schema,
    `SELECT state, progress_json, pause_reason, pause_detail FROM audio_switch WHERE id = 1`,
  ),
  explain(
    schema,
    `SELECT * FROM audio_switch_ops WHERE run_id = ? AND phase = ? AND state = 'planned' ORDER BY seq LIMIT ?`,
    'r',
    'delete',
    200,
  ),
  explain(
    schema,
    `SELECT state, COUNT(*) AS n FROM audio_switch_ops WHERE run_id = ? AND phase = ? GROUP BY state`,
    'r',
    'delete',
  ),
  explain(
    schema,
    `SELECT id FROM audio_switch_batches WHERE run_id = ? AND state = 'claimed' AND lease_until < ?`,
    'r',
    0,
  ),
  explain(
    schema,
    `SELECT 1 FROM audio_switch_batches WHERE run_id = ? AND state = 'claimed' AND lease_until >= ? LIMIT 1`,
    'r',
    0,
  ),
  explain(
    schema,
    `SELECT 1 FROM audio_switch_ops WHERE run_id = ? AND phase = ? LIMIT 1`,
    'r',
    'delete',
  ),
  explain(
    schema,
    `UPDATE audio_switch_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
    1,
  ),
  explain(
    schema,
    `SELECT * FROM audio_switch_links WHERE run_id = ? ORDER BY outcome, book_id LIMIT ? OFFSET ?`,
    'r',
    100,
    0,
  ),
  explain(schema, `SELECT COUNT(*) AS n FROM audio_switch_links WHERE run_id = ?`, 'r'),
  explain(
    schema,
    `SELECT * FROM audio_switch_files WHERE run_id = ? AND state = 'planned' ORDER BY lib_rel LIMIT 1`,
    'r',
  ),
  explain(
    schema,
    `SELECT state, COUNT(*) AS n FROM audio_switch_files WHERE run_id = ? GROUP BY state`,
    'r',
  ),
  explain(
    cleanup,
    `SELECT outcome, COUNT(*) AS n FROM audio_build_moves WHERE analysis_id = ? GROUP BY outcome`,
    analysis,
  ),
  explain(ttsu, `SELECT kind, reason, since FROM audio_hold WHERE kind = ?`, 'switch'),
  ...[
    `SELECT COUNT(*) AS n FROM audio_merge_jobs WHERE state IN ('queued', 'running', 'saving')`,
    `SELECT COUNT(*) AS n FROM worker_jobs WHERE state = 'running'`,
    `SELECT COUNT(*) AS n FROM worker_jobs WHERE state = 'queued' AND kind = 'sync_subtitles'`,
    `SELECT COUNT(*) AS n FROM audio_writes WHERE state IN ('reserving', 'writing', 'published')`,
  ].map((q) => explain(ttsu, q)),
];
const scans = explains.filter((e) => /SCAN (audio_switch|audio_build|audio_files)/.test(e.plan));

const q = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = Object.keys(rows[0] ?? { book: '' });
fs.writeFileSync(
  path.join(out, 'remap.csv'),
  String.fromCharCode(0xfeff) +
    [
      header.join(','),
      ...rows.map((r) => header.map((h) => q((r as Record<string, unknown>)[h])).join(',')),
    ].join('\r\n') +
    '\r\n',
);
const report = {
  at: new Date().toISOString(),
  ttsuSchema: { before: versionBefore, after: versionAfter, migrateMs },
  analysis,
  moves: moves.reduce<Record<string, number>>(
    (c, m) => ((c[m.outcome] = (c[m.outcome] ?? 0) + 1), c),
    {},
  ),
  links: links.length,
  counts,
  listed: rows.filter((r) => r.outcome === 'listed'),
  notBuilt: rows.filter((r) => r.newPathBuilt === false),
  notResolvingBefore: rows.filter((r) => r.statusBefore !== 'ok' && r.outcome !== 'outside'),
  offlineCopiesToRedownload: rows.filter((r) => r.changed && r.playableBefore).length,
  readerBusyNow: readerBusy(ttsu),
  timing: { loadMs, remapMs, totalMs: Date.now() - t0 },
  explain: explains,
  fullScans: scans,
  rows,
};
fs.writeFileSync(path.join(out, 'remap-report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      ...report,
      rows: undefined,
      explain: `${explains.length} queries, ${scans.length} full scans`,
    },
    null,
    2,
  ),
);
