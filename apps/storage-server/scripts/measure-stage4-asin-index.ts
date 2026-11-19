/**
 * WP20d: can a book's Kindle ASIN come from pages already fetched, so its Kindle search is never
 * asked? Two local indexes of normalized title -> ASINs: (1) every result card on the Kindle
 * search pages answered so far (other books' searches), (2) Natively's book pages read so far.
 * For every book whose own Kindle search picked a product, look its query title up (with the
 * same volume number) and compare with the ASIN its search picked: same = a search saved
 * losslessly, different = a wrong book (accuracy loss), none = not covered. Reads only.
 *
 *   npx tsx scripts/measure-stage4-asin-index.ts <cleanup.db snapshot> <fetch cache dir>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { brotliDecompressSync, gunzipSync } from 'zlib';
import { parseAmazonSearch } from '../src/cleanup/stage4/parse';
import { BUNDLED_BONUS, EXTRA, norm, nums } from '../src/cleanup/stage4/pick';
import { nfkc } from '../src/cleanup/stage4/ref-text';

const [dbPath, cacheDir] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true });

/** The title as a key: label in brackets, bonus notes and punctuation dropped; numbers kept. */
function key(t: string): string {
  const s = nfkc(t)
    .replace(BUNDLED_BONUS, '')
    .replace(/[(（][^()（）]*[)）]\s*$/u, '')
    .replace(/【[^】]*】/gu, '');
  return norm(s);
}
const volumes = (t: string) => [...nums(t)].sort().join(',');

// (1) Cards from every answered search, with the search they came from.
const cards = new Map<string, Map<string, Set<number>>>(); // key -> asin -> search ids
const searches = db
  .prepare(
    `SELECT id, cache_file FROM fetch_requests WHERE site = 'amazon-search' AND state = 'done' AND cache_file IS NOT NULL`,
  )
  .all() as { id: number; cache_file: string }[];
for (const s of searches) {
  let list: [string, string][];
  try {
    list = parseAmazonSearch(
      brotliDecompressSync(fs.readFileSync(path.join(cacheDir, s.cache_file))),
    );
  } catch {
    continue;
  }
  for (const [asin, title] of list) {
    if (EXTRA.test(nfkc(title).replace(BUNDLED_BONUS, ''))) continue;
    const k = key(title);
    if (k.length < 4) continue;
    const m = cards.get(k) ?? new Map<string, Set<number>>();
    (m.get(asin) ?? m.set(asin, new Set()).get(asin)!).add(s.id);
    cards.set(k, m);
  }
}
// (2) Natively: title -> Kindle ASINs.
const nat = new Map<string, Set<string>>();
for (const r of db
  .prepare(
    'SELECT b.title, a.asin FROM natively_books b JOIN natively_asins a ON a.natively_id = b.natively_id WHERE b.title IS NOT NULL',
  )
  .iterate() as Iterable<{ title: string; asin: string }>) {
  const k = key(r.title);
  if (k.length < 4) continue;
  (nat.get(k) ?? nat.set(k, new Set()).get(k)!).add(r.asin);
}

const t: Record<string, number> = {};
const inc = (k: string) => (t[k] = (t[k] ?? 0) + 1);
const wrong: string[] = [];
for (const r of db
  .prepare(`SELECT data FROM evidence_records WHERE kind = 'online'`)
  .iterate() as Iterable<{ data: Buffer }>) {
  let ev: any;
  try {
    ev = JSON.parse(gunzipSync(r.data).toString());
  } catch {
    continue;
  }
  const own = ev.requests?.['amazon-search'];
  const picked = ev.amazon?.picked_from_search ? ev.amazon?.product?.asin : null;
  if (!own || !picked) continue;
  inc('books whose search picked a product');
  const k = key(ev.query.title);
  // (1) Only other books' searches count (its own search wouldn't exist yet).
  const m = cards.get(k);
  const fromOthers = m
    ? [...m].filter(([, ids]) => [...ids].some((id) => id !== own)).map(([a]) => a)
    : [];
  if (fromOthers.length === 1) {
    if (fromOthers[0] === picked) inc('cards: same ASIN (search saved)');
    else {
      inc('cards: DIFFERENT ASIN');
      if (wrong.length < 10)
        wrong.push(`cards ${ev.query.title}: picked ${picked}, index ${fromOthers[0]}`);
    }
  } else if (fromOthers.length > 1) inc('cards: several ASINs (not used)');
  else inc('cards: not covered');
  const n = nat.get(k);
  if (n?.size === 1) {
    const a = [...n][0];
    if (a === picked) inc('natively: same ASIN (search saved)');
    else {
      inc('natively: DIFFERENT ASIN');
      if (wrong.length < 20) wrong.push(`natively ${ev.query.title}: picked ${picked}, index ${a}`);
    }
  } else if (n && n.size > 1) inc('natively: several ASINs (not used)');
  else inc('natively: not covered');
  const either =
    (fromOthers.length === 1 && fromOthers[0] === picked) ||
    (n?.size === 1 && [...n][0] === picked);
  if (either) inc('either: same ASIN');
  void volumes;
}
console.log(
  `${searches.length} answered searches, ${cards.size} card titles, ${nat.size} Natively titles`,
);
console.log(t);
for (const w of wrong) console.log('  ', w);
