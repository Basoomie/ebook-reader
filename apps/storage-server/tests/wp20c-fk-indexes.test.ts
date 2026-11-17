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

  // 2026-11-17: the page's status poll read every row of both big tables every 5 s and blocked
  // the server ~3 s of every 8 on the NAS. Its queries (as in cleanup-service.ts and batches.ts)
  // are answered from indexes, without reading the wide rows.
  it("the page status's counts and paces read indexes only", () => {
    const db = new Database(':memory:');
    migrateCleanup(db);
    const cur = "(state IN ('queued', 'applied', 'undone', 'kept') OR analysis_id = ?)";
    const queries: [string, RegExp][] = [
      [
        `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE stage = 3 AND library_id = ?
         AND ${cur} GROUP BY state`,
        /COVERING INDEX proposed_changes_counts/,
      ],
      [
        `SELECT field, class, state, COUNT(*) AS n FROM proposed_changes WHERE stage = 2 AND library_id = ?
         AND (${cur} OR decided_by IS NOT NULL) GROUP BY field, class, state`,
        /COVERING INDEX proposed_changes_counts/,
      ],
      [
        `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 3 AND library_id = ?
         AND state = 'proposed' AND class = 'auto' AND analysis_id = ?`,
        /COVERING INDEX proposed_changes_counts/,
      ],
      [
        `SELECT COUNT(*) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id
         WHERE b.kind = 'apply' AND b.stage = 3 AND i.state = 'removed' AND i.updated_at >= ?`,
        /INDEX batch_items_done/,
      ],
      [
        `SELECT COUNT(DISTINCT c.calibre_id) AS n, MIN(i.updated_at) AS first FROM batch_items i
         JOIN batches b ON b.id = i.batch_id JOIN proposed_changes c ON c.id = i.change_id
         WHERE b.kind = 'apply' AND b.stage = 2 AND i.state = 'written' AND i.updated_at >= ?`,
        /INDEX batch_items_done/,
      ],
      [
        'SELECT state, COUNT(*) AS n FROM batch_items WHERE batch_id = ? GROUP BY state',
        /COVERING INDEX batch_items_batch_state/,
      ],
    ];
    for (const [sql, index] of queries) {
      const args = Array((sql.match(/\?/g) ?? []).length).fill('x');
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
      expect(plan, sql).toMatch(index);
      expect(plan, sql).not.toMatch(/SCAN (proposed_changes|batch_items|i|c)\b/);
    }
  });
});
