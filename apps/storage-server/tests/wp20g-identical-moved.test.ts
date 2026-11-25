// WP20g run 7: the identical-copy check finds a library book whose folder Calibre renamed after
// file_facts kept its path (the row marked "changed"), and keeps a moved file's SHA-256.
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { libraryHashesOfSize, type PassDeps } from '../src/cleanup/arrivals/stage-passes';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { Pacer, type SnapshotBook } from '../src/cleanup/stage1';
import { makeTempDir } from './helpers/spawn-server';

function book(id: number, filePath: string): SnapshotBook {
  return {
    calibreId: id,
    uuid: `u-${id}`,
    title: `T${id}`,
    timestamp: null,
    lastModified: null,
    filePath,
    formats: ['EPUB'],
    tags: [],
  };
}

describe('the identical-copy check after Calibre renamed folders', () => {
  it('reads each book at its current folder, marked changed or not', async () => {
    const s = initCleanupDatabase(makeTempDir('ident-moved'));
    if (!s.ok) throw new Error(s.error);
    const lib = makeTempDir('ident-moved-lib');
    const bytes = Buffer.from('the same epub bytes');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const put = (rel: string) => {
      fs.mkdirSync(path.join(lib, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(lib, rel), bytes);
      return fs.statSync(path.join(lib, rel)).mtimeMs;
    };
    // Book 1: renamed folder, the row kept the old path and was marked changed (no hash).
    put('壱あらた/スキ (1)/スキ.epub');
    // Book 2: renamed folder, the row kept the old path with its hash (same size and mtime).
    const m2 = put('新/本 (2)/本.epub');
    const ins = s.db.prepare(
      `INSERT INTO file_facts (library_id, calibre_id, calibre_uuid, file_path, size, mtime_ms, sha256, stat_at, error)
       VALUES ('L', ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    ins.run(1, 'u-1', 'Yi arata/suki (1)/suki.epub', bytes.length, 1, null, 'changed');
    ins.run(2, 'u-2', 'old/hon (2)/hon.epub', bytes.length, m2, sha, null);
    const books = new Map([
      [1, book(1, '壱あらた/スキ (1)/スキ.epub')],
      [2, book(2, '新/本 (2)/本.epub')],
    ]);
    const deps: PassDeps = {
      cleanup: s.db,
      main: s.db,
      libraryId: 'L',
      libDir: lib,
      analysisId: 'arrivals:1',
    };
    const got = await libraryHashesOfSize(deps, books, bytes.length, new Pacer(0), () => false);
    expect(got.sort((a, b) => a.calibreId - b.calibreId)).toEqual([
      { calibreId: 1, sha256: sha },
      { calibreId: 2, sha256: sha },
    ]);
    const rows = s.db
      .prepare('SELECT calibre_id, file_path, error, sha256 FROM file_facts ORDER BY calibre_id')
      .all();
    expect(rows).toEqual([
      { calibre_id: 1, file_path: '壱あらた/スキ (1)/スキ.epub', error: null, sha256: sha },
      { calibre_id: 2, file_path: '新/本 (2)/本.epub', error: null, sha256: sha },
    ]);
  });
});
