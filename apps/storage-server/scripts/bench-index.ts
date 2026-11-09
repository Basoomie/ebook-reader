/**
 * Benchmark for the first index of a large library (not part of npm test).
 *
 *   node -r ts-node/register/transpile-only scripts/bench-index.ts [--books 60000] [--covers 500]
 *
 * Builds a synthetic Calibre library in a temp folder (metadata.db with
 * realistic field sizes, plus `--covers` realistic ~1 MB 1000x1500 JPEG
 * covers), then runs the real indexer and thumbnail code against it and
 * prints the timings. Runs on whatever disk the temp folder is on, so HDD
 * seek and read time must be added on top for the NAS (see the output).
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { CalibreIndexer } from '../src/calibre/indexer';
import { DEFAULT_CALIBRE } from '../src/config';
import { openDatabase } from '../src/db/database';
import { ThumbnailService } from '../src/thumbnails/thumbnails';
import { FIXTURE_DDL } from '../tests/helpers/calibre-fixture';

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const BOOKS = arg('--books', 60_000);
const COVERS = arg('--covers', 500);
const JP = '花街の薬屋で働く少女が後宮の謎を解く物語。毒と薬の知識で事件を次々に解決していく。';

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsu-bench-'));
  const root = path.join(base, 'calibre');
  const lib = path.join(root, 'japanese-library');
  fs.mkdirSync(lib, { recursive: true });
  console.log(`Building a ${BOOKS}-book library in ${base} ...`);

  const src = new Database(path.join(lib, 'metadata.db'));
  src.pragma('journal_mode = DELETE');
  src.exec(FIXTURE_DDL);
  src.prepare('INSERT INTO library_id (uuid) VALUES (?)').run(randomUUID());
  const authors = Math.max(1, Math.floor(BOOKS / 4));
  const series = Math.max(1, Math.floor(BOOKS / 8));
  src.transaction(() => {
    for (let a = 1; a <= authors; a++) {
      src
        .prepare('INSERT INTO authors (id, name, sort) VALUES (?, ?, ?)')
        .run(a, `著者${a}`, `著者${a}`);
    }
    for (let s = 1; s <= series; s++) {
      src
        .prepare('INSERT INTO series (id, name, sort) VALUES (?, ?, ?)')
        .run(s, `シリーズ${s}`, `シリーズ${s}`);
    }
    for (let t = 1; t <= 300; t++)
      src.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(t, `タグ${t}`);
    const insBook = src.prepare(
      `INSERT INTO books (id, title, sort, timestamp, pubdate, series_index, author_sort, path, uuid,
         has_cover, last_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let b = 1; b <= BOOKS; b++) {
      const when = new Date(Date.UTC(2015, 0, 1) + b * 60_000).toISOString().replace('T', ' ');
      const p = `Zhu Zhe ${b % authors}/Book ${b} (${b})`;
      insBook.run(
        b,
        `本のタイトル ${b} 巻`,
        `本のタイトル ${b}`,
        when,
        when,
        (b % 12) + 1,
        `著者${(b % authors) + 1}`,
        p,
        randomUUID(),
        b > BOOKS - COVERS ? 1 : 0,
        when,
      );
      src
        .prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)')
        .run(b, (b % authors) + 1);
      if (b % 3 !== 0)
        src
          .prepare('INSERT INTO books_series_link (book, series) VALUES (?, ?)')
          .run(b, (b % series) + 1);
      for (let k = 0; k < 3; k++) {
        src
          .prepare('INSERT OR IGNORE INTO books_tags_link (book, tag) VALUES (?, ?)')
          .run(b, ((b + k * 97) % 300) + 1);
      }
      src
        .prepare('INSERT INTO comments (book, text) VALUES (?, ?)')
        .run(b, `<p>${JP.repeat(6)}</p>`);
      src
        .prepare('INSERT INTO data (book, format, uncompressed_size, name) VALUES (?, ?, ?, ?)')
        .run(b, 'EPUB', 2_000_000, `Book ${b}`);
    }
  })();
  src.close();
  const dbSize = fs.statSync(path.join(lib, 'metadata.db')).size;
  console.log(`metadata.db: ${(dbSize / 1e6).toFixed(1)} MB`);

  console.log(`Writing ${COVERS} realistic covers ...`);
  let coverBytes = 0;
  for (let b = BOOKS - COVERS + 1; b <= BOOKS; b++) {
    const dir = path.join(lib, `Zhu Zhe ${b % authors}`, `Book ${b} (${b})`);
    fs.mkdirSync(dir, { recursive: true });
    const jpeg = await sharp({
      create: {
        width: 1000,
        height: 1500,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 40 },
      },
    })
      .blur(1.2)
      .jpeg({ quality: 92 })
      .toBuffer();
    coverBytes += jpeg.length;
    fs.writeFileSync(path.join(dir, 'cover.jpg'), jpeg);
  }
  if (COVERS) console.log(`average cover: ${(coverBytes / COVERS / 1e6).toFixed(2)} MB`);

  const dbDir = path.join(base, 'db');
  const cacheDir = path.join(base, 'cache');
  const dataDir = path.join(base, 'data');
  for (const d of [dbDir, cacheDir, dataDir]) fs.mkdirSync(d);
  const db = openDatabase(path.join(dbDir, 'ttsu.db'));
  const config = {
    ...DEFAULT_CALIBRE,
    dir: root,
    cacheDir,
    settleSeconds: 0,
    requireReadonly: false,
    thumbPerSecond: 0,
    thumbBackground: false,
  };
  const quiet = () => {};
  const thumbnails = new ThumbnailService({
    db,
    calibreDir: root,
    cacheDir,
    concurrency: 1,
    perSecond: 0,
    background: true,
    log: quiet,
  });
  const indexer = new CalibreIndexer({ db, config, dbDir, dataRoot: dataDir, log: quiet });
  await indexer.start({ timer: false });
  db.prepare("UPDATE libraries SET language = 'ja', enabled = 1").run();

  // Event-loop stalls during the index (what other requests would feel).
  let worstStall = 0;
  let last = process.hrtime.bigint();
  const probe = setInterval(() => {
    const now = process.hrtime.bigint();
    worstStall = Math.max(worstStall, Number(now - last) / 1e6 - 10);
    last = now;
  }, 10);

  let t = process.hrtime.bigint();
  await indexer.tick();
  const firstIndex = ms(t);
  clearInterval(probe);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n;

  db.prepare('UPDATE library_index_state SET reindex_requested_at = 1').run();
  t = process.hrtime.bigint();
  await indexer.tick();
  const unchangedIndex = ms(t);

  t = process.hrtime.bigint();
  thumbnails.wake();
  await thumbnails.idle();
  const thumbMs = ms(t);
  const thumbs = db
    .prepare("SELECT COUNT(*) AS n, AVG(bytes) AS avg FROM thumbnails WHERE status = 'ok'")
    .get() as {
    n: number;
    avg: number;
  };

  console.log('');
  console.log(
    `First index (snapshot + ingest) of ${count} books: ${(firstIndex / 1000).toFixed(1)} s`,
  );
  console.log(`Worst event-loop stall during it: ${worstStall.toFixed(0)} ms`);
  console.log(`Re-index with nothing changed: ${(unchangedIndex / 1000).toFixed(1)} s`);
  if (thumbs.n) {
    const per = thumbMs / thumbs.n;
    console.log(
      `Thumbnails: ${thumbs.n} in ${(thumbMs / 1000).toFixed(1)} s = ${per.toFixed(1)} ms each ` +
        `(CPU + this disk), average ${(thumbs.avg / 1000).toFixed(1)} KB`,
    );
    console.log(
      `  extrapolated to 60000 covers: ${((per * 60_000) / 60_000).toFixed(0)} min at full speed (ms per cover x 60000 / 60000 ms), ` +
        `${(60_000 / Math.min(8, 1000 / per) / 60).toFixed(0)} min at THUMB_PER_SECOND=8; ` +
        `thumbnail cache ${((thumbs.avg * 60_000) / 1e9).toFixed(2)} GB`,
    );
    console.log('  On the NAS add HDD seek + read per cover (~10-25 ms for a 1 MB file).');
  }
  db.close();
  fs.rmSync(base, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
