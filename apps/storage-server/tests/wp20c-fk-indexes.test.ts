import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrateCleanup } from '../src/cleanup/cleanup-db';

describe('cleanup.db: deleting proposals is checked by index (2026-11-17)', () => {
  it('every table pointing at proposed_changes has an index on change_id, and the delete uses them', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateCleanup(db);
    for (const t of ['batch_items', 'undo_records', 'field_undo']) {
      const idx = db
        .prepare(`SELECT name FROM pragma_index_list(?)`)
        .all(t)
        .map((r) => (r as { name: string }).name);
      const onChange = idx.some((name) =>
        (db.prepare('SELECT name FROM pragma_index_info(?)').all(name) as { name: string }[])
          .map((c) => c.name)
          .join(',')
          .startsWith('change_id'),
      );
      expect(onChange, t).toBe(true);
    }
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN DELETE FROM proposed_changes WHERE stage = 3 AND library_id = ?
             AND state IN ('proposed', 'skipped') AND id NOT IN (SELECT change_id FROM batch_items)`,
        )
        .all('lib') as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan.filter((d) => /^SCAN (batch_items|field_undo|undo_records)/.test(d))).toEqual([]);
  });
});
