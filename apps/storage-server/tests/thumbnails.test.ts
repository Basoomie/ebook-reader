import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetThumbnails,
  getThumbnailRecord,
  THUMB_SPEC,
  thumbnailFile,
  THUMBS_DIRNAME,
} from '../src/thumbnails/thumbnails';
import { CalibreRoot, fingerprint, LibraryFixture } from './helpers/calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.close();
});

async function indexed(
  setup: (lib: LibraryFixture) => Promise<void>,
  overrides = {},
): Promise<{ e: IndexerEnv; root: CalibreRoot; lib: LibraryFixture; libId: string }> {
  const root = new CalibreRoot();
  const lib = root.library('a');
  await setup(lib);
  const e = makeIndexerEnv(root.dir, overrides);
  envs.push(e);
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'a');
  await e.indexer.tick();
  return { e, root, lib, libId };
}

function bookIdByTitle(e: IndexerEnv, title: string): string {
  return (e.db.prepare('SELECT id FROM books WHERE title = ?').get(title) as { id: string }).id;
}

describe('thumbnails', () => {
  it('makes small WebP thumbnails in the cache and never writes near Calibre', async () => {
    const { e, root } = await indexed(async (lib) => {
      await lib.addBook({ title: 'Tall', cover: 'jpeg' });
      await lib.addBook({ title: 'None', cover: 'none' });
      await lib.addBook({ title: 'Corrupt', cover: 'corrupt' });
      await lib.addBook({ title: 'Gone', cover: 'listed-missing' });
    });
    const before = fingerprint(root.dir);

    const tall = await e.thumbnails.ensure(bookIdByTitle(e, 'Tall'));
    expect(tall!.record).toMatchObject({ status: 'ok', spec: THUMB_SPEC.version });
    const file = tall!.file!;
    expect(file).toBe(thumbnailFile(e.calibre.cacheDir, bookIdByTitle(e, 'Tall')));
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe('webp');
    // 600x900 cover fits inside 320x480.
    expect([meta.width, meta.height]).toEqual([320, 480]);
    expect(tall!.record.bytes).toBeLessThan(30_000);

    expect((await e.thumbnails.ensure(bookIdByTitle(e, 'None')))!.record.status).toBe('none');
    const corrupt = await e.thumbnails.ensure(bookIdByTitle(e, 'Corrupt'));
    expect(corrupt!.record).toMatchObject({ status: 'error', attempts: 1 });
    const gone = await e.thumbnails.ensure(bookIdByTitle(e, 'Gone'));
    expect(gone!.record.error).toMatch(/cover.jpg is missing/);

    // A failed cover is not retried until its source changes.
    await e.thumbnails.ensure(bookIdByTitle(e, 'Corrupt'));
    expect(getThumbnailRecord(e.db, bookIdByTitle(e, 'Corrupt'))!.attempts).toBe(1);
    expect(e.thumbnails.pending(10)).toEqual([]);

    expect(fingerprint(root.dir)).toEqual(before);
    expect(fs.readdirSync(e.calibre.cacheDir).sort()).toEqual(['calibre', THUMBS_DIRNAME]);
  });

  it('does not enlarge small covers', async () => {
    const { e, lib } = await indexed(async (l) => {
      await l.addBook({ title: 'Small', cover: 'none' });
    });
    // Give the book a tiny cover through "Calibre".
    const calibreId = (
      e.db.prepare('SELECT calibre_id FROM book_sources').get() as {
        calibre_id: number;
      }
    ).calibre_id;
    fs.writeFileSync(
      path.join(lib.bookDir(calibreId), 'cover.jpg'),
      await sharp({ create: { width: 100, height: 150, channels: 3, background: '#888' } })
        .jpeg()
        .toBuffer(),
    );
    lib.exec((db) =>
      db
        .prepare("UPDATE books SET has_cover = 1, last_modified = '2030-01-01 00:00:00+00:00'")
        .run(),
    );
    await e.indexer.tick();
    const res = await e.thumbnails.ensure(bookIdByTitle(e, 'Small'));
    expect([res!.record.width, res!.record.height]).toEqual([100, 150]);
  });

  it('fills the cache in the background, newest first, and then rests', async () => {
    const { e } = await indexed(
      async (lib) => {
        for (let i = 0; i < 5; i++) {
          await lib.addBook({
            title: `B${i}`,
            timestamp: `2020-01-0${i + 1} 00:00:00+00:00`,
          });
        }
      },
      { thumbBackground: true },
    );
    // tick() woke the background pass.
    await e.thumbnails.idle();
    const order = (
      e.db
        .prepare(
          'SELECT b.title FROM thumbnails t JOIN books b ON b.id = t.book_id ORDER BY t.generated_at, t.rowid',
        )
        .all() as { title: string }[]
    ).map((r) => r.title);
    expect(order).toEqual(['B4', 'B3', 'B2', 'B1', 'B0']);
    expect(e.thumbnails.pending(10)).toEqual([]);

    const made = e.thumbnails.generated;
    e.thumbnails.wake();
    await e.thumbnails.idle();
    expect(e.thumbnails.generated).toBe(made);
  });

  it('honors the background rate limit', async () => {
    const { e } = await indexed(
      async (lib) => {
        for (let i = 0; i < 4; i++) await lib.addBook({ title: `B${i}` });
      },
      { thumbBackground: false, thumbPerSecond: 5 },
    );
    // Turn the background pass on now that the books are indexed.
    (e.thumbnails as unknown as { opts: { background: boolean } }).opts.background = true;
    const start = Date.now();
    e.thumbnails.wake();
    await e.thumbnails.idle();
    // 4 starts at 5/s: at least 3 gaps of 200 ms.
    expect(Date.now() - start).toBeGreaterThanOrEqual(550);
    expect(e.thumbnails.pending(10)).toEqual([]);
  });

  it('remakes a thumbnail when Calibre changes the cover', async () => {
    const { e, lib } = await indexed(async (l) => {
      await l.addBook({ title: 'One', coverHue: 10 });
    });
    const id = bookIdByTitle(e, 'One');
    const first = fs.readFileSync((await e.thumbnails.ensure(id))!.file!);
    const calibreId = (
      e.db.prepare('SELECT calibre_id FROM book_sources').get() as {
        calibre_id: number;
      }
    ).calibre_id;
    await lib.setCover(calibreId, 200);
    await e.indexer.tick();
    expect(e.thumbnails.pending(10).map((p) => p.bookId)).toEqual([id]);
    const second = fs.readFileSync((await e.thumbnails.ensure(id))!.file!);
    expect(second.equals(first)).toBe(false);
  });

  it('remakes thumbnails after a rebuild request, a spec change or a cleared cache', async () => {
    const { e, libId } = await indexed(async (l) => {
      await l.addBook({ title: 'One' });
      await l.addBook({ title: 'Two' });
    });
    const one = bookIdByTitle(e, 'One');
    const two = bookIdByTitle(e, 'Two');
    await e.thumbnails.ensure(one);
    await e.thumbnails.ensure(two);
    expect(e.thumbnails.pending(10)).toEqual([]);

    expect(forgetThumbnails(e.db, { bookId: one })).toBe(1);
    expect(e.thumbnails.pending(10).map((p) => p.bookId)).toEqual([one]);
    await e.thumbnails.ensure(one);

    e.db.prepare('UPDATE thumbnails SET spec = 0').run();
    expect(e.thumbnails.pending(10)).toHaveLength(2);
    expect(forgetThumbnails(e.db, { libraryId: libId })).toBe(2);
    await e.thumbnails.ensure(one);
    await e.thumbnails.ensure(two);

    fs.rmSync(path.join(e.calibre.cacheDir, THUMBS_DIRNAME), { recursive: true });
    const again = await e.thumbnails.ensure(one);
    expect(fs.existsSync(again!.file!)).toBe(true);
  });

  it('walks pending books newest first with a cursor, skipping books without a cover', async () => {
    const { e } = await indexed(async (lib) => {
      for (let i = 0; i < 5; i++) {
        await lib.addBook({
          title: `B${i}`,
          timestamp: `2020-01-0${i + 1} 00:00:00+00:00`,
          cover: i === 2 ? 'none' : 'corrupt',
        });
      }
    });
    const titles = (ids: string[]) =>
      ids.map(
        (id) =>
          (e.db.prepare('SELECT title FROM books WHERE id = ?').get(id) as { title: string }).title,
      );
    const page1 = e.thumbnails.pending(2);
    expect(titles(page1.map((p) => p.bookId))).toEqual(['B4', 'B3']);
    const page2 = e.thumbnails.pending(2, page1[1]);
    expect(titles(page2.map((p) => p.bookId))).toEqual(['B1', 'B0']); // B2 has no cover
    expect(e.thumbnails.pending(2, page2[1])).toEqual([]);

    // The background pass works through every page.
    (e.thumbnails as unknown as { opts: { background: boolean } }).opts.background = true;
    e.thumbnails.wake();
    await e.thumbnails.idle();
    expect(e.thumbnails.pending(10)).toEqual([]);
    expect(e.thumbnails.generated).toBe(4);
    // The no-cover book still answers on request.
    const b2 = (e.db.prepare("SELECT id FROM books WHERE title = 'B2'").get() as { id: string }).id;
    expect((await e.thumbnails.ensure(b2))!.record.status).toBe('none');
  });

  it('serves nothing for missing books or disabled libraries', async () => {
    const { e, libId } = await indexed(async (l) => {
      await l.addBook({ title: 'One' });
    });
    const id = bookIdByTitle(e, 'One');
    e.db.prepare('UPDATE libraries SET enabled = 0 WHERE id = ?').run(libId);
    expect(await e.thumbnails.ensure(id)).toBeNull();
    expect(e.thumbnails.pending(10)).toEqual([]);
    expect(await e.thumbnails.ensure('no-such-book')).toBeNull();
  });
});
