/**
 * More Bookmeter coverage, step 1 (measuring only): every stage-4 book's stored Bookmeter search
 * answer with the values stage 4's acceptance compares it with, from a one-step copy of
 * cleanup.db and the reader's Calibre snapshot. The decision is stage 4's own code
 * (Stage4Analysis's record and decideStage4, bookmeterOwnTexts, acceptBookmeter); nothing is
 * fetched and nothing is written to the copies (opened read-only). One JSON line per book.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-coverage-extract.ts --db <copy/cleanup.db>
 *     --metadata <copy of cache/calibre/<library>.db> --main <copy/ttsu.db>
 *     --gold <gold800.json> --out <books.jsonl> [--cache <copy of cache/cleanup>]
 *
 * With --cache, each result's whole title is read from the cached search answer (the cover's alt
 * text; the list cuts long titles) and the edition check is run on it too.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brotliDecompressSync } from 'zlib';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { loadGold, mapLabeledIds } from '../src/cleanup/stage2-gate';
import { getStage } from '../src/cleanup/stages';
import {
  Stage4Analysis,
  bookmeterOwnTexts,
  type Stage4Progress,
} from '../src/cleanup/stage4/analysis';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import { acceptBookmeter, editionNotes } from '../src/cleanup/stage4/store-links';
import { nfkc } from '../src/cleanup/title-rules';
import { parseFullTitles, type BookRow } from './lib/bookmeter-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
const p = getStage(db, 4).progress as unknown as Stage4Progress;
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-extract-'));
const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${p.libraryId}.db`);
fs.mkdirSync(path.dirname(snap), { recursive: true });
fs.copyFileSync(arg('metadata')!, snap);
const analysis = new Stage4Analysis({
  cleanup: db,
  main,
  calibreDir: '',
  cacheDir,
  dbDir: null,
  // Never used: nothing is enqueued while measuring.
  queue: null as never,
});
// The stage's own private helpers, read-only.
const a = analysis as unknown as {
  loadSnapshot(lib: string): { books: Map<number, { uuid: string }> };
  book(uuid: string): ({ uuid: string; title: string; calibreId: number } & object) | null;
  record(book: object, ref: object, ev: object): Parameters<typeof decideStage4>[0];
};
const snapshot = a.loadSnapshot(p.libraryId);

const { gold } = loadGold(arg('gold')!);
const gidOf = new Map<number, string>();
for (const [gid, cid] of mapLabeledIds(db, p.libraryId, Object.keys(gold ?? {})))
  gidOf.set(cid, gid);

const cacheOf = db.prepare(`SELECT cache_file FROM fetch_requests WHERE id = ?`);
const out = fs.createWriteStream(arg('out')!);
let n = 0;
let changed = 0;
let missingPages = 0;
const rows = db
  .prepare(
    `SELECT calibre_uuid, calibre_id, labeled FROM stage4_books WHERE library_id = ? AND state = 'proposed'`,
  )
  .all(p.libraryId) as { calibre_uuid: string; calibre_id: number; labeled: number }[];
for (const r of rows) {
  const book = a.book(r.calibre_uuid);
  const ref = book ? analysis.loadRef(p.libraryId, r.calibre_uuid)?.file : null;
  const ev = book && ref ? analysis.loadOnline(p.libraryId, r.calibre_uuid) : null;
  if (!book || !ref || !ev) continue;
  const rec = a.record(book, ref, ev);
  const d = decideStage4(rec);
  const own = bookmeterOwnTexts(book, ref, d, rec.amazon?.product?.title)
    .filter((t): t is string => typeof t === 'string')
    .map((t) => nfkc(t));
  const hits = ev.bookmeter.hits ?? null;
  const base = hits
    ? acceptBookmeter(hits, { title: d.values.t, authors: d.values.au, own })
    : null;
  const stored = ev.bookmeter.accepted?.id ?? null;
  if ((base?.hit?.id ?? null) !== stored) changed++;
  const searchFile =
    (
      cacheOf.get(ev.requests['bookmeter-search'] ?? -1) as
        | { cache_file: string | null }
        | undefined
    )?.cache_file ?? null;
  // The whole titles from the cached answer (the list cuts long ones with "…").
  let full = new Map<string, string>();
  if (searchFile && arg('cache')) {
    try {
      full = parseFullTitles(
        brotliDecompressSync(fs.readFileSync(path.join(arg('cache')!, searchFile))).toString(
          'utf8',
        ),
      );
    } catch {
      missingPages++;
    }
  }
  const edOk = (title: string) => !editionNotes(title).some((x) => !own.some((t) => t.includes(x)));
  const row: BookRow = {
    uuid: r.calibre_uuid,
    cid: r.calibre_id,
    gid: gidOf.get(book.calibreId) ?? null,
    t: d.values.t,
    au: d.values.au,
    se: d.values.se ?? null,
    ix: (d.values.ix as number | null | undefined) ?? null,
    kind: d.values.kind ?? null,
    fmt: d.values.fmt ?? null,
    calTitle: book.title,
    opfTitle: ref.opf_title ?? null,
    hits: (hits ?? []).map((h) => {
      const f = full.get(h.id) ?? null;
      return { ...h, edOk: edOk(h.title), full: f, edOkFull: f === null ? null : edOk(f) };
    }),
    searched: hits !== null,
    stored,
    base: base?.hit?.id ?? null,
    stores: ev.bookmeter.stores ?? null,
    searchFile,
  };
  out.write(JSON.stringify(row) + '\n');
  if (++n % 5000 === 0) console.error(`${n} books`);
}
out.end();
console.error(
  `${n} books written; ${missingPages} cached search answers missing; ${changed} whose acceptance with today's code differs from the stored one; ${snapshot.books.size} books in the snapshot`,
);
fs.rmSync(cacheDir, { recursive: true, force: true });
