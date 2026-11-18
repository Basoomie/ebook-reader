/**
 * Stage 4 page parsers (WP20d), ported line by line from the reference fetcher ref4.py
 * (parse_amazon_dp, parse_amazon_search, parse_bw_list, parse_bw_detail and the RanobeDB
 * extraction), so the rules see the same evidence the measurement saw. Proven against the
 * reference run's cached pages (scripts/prove-stage4-parsers.ts).
 */
import { pyStrip } from '../title-rules';
import { decodeIgnore, nfkc, textOf, unescapeHtml } from './ref-text';

export interface AmazonAuthor {
  name: string;
  role: string;
}

export interface AmazonProduct {
  title: string;
  asin: string | null;
  authors: AmazonAuthor[];
  description: string;
  series: string;
  breadcrumbs: string[];
  rank_categories: string[];
  cover_url: string | null;
  publisher: string | null;
}

const html = (b: Buffer | string) => (typeof b === 'string' ? b : decodeIgnore(b));

export function parseAmazonDp(body: Buffer | string): AmazonProduct {
  const h = html(body);
  const ti = /id="productTitle"[^>]*>([\s\S]*?)<\/span>/.exec(h);
  const asin = /<link rel="canonical" href="[^"]*\/dp\/([A-Z0-9]{10})/.exec(h);
  const authors: AmazonAuthor[] = [];
  for (const m of h.matchAll(
    /<span class="author[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>[\s\S]*?<span class="a-color-secondary">\(([^)]+)\)/g,
  )) {
    authors.push({ name: pyStrip(unescapeHtml(m[1])), role: m[2] });
  }
  const de =
    /id="bookDescription_feature_div"[\s\S]*?a-expander-content[^>]*>([\s\S]*?)<\/div>/.exec(h);
  let series = '';
  const i = h.indexOf('data-rpi-attribute-name="book_details-series"');
  if (i > 0) {
    const j = h.indexOf('>', i) + 1;
    series = pyStrip(
      textOf(cpSlice(h, j, 3000))
        .replace(/\n/g, ' ')
        .split(/本の長さ|言語|出版社/)[0],
    );
  }
  const bc = /id="wayfinding-breadcrumbs_feature_div"([\s\S]*?)<\/ul>/.exec(h);
  const crumbs = bc
    ? [...bc[1].matchAll(/<a[^>]*>\s*([^<]+?)\s*<\/a>/g)].map((m) => pyStrip(unescapeHtml(m[1])))
    : [];
  const rank = /売れ筋ランキング[\s\S]*?<\/ul>/.exec(h);
  const rankCats = rank
    ? [...rank[0].matchAll(/<a[^>]*>([^<]+)<\/a>/g)].map((m) => pyStrip(unescapeHtml(m[1])))
    : [];
  const cov = /"hiRes":"(https:[^"]+)"/.exec(h) ?? /data-old-hires="(https:[^"]+)"/.exec(h);
  const img = /https:\/\/m\.media-amazon\.com\/images\/I\/([A-Za-z0-9+%-]+)\./.exec(h);
  const pub =
    /data-rpi-attribute-name="book_details-publisher"[\s\S]*?<span>([^<]+)<\/span>\s*<\/span>\s*<\/div>\s*<\/div>/.exec(
      h,
    );
  return {
    title: ti ? pyStrip(unescapeHtml(ti[1])) : '',
    asin: asin ? asin[1] : null,
    authors,
    description: de ? textOf(de[1]) : '',
    series,
    breadcrumbs: crumbs,
    rank_categories: rankCats,
    cover_url: cov ? cov[1] : img ? `https://m.media-amazon.com/images/I/${img[1]}.jpg` : null,
    publisher: pub ? pyStrip(unescapeHtml(pub[1])) : null,
  };
}

/** Python slices strings by code point; JS by UTF-16 unit. Slice `len` code points from `from`. */
function cpSlice(s: string, from: number, len: number): string {
  let end = from;
  let n = 0;
  while (end < s.length && n < len) {
    const c = s.charCodeAt(end);
    end += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
    n += 1;
  }
  return s.slice(from, end);
}

export type Candidate = [string, string];

export function parseAmazonSearch(body: Buffer | string): Candidate[] {
  const h = html(body);
  const out: Candidate[] = [];
  for (const m of h.matchAll(
    /data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"/g,
  )) {
    const end = m.index! + m[0].length;
    const seg = cpSlice(h, end, 15000);
    const t = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(seg);
    out.push([m[1], t ? textOf(t[1]).replace(/\n/g, ' ') : '']);
  }
  if (out.length === 0) {
    for (const blk of h.split('data-component-type="s-search-result"').slice(1)) {
      const a = /\/dp\/([A-Z0-9]{10})/.exec(blk);
      const t = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(blk);
      if (a) out.push([a[1], t ? textOf(t[1]).replace(/\n/g, ' ') : '']);
    }
  }
  const seen = new Set<string>();
  const res: Candidate[] = [];
  for (const [a, t] of out) {
    if (seen.has(a)) continue;
    seen.add(a);
    res.push([a, t]);
  }
  return res.slice(0, 10);
}

const BW_ITEM =
  /<a href="(https:\/\/bookwalker\.jp\/(?:de[0-9a-f-]{20,}|series\/\d+\/list)\/)"\s+class="m-book-item__title"[^>]*?title="([^"]*)"/g;

export function parseBwList(body: Buffer | string): Candidate[] {
  return [...html(body).matchAll(BW_ITEM)].map((m) => [m[1], unescapeHtml(m[2])] as Candidate);
}

export interface BwDetail {
  title: string;
  description: string;
  image: unknown;
  keywords: string;
  tags: string[];
}

export function parseBwDetail(body: Buffer | string): BwDetail {
  const h = html(body);
  let d: Record<string, unknown> = {};
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(h);
  if (m) {
    try {
      const v = JSON.parse(m[1]) as unknown;
      d =
        typeof v === 'object' && v !== null && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : {};
    } catch {
      d = {};
    }
  }
  const kw = /<meta name="keywords" content="([^"]*)"/.exec(h);
  const tags = [
    ...h.matchAll(/href="https:\/\/bookwalker\.jp\/tag\/\d+\/[^"]*"[^>]*>([^<]+)</g),
  ].map((x) => x[1]);
  return {
    title: typeof d.name === 'string' ? d.name : '',
    description: typeof d.description === 'string' ? d.description : '',
    image: d.image ?? null,
    keywords: kw ? unescapeHtml(kw[1]) : '',
    tags,
  };
}

/** json.loads that answers {} for anything unreadable (ref4's jload). */
export function jload(b: Buffer | string | null | undefined): Record<string, unknown> {
  if (b === null || b === undefined) return {};
  try {
    const v = JSON.parse(typeof b === 'string' ? b : b.toString('utf8')) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface RdbBook {
  id: unknown;
  title_orig: unknown;
  description_ja: unknown;
  series: { id: unknown; title_orig: unknown } | null;
  staff: { name: unknown; role: unknown }[];
  isbn13: unknown[];
}

/** ref4's RanobeDB book extraction (the /book/<id> answer). */
export function rdbBook(answer: Obj): RdbBook {
  const book = obj('book' in answer ? answer.book : answer);
  const ser = obj(book.series);
  return {
    id: book.id ?? null,
    title_orig: book.title_orig ?? null,
    description_ja: book.description_ja ?? null,
    series: Object.keys(ser).length
      ? { id: ser.id ?? null, title_orig: ser.title_orig ?? null }
      : null,
    staff: arr(book.editions).flatMap((e) =>
      arr(obj(e).staff).map((st) => ({
        name: obj(st).name ?? null,
        role: obj(st).role_type ?? null,
      })),
    ),
    isbn13: arr(book.releases)
      .map((r) => obj(r).isbn13)
      .filter((x) => x),
  };
}

export interface RdbSeries {
  title_orig: unknown;
  tags: { name: unknown; type: unknown }[];
  books: { id: unknown; sort_order: unknown; type: unknown; title_orig: unknown }[];
  bookwalker_id: unknown;
}

export function rdbSeries(answer: Obj): RdbSeries {
  const s = obj('series' in answer ? answer.series : answer);
  return {
    title_orig: s.title_orig ?? null,
    tags: arr(s.tags).map((t) => ({ name: obj(t).name ?? null, type: obj(t).ttype ?? null })),
    books: arr(s.books).map((x) => ({
      id: obj(x).id ?? null,
      sort_order: obj(x).sort_order ?? null,
      type: obj(x).book_type ?? null,
      title_orig: obj(x).title_orig ?? null,
    })),
    bookwalker_id: s.bookwalker_id ?? null,
  };
}

/** The RanobeDB search answer's candidates (id, original title). */
export function rdbCandidates(answer: Obj): [unknown, string][] {
  return arr(answer.books).map((x) => {
    const h = obj(x);
    const t = (h.title_orig as string) || (h.title as string) || '';
    return [h.id, t];
  });
}

/** True when RanobeDB's staff includes the queried author (ref4's author_match). */
export function rdbAuthorMatch(book: RdbBook, author: string): boolean {
  if (!author) return true;
  const staff = new Set(
    book.staff.map((x) => nfkc(String(x.name ?? '')).replace(/[\s\u3000]/g, '')),
  );
  return staff.has(nfkc(author));
}
