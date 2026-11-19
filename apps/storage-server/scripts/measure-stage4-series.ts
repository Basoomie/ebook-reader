/**
 * WP20d: how many Kindle searches one request per Amazon series could save. For every book whose
 * product page came from a Kindle search (its online evidence: picked_from_search, product ASIN),
 * reads that search's cached page, finds the picked card and its series link ("全15巻の第1巻:
 * 忘却探偵" -> /dp/<series ASIN>), and groups the books by series. Reads only.
 *
 *   npx tsx scripts/measure-stage4-series.ts <cleanup.db snapshot> <fetch cache dir>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { brotliDecompressSync, gunzipSync } from 'zlib';

const [dbPath, cacheDir] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });

type Ev = {
  amazon?: { picked_from_search?: boolean; product?: { asin?: string } | null; asked?: boolean };
  requests?: Record<string, number>;
};
const rows = db
  .prepare(`SELECT calibre_uuid, data FROM evidence_records WHERE kind = 'online'`)
  .all() as { calibre_uuid: string; data: Buffer }[];
const fileOf = db.prepare(
  `SELECT cache_file, outcome FROM fetch_requests WHERE id = ? AND site = 'amazon-search'`,
);

const series = new Map<string, { name: string; total: number; books: number }>();
const t: Record<string, number> = {};
const inc = (k: string) => (t[k] = (t[k] ?? 0) + 1);
for (const r of rows) {
  let ev: Ev;
  try {
    ev = JSON.parse(gunzipSync(r.data).toString()) as Ev;
  } catch {
    continue;
  }
  const searchId = ev.requests?.['amazon-search'];
  if (!searchId) continue;
  inc('books with a Kindle search');
  const asin = ev.amazon?.picked_from_search ? ev.amazon?.product?.asin : null;
  if (!asin) {
    inc('search picked nothing (yet)');
    continue;
  }
  const f = fileOf.get(searchId) as { cache_file: string | null; outcome: string } | undefined;
  if (!f?.cache_file) {
    inc('search page not cached');
    continue;
  }
  let html: string;
  try {
    html = brotliDecompressSync(fs.readFileSync(path.join(cacheDir, f.cache_file))).toString();
  } catch {
    inc('search page unreadable');
    continue;
  }
  const i = html.indexOf(`data-asin="${asin}"`);
  const next = html.indexOf('data-component-type="s-search-result"', i + 200);
  const card = i < 0 ? '' : html.slice(i, next > i ? next : i + 60000);
  const m =
    /href="\/dp\/([A-Z0-9]{10})\?binding=kindle_edition[^"]*"><span>全(\d+)巻の第(\d+)巻:\s*([^<]+)<\/span>/.exec(
      card,
    );
  if (!m) {
    inc('picked book has no series on its card');
    continue;
  }
  inc('picked book is in an Amazon series');
  const s = series.get(m[1]) ?? { name: m[4].trim(), total: Number(m[2]), books: 0 };
  s.books++;
  series.set(m[1], s);
}
const sizes = [...series.values()];
const inShared = sizes.filter((s) => s.books >= 2).reduce((a, s) => a + s.books, 0);
const saved = sizes.reduce((a, s) => a + s.books - 1, 0);
console.log(t);
console.log(
  `${sizes.length} Amazon series; ${inShared} of the searched books share a series with another searched book;` +
    ` one request per series would replace ${saved} searches (each series still needs 1).`,
);
const hist: Record<string, number> = {};
for (const s of sizes) {
  const k = s.books >= 10 ? '10+' : String(s.books);
  hist[k] = (hist[k] ?? 0) + 1;
}
console.log('series by searched books in them:', hist);
console.log(
  'largest:',
  sizes
    .sort((a, b) => b.books - a.books)
    .slice(0, 12)
    .map((s) => `${s.name} (${s.books} of ${s.total})`)
    .join(' | '),
);
const totals = sizes.map((s) => s.total).sort((a, b) => a - b);
console.log(
  'volumes per series (Amazon): median',
  totals[Math.floor(totals.length / 2)],
  'max',
  totals[totals.length - 1],
);
