/**
 * WP21f-1 stop-1 tools: a clean working copy of a copy of the live cleanup.db (shared by the
 * replay test and the whole-library diff).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { migrateCleanup } from '../src/cleanup/cleanup-db';

/**
 * A fresh cleanup.db at this schema, filled from the copy's audio, settings and secrets tables and
 * the audiobook stage's AI rows (stage 'audio5': the stored answers are reused; Calibre's rows
 * stay out, so the spending limit here counts the audiobook AI only).
 */
export function workingCopy(src: string, out: string): Database.Database {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  for (const x of [out, out + '-wal', out + '-shm']) fs.rmSync(x, { force: true });
  const db = new Database(out);
  db.pragma('journal_mode = WAL');
  migrateCleanup(db);
  const from = new Database(src, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = OFF');
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter(
      (n) =>
        (/^audio_/.test(n) && n !== 'audio_fetch_waiters') ||
        [
          'settings',
          'secrets',
          'ai_items',
          'ai_requests',
          'ai_batches',
          'ai_values',
          'ai_model_checks',
        ].includes(n),
    );
  for (const name of tables) {
    const has = from
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name);
    if (!has) continue;
    const cols = (from.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    const mine = new Set(
      (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => c.name),
    );
    const use = cols.filter((c) => mine.has(c));
    if (!use.length) continue;
    const list = use.map((c) => `"${c}"`).join(', ');
    const where = use.includes('stage') && name.startsWith('ai_') ? ` WHERE stage = 'audio5'` : '';
    const put = db.prepare(
      `INSERT OR REPLACE INTO "${name}" (${list}) VALUES (${use.map(() => '?').join(', ')})`,
    );
    db.prepare(`DELETE FROM "${name}"`).run();
    let rows: unknown[][] = [];
    let n = 0;
    const flush = db.transaction((rs: unknown[][]) => {
      for (const r of rs) put.run(...r);
    });
    for (const r of from
      .prepare(`SELECT ${list} FROM "${name}"${where}`)
      .raw()
      .iterate() as Iterable<unknown[]>) {
      rows.push(r);
      n++;
      if (rows.length >= 5000) {
        flush(rows);
        rows = [];
      }
    }
    flush(rows);
    console.log(`  ${name}: ${n} rows`);
  }
  from.close();
  // Stage rows the copy's schema adds (its audio_stages replaced the migrations' rows).
  for (const n of [5, 6, 7])
    db.prepare('INSERT OR IGNORE INTO audio_stages (stage, updated_at) VALUES (?, 0)').run(n);
  db.pragma('foreign_keys = ON');
  const orphans = db.pragma('foreign_key_check') as unknown[];
  if (orphans.length) throw new Error(`${orphans.length} rows without their parent`);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db;
}
