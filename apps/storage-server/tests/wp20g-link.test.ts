/**
 * WP20g: the linking sidecar's book archives (1.4.0). The writer reads archives under a book
 * source folder (torrents/<pair>, never torrents/audiobooks) and writes only new files under that
 * folder's _extracted/; split sets go through 7-Zip by their first volume's name, everything else
 * through bsdtar on a read-only fd. The real tools run in the Linux image
 * (.tmp-e2e/wp20g/Dockerfile.test); on other systems those parts are skipped.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import {
  entryStream,
  extractArgs,
  listArchive,
  listSevenZip,
  parseSevenListing,
  sevenEntryStream,
} from '../../cleanup-link/src/archive';
import { BOOK_ARCHIVE, LinkWriter, WriteRefused } from '../../cleanup-link/src/writer';
import { makeZip } from './helpers/epub-fixture';
import { makeTempDir } from './helpers/spawn-server';

function hasTool(cmd: string, args = ['--version']): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const LINUX = process.platform === 'linux';
const BSDTAR = LINUX && hasTool('bsdtar');
const SEVEN = LINUX && hasTool('7zz', ['i']);

function setup() {
  const data = makeTempDir('wp20g-link');
  const root = path.join(data, 'torrents', 'books', 'japanese');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(data, 'torrents', 'audiobooks', 'japanese'), { recursive: true });
  fs.mkdirSync(path.join(data, 'media', 'audiobooks'), { recursive: true });
  return { data, root, writer: new LinkWriter({ dataDir: data }) };
}

function planned(root: string, rel: string) {
  const st = fs.lstatSync(path.join(root, rel), { bigint: true });
  return {
    rel,
    raw: null,
    size: Number(st.size),
    mtimeMs: Math.floor(Number(st.mtimeMs)),
    dev: Number(st.dev),
    ino: Number(st.ino),
  };
}

const fake =
  (bytes: Buffer, code = 0) =>
  () => ({
    stream: Readable.from([bytes]),
    done: Promise.resolve({ code, stderr: code ? 'Wrong password' : '' }),
    kill: () => undefined,
  });

describe('wp20g: the linking sidecar’s book archives', () => {
  it('book source folders: never the audiobooks, never inside _extracted', () => {
    const { writer } = setup();
    expect(() => writer.bookRoot('books/japanese')).not.toThrow();
    expect(() => writer.bookRoot('audiobooks/japanese')).toThrow(WriteRefused);
    expect(() => writer.bookRoot('Audiobooks')).toThrow(WriteRefused);
    expect(() => writer.bookRoot('books/_extracted')).toThrow(WriteRefused);
    expect(() => writer.bookRoot('books/../audiobooks')).toThrow(WriteRefused);
    expect(() => writer.bookRoot('')).toThrow(WriteRefused);
    expect(BOOK_ARCHIVE.test('a.zip')).toBe(true);
    expect(BOOK_ARCHIVE.test('a.7z.001')).toBe(true);
    expect(BOOK_ARCHIVE.test('a.7z.002')).toBe(false);
    expect(BOOK_ARCHIVE.test('a.epub')).toBe(false);
  });

  it('unpacks one entry into the folder’s _extracted/ only; the archive and its volumes unchanged', async () => {
    const { writer, root } = setup();
    fs.writeFileSync(path.join(root, 'a.zip'), makeZip([{ name: 'x/B.epub', data: 'hello' }]));
    const zip = planned(root, 'a.zip');
    const r = await writer.extractBookEntry(
      'books/japanese',
      zip,
      [],
      '_extracted/a.zip/x/B.epub',
      5,
      1,
      fake(Buffer.from('hello')),
    );
    expect(r).toEqual({ existed: false, bytes: 5 });
    expect(fs.readFileSync(path.join(root, '_extracted', 'a.zip', 'x', 'B.epub'), 'utf8')).toBe(
      'hello',
    );
    // Again: there with its size = done; never over another file.
    expect(
      (
        await writer.extractBookEntry(
          'books/japanese',
          zip,
          [],
          '_extracted/a.zip/x/B.epub',
          5,
          1,
          fake(Buffer.from('hello')),
        )
      ).existed,
    ).toBe(true);
    await expect(
      writer.extractBookEntry(
        'books/japanese',
        zip,
        [],
        'x/B.epub',
        5,
        2,
        fake(Buffer.from('hello')),
      ),
    ).rejects.toThrow(/Not inside _extracted/);
    await expect(
      writer.extractBookEntry(
        'audiobooks/japanese',
        zip,
        [],
        '_extracted/a.zip/C.epub',
        5,
        3,
        fake(Buffer.from('hello')),
      ),
    ).rejects.toThrow(WriteRefused);
    await expect(
      writer.extractBookEntry(
        'books/japanese',
        zip,
        [],
        '_extracted/a.zip/D.epub',
        9,
        4,
        fake(Buffer.from('hello')),
      ),
    ).rejects.toThrow(/Unpacked 5 of 9/);
    await expect(
      writer.extractBookEntry(
        'books/japanese',
        zip,
        [],
        '_extracted/a.zip/E.epub',
        5,
        5,
        fake(Buffer.alloc(0), 2),
      ),
    ).rejects.toThrow(/Wrong password/);
    // A volume that changed since it was planned: refused.
    fs.writeFileSync(path.join(root, 'b.7z.001'), 'one');
    fs.writeFileSync(path.join(root, 'b.7z.002'), 'two');
    const v1 = planned(root, 'b.7z.001');
    const v2 = { ...planned(root, 'b.7z.002'), size: 99 };
    await expect(
      writer.extractBookEntry(
        'books/japanese',
        v1,
        [v2],
        '_extracted/b.7z.001/F.epub',
        5,
        6,
        fake(Buffer.from('hello')),
      ),
    ).rejects.toThrow(/changed/);
    // The archive itself is as it was; nothing else appeared in the folder but _extracted/.
    expect(fs.readdirSync(root).sort()).toEqual(['_extracted', 'a.zip', 'b.7z.001', 'b.7z.002']);
    expect(fs.readdirSync(path.join(root, '_extracted', 'a.zip', 'x'))).toEqual(['B.epub']);
  });

  it('7-Zip’s listing blocks', () => {
    const out = [
      'Path = inner/A.epub',
      'Folder = -',
      'Size = 120',
      'Attributes = A_ -rw-r--r--',
      '',
      'Path = inner',
      'Folder = +',
      'Size = 0',
      'Attributes = D_ drwxr-xr-x',
      '',
      'Path = inner/link',
      'Folder = -',
      'Size = 0',
      'Attributes = A_ lrwxrwxrwx',
    ].join('\n');
    expect(parseSevenListing(out)).toEqual([
      { name: 'inner/A.epub', kind: 'file', size: 120 },
      { name: 'inner', kind: 'dir', size: 0 },
      { name: 'inner/link', kind: 'link', size: 0 },
    ]);
  });

  describe.skipIf(!BSDTAR)('with the real bsdtar (Linux image)', () => {
    it('lists a zip and unpacks its EPUB through bsdtar on a read-only fd', async () => {
      const { writer, root } = setup();
      fs.writeFileSync(
        path.join(root, 'p.zip'),
        makeZip([{ name: '本/A.epub', data: 'epub-bytes', utf8: true }]),
      );
      const p = planned(root, 'p.zip');
      const h = await writer.openBookArchive('books/japanese', p);
      const l = await listArchive('bsdtar', h);
      await h.close();
      expect(l.entries.map((e) => [e.name, e.size])).toEqual([['本/A.epub', 10]]);
      const r = await writer.extractBookEntry(
        'books/japanese',
        p,
        [],
        '_extracted/p.zip/本/A.epub',
        10,
        7,
        (fd) => entryStream('bsdtar', fd, extractArgs('本/A.epub', 'utf8')),
      );
      expect(r.bytes).toBe(10);
      expect(fs.readFileSync(path.join(root, '_extracted', 'p.zip', '本', 'A.epub'), 'utf8')).toBe(
        'epub-bytes',
      );
    });
  });

  describe.skipIf(!SEVEN)('with the real 7-Zip (Linux image)', () => {
    it('lists a split set by its first volume and unpacks one entry', async () => {
      const { writer, root } = setup();
      const zip = makeZip([
        { name: 'set/A.epub', data: 'x'.repeat(4000), utf8: true },
        { name: 'set/B.pdf', data: 'pdf', utf8: true },
      ]);
      // A plain byte split, as .001/.002 sets are made.
      fs.writeFileSync(path.join(root, 's.zip.001'), zip.subarray(0, 2000));
      fs.writeFileSync(path.join(root, 's.zip.002'), zip.subarray(2000));
      const v1 = planned(root, 's.zip.001');
      const v2 = planned(root, 's.zip.002');
      const file = await writer.bookArchivePath('books/japanese', v1, [v2]);
      const l = await listSevenZip('7zz', file);
      expect(l.problem).toBeNull();
      expect(l.entries.filter((e) => e.kind === 'file').map((e) => [e.name, e.size])).toEqual([
        ['set/A.epub', 4000],
        ['set/B.pdf', 3],
      ]);
      const r = await writer.extractBookEntry(
        'books/japanese',
        v1,
        [v2],
        '_extracted/s.zip.001/set/A.epub',
        4000,
        8,
        (_h, f) => sevenEntryStream('7zz', f, 'set/A.epub'),
      );
      expect(r.bytes).toBe(4000);
      expect(fs.statSync(path.join(root, '_extracted', 's.zip.001', 'set', 'A.epub')).size).toBe(
        4000,
      );
      // Only the folder's _extracted/ is new.
      expect(fs.readdirSync(root).sort()).toEqual(['_extracted', 's.zip.001', 's.zip.002']);
    });
  });
});
