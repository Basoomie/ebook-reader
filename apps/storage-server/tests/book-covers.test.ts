/**
 * Book covers (docs/design/book-covers.md): the store pictures offered in the edit form and the
 * cover archive's own rules. The archive through the real write path (the apply sidecar with a
 * stand-in calibredb) is in calibre-edits.test.ts.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { brotliCompressSync } from 'zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { CoverArchive } from '../src/cleanup/edits/cover-archive';
import { amazonCoverUrl, StoreCovers } from '../src/cleanup/edits/store-covers';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { makeJpeg } from './helpers/calibre-fixture';
import { makeTempDir } from './helpers/spawn-server';

const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cleanupDb() {
  const dir = makeTempDir('covers-');
  dirs.push(dir);
  const db = openCleanupDatabase(path.join(dir, 'cleanup.db'));
  dbs.push(db);
  const s = getSettings(db).fetch;
  const sites = Object.fromEntries(
    Object.keys(s.sites).map((k) => [k, { ...s.sites[k], intervalSeconds: 0.25 }]),
  );
  updateSettings(db, { fetch: { ...s, sites } });
  return { db, dir };
}

const answer = (body: Buffer, status = 200) => ({
  status,
  ms: 10,
  error: null,
  body: brotliCompressSync(body),
  encoding: 'br' as const,
});

/** A picture with a pattern (flat pictures all share one difference hash). */
async function striped(width: number, height: number): Promise<Buffer> {
  const half = await sharp({
    create: { width: Math.floor(width / 2), height, channels: 3, background: '#000' },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: '#fff' } })
    .composite([{ input: half, left: 0, top: 0 }])
    .jpeg()
    .toBuffer();
}

const BW_ID = '5b1a695e-9481-4a89-8bc2-c924090c6114';
const BW_PAGE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'store-ratings', 'bookwalker-rated.html'),
);
const AMAZON_PAGE = (img: string) =>
  Buffer.from(
    `<html><body><div id="ebooksImageBlockContainer"><img alt="cover" src="https://m.media-amazon.com/images/I/81small._SY346_.jpg" id="ebooksImgBlkFront" data-a-dynamic-image="{&quot;https://m.media-amazon.com/images/I/81small._SY346_.jpg&quot;:[346,240],&quot;${img}&quot;:[1500,1050]}"></div>` +
      `<script src="https://m.media-amazon.com/images/I/51JfbF-itML.js?xcp"></script></body></html>`,
  );

describe('the cover address on an Amazon page', () => {
  it('takes hiRes, then data-old-hires, then the front cover’s largest size, never a script', () => {
    expect(amazonCoverUrl('"hiRes":"https://m.media-amazon.com/images/I/91abc._SL1500_.jpg"')).toBe(
      'https://m.media-amazon.com/images/I/91abc._SL1500_.jpg',
    );
    expect(
      amazonCoverUrl('<img data-old-hires="https://m.media-amazon.com/images/I/71x.jpg" src="x">'),
    ).toBe('https://m.media-amazon.com/images/I/71x.jpg');
    expect(
      amazonCoverUrl(
        AMAZON_PAGE('https://m.media-amazon.com/images/I/81big._SY1500_.jpg').toString(),
      ),
    ).toBe('https://m.media-amazon.com/images/I/81big._SY1500_.jpg');
    // The trimmed test pages name only a script of the same folder: no cover.
    const trimmed = fs
      .readFileSync(path.join(__dirname, 'fixtures', 'store-ratings', 'amazon-rated-1.html'))
      .toString();
    expect(amazonCoverUrl(trimmed)).toBeNull();
  });

  it('asks for the original upload (the size suffix taken off)', () => {
    expect(
      StoreCovers.pictureUrl(
        'amazon',
        AMAZON_PAGE('https://m.media-amazon.com/images/I/81big._SY1500_.jpg'),
      ),
    ).toBe('https://m.media-amazon.com/images/I/81big.jpg');
    expect(StoreCovers.pictureUrl('bookwalker', BW_PAGE)).toBe(
      'https://rimg.bookwalker.jp/7801527/UwdNlrHZZCAtX4RcoBwrFg__.jpg',
    );
  });
});

describe('store covers through the fetch queue', () => {
  function setup(ids: Record<string, string>, current: Buffer | null) {
    const { db, dir } = cleanupDb();
    const main = new Database(':memory:');
    dbs.push(main);
    main.exec('CREATE TABLE book_identifiers (book_id TEXT, type TEXT, value TEXT)');
    for (const [type, value] of Object.entries(ids))
      main.prepare('INSERT INTO book_identifiers VALUES (?, ?, ?)').run('b1', type, value);
    const q = new FetchQueue(db, path.join(dir, 'cache'), () => getSettings(db).fetch);
    const s = new StoreCovers({ cleanup: db, main, queue: q, currentCover: () => current });
    let t = Date.now();
    /** The fetcher: answers every request it is given, by its address. */
    const fetcher = (answers: Record<string, Buffer | number>) => {
      t += 60_000;
      const got = q.claim(t).requests;
      for (const c of got) {
        const a = answers[c.url];
        if (a === undefined) throw new Error(`unexpected request ${c.url}`);
        q.report(
          c.id,
          c.leaseToken,
          typeof a === 'number' ? answer(Buffer.from('gone'), a) : answer(a),
          t,
        );
      }
      return got.map((c) => c.url);
    };
    return { s, q, db, fetcher };
  }

  it('only a saved direct id, never a search', () => {
    const { s } = setup(
      { amazon_jp: 'not-an-asin', bookwalker: BW_ID, isbn: '9784040000000' },
      null,
    );
    expect(s.stores('b1')).toEqual([{ store: 'bookwalker', id: BW_ID }]);
  });

  it('asks the page, then its picture, at the top priority, and tells the size and sameness', async () => {
    const cover = await makeJpeg(40, 1050, 1500);
    const bigImg = 'https://m.media-amazon.com/images/I/81big._SY1500_.jpg';
    const { s, db, fetcher } = setup({ amazon_jp: 'B07DXV5BP2', bookwalker: BW_ID }, cover);
    const v1 = await s.view('b1');
    expect(v1.stores.map((x) => x.state)).toEqual(['waiting', 'waiting']);
    expect(db.prepare('SELECT site, priority FROM fetch_requests ORDER BY site').all()).toEqual([
      { site: 'amazon-dp', priority: 100 },
      { site: 'bookwalker', priority: 100 },
    ]);
    fetcher({
      'https://www.amazon.co.jp/dp/B07DXV5BP2': AMAZON_PAGE(bigImg),
      [`https://bookwalker.jp/de${BW_ID}/`]: BW_PAGE,
    });
    await s.view('b1');
    fetcher({
      'https://m.media-amazon.com/images/I/81big.jpg': cover,
      'https://rimg.bookwalker.jp/7801527/UwdNlrHZZCAtX4RcoBwrFg__.jpg': await striped(400, 600),
    });
    const v3 = await s.view('b1');
    expect(v3.stores[0]).toMatchObject({
      store: 'amazon',
      state: 'ready',
      width: 1050,
      height: 1500,
      same: true,
    });
    expect(v3.stores[1]).toMatchObject({
      store: 'bookwalker',
      state: 'ready',
      width: 400,
      same: false,
    });
    expect(s.picture('b1', 'amazon').equals(cover)).toBe(true);
  });

  it('a page that is gone or names no cover says so; Ask again asks a failed store again', async () => {
    const { s, q, db, fetcher } = setup({ amazon_jp: 'B000000001', bookwalker: BW_ID }, null);
    await s.view('b1');
    fetcher({
      'https://www.amazon.co.jp/dp/B000000001': 404,
      [`https://bookwalker.jp/de${BW_ID}/`]: Buffer.from('<html>no product data</html>'),
    });
    const v = await s.view('b1');
    expect(v.stores[0]).toMatchObject({ state: 'none', reason: 'Amazon has no page for this id' });
    expect(v.stores[1]).toMatchObject({
      state: 'none',
      reason: "BOOK☆WALKER's page shows no cover",
    });
    expect(() => s.picture('b1', 'amazon')).toThrow(/isn't here yet/);
    const again = await s.view('b1', true);
    expect(again.stores[0].state).toBe('waiting');
    expect(
      (
        db.prepare(`SELECT state FROM fetch_requests WHERE site = 'amazon-dp'`).get() as {
          state: string;
        }
      ).state,
    ).toBe('queued');
    void q;
  });

  it('says when the fetcher is away', async () => {
    const { s, db } = setup({ bookwalker: BW_ID }, null);
    expect((await s.view('b1')).fetcher).toBe(false);
    db.prepare('UPDATE fetcher_status SET last_seen_at = ? WHERE id = 1').run(Date.now());
    expect((await s.view('b1')).fetcher).toBe(true);
  });
});

describe('the cover archive', () => {
  it('keeps one file per picture, checked, and lists a book’s pictures oldest first', async () => {
    const { db, dir } = cleanupDb();
    const a = new CoverArchive(db, path.join(dir, 'covers'));
    const book = { libraryId: 'L', uuid: 'U', calibreId: 1 };
    const one = await makeJpeg(10);
    const two = await makeJpeg(200);
    const s1 = await a.keep(book, one, 'before', 5, 1000);
    await a.keep(book, one, 'before', 5, 1000); // the same again: nothing new
    await a.keep({ ...book, uuid: 'OTHER' }, one, 'seen', null, 1500); // shared file
    const s2 = await a.keep(book, two, 'seen', null, 2000);
    expect(fs.readdirSync(path.join(dir, 'covers')).sort()).toEqual(
      [`${s1}.jpg`, `${s2}.jpg`].sort(),
    );
    expect(a.list(book).map((c) => [c.sha256, c.width, c.height])).toEqual([
      [s1, 600, 900],
      [s2, 600, 900],
    ]);
    expect(a.keptBefore(5)).toBe(s1);
    expect(a.has(book, s2)).toBe(true);
    expect(a.has({ libraryId: 'L', uuid: 'OTHER' }, s2)).toBe(false);
    await expect(a.keep(book, Buffer.from('not a picture'), 'seen', null)).rejects.toThrow(
      /Not a picture/,
    );
  });

  it('refuses when the folder can’t be written (the caller then doesn’t replace the cover)', async () => {
    const { db, dir } = cleanupDb();
    const blocked = path.join(dir, 'covers');
    fs.writeFileSync(blocked, 'a file where the folder should be');
    const a = new CoverArchive(db, blocked);
    await expect(
      a.keep({ libraryId: 'L', uuid: 'U', calibreId: 1 }, await makeJpeg(10), 'before', 1),
    ).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM cover_archive').get()).toEqual({ n: 0 });
  });
});
