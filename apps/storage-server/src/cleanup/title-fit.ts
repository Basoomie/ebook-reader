/**
 * Titles too long for a Calibre folder (decided with the user 2026-11-22): Calibre names a book's
 * folder and file from its title and first author and never checks bytes; the NAS disk takes 255
 * per name (`calibreNameBytes`). Only a title whose names would be too long is changed, and then
 * in this order, stopping as soon as the names fit:
 *   1. cleaning: what is not part of the title (site branding, file names, a store-bonus word, the
 *      book's own author, a title said twice), on top of stage 2's own cleaning (`cleanTitle`);
 *   2. shortening, least impact first (measured at stop B on stage 4's own picker and the series
 *      order's number reading): a bracketed bonus note, a bracketed label, a subtitle after ": ",
 *      a subtitle between ～…～; no step drops a volume mark the rest of the title lacks;
 *   3. the cut: at the last punctuation mark before the limit, "…", and a trailing volume number
 *      kept after it (user: 「長いタイトル… 3」).
 * A title that fits is returned unchanged (user: "Do not change titles that are not too long").
 * A first author that alone makes a name too long is bad data: nothing is fitted (review).
 */
import { nums } from './stage4/pick';
import { calibreNameBytes, NAME_MAX_BYTES } from './calibre-names';
import { cleanTitle, N, NA, nfkc } from './title-rules';

export type FitStep = 'none' | 'cleaned' | 'shortened' | 'cut' | 'author_too_long';

export interface TitleFit {
  title: string;
  step: FitStep;
  /** The rules that changed the title, in order. */
  rules: string[];
  bytesBefore: number;
  bytesAfter: number;
}

export interface FitBook {
  /** The book's Calibre id (an arrival not added yet: the largest the library can reach soon). */
  calibreId: number;
  firstAuthor: string;
  /** Every author of the book (for the author-text cleaning). */
  authors?: readonly string[];
}

/** The id used for a book Calibre has not numbered yet (worst case for the name's length). */
export const UNKNOWN_ID = 9_999_999;

const tidy = (s: string) =>
  s
    .replace(/\s{2,}/gu, ' ')
    .replace(/^[\s:：]+|[\s:：、,]+$/gu, '')
    .trim();

// ---- 1. cleaning ---------------------------------------------------------------------------------

/** A title said twice keeps one part (only for titles too long; one that fits goes to review). */
const coreOf = (x: string) =>
  (N(x.replace(/[【（(［[][^】）)］\]]*[】）)］\]]/gu, '')) ?? '').replace(/[0-9]+/gu, '');
export function removeRepeat(t: string): string {
  const parts = t.split(/[ \u3000]+/u).filter(Boolean);
  // The split whose two parts are most alike (the last of equals), each at least 6 characters,
  // the shorter at least 60 % of the longer, one starting with the other.
  let best: { l: string; r: string; a: string; b: string; diff: number } | null = null;
  for (let k = 1; k < parts.length; k++) {
    const l = parts.slice(0, k).join(' ');
    const r = parts.slice(k).join(' ');
    const a = coreOf(l);
    const b = coreOf(r);
    if (a.length < 6 || b.length < 6) continue;
    if (Math.min(a.length, b.length) < 0.6 * Math.max(a.length, b.length)) continue;
    if (!(a === b || a.startsWith(b) || b.startsWith(a))) continue;
    // 「wonder wonderful」: the shorter must end where a word of the longer ends.
    const [sh, lo] = a.length <= b.length ? [a, b] : [b, a];
    if (/[a-z]/u.test(lo[sh.length] ?? '') && /[a-z]$/u.test(sh)) continue;
    const diff = Math.abs(a.length - b.length);
    if (!best || diff <= best.diff) best = { l, r, a, b, diff };
  }
  if (!best) return t;
  const { l, r, a, b } = best;
  let keep: string;
  // Not the series name (…シリーズ), else the part holding the other, else the numbered one.
  if (/シリーズ$/u.test(nfkc(r))) keep = l;
  else if (/シリーズ$/u.test(nfkc(l))) keep = r;
  else if (a.length !== b.length) keep = a.length > b.length ? l : r;
  else keep = nums(r).size && !nums(l).size ? r : l;
  const drop = keep === l ? r : l;
  if ([...nums(drop)].some((x) => !nums(keep).has(x))) return t;
  return keep.replace(/[\s:：]+$/u, '');
}

interface Rule {
  id: string;
  apply: (t: string, authors: readonly string[]) => string;
}

/** The cleaning rules approved at stop B (real examples in decisions.md). */
export const CLEANING: Rule[] = [
  {
    // 「人間失格 -- 太宰治 (Osamu Dazai) -- 6d50… -- Anna’s Archive」
    id: 'annas-archive',
    apply: (t) => (/\s--\s.*Anna[’']s Archive\s*$/iu.test(t) ? t.split(/\s--\s/u)[0].trim() : t),
  },
  {
    // 「… (z-library.sk, 1lib.sk, z-lib.sk)」
    id: 'z-library',
    apply: (t) =>
      t
        .replace(/\s*[（(][^（()）]*(?:z-?lib|1lib|libgen|annas-archive)[^（()）]*[）)]\s*$/iu, '')
        .trim(),
  },
  {
    // 「_14 - よつばと!(14) (368 MiB) | mokuro」, 「… (with mokuro)」
    id: 'mokuro',
    apply: (t) =>
      t
        .replace(/\s*\|\s*mokuro\s*$/iu, '')
        .replace(/\s*\(with mokuro\)\s*$/iu, '')
        .replace(/\s*\(\d+(?:\.\d+)?\s*[KMG]iB\)\s*$/u, '')
        .replace(/^_\d+\s+-\s+/u, '')
        .trim(),
  },
  {
    // 「Doraemon LongStory v01[Raw-JP]」, 「(一般小説) [橋本紡] 半分の月がのぼる空」
    id: 'scanner-tag',
    apply: (t) =>
      t
        .replace(/\s*\[raw(?:-jp)?\]\s*/giu, ' ')
        .replace(/^\s*[（(](?:一般小説|一般書籍|成年コミック|一般コミック)[）)]\s*/u, '')
        .trim(),
  },
  {
    // 「Shin Kanzen Master N1-Kanji.pdf」; a Kindle file id 「CR!3V9N….azw」 is no title at all.
    id: 'file-name',
    apply: (t) =>
      /^CR![0-9A-Z]{20,}\.azw3?$/iu.test(t.trim())
        ? ''
        : t.replace(/\.(epub|pdf|azw3?|mobi|txt)\s*$/iu, '').trim(),
  },
  {
    // 「電子書籍特典\u3000駄菓子屋ヤハギ\u3000異世界に出店します３」, 「…\u3000電子書籍特典付き」
    id: 'store-bonus',
    apply: (t) =>
      t
        .replace(/^\s*電子書籍特典[\s\u3000]+/u, '')
        .replace(/[\s\u3000]+電子書籍特典付き\s*$/u, '')
        .trim(),
  },
  {
    // 「ウザク式麻雀学習 はじめの書 -- G・ウザク」
    id: 'author-tail',
    apply: (t, authors) => {
      const m = /^(.+?)\s+--\s+([^-]+)$/u.exec(t);
      if (!m) return t;
      const names = m[2].split(/[,、&＆]/u).map((x) => NA(x));
      return names.some((n) => n && authors.some((a) => NA(a) === n)) ? m[1].trim() : t;
    },
  },
  {
    // The book's own author in [ ] anywhere: 「(一般小説) [橋本紡] 半分の月がのぼる空」
    id: 'author-bracket',
    apply: (t, authors) =>
      t
        .replace(/\s*[[［]([^\]］]{1,30})[\]］]\s*/gu, (m, inner: string) =>
          authors.some((a) => NA(a) === NA(inner)) ? ' ' : m,
        )
        .trim(),
  },
  { id: 'repeat', apply: (t) => removeRepeat(t) },
];

// ---- 2. shortening -------------------------------------------------------------------------------

const VOL = String.raw`(?:\d{1,3}|[０-９]{1,3}|[IVXⅠ-Ⅻ]{1,4}|[上中下]|[一二三四五六七八九十]{1,3})(?:巻)?`;
const LABEL =
  /文庫|ノベルス|ノベルズ|ノベル$|ブックス|BOOKS|Books|新文芸|フォレスト|叢書|選書|新書|シリーズ|出版|書房|電子書籍|Kindle|kindle|NOVELS|COMICS|レーベル/u;
const BONUS = /特典|限定|特別版|SS|ＳＳ|書き下ろし|書下ろし|付き|付】|おまけ|寄付版|無料|お試し/u;
/** Notes stage 3 needs (omnibus, edition) and volume words: never dropped as a note or a label. */
const KEEP_BRACKET = /合本|総集編|新装版|完全版|改訂|上下|前編|後編|^\s*\d+\s*$|^[上中下]$/u;
/** Volume marks a step may not drop when the rest of the title lacks them (「…ティップス集その8」). */
const VOLMARK = /その\s*\d+|第\s*\d+\s*[巻部]|\d+\s*巻|vol\.?\s*\d+/giu;

/** The shortening rules in the approved order. */
export const SHORTENING: Rule[] = [
  {
    // 【電子特別版】, 〈電子特別版〉, （初回限定）
    id: 'bonus-note',
    apply: (t) =>
      tidy(
        t.replace(/[【〈《［[（(]([^】〉》］\]）)]{1,30})[】〉》］\]）)]/gu, (m, inner: string) =>
          BONUS.test(inner) && !KEEP_BRACKET.test(inner) ? ' ' : m,
        ),
      ),
  },
  {
    // 「…～（サーガフォレスト）1」 → 「…～ 1」, 「(電撃の新文芸)」, 「(歴史世界叢書)」
    id: 'label',
    apply: (t) =>
      tidy(
        t.replace(/\s*[（(]([^（()）]{2,40})[）)]/gu, (m, inner: string) =>
          LABEL.test(inner) && !KEEP_BRACKET.test(inner) ? ' ' : m,
        ),
      ),
  },
  {
    // KDP style 「アメリカ人の物語12 血塗られた夏の日: 革命の剣…」 (never a bare volume number)
    id: 'colon-subtitle',
    apply: (t) => {
      const m = /^(.{4,}?)\s*[:：]\s*(.+)$/u.exec(t);
      if (!m) return t;
      const rest = nfkc(m[2])
        .replace(/【.*?】/gu, '')
        .trim();
      if (new RegExp(`^${VOL}\\s*$`, 'u').test(rest)) return t;
      return tidy(m[1]);
    },
  },
  {
    // 「左遷された無能王子は実力を隠したい2 ～二度転生した…～」 → 「左遷された無能王子は実力を隠したい2」
    id: 'wave-subtitle',
    apply: (t) =>
      tidy(
        t.replace(
          /(.{4,}?)\s*([～~〜―─－-]{1,3})[^～~〜―─－-]{4,}\2/u,
          (_m, head: string) => `${head} `,
        ),
      ),
  },
];

// ---- 3. the cut ------------------------------------------------------------------------------------

const PUNCT = /[、。，,・！!？?―～~〜：:\s」』）)】〉》]/u;

/** Cut at the last punctuation mark before the limit and add "…"; a trailing number stays after it. */
export function cutTitle(t: string, book: FitBook): string {
  const m = new RegExp(
    `^(.*?)[\\s\u3000]*((?:その|第)?${VOL})\\s*(?:[（(][^（()）]*[）)])?\\s*$`,
    'u',
  ).exec(t);
  const keepsNumber = !!m && [...m[1]].length >= 4;
  const head = keepsNumber ? m![1] : t;
  const tail = keepsNumber ? ` ${m![2]}` : '';
  const chars = [...head];
  const fits = (s: string) =>
    calibreNameBytes(book.calibreId, s, book.firstAuthor) <= NAME_MAX_BYTES;
  let n = chars.length;
  while (n > 0 && !fits(chars.slice(0, n).join('') + '…' + tail)) n--;
  let k = n;
  while (k > 0 && !PUNCT.test(chars[k - 1])) k--;
  // A mark too far back (more than half the room): cut at the limit instead.
  const at = k >= Math.floor(n / 2) && k > 0 ? k : n;
  return (
    chars
      .slice(0, at)
      .join('')
      .replace(/[\s、。，,・：:―～~〜]+$/u, '') +
    '…' +
    tail
  );
}

// ---- the whole fit --------------------------------------------------------------------------------

const marksOf = (x: string) =>
  new Set([...nfkc(x).matchAll(VOLMARK)].map((m) => m[0].replace(/\s/gu, '').toLowerCase()));

/** The title to write: unchanged when the names fit, else cleaned, shortened or cut until they do. */
export function fitTitle(title: string, book: FitBook): TitleFit {
  const bytesOf = (t: string) => calibreNameBytes(book.calibreId, t, book.firstAuthor);
  const before = bytesOf(title);
  const done = (t: string, step: FitStep, rules: string[]): TitleFit => ({
    title: t,
    step,
    rules,
    bytesBefore: before,
    bytesAfter: bytesOf(t),
  });
  if (before <= NAME_MAX_BYTES) return done(title, 'none', []);
  if (calibreNameBytes(book.calibreId, '', book.firstAuthor) > NAME_MAX_BYTES)
    return done(title, 'author_too_long', []);
  const authors = book.authors?.length ? book.authors : [book.firstAuthor];
  const rules: string[] = [];
  // 1. cleaning: stage 2's own, then the approved rules, all of them.
  let t = cleanTitle(title, authors);
  if (t !== title) rules.push('clean');
  for (const r of CLEANING) {
    const s = r.apply(t, authors);
    if (s !== t && s !== '') {
      t = s;
      rules.push(r.id);
    }
  }
  if (t === '') t = title;
  if (bytesOf(t) <= NAME_MAX_BYTES) return done(t, 'cleaned', rules);
  // 2. shortening, one rule at a time, stopping as soon as the names fit.
  for (const r of SHORTENING) {
    const s = r.apply(t, authors);
    if (s === t || s === '') continue;
    const kept = marksOf(s);
    if ([...marksOf(t)].some((x) => !kept.has(x))) continue;
    t = s;
    rules.push(r.id);
    if (bytesOf(t) <= NAME_MAX_BYTES) return done(t, 'shortened', rules);
  }
  // 3. the cut.
  rules.push('cut');
  return done(cutTitle(t, book), 'cut', rules);
}

/** Whether a title and first author fit Calibre's names (the disk's 255 bytes). */
export function namesFit(calibreId: number, title: string, firstAuthor: string): boolean {
  return calibreNameBytes(calibreId, title, firstAuthor) <= NAME_MAX_BYTES;
}
