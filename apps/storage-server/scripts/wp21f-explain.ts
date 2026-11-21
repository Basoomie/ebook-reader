/**
 * WP21f-1 stop 1: EXPLAIN of every query stage 7's page polls, on a live-size copy (the
 * whole-library diff's working copy: the live audio and AI tables) with stage 7's tables filled
 * as a year of daily runs would leave them (a first run with every recording listed, then 364
 * small runs; the 93 archives and their 722 entries; reviews). The SQL is the one the code runs:
 * every statement prepared while the polled entry points run is recorded with its arguments
 * (status(), each list, the notifications watcher's query), then explained and timed.
 *
 *   npx ts-node --transpile-only scripts/wp21f-explain.ts --work <live-size copy.db> --out <report.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { DiskLock } from '../src/cleanup/disk-lock';
import { AudioStage7 } from '../src/cleanup/audio/stage7-arrivals';
import { getAudioStage, updateAudioStage } from '../src/cleanup/audio/audio-stages';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const LISTS = [
  'new',
  'waiting',
  'held',
  'identical',
  'duplicate',
  'better',
  'removed',
  'plan',
  'archives',
  'review',
  'review:archive',
  'runs',
];

function fill(db: Database.Database): void {
  const units = (
    db
      .prepare(
        `SELECT unit_key, name FROM audio_online_units WHERE analysis_id = ? ORDER BY unit_key`,
      )
      .all((getAudioStage(db, 4).progress as { analysisId: string }).analysisId) as {
      unit_key: string;
      name: string;
    }[]
  ).slice(0);
  const outcomes = ['new', 'identical', 'duplicate', 'better', 'waiting', 'held', 'removed'];
  const now = Date.now();
  db.transaction(() => {
    const run = db.prepare(
      `INSERT INTO audio_arrival_runs (id, trigger, mode, state, phase, started_at, finished_at, progress_json, report_json)
       VALUES (?, 'schedule', 'on', 'done', 'done', ?, ?, '{}', '{"books":3}')`,
    );
    const arr = db.prepare(
      `INSERT INTO audio_arrivals (run_id, unit_key, name, outcome, reason, design, detail_json)
       VALUES (?, ?, ?, ?, NULL, 'J', '{"arrivals":[],"link":[],"linked":[]}')`,
    );
    const book = db.prepare(
      `INSERT INTO audio_arrival_books (run_id, unit_key, copy_key, area, state, folder, base_folder, author, series,
         title, notes_json, files, pdfs, metadata, design)
       VALUES (?, ?, ?, 'main', 'built', ?, ?, 'a', NULL, 't', '{}', 1, 0, x'7b7d', 'J')`,
    );
    const op = db.prepare(
      `INSERT INTO audio_arrival_ops (run_id, book_id, kind, dst, book_folder, state, dev, ino)
       VALUES (?, ?, ?, ?, ?, 'done', 1, ?)`,
    );
    let ino = 1;
    for (let r = 1; r <= 365; r++) {
      run.run(r, now - (366 - r) * 86_400_000, now - (366 - r) * 86_400_000 + 3_600_000);
      const n = r === 1 ? units.length : 20;
      for (let i = 0; i < n; i++) {
        const u = units[(r * 97 + i) % units.length];
        arr.run(r, u.unit_key, u.name, outcomes[i % outcomes.length]);
      }
      for (let i = 0; i < (r === 1 ? 300 : 10); i++) {
        const folder = `japanese/作者${r}/本${i}`;
        const id = Number(
          book.run(r, `u:${r}:${i}`, `c:${r}:${i}`, folder, folder).lastInsertRowid,
        );
        op.run(r, id, 'folder', folder, folder, ino++);
        op.run(r, id, 'link', `${folder}/x.m4b`, folder, ino++);
        op.run(r, id, 'metadata', `${folder}/metadata.json`, folder, ino++);
      }
    }
    const arch = db.prepare(
      `INSERT INTO audio_archives (rel, raw, size, mtime_ms, dev, ino, state, updated_at) VALUES (?, NULL, 1, 1, 1, ?, ?, 1)`,
    );
    const ent = db.prepare(
      `INSERT INTO audio_archive_entries (archive_id, seq, name, kind, size, state) VALUES (?, ?, ?, 'file', 1, 'done')`,
    );
    for (let a = 0; a < 93; a++) {
      const id = Number(
        arch.run(`x/${a}.zip`, 10_000 + a, a < 90 ? 'extracted' : 'no_audio').lastInsertRowid,
      );
      for (let e = 0; e < 8; e++) ent.run(id, e, `本/${e}.mp3`);
    }
    const rev = db.prepare(
      `INSERT INTO audio_arrival_reviews (review_key, kind, unit_key, title, detail_json, first_run_id, last_run_id, resolved_at)
       VALUES (?, ?, NULL, 't', '{}', ?, ?, ?)`,
    );
    for (let i = 0; i < 500; i++)
      rev.run(
        `k${i}`,
        ['better_copy', 'archive', 'held', 'abs_missing'][i % 4],
        1 + (i % 365),
        1 + (i % 365),
        i % 3 ? now : null,
      );
  })();
  const p = getAudioStage(db, 7).progress as Record<string, unknown>;
  updateAudioStage(db, 7, { progress: { ...p, lastRun: 365 } });
}

function main() {
  const db = new Database(arg('work')!);
  const cols = db.prepare('PRAGMA table_info(audio_archive_entries)').all() as { name: string }[];
  if (!cols.length) throw new Error('not a v17 cleanup.db');
  if (!(db.prepare('SELECT COUNT(*) AS n FROM audio_arrival_runs').get() as { n: number }).n)
    fill(db);
  const seen = new Map<string, unknown[]>();
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = prepare(sql);
    const wrap =
      (fn: (...a: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        if (!seen.has(sql)) seen.set(sql, args);
        return fn.apply(stmt, args);
      };
    return new Proxy(stmt, {
      get(target, key) {
        const v = Reflect.get(target, key);
        if (key === 'all' || key === 'get' || key === 'iterate' || key === 'raw' || key === 'pluck')
          return typeof v === 'function' ? wrap(v as (...a: unknown[]) => unknown) : v;
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
  const stage = new AudioStage7({
    db,
    roots: { torrents: '/none', library: '/none', media: null },
    lock: new DiskLock(),
    reanalyse: () => undefined,
    abs: () => null,
  });
  const t0 = Date.now();
  stage.status();
  for (const l of LISTS) stage.list(l);
  stage.list('new', { offset: 4000 });
  // The notifications watcher (every minute).
  db.prepare(
    `SELECT id, mode, report_json FROM audio_arrival_runs WHERE state = 'done' AND id > ? ORDER BY id`,
  ).all(300);
  const firstPass = Date.now() - t0;
  (db as unknown as { prepare: typeof prepare }).prepare = prepare;
  const out: { sql: string; plan: string; ms: number; scan: boolean }[] = [];
  for (const [sql, args] of seen) {
    if (!/^\s*(SELECT|WITH)/i.test(sql)) continue;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
    const s = prepare(sql);
    const t = process.hrtime.bigint();
    for (let i = 0; i < 5; i++) s.all(...args);
    const ms = Number(process.hrtime.bigint() - t) / 5e6;
    const scan =
      /SCAN (audio_arrival|audio_archive|audio_arrivals|ai_values|ai_items|audio_online)/.test(
        plan,
      ) && !/USING (COVERING )?INDEX/.test(plan.split('|').find((x) => /SCAN/.test(x)) ?? '');
    out.push({ sql: sql.replace(/\s+/g, ' ').trim(), plan, ms: Math.round(ms * 100) / 100, scan });
  }
  out.sort((a, b) => b.ms - a.ms);
  const sizes = Object.fromEntries(
    [
      'audio_arrivals',
      'audio_arrival_runs',
      'audio_arrival_books',
      'audio_arrival_ops',
      'audio_arrival_reviews',
      'audio_archives',
      'audio_archive_entries',
      'ai_values',
      'ai_items',
      'audio_online_units',
    ].map((t) => [t, (prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );
  fs.writeFileSync(
    arg('out')!,
    JSON.stringify({ sizes, firstPassMs: firstPass, queries: out }, null, 1),
  );
  console.log(JSON.stringify(sizes));
  console.log(
    `status + ${LISTS.length + 1} lists + watcher: ${firstPass} ms the first time (incl. the upgrade estimate)`,
  );
  for (const q of out)
    console.log(
      `${q.ms.toFixed(2)} ms${q.scan ? '  SCAN' : ''}  ${q.sql.slice(0, 110)}\n    ${q.plan.slice(0, 200)}`,
    );
}

main();
