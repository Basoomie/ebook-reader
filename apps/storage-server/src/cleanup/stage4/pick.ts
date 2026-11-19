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

/** ref4 pick_by_volume(): comic editions last for text books, then the volume, then similarity. */
export function pickByVolume<T extends [unknown, string]>(
  qtitle: string,
  cands: T[],
  textBook = true,
): T | null {
  const qn = nums(qtitle);
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
  let best: T | null = null;
  let bestKey: [number, number, number] | null = null;
  for (const c of list) {
    const fmt = textBook && COMIC.test(nfkc(c[1])) ? 0 : 1;
    const tn = nums(c[1]);
    let vol: number;
    if (qn.size) vol = [...qn].some((x) => tn.has(x)) ? 2 : tn.size ? 0 : 1;
    else vol = !tn.size || tn.has(1) ? 2 : 0;
    const key: [number, number, number] = [fmt, vol, sim(qtitle, c[1])];
    if (
      !bestKey ||
      key[0] > bestKey[0] ||
      (key[0] === bestKey[0] &&
        (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))
    ) {
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
