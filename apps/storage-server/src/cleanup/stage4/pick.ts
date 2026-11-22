/**
 * How the reference fetcher (ref4.py) built its queries and picked among search results:
 * clean_title, nums, sim, pick_by_volume, and Python's urllib.parse.quote for the URLs.
 * Ported unchanged so the lookups ask what the measured run asked.
 */
import { pyStrip } from '../title-rules';
import { nfkc } from './ref-text';

export const ROMAN: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
  XIII: 13,
  XIV: 14,
  XV: 15,
  XVI: 16,
  XVII: 17,
  XVIII: 18,
  XIX: 19,
  XX: 20,
};
export const KANJI: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  壱: 1,
  弐: 2,
  参: 3,
  肆: 4,
  伍: 5,
  陸: 6,
  漆: 7,
  捌: 8,
  玖: 9,
};

/** Unicode decimal digits to ASCII (Python's float() reads any Nd digit). */
function asciiDigits(s: string): string {
  return s.replace(/\p{Nd}/gu, (d) => {
    const c = d.codePointAt(0)!;
    if (c >= 0x30 && c <= 0x39) return d;
    // Unicode's decimal digits come in runs that start at a zero.
    let z = c;
    while (z > 0 && /\p{Nd}/u.test(String.fromCodePoint(z - 1))) z -= 1;
    return String((c - z) % 10);
  });
}

/** ref4 nums(): volume-like numbers in a title. */
export function nums(s: string): Set<number> {
  const t = nfkc(s);
  const out = new Set<number>();
  for (const m of t.matchAll(/\p{Nd}+(?:\.\p{Nd}+)?/gu)) {
    const v = parseFloat(asciiDigits(m[0]));
    if (v < 500) out.add(v);
  }
  for (const m of t.matchAll(/(?<![A-Za-z])(X{0,2}(?:IX|IV|V?I{0,3}))(?![A-Za-z])/g)) {
    const r = m[1];
    if (r && ROMAN[r] !== undefined) out.add(ROMAN[r]);
  }
  for (const m of t.matchAll(/第([一二三四五六七八九十]{1,3})/gu)) {
    let v = 0;
    for (const ch of m[1]) {
      v = ch === '十' && v ? v * 10 : v;
      v = ch !== '十' ? v + KANJI[ch] : !v ? (v || 1) * 10 : v;
    }
    out.add(v || 10);
  }
  const m = /[\s\u3000]([一二三四五六七八九十壱弐参肆伍陸漆捌玖])\s*$/u.exec(t);
  if (m) out.add(KANJI[m[1]]);
  return out;
}

export function norm(s: string | null | undefined): string {
  return nfkc(s)
    .replace(/[\s\u3000・!！?？:：~〜～\-ー―‐()（）「」『』【】[\]、。,.〈〉<>＜＞]/gu, '')
    .toLowerCase();
}

/** ref4 sim(): share of the query's bigrams found in the title. */
export function sim(q: string, t: string): number {
  const a = [...norm(q)];
  const b = norm(t);
  if (a.length < 2 || !b) return 0;
  let hit = 0;
  for (let k = 0; k < a.length - 1; k++) if (b.includes(a[k] + a[k + 1])) hit += 1;
  return hit / (a.length - 1);
}

function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** ref4 clean_title(): the query title. */
export function queryTitle(t: string | null | undefined): string {
  let s = pyStrip(nfkc(t));
  s = s.replace(/\s+-\s+[^-]+$/u, '');
  s = s.replace(/^\[[^\]]+\]\s*/u, '');
  s = s.replace(/^電子書籍特典\s*/u, '');
  s = s.replace(
    /[【[(（][^】\])）]*(特典|限定|書き下ろし|書下ろし|SS|イラスト|合本|版)[^】\])）]*[】\])）]/gu,
    '',
  );
  s = s.replace(
    /\s*[(（][^()（）]*(文庫|ノベルス|ノベル|ブックス|BOOKS|Books|NOVELS|新書|コミックス|出版|書房)[^()（）]*[)）]\s*$/u,
    '',
  );
  return stripChars(s, ' :：');
}

export const COMIC = /MFC|コミック|マンガ|漫画|COMIC|Comic|comic|ｺﾐｯｸ/u;
export const EXTRA =
  /購入特典|特典SS|ショートストーリー|試し読み|無料|お試し|Prelude|特装版|special edition/iu;

export type Pick = [string, string];

/**
 * A bracketed note that the edition comes with a bonus ("【特典SS付】", "【電子書店共通特典SS付】",
 * "【特典ショートストーリーつき】"): the normal edition, not a bonus item of its own.
 */
export const BUNDLED_BONUS =
  /【[^】]*(?:特典SS付き?|特典SS付|特典ショートストーリー(?:つき|付き?))[^】]*】/gu;

/**
 * A title with its volume number, store markers (【…】), imprint and punctuation set aside: two
 * volumes of one series that share a subtitle compare equal (「事情3 ～離婚できずに新婚旅行～
 * (ビーズログ文庫)」 and the file's 「事情～離婚できずに新婚旅行!?～」).
 */
export function titleKey(s: string): string {
  // Only volume-like numbers go (as nums(): under 500): 「Another 2001（下）」 is another book.
  const t = queryTitle(nfkc(s).replace(/【[^】]*】/gu, ' ')).replace(
    /\p{Nd}+(?:\.\p{Nd}+)?/gu,
    (m) => (parseFloat(asciiDigits(m)) < 500 ? '' : m),
  );
  return norm(t);
}

/** Whether a title has words of its own after its last volume number (a volume's subtitle). */
export function subtitleAfterNumber(s: string): boolean {
  const t = queryTitle(nfkc(s).replace(/【[^】]*】/gu, ' '));
  const m = [...t.matchAll(/\p{Nd}+(?:\.\p{Nd}+)?/gu)].pop();
  if (!m || m.index === undefined) return false;
  return norm(t.slice(m.index + m[0].length)).length >= 2;
}

/**
 * ref4 pick_by_volume(): comic editions last for text books, then the volume, then similarity.
 *
 * Series-order follow-up (2026-11-22, measured on the live copy: 437 books): a query without a
 * number ranked volume 1 or an unnumbered result above the result that IS the book, so a
 * volume whose file title has no number (「(仮)花嫁のやんごとなき事情～離婚できずに新婚旅行!?～」,
 * volume 3) took volume 1's record even when Amazon listed volume 3 first. Now, for such a
 * query, a result whose title equals the query's once the number, imprint and punctuation are
 * set aside (titleKey) comes first; "volume 1 or unnumbered" only breaks ties among those (a
 * shared subtitle: 「時魔術士の強くてニューゲーム ～…～」 and its 「２ ～…～」). A query with a number
 * picks as before.
 */
export function pickByVolume<T extends [unknown, string]>(
  qtitle: string,
  cands: T[],
  textBook = true,
): T | null {
  const qn = nums(qtitle);
  const qkey = qn.size ? '' : titleKey(qtitle);
  let list = cands;
  if (!EXTRA.test(nfkc(qtitle))) {
    const plain = list.filter((c) => !EXTRA.test(nfkc(c[1])));
    // Every result is marked: Amazon marks many normal editions "【特典SS付】" (found
    // 2026-11-19: 10 of 4,564 searches picked nothing). Those editions count; bonus stories of
    // their own (購入特典, …限定ショートストーリー) still don't.
    list = plain.length
      ? plain
      : list.filter((c) => !EXTRA.test(nfkc(c[1]).replace(BUNDLED_BONUS, '')));
  }
  // A numbered result counts as the book only when its own subtitle follows the number (「事情3
  // ～離婚できずに新婚旅行～」; not 「…楽しくなりました２」, whose title is the series name) and no
  // other volume among the results shares that subtitle (「時魔術士の…２ ～過去に戻って…～」 shares
  // volume 1's: then only volume 1 or an unnumbered result counts).
  const keyNums = new Map<string, Set<string>>();
  if (qkey)
    for (const c of list) {
      const k = titleKey(c[1]);
      if (k !== qkey) continue;
      const s = keyNums.get(k) ?? new Set<string>();
      s.add([...nums(c[1])].sort().join(','));
      keyNums.set(k, s);
    }
  const sameTitle = (c: T, tn: Set<number>) => {
    if (!qkey || titleKey(c[1]) !== qkey) return 0;
    // Volume 1 only by itself: 「冰剣の…２～…～（１）」 (a manga's first part of novel 2) is not.
    if (!tn.size || (tn.size === 1 && tn.has(1))) return 1;
    if ((keyNums.get(qkey)?.size ?? 0) > 1) return 0;
    return subtitleAfterNumber(c[1]) ? 1 : 0;
  };
  let best: T | null = null;
  let bestKey: number[] | null = null;
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  for (const c of list) {
    const fmt = textBook && COMIC.test(nfkc(c[1])) ? 0 : 1;
    const tn = nums(c[1]);
    let vol: number;
    if (qn.size) vol = [...qn].some((x) => tn.has(x)) ? 2 : tn.size ? 0 : 1;
    else vol = !tn.size || tn.has(1) ? 2 : 0;
    const same = sameTitle(c, tn);
    const key = [fmt, same, vol, sim(qtitle, c[1])];
    if (!bestKey || better(key, bestKey)) {
      best = c;
      bestKey = key;
    }
  }
  return best;
}

/** Python's urllib.parse.quote (safe '/'). */
export function pyQuote(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, '/');
}

/** An ASIN in the file's identifiers or written as a title (ref4). */
export const ASIN_RE = /\bB0[0-9A-Z]{8}\b/;
