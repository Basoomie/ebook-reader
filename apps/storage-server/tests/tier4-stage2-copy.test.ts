/**
 * Tier 4, part 1: the copy-run tool's own logic (scripts/tier4-stage2-copy.ts): the NAS file
 * listing read exactly as Node's stat would give it, the 94 books, and who last wrote a field's
 * value in Calibre (the guard the report measures).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { CLEANUP_MIGRATIONS } from '../src/cleanup/cleanup-db';
import { lastWriter, mtimeToMs, readListing, UNWRITTEN_94 } from '../scripts/tier4-stage2-copy';
import { makeTempDir } from './helpers/spawn-server';

describe('tier 4 copy run', () => {
  it("reads find's %T@ to the millisecond Node's stat floors to", () => {
    expect(mtimeToMs('1731234567.123456789')).toBe(1731234567123);
    expect(mtimeToMs('1731234567.9999999999')).toBe(1731234567999);
    expect(mtimeToMs('1731234567')).toBe(1731234567000);
    expect(mtimeToMs('1731234567.5')).toBe(1731234567500);
  });

  it('reads the listing (size, mtime, path with tabs and Japanese names)', () => {
    const file = path.join(makeTempDir('listing'), 'files.tsv');
    fs.writeFileSync(
      file,
      '123\t1731234567.123456789\t絢乃/異世界 (33008)/本 - 絢乃.epub\n' +
        '45\t1731234568.000000000\t絢乃/異世界 (33008)/cover.jpg\r\nbad line\n',
    );
    const m = readListing(file);
    expect(m.get('絢乃/異世界 (33008)/本 - 絢乃.epub')).toEqual({
      size: 123,
      mtimeMs: 1731234567123,
    });
    expect(m.get('絢乃/異世界 (33008)/cover.jpg')).toEqual({ size: 45, mtimeMs: 1731234568000 });
    expect(m.size).toBe(2);
  });

  it('names the 94 unwritten books of maintenance-todo, each once', () => {
    expect(UNWRITTEN_94).toHaveLength(94);
    expect(new Set(UNWRITTEN_94.map((b) => b.id)).size).toBe(94);
    expect(UNWRITTEN_94.find((b) => b.id === 29728)?.why).toContain('authors');
  });

  it("finds who last wrote a field's value: stage 4, stage 5, your edit, or nobody", () => {
    const db = new Database(':memory:');
    for (const m of CLEANUP_MIGRATIONS) db.exec(m.sql);
    const put = db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
         source, evidence_json, class, state, analysis_id, created_at, updated_at)
       VALUES (?, 'L', 1, ?, ?, '[]', ?, ?, '{}', 'auto', ?, ?, ?, ?)`,
    );
    put.run(2, 'u1', 'authors', '["A and B"]', 'file', 'skipped', 'a2', 10, 10);
    put.run(4, 'u1', 'authors', '["A"]', 'rules', 'applied', 'a4', 20, 20);
    put.run(2, 'u2', 'title', '"T2"', 'file', 'applied', 'a2', 10, 10);
    put.run(4, 'u2', 'title', '"T4"', 'store', 'applied', 'a4', 30, 30);
    put.run(5, 'u3', 'tags', '{"add":["x"]}', 'ai', 'applied', 'a5', 40, 40);
    put.run(2, 'u5', 'title', '"Short…"', 'title-fit', 'applied', 'a2', 50, 50);
    db.prepare(
      `INSERT INTO user_fields (library_id, calibre_uuid, field, value_json, source, since)
       VALUES ('L', 'u4', 'author_sort', '"S"', 'edit', 1)`,
    ).run();
    expect(lastWriter(db, 'L', 'u1', 'authors')).toMatchObject({ writer: 'stage 4', value: ['A'] });
    expect(lastWriter(db, 'L', 'u2', 'title')).toMatchObject({ writer: 'stage 4', value: 'T4' });
    expect(lastWriter(db, 'L', 'u3', 'tags')).toMatchObject({ writer: 'stage 5' });
    expect(lastWriter(db, 'L', 'u4', 'authors')).toMatchObject({
      writer: 'your edit',
      yours: 'edit',
    });
    expect(lastWriter(db, 'L', 'u5', 'title')).toMatchObject({ writer: 'title fit' });
    expect(lastWriter(db, 'L', 'u9', 'title')).toMatchObject({ writer: 'none', value: null });
  });
});
