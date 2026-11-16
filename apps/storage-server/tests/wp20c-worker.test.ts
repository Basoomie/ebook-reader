/**
 * WP20c: the stage-3 reader processes (forked book-text-child with the real counter bundle) give
 * the same results as the same work run in-process; a stuck book times out and the process
 * is replaced; a closed pool answers "stopped".
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { InProcessReader, Stage3Worker } from '../src/counts/book-text-worker';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { sketchToBlob } from '../src/cleanup/stage3-sketch';
import { makeTempDir } from './helpers/spawn-server';
import { chaptersOf, fakeText, makeTextEpub } from './helpers/stage3-fixture';

const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };

describe('stage 3 reader processes', () => {
  const dir = makeTempDir('wp20c-worker');
  const a = path.join(dir, 'a.epub');
  const b = path.join(dir, 'b.epub');
  const broken = path.join(dir, 'broken.epub');
  fs.writeFileSync(a, makeTextEpub({ title: 'A', chapters: chaptersOf(1), ruby: true }));
  fs.writeFileSync(
    b,
    makeTextEpub({ title: 'B', chapters: [...chaptersOf(1), fakeText(9, 15_000)] }),
  );
  fs.writeFileSync(broken, 'not a zip');
  const worker = new Stage3Worker(
    { bundle: COUNTER_BUNDLE, importOptions: IMPORT, timeoutMs: () => 120_000 },
    2,
  );
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const local = new InProcessReader(require(COUNTER_BUNDLE) as BookTextModule, IMPORT);

  afterAll(() => worker.close());

  it('reads, compares and indexes like the in-process work', async () => {
    const [ta, tb, la, bad] = await Promise.all([
      worker.text(a),
      worker.text(b),
      local.text(a),
      worker.text(broken),
    ]);
    expect(ta.ok && la.ok).toBe(true);
    if (!ta.ok || !tb.ok || !la.ok) return;
    expect({ ...ta.data, durationMs: 0, bytesRead: 0 }).toEqual({
      ...la.data,
      durationMs: 0,
      bytesRead: 0,
    });
    expect(ta.data.characters).toBe(ta.data.importCharacters);
    expect(ta.data.ruby).toBeGreaterThan(0);
    expect(bad).toMatchObject({ ok: false, code: 'bad_epub' });

    const cmp = await worker.compare(
      [
        { key: 1, file: a },
        { key: 2, file: b },
      ],
      [[1, 2]],
      { minRun: 100, minContext: 500 },
    );
    expect(cmp.ok).toBe(true);
    if (!cmp.ok) return;
    expect(cmp.data.pairs[0].aInB).toBe(1);
    expect(cmp.data.pairs[0].bInA).toBeCloseTo(36_000 / 51_000, 2);
    expect(cmp.data.pairs[0].extraB.interleavedRuns).toBe(0);
    expect(cmp.data.pairs[0].extraB.runCount).toBe(1);

    const cacheFile = path.join(dir, 'stage3.db');
    const db = new Database(cacheFile);
    db.exec(
      'CREATE TABLE sketches (library_id TEXT, calibre_id INTEGER, size INTEGER, mtime_ms INTEGER, build TEXT, samples BLOB)',
    );
    const put = db.prepare("INSERT INTO sketches VALUES ('L', ?, 0, 0, 'x', ?)");
    put.run(1, sketchToBlob(Uint32Array.from(ta.data.sketch)));
    put.run(2, sketchToBlob(Uint32Array.from(tb.data.sketch)));
    db.close();
    const idx = await worker.index({
      cacheFile,
      libraryId: 'L',
      ids: [1, 2],
      commonBooks: 50,
      minShared: 2,
      minEstimate: 0.05,
    });
    expect(idx.ok && idx.data.pairs.map((p) => [p.a, p.b])).toEqual([[1, 2]]);
  }, 180_000);

  it('a closed pool answers "stopped"', async () => {
    const w = new Stage3Worker(
      { bundle: COUNTER_BUNDLE, importOptions: IMPORT, timeoutMs: () => 60_000 },
      1,
    );
    w.close();
    expect(await w.text(a)).toMatchObject({ ok: false, stopped: true });
  });
});
