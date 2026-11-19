/**
 * Stage 4's store answers (WP21c), parsed. Pure: text in, records out.
 *
 * Every field an answer has is kept (WP21d chooses values from them without fetching again):
 * Audible's product object as it came, and for kikubon and audiobook.jp every field their
 * pages show. Checked against the reference sample's answers (`refsample/raw`, 2026-11-17)
 * and audiobook.jp product pages from the first probe and the live site (2026-11-19).
 *
 * - Audible's catalog API answers an ASIN it doesn't sell with HTTP 200 and a product that has
 *   no title (checked 2026-11-19): that is "not on Audible", not an error.
 * - Audible's search needs `product_desc` in its response groups or titles come back empty;
 *   even with it a few results have none (15 of 648 in the sample): they are skipped.
 * - audiobook.jp shows "新着作品のご紹介" (unrelated new products) below the results, and only
 *   them when nothing matched ("検索結果がありませんでした"): never taken as results.
 * - kikubon's titles carry the narrators in brackets ("藪の中（古川登志夫、柿沼紫乃）").
 */
import { unescapeHtml } from '../stage4/ref-text';

export type StoreSource = 'audible' | 'kikubon' | 'audiobookjp';

export interface SeriesRef {
  name: string;
  /** The printed label (Audible's `sequence`: "5.5", "9・短編集", "上"). */
  sequence: string | null;
  /** The reading-order position (Audible's `sort`). */
  sort: string | null;
  id: string | null;
}

/** What every check reads, the same for each store. */
export interface StoreRecord {
  source: StoreSource;
  id: string;
  title: string;
  subtitle: string | null;
  authors: string[];
  narrators: string[];
  /** Length in seconds (Audible: whole minutes × 60). */
  seconds: number | null;
  publisher: string | null;
  releaseDate: string | null;
  series: SeriesRef[];
  /** Everything else the answer had (Audible: the product object as it came). */
  extra: Record<string, unknown>;
}

/** A search result: enough to decide whether its product page is worth reading. */
export interface SearchHit {
  source: StoreSource;
  id: string;
  title: string;
  authors: string[];
  narrators: string[];
  seconds: number | null;
  /** Audible's search results are full records already (minus a few response groups). */
  record?: StoreRecord;
}

const text = (b: Buffer | string) => (typeof b === 'string' ? b : b.toString('utf8'));

/** Tags removed, entities decoded, spaces folded. */
export function plain(html: string): string {
  return unescapeHtml(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** "HH:MM:SS" or "H時間M分S秒" (either part may be missing) as seconds. */
export function clockSeconds(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.normalize('NFKC');
  const c = /(\d+):(\d{1,2}):(\d{1,2})/.exec(t);
  if (c) return Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]);
  const h = /(\d+)\s*時間/.exec(t);
  const m = /(\d+)\s*分/.exec(t);
  const sec = /(\d+)\s*秒/.exec(t);
  if (!h && !m && !sec) return null;
  return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0);
}

// ---------------------------------------------------------------------------------------------
// Audible

interface AudibleProduct {
  asin?: string;
  title?: string;
  subtitle?: string;
  authors?: { name?: string; asin?: string }[];
  narrators?: { name?: string }[];
  runtime_length_min?: number;
  publisher_name?: string;
  release_date?: string;
  series?: { asin?: string; title?: string; sequence?: string }[];
  relationships?: {
    asin?: string;
    relationship_type?: string;
    relationship_to_product?: string;
    sequence?: string;
    sort?: string;
    title?: string;
  }[];
  sample_url?: string;
  [k: string]: unknown;
}

function names(list: { name?: string }[] | undefined): string[] {
  return (list ?? [])
    .map((x) => (typeof x?.name === 'string' ? x.name.trim() : ''))
    .filter((x) => x !== '');
}

function audibleRecord(p: AudibleProduct): StoreRecord | null {
  if (typeof p.asin !== 'string' || typeof p.title !== 'string' || p.title.trim() === '')
    return null;
  // The series relationship has both the printed label (sequence) and the reading-order
  // position (sort); the `series` list only the label. Every parent series is kept.
  const series: SeriesRef[] = [];
  for (const r of p.relationships ?? []) {
    if (r.relationship_type !== 'series' || r.relationship_to_product !== 'parent') continue;
    series.push({
      name: (r.title ?? '').trim(),
      sequence: r.sequence ?? null,
      sort: r.sort ?? null,
      id: r.asin ?? null,
    });
  }
  for (const s of p.series ?? []) {
    if (series.some((x) => x.id && x.id === s.asin)) continue;
    series.push({
      name: (s.title ?? '').trim(),
      sequence: s.sequence ?? null,
      sort: null,
      id: s.asin ?? null,
    });
  }
  return {
    source: 'audible',
    id: p.asin,
    title: p.title.trim(),
    subtitle: typeof p.subtitle === 'string' && p.subtitle.trim() ? p.subtitle.trim() : null,
    authors: names(p.authors),
    narrators: names(p.narrators),
    seconds: typeof p.runtime_length_min === 'number' ? p.runtime_length_min * 60 : null,
    publisher: typeof p.publisher_name === 'string' ? p.publisher_name : null,
    releaseDate: typeof p.release_date === 'string' ? p.release_date : null,
    series,
    extra: { ...p },
  };
}

/** The product answer (`/1.0/catalog/products/<ASIN>`); null = Audible doesn't sell it. */
export function parseAudibleProduct(body: Buffer | string): StoreRecord | null {
  try {
    const j = JSON.parse(text(body)) as { product?: AudibleProduct };
    return j.product ? audibleRecord(j.product) : null;
  } catch {
    return null;
  }
}

/** The search answer (`/1.0/catalog/products?title=…`): results with a title. */
export function parseAudibleSearch(body: Buffer | string): SearchHit[] {
  let j: { products?: AudibleProduct[] };
  try {
    j = JSON.parse(text(body)) as { products?: AudibleProduct[] };
  } catch {
    return [];
  }
  const out: SearchHit[] = [];
  for (const p of j.products ?? []) {
    const r = audibleRecord(p);
    if (!r) continue;
    out.push({
      source: 'audible',
      id: r.id,
      title: r.title,
      authors: r.authors,
      narrators: r.narrators,
      seconds: r.seconds,
      record: r,
    });
  }
  return out;
}

/** The sample answer (`response_groups=sample`): the sample audio's address, if any. */
export function parseAudibleSample(body: Buffer | string): string | null {
  try {
    const j = JSON.parse(text(body)) as { product?: AudibleProduct };
    const u = j.product?.sample_url;
    return typeof u === 'string' && /^https:\/\//.test(u) ? u : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// kikubon

/** kikubon's "名前," link lists ("下山吉光,", "浅井晴美"). */
function linkTexts(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) =>
      plain(m[1])
        .replace(/[,、，]\s*$/, '')
        .trim(),
    )
    .filter((x) => x !== '');
}

/** kikubon's search page (`searchAudiobookList.php?search=`): its result list only. */
export function parseKikubonSearch(body: Buffer | string): SearchHit[] {
  const html = text(body);
  const start = html.indexOf('<ul class="thumb_list">');
  if (start < 0) return [];
  const end = html.indexOf('</ul>', start);
  const list = html.slice(start, end < 0 ? undefined : end);
  const out: SearchHit[] = [];
  for (const li of list.split(/<li>/).slice(1)) {
    const id = /product\.php\?aKey=(\d+)/.exec(li)?.[1];
    const t = /<p class="title">([\s\S]*?)<\/p>/.exec(li)?.[1];
    if (!id || t === undefined) continue;
    const w = /<p class="writer">([\s\S]*?)<\/p>/.exec(li)?.[1] ?? '';
    const r = /<p class="reader">([\s\S]*?)<\/p>/.exec(li)?.[1] ?? '';
    if (out.some((h) => h.id === id)) continue;
    out.push({
      source: 'kikubon',
      id,
      title: plain(t),
      authors: linkTexts(w),
      narrators: linkTexts(r),
      seconds: null,
    });
  }
  return out;
}

/** kikubon's product page (`product.php?aKey=N`); null when it isn't one (no title). */
export function parseKikubonProduct(body: Buffer | string, id: string): StoreRecord | null {
  const html = text(body);
  const info = /<section class="book_info[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  const title = /<h2 class="title">([\s\S]*?)<\/h2>/.exec(info)?.[1];
  if (title === undefined || plain(title) === '') return null;
  const p = (cls: string) =>
    new RegExp(`<p class="${cls}">([\\s\\S]*?)</p>`).exec(info)?.[1] ?? null;
  const sub: Record<string, string> = {};
  for (const m of info.matchAll(/<p class="sub_text">([\s\S]*?)<\/p>/g)) {
    const t = plain(m[1]);
    const k = /^([^：:]+)[：:]\s*(.*)$/s.exec(t);
    if (k) sub[k[1].trim()] = k[2].trim();
  }
  const ptime = p('ptime');
  const genre = p('genre');
  const desc = /<div id="acHalf" class="description">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;
  const chapters = [
    ...html.matchAll(
      /<p class="index_title">([\s\S]*?)<br>[\s\S]*?<span class="time_text">([^<]*)<\/span>/g,
    ),
  ].map((m) => ({ title: plain(m[1]), seconds: clockSeconds(m[2]) }));
  const sample = /<source src="([^"]+)" type="audio\/mpeg">/.exec(info)?.[1] ?? null;
  const awards = [...html.matchAll(/<div class="doc2">([\s\S]*?)<\/div>/g)].map((m) => plain(m[1]));
  return {
    source: 'kikubon',
    id,
    title: plain(title),
    subtitle: null,
    authors: linkTexts(p('writer') ?? ''),
    narrators: linkTexts(p('reader') ?? ''),
    seconds: clockSeconds(ptime ? plain(ptime) : null),
    publisher: sub['出版社'] ?? null,
    releaseDate: null,
    series: [],
    extra: {
      runtimeText: ptime ? plain(ptime).replace(/^総朗読時間[：:]\s*/, '') : null,
      genre: genre ? linkTexts(genre) : [],
      fields: sub,
      description: desc === null ? null : plain(desc),
      highlights: awards,
      chapters,
      sampleUrl: sample,
      cover: /<img src="([^"]+)" alt="[^"]*">/.exec(info)?.[1] ?? null,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// audiobook.jp

/** audiobook.jp's search page (`search?q=`): its results, never the new-arrivals lane below. */
export function parseAbjpSearch(body: Buffer | string): SearchHit[] {
  let html = text(body);
  if (html.includes('検索結果がありませんでした')) return [];
  const cut = html.indexOf('新着作品のご紹介');
  if (cut >= 0) html = html.slice(0, cut);
  const out: SearchHit[] = [];
  const boxes = html.split('<div class="product-box media" data-product-id="').slice(1);
  for (const box of boxes) {
    const id = /^(\d+)"/.exec(box)?.[1];
    if (!id || out.some((h) => h.id === id)) continue;
    const g = (cls: string) =>
      new RegExp(`class="product-box__${cls}"[^>]*>([\\s\\S]*?)</div>`).exec(box)?.[1] ?? '';
    const title = /product-box__title"[^>]*>([\s\S]*?)<\/a>/.exec(box)?.[1] ?? '';
    const people = (s: string) =>
      plain(s)
        .split(/[,，、]/)
        .map((x) => x.trim())
        .filter((x) => x !== '' && x !== '-');
    out.push({
      source: 'audiobookjp',
      id,
      title: plain(title),
      authors: people(g('info--author')),
      narrators: people(g('info--narrator')),
      seconds: clockSeconds(plain(g('info--playtime'))),
    });
  }
  return out;
}

/** audiobook.jp's product page (`/product/N`); null when it isn't one (no title). */
export function parseAbjpProduct(body: Buffer | string, id: string): StoreRecord | null {
  const html = text(body);
  const title = /<h1 class="show-product-detail__title">([\s\S]*?)<\/h1>/.exec(html)?.[1];
  if (title === undefined || plain(title) === '') return null;
  const links = (cls: string) =>
    [
      ...html.matchAll(
        new RegExp(`<a class="show-product-detail__${cls}"[^>]*>([\\s\\S]*?)</a>`, 'g'),
      ),
    ]
      .map((m) => plain(m[1]))
      .filter((x) => x !== '' && x !== '-');
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<p><strong>([^<]+)<\/strong>([\s\S]*?)<\/p>/g)) {
    fields[plain(m[1])] = plain(m[2]);
  }
  const desc =
    /(?:id|class)="discription-text__content-inner">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null;
  const genres = [
    ...(
      /<h2 class="has-text-centered is-size-5 mt-6">ジャンル<\/h2>([\s\S]*?)<\/ul>/.exec(
        html,
      )?.[1] ?? ''
    ).matchAll(/<li>([\s\S]*?)<\/li>/g),
  ].map((m) => linkTexts(m[1]));
  const sample = /<audio id="sample-audio"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1] ?? null;
  const cover = /<img class="show-product-detail__coverart-image" src="([^"]+)"/.exec(html)?.[1];
  return {
    source: 'audiobookjp',
    id,
    title: plain(title),
    subtitle: null,
    authors: links('author'),
    narrators: links('narrator'),
    seconds: clockSeconds(fields['再生時間'] ?? null),
    publisher: fields['出版社'] ?? null,
    releaseDate: fields['出版日'] ?? fields['販売開始日'] ?? null,
    series: [],
    extra: {
      fields,
      description: desc === null ? null : plain(desc),
      genres,
      sampleUrl: sample === null ? null : unescapeHtml(sample),
      cover: cover ? unescapeHtml(cover) : null,
    },
  };
}
