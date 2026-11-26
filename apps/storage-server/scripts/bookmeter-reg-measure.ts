/**
 * Bookmeter links, second look (2026-11-25), measuring: for every book the link pass looked at
 * (bookmeter_listing_books), the answers it read (stage 4's search, More Bookmeter's Q1/Q2, the
 * pass's author-field search) with each listing's 登録 count; the book's CURRENT Bookmeter id
 * (the reader's ttsu.db: what was written); today's pick (judgeBookmeter) and the pick with
 * "another listing of the same book" (bookmeter-same.ts) added. Read only: copies on this PC and
 * a local copy of the fetch cache. One JSON line per book.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-reg-measure.ts --cleanup <copy> --ttsu <copy>
 *     --calibre <snapshot copy> --cache <folder with fetch/> --out <file.jsonl> [--limit N]
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brotliDecompressSync } from 'zlib';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { BookmeterListings, mergeAnswers } from '../src/cleanup/stage4/bookmeter-listing';
import { sameBook, sameBookFails } from '../src/cleanup/stage4/bookmeter-same';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import {
  bookmeterListingSearch,
  judgeBookmeter,
  mostRegistered,
  parseBookmeterSearch,
  type BookmeterHit,
} from '../src/cleanup/stage4/store-links';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function refuseLive(p: string): void {
  const n = path.resolve(p).toLowerCase();
  if (n.includes(`${path.sep}appdata${path.sep}`) || n.startsWith('\\\\') || n.startsWith('//'))
    throw new Error(`${p}: a copy on this PC only (never the NAS or a live database)`);
}

const reg = (h: BookmeterHit | null | undefined) =>
  h && typeof h.registrations === 'number' ? h.registrations : null;
const brief = (h: BookmeterHit | null | undefined) =>
  h ? { id: h.id, reg: reg(h), title: h.title, authors: h.authors } : null;

async function main() {
  for (const k of ['cleanup', 'ttsu', 'calibre', 'cache']) refuseLive(arg(k)!);
  const db = new Database(arg('cleanup')!, { readonly: true });
  const main = new Database(arg('ttsu')!, { readonly: true });
  const lib = (getStage(db, 4).progress as unknown as Stage4Progress).libraryId!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-measure-'));
  const snap = path.join(tmp, SNAPSHOT_DIRNAME, `${lib}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('calibre')!, snap);
  const cache = arg('cache')!;
  const queue = new FetchQueue(db, tmp, () => getSettings(db).fetch);
  const cacheOf = db.prepare('SELECT cache_file FROM fetch_requests WHERE id = ?');
  queue.readAnswer = (id: number) => {
    const r = cacheOf.get(id) as { cache_file: string | null } | undefined;
    if (!r?.cache_file) return null;
    try {
      return brotliDecompressSync(fs.readFileSync(path.join(cache, r.cache_file)));
    } catch {
      return null;
    }
  };
  const analysis = new Stage4Analysis({
    cleanup: db,
    main,
    calibreDir: '',
    cacheDir: tmp,
    dbDir: null,
    queue,
  });
  const pass = new BookmeterListings({
    db,
    analysis,
    queue,
    batches: null as never,
    targetLibrary: () => lib,
    stage4Done: () => true,
    writeWait: () => 'read only',
    referenceFile: () => null,
    log: () => undefined,
  });
  analysis.loadSnapshot(lib);
  const current = new Map<string, string>();
  for (const r of main
    .prepare(
      `SELECT x.calibre_uuid AS u, bi.value AS v FROM book_sources x
       JOIN book_identifiers bi ON bi.book_id = x.book_id AND bi.type = 'bookmeter'
       WHERE x.library_id = ? AND x.missing_at IS NULL`,
    )
    .all(lib) as { u: string; v: string }[])
    current.set(r.u, r.v.trim());
  const rows = db
    .prepare(
      `SELECT calibre_uuid AS u, state, saved_id, labeled FROM bookmeter_listing_books
       WHERE library_id = ? ORDER BY calibre_uuid`,
    )
    .all(lib) as { u: string; state: string; saved_id: string; labeled: number }[];
  // --sample N: a blind sample, N books with a current id in sha256(salt + uuid) order.
  const sample = Number(arg('sample') ?? 0);
  if (sample > 0) {
    const salt = arg('salt') ?? 'blreg2';
    const h = (u: string) =>
      createHash('sha256')
        .update(salt + u)
        .digest('hex');
    rows.sort((a, b) => (h(a.u) < h(b.u) ? -1 : 1));
    rows.splice(0, rows.length, ...rows.filter((r) => current.has(r.u)).slice(0, sample));
  }
  const ratingOf = main.prepare(
    "SELECT count, reviews IS NOT NULL AS page FROM store_ratings WHERE site = 'bookmeter' AND site_id = ?",
  );
  const freshOf = db.prepare(
    `SELECT id FROM fetch_requests WHERE site = 'bookmeter' AND key = ? AND state = 'done'`,
  );
  // --live: the sample's live pages (author walk + keyword search) added to its answers, by index.
  const live = arg('live')
    ? (JSON.parse(fs.readFileSync(arg('live')!, 'utf8')) as Record<
        string,
        {
          w: { out: { id: string; title: string; authors: string[]; reg: number | null }[] };
          k: { id: string; title: string; authors: string[]; reg: number | null }[] | null;
        }
      >)
    : null;
  const out = fs.createWriteStream(arg('out')!);
  const limit = Number(arg('limit') ?? Infinity);
  let n = 0;
  const t0 = Date.now();
  for (const r of rows) {
    if (n >= limit) break;
    const cur = current.get(r.u);
    if (!cur) continue;
    n++;
    const f = analysis.bookmeterFacts(lib, r.u);
    if (!f) {
      out.write(JSON.stringify({ u: r.u, state: r.state, cur, nofacts: true }) + '\n');
      continue;
    }
    const spec = bookmeterListingSearch(f.input.title, f.input.authors);
    const fr = spec ? (freshOf.get(spec.key) as { id: number } | undefined) : undefined;
    const fb = fr ? queue.readAnswer(fr.id) : null;
    let hits = pass.answersOf(f, fb ? parseBookmeterSearch(fb) : null);
    const lv = live?.[String(n - 1)];
    if (lv) {
      const extra = [...lv.w.out, ...(lv.k ?? [])].map((h) => ({
        id: h.id,
        title: h.title,
        authors: h.authors,
        pages: null,
        registrations: h.reg,
      }));
      hits = mergeAnswers([hits, extra]);
    }
    const j = judgeBookmeter(hits, f.input);
    const strict = hits.filter((_, i) => j.tier[i] !== null);
    const sb = {
      title: f.input.title,
      authors: f.input.authors,
      series: f.input.chosen?.series ?? null,
      fmt: f.input.chosen?.fmt,
      own: (f.input.own ?? [f.input.title]).filter((t): t is string => typeof t === 'string'),
    };
    const same = hits.filter((h, i) => j.tier[i] === null && sameBookFails(h, sb).length === 0);
    // Near misses for review: one check off, more registrations than the current listing.
    const curHit = hits.find((h) => h.id === cur) ?? null;
    const near = hits
      .map((h, i) => ({ h, i, fails: j.tier[i] === null ? sameBookFails(h, sb) : [] }))
      .filter((x) => x.fails.length === 1 && (reg(x.h) ?? -1) > (reg(curHit) ?? -1))
      .map((x) => ({ ...brief(x.h), fails: x.fails }));
    const strictBest = mostRegistered(strict);
    const newBest = mostRegistered([...strict, ...same]);
    out.write(
      JSON.stringify({
        u: r.u,
        state: r.state,
        labeled: r.labeled === 1,
        book: {
          t: sb.title,
          au: sb.authors,
          se: sb.series,
          ix: f.input.chosen?.ix ?? null,
          fmt: sb.fmt,
        },
        cur: curHit ? brief(curHit) : { id: cur, reg: null, title: null },
        curInAnswers: !!curHit,
        rating: ratingOf.get(cur) ?? null,
        hits: hits.length,
        strict: brief(strictBest),
        strictN: strict.length,
        best: brief(newBest),
        bestHow: newBest && !strict.includes(newBest) ? sameBook(newBest, sb).how : 'strict',
        sameN: same.length,
        near,
        all: arg('hits') !== undefined ? hits.map(brief) : undefined,
      }) + '\n',
    );
    if (n % 2000 === 0) console.log(`${n} books, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  out.end();
  console.log(`done: ${n} books in ${Math.round((Date.now() - t0) / 1000)} s`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
