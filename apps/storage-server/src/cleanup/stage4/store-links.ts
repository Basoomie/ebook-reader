/**
 * The store-link lookups (WP20d; plan section 6 "Store-link lookups", decided 2026-11-15):
 * Bookmeter, Natively and the Web NDL Authorities readings. Formats checked on real answers
 * fetched through the VPN on 2026-11-17 (probes in data/backups/wp20d-probe):
 *
 * - Bookmeter's search page loads its results from `/search?…&partial=true` (an HTML list:
 *   /books/<id>, title, authors, pages). Its "書店で詳細を見る" box loads
 *   `/api/v1/books/<id>/external_book_stores.json` ({resources: [{alphabet_name, url}]}), which
 *   holds every store link the book page shows. robots.txt disallows only /users/linkages/.
 * - Natively's sitemap.xml is one file (148,749 entries, of them exactly 50,000 /book/ pages: the
 *   sitemap format's limit per file, so later books may be missing). A book page carries Next.js
 *   data (self.__next_f.push) with the item's isbn, isbn13 and its store links; the Kindle one
 *   (bookProvider slug amazon-kindle-jp) gives the ASIN. Its search must never be used.
 * - NDL: the SPARQL endpoint answers application/sparql-results+json (ndl_sparql.py's query).
 *
 * Store ids are kept without any affiliate or tracking part (decided 2026-11-15).
 */
import { N, NA, nfkc, pyStrip } from '../title-rules';
import { decodeIgnore, textOf, unescapeHtml } from './ref-text';
import { clean } from './rules-v3';
import { nums, pyQuote } from './pick';

// ---------------------------------------------------------------- Bookmeter

export interface BookmeterHit {
  id: string;
  title: string;
  authors: string[];
  pages: number | null;
}

export function bookmeterSearchUrl(title: string): string {
  return `https://bookmeter.com/search?author=&keyword=${pyQuote(title)}&partial=true&sort=recommended&type=japanese_v2`;
}

export function bookmeterStoresUrl(id: string): string {
  return `https://bookmeter.com/api/v1/books/${id}/external_book_stores.json`;
}

/** The search answer's books, in Bookmeter's order. */
export function parseBookmeterSearch(body: Buffer | string): BookmeterHit[] {
  const h = typeof body === 'string' ? body : decodeIgnore(body);
  const out: BookmeterHit[] = [];
  for (const li of h.split('<li class="group__book">').slice(1)) {
    const t = /<div class="detail__title"><a href="\/books\/(\d+)">([\s\S]*?)<\/a>/.exec(li);
    if (!t) continue;
    const authorsBlock = /<ul class="detail__authors">([\s\S]*?)<\/ul>/.exec(li)?.[1] ?? '';
    const authors = [...authorsBlock.matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map((m) =>
      pyStrip(unescapeHtml(m[1])),
    );
    const pages = /<div class="detail__page">(\d+)<\/div>/.exec(li);
    out.push({
      id: t[1],
      title: textOf(t[2]),
      authors: authors.filter((a) => a !== ''),
      pages: pages ? parseInt(pages[1], 10) : null,
    });
  }
  return out;
}

export interface StoreIds {
  bookwalker?: string;
  isbn?: string;
  rakuten?: string;
  honto?: string;
  ebookjapan?: string;
  unext?: string;
}

/** The real address inside an affiliate redirect (valuecommerce vc_url, moshimo url, a8 a8ejpredirect). */
function unwrap(url: string): string {
  let u = url.startsWith('//') ? 'https:' + url : url;
  for (let i = 0; i < 3; i++) {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return u;
    }
    const inner =
      parsed.searchParams.get('vc_url') ??
      parsed.searchParams.get('url') ??
      parsed.searchParams.get('a8ejpredirect') ??
      parsed.searchParams.get('pc');
    if (!inner || !/^https?:\/\//.test(inner)) return u;
    u = inner;
  }
  return u;
}

/** Store ids from Bookmeter's store list (only ebook pages for honto; print-only links ignored). */
export function parseBookmeterStores(body: Buffer | string): StoreIds {
  let data: unknown;
  try {
    data = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
  } catch {
    return {};
  }
  const res = (data as { resources?: unknown })?.resources;
  if (!Array.isArray(res)) return {};
  const out: StoreIds = {};
  for (const r of res) {
    const url =
      typeof (r as { url?: unknown }).url === 'string' ? unwrap((r as { url: string }).url) : '';
    let m: RegExpExecArray | null;
    if ((m = /bookwalker\.jp\/de([0-9a-f-]{36})/.exec(url))) out.bookwalker ??= m[1];
    else if ((m = /kinokuniya\.co\.jp\/f\/dsg-0[0-9]-(97[89]\d{10})/.exec(url))) out.isbn ??= m[1];
    else if ((m = /books\.rakuten\.co\.jp\/(rk|rb)\/([0-9a-z]+)/.exec(url)))
      out.rakuten ??= `${m[1]}/${m[2]}`;
    else if ((m = /honto\.jp\/ebook\/pd_(\d+)\.html/.exec(url))) out.honto ??= m[1];
    else if ((m = /ebookjapan\.yahoo\.co\.jp\/books\/(\d+)\/([0-9A-Za-z]+)/.exec(url)))
      out.ebookjapan ??= `${m[1]}/${m[2]}`;
    else if ((m = /unext\.jp\/book\/title\/(BSD\d+)(?:\/(BID\d+))?/.exec(url)))
      out.unext ??= m[2] ? `${m[1]}/${m[2]}` : m[1];
  }
  return out;
}

/**
 * Match acceptance for Bookmeter (plan section 6): the title, an author and the volume must all
 * agree with the book's decided values. Bookmeter's titles carry the label ("(GAノベル)"), so
 * both sides go through rules v3's clean().
 */
export function acceptBookmeter(
  hits: BookmeterHit[],
  book: { title: string; authors: string[] },
): { hit: BookmeterHit; reason: string } | { hit: null; reason: string } {
  const want = N(clean(book.title)) ?? '';
  if (!want) return { hit: null, reason: 'no title to compare' };
  const authors = new Set(book.authors.map((a) => NA(a)));
  const wantNums = [...nums(book.title)].sort().join(',');
  for (const h of hits) {
    if ((N(clean(h.title)) ?? '') !== want) continue;
    if (!h.authors.some((a) => authors.has(NA(a)))) continue;
    if ([...nums(h.title)].sort().join(',') !== wantNums) continue;
    return { hit: h, reason: 'title, author and volume agree' };
  }
  return {
    hit: null,
    reason: hits.length ? 'no result with the same title, author and volume' : 'no results',
  };
}

// ---------------------------------------------------------------- Natively

export const NATIVELY_SITEMAP = 'https://learnnatively.com/sitemap.xml';

/** The /book/ pages of the sitemap, with their Natively id (the slug). */
export function parseNativelySitemap(body: Buffer | string): { id: string; url: string }[] {
  const s = typeof body === 'string' ? body : body.toString('utf8');
  const out: { id: string; url: string }[] = [];
  for (const m of s.matchAll(/<loc>(https:\/\/learnnatively\.com\/book\/([0-9a-z]+)\/)<\/loc>/g)) {
    out.push({ id: m[2], url: m[1] });
  }
  return out;
}

export interface NativelyBook {
  title: string | null;
  isbn10: string | null;
  isbn13: string | null;
  /** Kindle JP ASINs from the page's store links. */
  kindleAsins: string[];
}

/** A Natively book page's own identifiers (from its Next.js data). */
export function parseNativelyBook(body: Buffer | string): NativelyBook | null {
  const h = typeof body === 'string' ? body : decodeIgnore(body);
  for (const m of h.matchAll(
    /<script>self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)<\/script>/g,
  )) {
    let s: string;
    try {
      s = JSON.parse(m[1]) as string;
    } catch {
      continue;
    }
    if (!s.includes('"item":{')) continue;
    let data: unknown;
    try {
      data = JSON.parse(s.slice(s.indexOf(':') + 1));
    } catch {
      continue;
    }
    const d = (Array.isArray(data) ? (data[3] as { data?: unknown })?.data : null) as
      | { item?: Record<string, unknown>; whereToFindUrls?: unknown }
      | null
      | undefined;
    const item = d?.item;
    if (!item) continue;
    const asins = new Set<string>();
    for (const w of Array.isArray(d.whereToFindUrls) ? d.whereToFindUrls : []) {
      const o = w as { url?: unknown; bookType?: unknown; bookProvider?: { slug?: unknown } };
      const slug = o.bookProvider?.slug;
      if (typeof o.url !== 'string') continue;
      if (
        slug !== 'amazon-kindle-jp' &&
        !(o.bookType === 'ebook' && o.url.includes('amazon.co.jp'))
      )
        continue;
      const a = /amazon\.co\.jp\/dp\/([A-Z0-9]{10})/.exec(o.url);
      if (a) asins.add(a[1]);
    }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
    return {
      title: str(item.title),
      isbn10: str(item.isbn),
      isbn13: str(item.isbn13),
      kindleAsins: [...asins],
    };
  }
  return null;
}

/** ISBN-10 to ISBN-13 (978 prefix). */
export function isbn13From10(isbn10: string): string | null {
  const d = isbn10.replace(/-/g, '');
  if (!/^\d{9}[\dX]$/.test(d)) return null;
  const core = '978' + d.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += parseInt(core[i], 10) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

// ---------------------------------------------------------------- NDL

export const NDL_SPARQL = 'https://id.ndl.go.jp/auth/ndla/sparql';

const lit = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** ndl_sparql.py's query: exact foaf:name matches, the authority's label and katakana reading. */
export function ndlQuery(names: string[]): string {
  const values = names.map((n) => `${lit(n)} ${lit(n)}@ja`).join(' ');
  return `PREFIX xl: <http://www.w3.org/2008/05/skos-xl#>
PREFIX ndl: <http://ndl.go.jp/dcndl/terms/>
PREFIX foaf: <http://xmlns.com/foaf/0.1/>
SELECT ?name ?auth ?label ?yomi WHERE {
  VALUES ?name { ${values} }
  ?ent foaf:name ?name .
  { ?auth foaf:primaryTopic ?ent } UNION { ?ent foaf:primaryTopic ?auth }
  ?auth xl:prefLabel ?pl . ?pl xl:literalForm ?label ; ndl:transcription ?yomi .
  FILTER(lang(?yomi) = "ja-Kana")
} LIMIT 1000`;
}

export interface NdlRow {
  name: string;
  auth: string;
  label: string;
  yomi: string;
}

export function parseNdl(body: Buffer | string): NdlRow[] | null {
  let d: unknown;
  try {
    d = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
  } catch {
    return null;
  }
  const b = (d as { results?: { bindings?: unknown } })?.results?.bindings;
  if (!Array.isArray(b)) return null;
  return b.map((x) => {
    const v = (k: string) =>
      String(((x as Record<string, { value?: unknown }>)[k] ?? {}).value ?? '');
    return { name: v('name'), auth: v('auth'), label: v('label'), yomi: v('yomi') };
  });
}

/** NDL's katakana reading in its own "Family, Given" form, life dates removed. */
export function ndlYomi(yomi: string): string {
  return pyStrip(yomi.replace(/,\s*[0-9?]{0,4}\s*-\s*[0-9?]{0,4}\s*$/u, ''));
}

/**
 * The reading for one name from NDL's rows (ndl:transcription @ja-Kana, "ナツメ, ソウセキ,
 * 1867-1916" -> "ナツメ, ソウセキ"). Several authorities with different readings = ambiguous (the
 * 2026-11-13 test found 7 namesakes, all with the same reading).
 */
export function ndlReading(
  rows: NdlRow[],
  name: string,
): { reading: string; authority: string; ambiguous: boolean } | null {
  const mine = rows.filter((r) => nfkc(r.name) === nfkc(name));
  if (!mine.length) return null;
  const key = (y: string) => ndlYomi(y).replace(/[,\s、]/g, '');
  const readings = new Set(mine.map((r) => key(r.yomi)));
  return { reading: ndlYomi(mine[0].yomi), authority: mine[0].auth, ambiguous: readings.size > 1 };
}
