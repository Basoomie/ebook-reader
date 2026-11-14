/**
 * WP20b: the stage-2 measurement of 2026-11-14 (measure_stage2.py) reproduced with the
 * server's own rules on the 800 labeled books, and what stage 2 will apply on them.
 * Opt-in: needs the git-ignored reference folder (CLEANUP_REFERENCE_DIR, e.g.
 * docs/design/cleanup-reference in the main checkout).
 *
 * Also checks the cleanup.db migration to v3 keeps stage 1's batches (the NAS has 19).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { CLEANUP_MIGRATIONS, migrateCleanup } from '../src/cleanup/cleanup-db';
import { formatReproduction, reproduce } from '../scripts/measure-stage2';
import { pct } from '../src/cleanup/stage2-score';
import { makeTempDir } from './helpers/spawn-server';

const REF = process.env.CLEANUP_REFERENCE_DIR;

describe.skipIf(!REF)('the stage-2 measurement on the 800 labeled books', () => {
  it('reproduces measure_stage2.py exactly and passes the gate', () => {
    const r = reproduce(REF!);
    console.log(formatReproduction(r));
    const one = (k: string, f: 't' | 'ct' | 'aa' | 'a1') => {
      const c = r.python[k];
      const base = f === 't' || f === 'ct' ? c.tn : c.an;
      return Math.round(10 * pct(c[f], base)!) / 10;
    };
    // The numbers in library-cleanup-plan.md section 4.
    expect([
      r.python.unknown.n,
      one('unknown', 't'),
      one('unknown', 'ct'),
      one('unknown', 'aa'),
      one('unknown', 'a1'),
    ]).toEqual([394, 89.3, 12.2, 90.3, 97.2]);
    expect([
      r.python.processed.n,
      one('processed', 't'),
      one('processed', 'ct'),
      one('processed', 'aa'),
      one('processed', 'a1'),
    ]).toEqual([222, 96.4, 59.0, 57.7, 96.8]);
    expect([
      r.python.agree.n,
      one('agree', 't'),
      one('agree', 'ct'),
      one('agree', 'aa'),
      one('agree', 'a1'),
    ]).toEqual([181, 96.7, 96.7, 74.0, 96.1]);
    // What stage 2 applies: titles >= 85 % and >= 20 points above Calibre; authors >= 95 %.
    const t = r.stage2.title;
    for (const g of ['unknown', 'processed'] as const) {
      const applied = pct(t[g].applied, t[g].n)!;
      expect(applied).toBeGreaterThanOrEqual(85);
      expect(applied - pct(t[g].calibre, t[g].n)!).toBeGreaterThanOrEqual(20);
    }
    const a = r.stage2.authors;
    const n = a.unknown.n + a.processed.n + a.agree.n;
    const right = a.unknown.applied + a.processed.applied + a.agree.applied;
    expect(pct(right, n)!).toBeGreaterThanOrEqual(95);
    expect(r.asinMismatches).toEqual([]);
  });
});

describe('cleanup.db migration to v3', () => {
  it("keeps stage 1's batch items (state, quarantine folder) and adds the stage-2 tables", () => {
    const file = path.join(makeTempDir('cleanup-v2'), 'cleanup.db');
    const db = new Database(file);
    db.pragma('foreign_keys = ON');
    for (const m of CLEANUP_MIGRATIONS.filter((x) => x.version <= 2)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare(
      `INSERT INTO proposed_changes (id, stage, library_id, calibre_id, calibre_uuid, field, source, class, state, created_at, updated_at)
       VALUES (1, 1, 'lib', 5, 'u5', 'book', 'stage1:sha256', 'auto', 'applied', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO batches (id, stage, library_id, kind, state, item_count, created_at, updated_at) VALUES ('b1', 1, 'lib', 'apply', 'applied', 1, 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO batch_items (id, batch_id, change_id, position, state, quarantine_dir, export_sha256, updated_at)
       VALUES (7, 'b1', 1, 0, 'removed', '/quarantine/b1/5', 'abc', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO undo_records (batch_id, change_id, library_id, removed_calibre_id, removed_uuid, kept_calibre_id, kept_uuid, created_at)
       VALUES ('b1', 1, 'lib', 5, 'u5', 4, 'u4', 0)`,
    ).run();
    expect(migrateCleanup(db)).toBe(3);
    expect(
      db.prepare('SELECT id, state, quarantine_dir, export_sha256 FROM batch_items').all(),
    ).toEqual([
      { id: 7, state: 'removed', quarantine_dir: '/quarantine/b1/5', export_sha256: 'abc' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // 'written' is a valid item state now; the stage-2 tables exist.
    db.prepare(`UPDATE batch_items SET state = 'written' WHERE id = 7`).run();
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE name IN ('field_undo', 'stage_field_pauses')`,
        )
        .all(),
    ).toHaveLength(2);
    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });
});
