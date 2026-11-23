/**
 * More Bookmeter coverage, step 1 (measuring only): acceptBookmeter's four checks taken apart,
 * per search result, and the candidate rule changes the user chooses from. Pure; used by
 * scripts/bookmeter-coverage-measure.ts and tested in tests/bookmeter-coverage.test.ts. Nothing
 * here is used by the running stages.
 */
import { N, NA, nfkc } from '../../src/cleanup/title-rules';
import { clean } from '../../src/cleanup/stage4/rules-v3';
import { nums } from '../../src/cleanup/stage4/pick';
import type { BookmeterHit, StoreIds } from '../../src/cleanup/stage4/store-links';
import { unescapeHtml } from '../../src/cleanup/stage4/ref-text';

export interface BookRow {
  uuid: string;
  cid: number;
  /** The label's id when the book is labeled. */
  gid: string | null;
  /** Stage 4's decided values (the rules', as acceptBookmeter is given them). */
  t: string;
  au: string[];
  se: string | null;
  ix: number | null;
  kind: string | null;
  /** The decided format (light novel, novel, nonfiction, manga, image-only). */
  fmt?: string | null;
  calTitle: string;
  opfTitle: string | null;
  /** Bookmeter's hits; edOk: the edition check passes (no 【…】 edition the book lacks). */
  hits: Hit[];
  searched: boolean;
  /** The accepted hit stored in cleanup.db, and the one today's code accepts. */
  stored: string | null;
  base: string | null;
  stores: StoreIds | null;
  /** The search answer's file in the fetch cache (relative to the cache folder). */
  searchFile: string | null;
}

/** A stored hit; full: the whole title from the cached page (null when not read). */
export type Hit = BookmeterHit & { edOk: boolean; full?: string | null; edOkFull?: boolean | null };

export type Check = 'title' | 'author' | 'volume' | 'edition';
export const CHECKS: Check[] = ['title', 'author', 'volume', 'edition'];

/** A rule set: how each of the four checks is judged. The baseline is acceptBookmeter's. */
export interface Rules {
  title: (book: BookRow, hit: BookmeterHit) => boolean;
  author: (book: BookRow, hit: BookmeterHit) => boolean;
  volume: (book: BookRow, hit: BookmeterHit) => boolean;
}

const numKey = (s: string) => [...nums(s)].sort().join(',');

export const baseTitle = (book: BookRow, hit: BookmeterHit): boolean =>
  (N(clean(hit.title)) ?? '') === (N(clean(book.t)) ?? '') && (N(clean(book.t)) ?? '') !== '';
export const baseAuthor = (book: BookRow, hit: BookmeterHit): boolean => {
  const want = new Set(book.au.map((a) => NA(a)));
  return hit.authors.some((a) => want.has(NA(a)));
};
export const baseVolume = (book: BookRow, hit: BookmeterHit): boolean =>
  numKey(hit.title) === numKey(book.t);

export const BASE: Rules = { title: baseTitle, author: baseAuthor, volume: baseVolume };

/** The checks a hit fails under a rule set (edition is the stored edOk). */
export function failed(
  rules: Rules,
  book: BookRow,
  hit: BookmeterHit & { edOk: boolean },
): Check[] {
  const out: Check[] = [];
  if (!rules.title(book, hit)) out.push('title');
  if (!rules.author(book, hit)) out.push('author');
  if (!rules.volume(book, hit)) out.push('volume');
  if (!hit.edOk) out.push('edition');
  return out;
}

/** acceptBookmeter under a rule set: the first hit that passes all four checks. */
export function accept(rules: Rules, book: BookRow): BookmeterHit | null {
  if (!(N(clean(book.t)) ?? '')) return null;
  for (const h of book.hits) if (failed(rules, book, h).length === 0) return h;
  return null;
}

/**
 * Bigram similarity of two cleaned titles (Dice), used only to pick the closest result among
 * results that fail as many checks.
 */
const cleanKeys = new Map<string, string>();
const cleanKey = (s: string): string => {
  let k = cleanKeys.get(s);
  if (k === undefined) {
    k = N(clean(s)) ?? '';
    cleanKeys.set(s, k);
  }
  return k;
};

export function titleSimilarity(a: string, b: string): number {
  const x = cleanKey(a);
  const y = cleanKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    const cs = [...s];
    for (let i = 0; i < cs.length - 1; i++) {
      const g = cs[i] + cs[i + 1];
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let both = 0;
  for (const [g, c] of gx) both += Math.min(c, gy.get(g) ?? 0);
  const total =
    [...gx.values()].reduce((s, c) => s + c, 0) + [...gy.values()].reduce((s, c) => s + c, 0);
  return total ? (2 * both) / total : 0;
}

/** The closest result: fewest failed checks, then the most similar title, then Bookmeter's order. */
export function closest(
  rules: Rules,
  book: BookRow,
): { hit: BookmeterHit & { edOk: boolean }; failed: Check[]; index: number } | null {
  let best: {
    hit: BookmeterHit & { edOk: boolean };
    failed: Check[];
    index: number;
    sim: number;
  } | null = null;
  book.hits.forEach((hit, index) => {
    const f = failed(rules, book, hit);
    const sim = titleSimilarity(book.t, hit.title);
    if (
      !best ||
      f.length < best.failed.length ||
      (f.length === best.failed.length && sim > best.sim + 1e-9)
    )
      best = { hit, failed: f, index, sim };
  });
  return best;
}

export const groupName = (f: Check[]): string => (f.length ? f.join('+') : 'passes');

export { N, NA, nfkc, clean, nums };

// ---------------------------------------------------------------- the full titles

/**
 * Bookmeter's search list cuts a title at about 22 characters with "…" in the link text; the
 * cover picture's alt text in the same item holds the whole title (checked on the cached
 * answers). Returns id → the whole title.
 */
export function parseFullTitles(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const li of html.split('<li class="group__book">').slice(1)) {
    const m = /<a href="\/books\/(\d+)"><img alt="([^"]*)"/.exec(li);
    if (m && !out.has(m[1])) out.set(m[1], unescapeHtml(m[2]).trim());
  }
  return out;
}

/** True when the list's title was cut ("…" at its end). */
export const cut = (t: string): boolean => /…$/u.test(t.trim());

// ---------------------------------------------------------------- candidate rules

export interface Options {
  /** The whole title from the cover's alt text instead of the list's cut one. */
  full?: boolean;
  /** Any trailing (…) dropped on both sides unless it only holds a volume. */
  paren?: boolean;
  /** One title is the other plus a subtitle after a separator. */
  sub?: boolean;
  /** The book's title is its series + the hit's title (numbers set aside; volume checked apart). */
  front?: boolean;
  /** Authors split at , 、 / and role marks dropped (原作, 編著, 訳, …). */
  authSplit?: boolean;
  /** ・ = and similar marks ignored in names (プーシキン, ハセガワ・ケイスケ). */
  authDot?: boolean;
  /** Old and new kanji forms of names counted alike (國/国, 螢/蛍, 澤/沢, …). */
  authKanji?: boolean;
  /** Volume numbers read from the cleaned titles (no label codes such as "す 9-5"). */
  volClean?: boolean;
  /** The series position counts as the book's number as well as the title's numbers. */
  volIx?: boolean;
  /** The shortest title (in N() characters) the subtitle rule takes as a whole title. */
  subMin?: number;
  /**
   * Guard: no match when the book's Calibre title and its decided title disagree on the numbers
   * (the decided title may have lost the volume: 捨てられ勇者は帰宅中…2).
   */
  volGuard?: boolean;
  /** Guard: a result with a comic label (コミックス, COMICS, …) only for a book whose own titles have one. */
  comicGuard?: boolean;
  /** Guard: a result with a comic label only for a book decided as manga or image-only. */
  comicFmt?: boolean;
  /** Today's accepted match is kept; only books without one are decided by the candidate rules. */
  keep?: boolean;
  /**
   * The whole title repeats the series after the title (Bookmeter's form): a trailing <…>, or
   * trailing words that are the book's series or the title's own start (シリーズ, 『』 aside).
   */
  seriesTail?: boolean;
}

export const COMIC_LABEL = /コミックス|COMICS|Comics|コミック|ＣＯＭＩＣＳ|マンガ|漫画/u;

const VOLUME_ONLY =
  /^(?:第?[0-9０-９一二三四五六七八九十百]+[巻話部]?|[上中下]|前編|中編|後編|上巻|中巻|下巻)$/u;

/** Drops trailing (…) parts (labels, series) unless they only hold a volume. */
export function dropParens(t: string): string {
  let s = nfkc(t).trim();
  for (;;) {
    const m = /\s*[(（]([^()（）]*)[)）]\s*$/u.exec(s);
    if (!m || VOLUME_ONLY.test(m[1].trim())) return s;
    const rest = s.slice(0, m.index).trim();
    if (!rest) return s;
    s = rest;
  }
}

/** A cut title's unclosed label fragment at the end ("… (星海社FICTI…") dropped. */
function dropCutTail(t: string): string {
  return t
    .replace(/\s*[(（][^()（）]*…$/u, '')
    .replace(/…$/u, '')
    .trim();
}

const hitText = (o: Options, hit: Hit): string => (o.full && hit.full ? hit.full : hit.title);

function titleText(o: Options, s: string): string {
  let c = clean(s) ?? '';
  if (o.paren) c = dropParens(dropCutTail(c));
  return c;
}

const SEP = /^[\s~～〜\-―‐─—:：「『(（<〈《【／/]/u;

/** One title (raw, cleaned) is the other plus a subtitle after a separator. */
export function subtitleMatch(a: string, b: string, min = 4): boolean {
  const na = N(a) ?? '';
  const nb = N(b) ?? '';
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long, nlong] = na.length < nb.length ? [na, b, nb] : [nb, a, na];
  if ([...short].length < min || !nlong.startsWith(short)) return false;
  const L = nfkc(long);
  // The smallest raw prefix of the longer title that normalizes to the shorter one.
  for (let i = 1; i <= L.length; i++) {
    const k = N(L.slice(0, i)) ?? '';
    if (k.length < short.length) continue;
    if (k !== short) return false;
    const rest = L.slice(i);
    return rest === '' || SEP.test(rest);
  }
  return false;
}

/** Drops a trailing <series> and trailing words that repeat the series or the title's start. */
export function dropSeriesTail(t: string, series: string | null): string {
  let s = nfkc(t)
    .replace(/\s*<[^<>]*>\s*$/u, '')
    .trim();
  const m = /^(.*\S)\s+(\S.*)$/u.exec(s);
  if (m) {
    const tail = N(m[2].replace(/シリーズ$/u, '').replace(/[『』]/gu, '')) ?? '';
    const head = N(m[1]) ?? '';
    const ns = N(series) ?? '';
    if ([...tail].length >= 3 && ((ns && tail === ns) || head.startsWith(tail))) s = m[1];
  }
  return s;
}

const stripNums = (s: string) => s.replace(/\p{Nd}+(?:\.\p{Nd}+)?/gu, '').replace(/[上中下]$/u, '');

/** The book's title without its series in front equals the hit's (numbers set aside). */
export function seriesFrontMatch(
  bookTitle: string,
  series: string | null,
  hitTitle: string,
): boolean {
  if (!series) return false;
  const nb = N(bookTitle) ?? '';
  const ns = N(series) ?? '';
  const nh = N(hitTitle) ?? '';
  if (!ns || !nb.startsWith(ns)) return false;
  const rest = stripNums(nb.slice(ns.length));
  const other = stripNums(nh.startsWith(ns) ? nh.slice(ns.length) : nh);
  return [...rest].length >= 3 && rest === other;
}

const ROLES =
  '原作|原案|著者|著|編著|編集|編|翻訳|訳|監修|監訳|作画|作|文|絵|画|イラスト|漫画|写真|構成|脚本';
const ROLE_ONLY = new RegExp(`^(?:${ROLES}|他|ほか)$`, 'u');
const ROLE_PREFIX = new RegExp(`^[(（\\[［【〔]\\s*(?:${ROLES})\\s*[)）\\]］】〕]\\s*`, 'u');
const ROLE_SUFFIX = new RegExp(
  `\\s*[(（\\[［【〔]?\\s*(?:原作|原案|編著|編集|編|著|翻訳|訳|監修|監訳)\\s*[)）\\]］】〕]?$`,
  'u',
);

const KANJI_OLD: Record<string, string> = {
  國: '国',
  螢: '蛍',
  澤: '沢',
  邊: '辺',
  邉: '辺',
  齋: '斎',
  齊: '斉',
  髙: '高',
  﨑: '崎',
  嶋: '島',
  濱: '浜',
  櫻: '桜',
  廣: '広',
  黑: '黒',
  壽: '寿',
  惠: '恵',
  眞: '真',
  實: '実',
  德: '徳',
  瀨: '瀬',
  曾: '曽',
  淸: '清',
  會: '会',
  學: '学',
  龜: '亀',
  藝: '芸',
  榮: '栄',
  圓: '円',
  傳: '伝',
  豐: '豊',
  晉: '晋',
  禮: '礼',
  鷗: '鴎',
};

export function nameKeys(names: string[], o: Options): Set<string> {
  let xs = names;
  if (o.authSplit)
    xs = xs
      .flatMap((n) => nfkc(n).split(/[,、，/／]/u))
      .map((n) => n.trim().replace(ROLE_PREFIX, '').replace(ROLE_SUFFIX, '').trim())
      .filter((n) => n !== '' && !ROLE_ONLY.test(n));
  return new Set(
    xs
      .map((n) => {
        let k = NA(n);
        if (o.authDot) k = k.replace(/[・･·=＝]/gu, '');
        if (o.authKanji) k = [...k].map((c) => KANJI_OLD[c] ?? c).join('');
        return k;
      })
      .filter((k) => k !== ''),
  );
}

const keyOf = (s: Set<number>) => [...s].sort((a, b) => a - b).join(',');

export type CandidateRules = Rules & {
  edition: (hit: Hit) => boolean;
  /** The guards (counted with the edition check: another edition or format). */
  other: (book: BookRow, hit: Hit) => boolean;
};

/** Memoized per rule set: the measuring runs every candidate over a million results. */
function memo<T>(f: (s: string) => T): (s: string) => T {
  const m = new Map<string, T>();
  return (s) => {
    let v = m.get(s);
    if (v === undefined && !m.has(s)) {
      v = f(s);
      m.set(s, v);
    }
    return v as T;
  };
}

export function makeRules(o: Options): CandidateRules {
  const tt = memo((s) => titleText(o, s));
  const nt = memo((s) => N(tt(s)) ?? '');
  const vt = memo((s) => keyOf(nums(o.volClean ? titleText({ ...o, paren: true }, s) : s)));
  const vset = memo((s) => nums(o.volClean ? titleText({ ...o, paren: true }, s) : s));
  const names = memo((s) => nameKeys([s], o));
  return {
    title: (b, h) => {
      const bt = tt(b.t);
      const ht = tt(hitText(o, h as Hit));
      const nb = nt(b.t);
      if (!nb) return false;
      if (nt(hitText(o, h as Hit)) === nb) return true;
      if (o.sub && subtitleMatch(bt, ht, o.subMin ?? 4)) return true;
      if (o.seriesTail && (N(dropSeriesTail(ht, b.se)) ?? '') === nb) return true;
      if (o.front && seriesFrontMatch(bt, b.se, ht)) return true;
      return false;
    },
    author: (b, h) => {
      const want = new Set(b.au.flatMap((a) => [...names(a)]));
      for (const a of h.authors) for (const k of names(a)) if (want.has(k)) return true;
      return false;
    },
    volume: (b, h) => {
      const H = vt(hitText(o, h as Hit));
      const B = vset(b.t);
      if (o.volGuard && vt(b.calTitle) !== vt(b.t)) return false;
      if (H === vt(b.t)) return true;
      if (o.volIx && b.ix !== null) {
        if (H === keyOf(new Set([b.ix]))) return true;
        if (H === keyOf(new Set([...B, b.ix]))) return true;
      }
      return false;
    },
    edition: (h) => (o.full ? (h.edOkFull ?? h.edOk) : h.edOk),
    other: (b, h) => {
      if (!COMIC_LABEL.test(hitText(o, h))) return true;
      if (o.comicFmt && b.fmt !== 'manga' && b.fmt !== 'image-only') return false;
      if (o.comicGuard && ![b.t, b.calTitle, b.opfTitle ?? ''].some((t) => COMIC_LABEL.test(t)))
        return false;
      return true;
    },
  };
}

/** The checks a hit fails under candidate rules. */
export function failedWith(r: CandidateRules, b: BookRow, h: Hit): Check[] {
  const out: Check[] = [];
  if (!r.title(b, h)) out.push('title');
  if (!r.author(b, h)) out.push('author');
  if (!r.volume(b, h)) out.push('volume');
  if (!r.edition(h) || !r.other(b, h)) out.push('edition');
  return out;
}

export function acceptWith(r: CandidateRules, b: BookRow): Hit | null {
  if (!(N(clean(b.t)) ?? '')) return null;
  for (const h of b.hits) if (failedWith(r, b, h).length === 0) return h;
  return null;
}

/** The closest result under candidate rules (fewest failed checks, then title similarity). */
export function closestWith(
  r: CandidateRules,
  b: BookRow,
  o: Options,
): { hit: Hit; failed: Check[]; index: number } | null {
  let best: { hit: Hit; failed: Check[]; index: number; sim: number } | null = null;
  b.hits.forEach((hit, index) => {
    const f = failedWith(r, b, hit);
    if (best && f.length > best.failed.length) return;
    const sim = titleSimilarity(b.t, hitText(o, hit));
    if (
      !best ||
      f.length < best.failed.length ||
      (f.length === best.failed.length && sim > best.sim + 1e-9)
    )
      best = { hit, failed: f, index, sim };
  });
  return best;
}

export { hitText, titleText };

// ---------------------------------------------------------------- the labeled books

export interface Gold {
  t: string;
  au: string[] | string;
  se: string | null;
  ix: number | string | null;
  alt_t?: unknown;
  [k: string]: unknown;
}

/**
 * A first, strict look at a match against the book's label: the whole title (labels and
 * trailing brackets dropped) equals the label's title or one of its alternatives, the numbers
 * agree with the label's title or number, and an author is in common. Anything else is flagged
 * for a look by eye (WP20d judged the checker's flags by eye too).
 */
export function judge(h: Hit, g: Gold): { ok: boolean; why: string[] } {
  const o: Options = { full: true, paren: true, authSplit: true, authDot: true, authKanji: true };
  const ht = titleText(o, hitText(o, h));
  const titles = [g.t, ...(Array.isArray(g.alt_t) ? g.alt_t : g.alt_t ? [g.alt_t] : [])].filter(
    (x): x is string => typeof x === 'string',
  );
  const why: string[] = [];
  if (!titles.some((t) => N(titleText(o, t)) === N(ht))) why.push('title');
  const hn = keyOf(nums(ht));
  const gix = typeof g.ix === 'number' ? g.ix : null;
  if (
    !titles.some((t) => keyOf(nums(titleText(o, t))) === hn) &&
    !(gix !== null && hn === keyOf(new Set([gix])))
  )
    why.push('volume');
  const gau = (Array.isArray(g.au) ? g.au : [g.au]).filter((x) => typeof x === 'string');
  const want = nameKeys(
    gau.filter((x) => x !== '?'),
    o,
  );
  if (!gau.includes('?') && ![...nameKeys(h.authors, o)].some((k) => want.has(k)))
    why.push('author');
  return { ok: why.length === 0, why };
}

// ---------------------------------------------------------------- the second search

/**
 * A query's title without its subtitle: cut at the first subtitle separator (": ", " ―",
 * " ～", " -", "「", "『", a bracket) after at least two characters; trailing brackets dropped.
 */
export function mainTitle(q: string): string {
  const s = dropParens(nfkc(q));
  const m = /^(.{2,}?)(?:\s*[:：]\s|\s*[―—–]|\s+[~～〜-]|[~～〜]|\s*[「『(（【])/u.exec(s);
  return (m ? m[1] : s).trim();
}
