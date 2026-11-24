/**
 * Link discovery, measuring only: every stage-4 book's stored store records (Amazon, RanobeDB,
 * BOOK☆WALKER: the picked record and the lists it was picked from) with the values they would be
 * compared with (stage 4's decided values, Calibre's current values and identifiers), from
 * private copies of cleanup.db and the reader's Calibre snapshot. The decision is stage 4's own
 * code (Stage4Analysis's record and decideStage4); nothing is fetched and nothing is written to
 * the copies (opened read-only). One JSON line per book.
 *
 *   npx ts-node --transpile-only scripts/link-discovery-extract.ts --db <copy/cleanup.db>
 *     --metadata <copy of cache/calibre/<library>.db> --main <copy/ttsu.db>
 *     --gold <gold800.json> --out <books.jsonl>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { loadGold, mapLabeledIds } from '../src/cleanup/stage2-gate';
import type { Stage2Book } from '../src/cleanup/stage2-snapshot';
import { getStage } from '../src/cleanup/stages';
import {
  Stage4Analysis,
  bookmeterOwnTexts,
  type OnlineEvidence,
  type Stage4Progress,
} from '../src/cleanup/stage4/analysis';
import { decideStage4 } from '../src/cleanup/stage4/stage4-rules';
import { N, nfkc } from '../src/cleanup/title-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
const meta = new Database(arg('metadata')!, { readonly: true, fileMustExist: true });
const p = getStage(db, 4).progress as unknown as Stage4Progress;
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-extract-'));
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
const a = analysis as unknown as {
  loadSnapshot(lib: string): { books: Map<number, Stage2Book> };
  book(uuid: string): Stage2Book | null;
  record(book: object, ref: object, ev: object): Parameters<typeof decideStage4>[0];
};
a.loadSnapshot(p.libraryId);

// Calibre's series and number (the snapshot's own tables; Stage2Book has no series).
const seriesOf = new Map<number, { name: string | null; index: number | null }>();
for (const r of meta
  .prepare(
    `SELECT b.id, b.series_index AS ix,
            (SELECT s.name FROM books_series_link l JOIN series s ON s.id = l.series
              WHERE l.book = b.id) AS name
       FROM books b`,
  )
  .all() as { id: number; ix: number | null; name: string | null }[])
  seriesOf.set(r.id, { name: r.name, index: r.name ? r.ix : null });

const { gold } = loadGold(arg('gold')!);
const gidOf = new Map<number, string>();
for (const [gid, cid] of mapLabeledIds(db, p.libraryId, Object.keys(gold ?? {})))
  gidOf.set(cid, gid);

const names = (xs: unknown): string[] =>
  (Array.isArray(xs) ? xs : [])
    .map((x) => (typeof x === 'string' ? x : (x as { name?: unknown })?.name))
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '');
const bwIdOf = (url: string | null | undefined) =>
  url ? (/bookwalker\.jp\/de([0-9a-f-]{36})/.exec(url)?.[1] ?? null) : null;

const out = fs.createWriteStream(arg('out')!);
let n = 0;
const rows = db
  .prepare(
    `SELECT calibre_uuid, calibre_id FROM stage4_books WHERE library_id = ? AND state = 'proposed'`,
  )
  .all(p.libraryId) as { calibre_uuid: string; calibre_id: number }[];
for (const r of rows) {
  const book = a.book(r.calibre_uuid);
  const ref = book ? analysis.loadRef(p.libraryId, r.calibre_uuid)?.file : null;
  const ev: OnlineEvidence | null =
    book && ref ? analysis.loadOnline(p.libraryId, r.calibre_uuid) : null;
  if (!book || !ref || !ev) continue;
  const rec = a.record(book, ref, ev);
  const d = decideStage4(rec);
  const own = bookmeterOwnTexts(book, ref, d, rec.amazon?.product?.title)
    .filter((t): t is string => typeof t === 'string')
    .map((t) => nfkc(t));
  const v = d.values;
  const accepted = d.auto.t && d.auto.au && d.auto.fmt && (d.auto.ix || v.se === null);
  const prod = ev.amazon.product as
    | { asin?: string; title?: string; authors?: unknown; series?: string; breadcrumbs?: string[] }
    | null
    | undefined;
  const rb = ev.ranobedb.book as
    | {
        id?: number;
        title_orig?: string;
        staff?: { name: string; role: string }[];
        isbn13?: string[];
      }
    | null
    | undefined;
  const bw = ev.bookwalker.detail as
    | ({ url: string; title?: string } & Record<string, unknown>)
    | null
    | undefined;
  const se = seriesOf.get(book.calibreId) ?? { name: null, index: null };
  const row = {
    uuid: r.calibre_uuid,
    cid: r.calibre_id,
    gid: gidOf.get(book.calibreId) ?? null,
    // Stage 4's decided values (the rules', before the AI check) and what they were sure of.
    t: v.t,
    au: v.au,
    se: v.se ?? null,
    ix: typeof v.ix === 'number' ? v.ix : null,
    kind: v.kind ?? null,
    fmt: v.fmt ?? null,
    auto: d.auto,
    accepted,
    amazonIdentified: d.trace.amazonIdentified,
    ranobedbIdentified: d.trace.ranobedbIdentified,
    amazonRejected: d.amazonRejected,
    bwTitleAgrees: !!d.trace.cleaned.bookwalker && N(d.trace.cleaned.bookwalker) === N(v.t),
    // Calibre now.
    cal: {
      title: book.title,
      authors: book.authors,
      series: se.name,
      index: se.index,
      ids: book.identifiers,
      illustrators: book.illustrators ?? [],
    },
    opfTitle: ref.opf_title ?? null,
    own,
    standin: ev.amazon.standin ?? null,
    amazon: prod?.asin
      ? {
          id: prod.asin,
          title: prod.title ?? '',
          authors: names(prod.authors),
          roles: (Array.isArray(prod.authors) ? prod.authors : []).map(
            (x) => (x as { role?: string })?.role ?? '',
          ),
          series: prod.series ?? null,
          breadcrumbs: prod.breadcrumbs ?? [],
        }
      : null,
    amazonList: ev.amazon.search_candidates ?? [],
    ranobedb:
      rb?.id != null
        ? {
            id: String(rb.id),
            title: rb.title_orig ?? '',
            authors: (rb.staff ?? []).filter((s) => s.role === 'author').map((s) => s.name),
            staff: (rb.staff ?? []).map((s) => s.name),
            isbn13: rb.isbn13 ?? [],
            authorMatch: ev.ranobedb.author_match ?? null,
          }
        : null,
    ranobedbList: (
      (
        ev.ranobedb.series as {
          books?: { id: number; title_orig?: string; type?: string }[];
        } | null
      )?.books ?? []
    ).map((b) => [String(b.id), b.title_orig ?? '', b.type ?? '']),
    bookwalker: bwIdOf(bw?.url)
      ? {
          id: bwIdOf(bw!.url)!,
          title: bw!.title ?? '',
          // BOOK☆WALKER's page data has no author list; its keywords name the authors.
          keywords: typeof bw!.keywords === 'string' ? bw!.keywords : '',
          tags: Array.isArray(bw!.tags) ? bw!.tags : [],
        }
      : null,
    bookwalkerList: (ev.bookwalker.series_candidates ?? [])
      .map(([url, title]) => [bwIdOf(url), title])
      .filter((x) => x[0]),
    bookmeter: ev.bookmeter.accepted?.id ?? null,
    bmStores: ev.bookmeter.stores ?? null,
  };
  out.write(JSON.stringify(row) + '\n');
  if (++n % 5000 === 0) console.error(`${n} books`);
}
out.end();
console.error(`${n} books written`);
fs.rmSync(cacheDir, { recursive: true, force: true });
