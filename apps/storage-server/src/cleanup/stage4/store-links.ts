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
import { chosenDecision, type ChosenBook } from './bookmeter-rules';

// ---------------------------------------------------------------- Bookmeter

export interface BookmeterHit {
  id: string;
  /**
   * The whole title: the cover picture's alt text (Bookmeter's list cuts long titles at about 22
   * characters with "…"; More Bookmeter coverage, step 2), else the list's text. Results stored
   * before step 2 hold the list's text here and have no listTitle.
   */
  title: string;
  /** The list's own text (cut when long); set by the parser since step 2. */
  listTitle?: string;
  authors: string[];
  pages: number | null;
}

/**
 * Bookmeter's search of Japanese books. Not type=japanese_v2: that index misses many books the
 * plain one finds (proven 2026-11-19: 13,955 of 30,168 searches came back empty with v2; of 19
 * of them asked again with type=japanese, 15 found the exact book first). Its requests use
 * BOOKMETER_SEARCH_KEY so an answer from the old index is never reused.
 */
export function bookmeterSearchUrl(title: string, author?: string | null): string {
  // More Bookmeter coverage's second search (Q2): the first author in Bookmeter's own author
  // field, as step 1 asked it (encodeURIComponent; the keyword keeps pyQuote).
  const au = author ? encodeURIComponent(author) : '';
  return `https://bookmeter.com/search?author=${au}&keyword=${pyQuote(title)}&partial=true&sort=recommended&type=japanese`;
}

/** The queue key of More Bookmeter coverage's Q2 search (the author field filled). */
export const BOOKMETER_AUTHOR_SEARCH_KEY = 'search-jp-au:';

/** The queue key of a Bookmeter search (type=japanese); the old index's were `search:<title>`. */
export const BOOKMETER_SEARCH_KEY = 'search-jp:';

/** True for a Bookmeter search address that asked the old index. */
export function oldBookmeterSearch(url: string): boolean {
  return url.includes('type=japanese_v2');
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
    // The same item's cover picture carries the whole title (on the 777,100 stored results:
    // present for every one, still cut for 116).
    const alt = /<a href="\/books\/(\d+)"><img alt="([^"]*)"/.exec(li);
    const whole = alt && alt[1] === t[1] ? unescapeHtml(alt[2]).trim() : '';
    const listTitle = textOf(t[2]);
    const authorsBlock = /<ul class="detail__authors">([\s\S]*?)<\/ul>/.exec(li)?.[1] ?? '';
    const authors = [...authorsBlock.matchAll(/<a[^>]*>([^<]*)<\/a>/g)].map((m) =>
      pyStrip(unescapeHtml(m[1])),
    );
    const pages = /<div class="detail__page">(\d+)<\/div>/.exec(li);
    out.push({
      id: t[1],
      title: whole || listTitle,
      listTitle,
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

const VOLUME_NOTE = /^(?:第?[0-9一二三四五六七八九十百]+[巻話部]?|[上中下]|前編|中編|後編)$/u;
/** A store bonus of the e-book itself (【電子特典付き】, 【イラスト特典付き】, 【電子書籍限定短編】). */
const BONUS_NOTE = /特典|限定|SS|書き下ろし|書下ろし|イラスト付|イラスト入|短編/u;
/** Still an edition when a bonus is named with it (【新装版・イラスト三枚入り】). */
const EDITION_NOTE = /特別版|新装版|特装|完全版|増補|改訂|大活字|横書き|合本|総集編|愛蔵版|復刻/u;

/**
 * The 【…】 notes of a title that name an edition or a collection (【大活字シリーズ】,
 * 【新装版】, 【合本版】): not a volume number (【3】, 【第3巻】, 【上】) and not a store bonus,
 * which marks the e-book itself (measured on the library, WP20e: 【イラスト特典付き】 and
 * 【電子書籍限定書き下ろしSS付き】 hits were the books' own e-book editions, by their ASIN).
 */
export function editionNotes(title: string): string[] {
  return [...nfkc(title).matchAll(/【([^】]*)】/gu)]
    .map((m) => m[1].trim())
    .filter(
      (x) => x !== '' && !VOLUME_NOTE.test(x) && (EDITION_NOTE.test(x) || !BONUS_NOTE.test(x)),
    );
}

/** The reason of a match the chosen rules accepted (acceptBookmeter's second tier). */
export const WHOLE_TITLE_REASON =
  'the whole titles agree (labels, series brackets and a trailing series name set aside), an author and the volume';

/**
 * Match acceptance for Bookmeter (plan section 6): the title, an author and the volume must all
 * agree with the book's decided values. Bookmeter's titles carry the label ("(GAノベル)"), so
 * both sides go through rules v3's clean(), which drops 【…】 notes. WP20e: a hit whose title
 * holds an edition note (editionNotes) the book itself doesn't have is another edition:
 * rejected, and the next hit is tried. The book's own texts are its titles (file, Calibre), the
 * title of the Amazon record the rules identified, and the file's first and last pages (the
 * colophon prints the edition: 【大活字シリーズ】悪の説得術 is that edition's own e-book).
 *
 * More Bookmeter coverage, step 2 (user, 2026-11-23): this first tier runs on the list's own text
 * (`listTitle`, or `title` for results stored before step 2), so a book decides exactly as before
 * and today's matches stay. When it accepts nothing and `chosen` is given, the second tier runs
 * the rules the user chose (bookmeter-rules.ts CHOSEN_RULES) on the whole titles.
 */
export function acceptBookmeter(
  hits: BookmeterHit[],
  book: {
    title: string;
    authors: string[];
    own?: (string | null | undefined)[];
    /** The chosen rules' other inputs (stage 4's decided series and format, Calibre's title). */
    chosen?: Omit<ChosenBook, 'title' | 'authors'>;
  },
): { hit: BookmeterHit; reason: string } | { hit: null; reason: string } {
  const own = (book.own ?? [book.title])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => nfkc(t));
  const edOk = (title: string) => !editionNotes(title).some((n) => !own.some((t) => t.includes(n)));
  let edition = false;
  const want = N(clean(book.title)) ?? '';
  if (!want) return { hit: null, reason: 'no title to compare' };
  const authors = new Set(book.authors.map((a) => NA(a)));
  const wantNums = [...nums(book.title)].sort().join(',');
  for (const h of hits) {
    const listed = h.listTitle ?? h.title;
    if ((N(clean(listed)) ?? '') !== want) continue;
    if (!h.authors.some((a) => authors.has(NA(a)))) continue;
    if ([...nums(listed)].sort().join(',') !== wantNums) continue;
    if (!edOk(listed)) {
      edition = true;
      continue;
    }
    return { hit: h, reason: 'title, author and volume agree' };
  }
  if (book.chosen && hits.length) {
    const r = chosenDecision(
      hits.map((h) => ({
        ...h,
        title: h.listTitle ?? h.title,
        full: h.listTitle !== undefined ? h.title : null,
      })),
      { ...book.chosen, title: book.title, authors: book.authors },
      edOk,
    );
    const hit = r.hit ? hits.find((h) => h.id === r.hit!.id) : undefined;
    if (hit) return { hit, reason: WHOLE_TITLE_REASON };
  }
  return {
    hit: null,
    reason: edition
      ? 'only another edition (a 【…】 edition note the book itself does not have)'
      : hits.length
        ? 'no result with the same title, author and volume'
        : 'no results',
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
 * The reading of the name itself from one NDL row: NDL's label and reading have the same parts
 * ("青木, 邦子, 陶芸家" / "アオキ, クニコ, トウゲイカ"), and the parts after the name are notes
 * telling namesakes apart (a profession, "pub. 2013", "1886- 薬剤師"; the live Preview of
 * 2026-11-22 found them written into author_sort). The name's parts are the label's first parts
 * that spell the name; without such a label, the parts with a year and those after the second.
 */
export function ndlNameReading(row: NdlRow, name: string): string {
  // Notes in brackets at the end ("堤 (家)" / "ツツミ (ケ)", "角川書店 (2003年)"), unless the
  // name ends with one.
  const paren = /\s*[(（][^()（）]*[)）]\s*$/u;
  let label = row.label.trim();
  let yomi = row.yomi.trim();
  while (!paren.test(nfkc(name)) && paren.test(label) && paren.test(yomi)) {
    label = label.replace(paren, '');
    yomi = yomi.replace(paren, '');
  }
  // The reading's first k parts as NDL wrote them (its spacing kept).
  const commas = [...yomi.matchAll(/\s*,\s*/gu)];
  const cut = (k: number) => pyStrip(k > commas.length ? yomi : yomi.slice(0, commas[k - 1].index));
  const parts = label.split(/\s*,\s*/u);
  const squash = (t: string) => nfkc(t).replace(/[\s・･,、]/gu, '');
  const want = squash(name);
  if (parts.length === commas.length + 1)
    for (let k = 1; k <= parts.length; k++)
      if (squash(parts.slice(0, k).join('')) === want) return cut(k);
  const second = commas.length
    ? yomi.slice(commas[0].index! + commas[0][0].length).split(/\s*,\s*/u)[0]
    : '';
  return cut(second && !/[0-9]|pub\./u.test(second) ? 2 : 1);
}

/**
 * The reading for one name from NDL's rows (ndl:transcription @ja-Kana, "ナツメ, ソウセキ,
 * 1867-1916" -> "ナツメ, ソウセキ"; notes after the name are left out). Namesakes read
 * differently = ambiguous, a best guess (渡部正和: ワタナベ for one, ワタベ for another): the
 * reading of the authority with no note first (the name's main entry), else the most common one;
 * `prefer` (the reading chosen before) when it is one of them. `forms`: each reading as it was
 * stored before notes were left out (ndlYomi), with the name's own reading.
 */
export function ndlReading(
  rows: NdlRow[],
  name: string,
  prefer?: string | null,
): {
  reading: string;
  authority: string;
  ambiguous: boolean;
  forms: [string, string][];
} | null {
  const mine = rows.filter((r) => nfkc(r.name) === nfkc(name));
  if (!mine.length) return null;
  const key = (y: string) => y.replace(/[,\s、]/gu, '');
  const read = mine.map((r) => ({ r, reading: ndlNameReading(r, name) }));
  const counts = new Map<string, number>();
  for (const x of read) counts.set(key(x.reading), (counts.get(key(x.reading)) ?? 0) + 1);
  const plain = read.find((x) => key(x.r.label) !== '' && key(x.r.label) === key(nfkc(name)));
  const common = [...read].sort(
    (a, b) => (counts.get(key(b.reading)) ?? 0) - (counts.get(key(a.reading)) ?? 0),
  )[0];
  const kept = prefer ? read.find((x) => key(x.reading) === key(prefer)) : undefined;
  const pick = kept ?? plain ?? common;
  return {
    reading: pick.reading,
    authority: pick.r.auth,
    ambiguous: counts.size > 1,
    forms: read.map((x) => [ndlYomi(x.r.yomi), x.reading]),
  };
}
