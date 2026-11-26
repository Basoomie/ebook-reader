/**
 * Bookmeter listings, second look (bookmeter-listings.md section 8, approved 2026-11-25): another
 * listing of the SAME book. acceptBookmeter's checks were made to tell one book from another, so
 * they compare titles as written; Bookmeter's older print listings (where readers log) write the
 * same book differently from its e-book listing: 狼と香辛料 (2) for 狼と香辛料II, a label code read
 * as a number (電撃文庫 ふ 7-2), 〈改〉 for (改), a subtitle's ruby reading after it (燃える銀氷
 * ダイヤモンドダスト), the list's cut text, the series after the title (キメラの刻印: 警察庁α特務班).
 * This check compares the title with the volume written in any form set aside and the volume
 * compared on its own. It only chooses among a book's listings once the book's own listing is
 * known (store-links.ts bookListings); it never makes a first match.
 *
 * Measured (bookmeter-listings.md 8.2): two blind samples of 100, library-wide changes on the
 * stored answers and three random looks of 40 changes. Editions of the same work count as the
 * same book (user's decision 1: 新装版, 文庫版/単行本…); sets, omnibus volumes, comics and
 * adaptations never do.
 */
import { N, nfkc } from '../title-rules';
import {
  CHOSEN_RULES,
  COMIC_LABEL,
  adaptationListing,
  makeRules,
  type BookRow,
} from './bookmeter-rules';
import { clean } from './rules-v3';
import type { BookmeterHit } from './store-links';

export interface SameBook {
  title: string;
  authors: string[];
  series: string | null;
  fmt: string | null | undefined;
  /** The book's own texts (titles from the file, Calibre, the store record). */
  own: string[];
}

export type SameFail = 'author' | 'volume' | 'title' | 'set' | 'comic' | 'adaptation';

/** How the title was found to be the same (kept in the decision). */
export type SameHow = 'as-written' | 'reading' | 'subtitle' | 'order';

/** Brackets that hold a part of the title, read as plain parentheses (〈改〉, 《上》, ＜下＞). */
const asParens = (s: string) => s.replace(/[〈《＜<]/gu, '(').replace(/[〉》＞>]/gu, ')');

/**
 * A trailing (…) that names a label, an imprint or a printing year, never a part of the title:
 * (電撃文庫 ふ 7-2), (ハヤカワ文庫 JA カ 3-27), (1984年), (歴史群像新書). A part of the title
 * ((改), 〈境〉) stays.
 */
const LABEL_PAREN =
  /文庫|ノベル|NOVEL|Novel|ブックス|BOOKS|Books|新書|コミック|COMIC|単行本|ムック|シリーズ|叢書|選書|ライブラリ|Library|出版|書房|書店|KADOKAWA|講談社|集英社|小学館|徳間|角川|電撃|富士見|ガガガ|スニーカー|ファミ通|PHP|DIGITAL|Kindle|電子|特典|^[0-9]{4}年$|[ぁ-んァ-ヶA-Za-z]{1,3}\s?[0-9]+(?:-[0-9]+)+|^[A-Za-z]+\s?[0-9]+$/u;

function dropLabels(t: string): string {
  let s = t.trim();
  for (;;) {
    const m = /\s*[(（]([^()（）]*)[)）]\s*$/u.exec(s);
    if (!m || !LABEL_PAREN.test(m[1].trim())) return s;
    const rest = s.slice(0, m.index).trim();
    if (!rest) return s;
    s = rest;
  }
}

/** The title with its trailing labels dropped (a label code's numbers are not a volume). */
function listingTextRaw(t: string): string {
  const c = clean(nfkc(t)) ?? '';
  return dropLabels(
    asParens(c)
      .replace(/\s*[(（][^()（）]*…$/u, '')
      .replace(/…$/u, '')
      .trim(),
  );
}

const ROMAN_TOKEN = /(?<![A-Za-z])(?:X{0,3}(?:IX|IV|V?I{1,3}|V)|X{1,3})(?![a-z])/gu;
/** Marks that only separate a title's parts. */
const SEPARATORS = /[\s:：~～〜\-―‐─—/／|｜・･「」『』"“”()（）[\]［］〔〕【】{}]+/gu;
/** A part mark (上/中/下, 前編/後編) standing on its own, not inside a word (天下, 下剋上). */
const PART_MARK =
  /(?<![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])(上|中|下|前編|中編|後編)巻?(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー])/gu;

/**
 * An edition of the same work named in its title (the user's decision 1: the link goes to the
 * edition readers log most; 夢をかなえるゾウ2 → its ＜文庫版＞ listing was judged right).
 */
const EDITION_WORDS =
  /新装改訂版|増補改訂版|新装版|改訂新版|改訂版|改版|新版|決定版|完全版|愛蔵版|文庫版|増補版|復刻版|特装版|限定版|通常版|電子特別版|電子版|Kindle版/gu;

/** The title without any volume mark: digits, Roman numerals, 第N巻, part marks; editions aside. */
function stripVolume(t: string): string {
  let s = listingText(t);
  s = s.replace(/第?[0-9]+(?:\.[0-9]+)?\s*[巻部話号]?/gu, ' ');
  s = s.replace(/第[一二三四五六七八九十]{1,3}[巻部話号]?/gu, ' ');
  s = s.replace(ROMAN_TOKEN, ' ');
  s = s.replace(PART_MARK, ' ');
  return s.replace(EDITION_WORDS, ' ');
}

/** The title as one key, volume marks set aside. */
function titleKeyRaw(t: string): string {
  return (N(stripVolume(t)) ?? '').replace(/[()（）[\]［］〔〕【】{}、。,.・･]/gu, '');
}

/** The title's parts (split at separators), each as a key, volume marks set aside. */
function titlePartsRaw(t: string): string[] {
  return stripVolume(t)
    .split(SEPARATORS)
    .map((p) => (N(p) ?? '').replace(/[、。,.]/gu, ''))
    .filter((p) => p !== '');
}

const ROMAN_VALUE: Record<string, number> = { I: 1, V: 5, X: 10 };
const ROMAN_BACK = [
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
] as const;

/** A Roman numeral's value (null when the letters are not a well-formed numeral). */
export function romanValue(r: string): number | null {
  let v = 0;
  for (let i = 0; i < r.length; i++) {
    const a = ROMAN_VALUE[r[i]];
    const b = ROMAN_VALUE[r[i + 1]] ?? 0;
    if (a === undefined) return null;
    v += a < b ? -a : a;
  }
  let w = v;
  let out = '';
  for (const [n, t] of ROMAN_BACK) {
    while (w >= n) {
      out += t;
      w -= n;
    }
  }
  return out === r && v > 0 ? v : null;
}

const KANJI_DIGIT: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 第三, 第十二: the kanji ordinal's value. */
function kanjiValue(k: string): number {
  let v = 0;
  let cur = 0;
  for (const ch of k) {
    if (ch === '十') {
      v += (cur || 1) * 10;
      cur = 0;
    } else cur = KANJI_DIGIT[ch] ?? 0;
  }
  return v + cur;
}

/**
 * The printed volume: every number the title prints (digits, Roman numerals, 第＋kanji), repeats
 * kept (C3 -シーキューブ- III is 3 and 3) and years included (CNN 2026年1月号 is not 2023年
 * 1月号), and a 上/中/下 or 前編/後編 mark. Never the series index. A label code's numbers are not
 * a volume (listingText drops the label).
 */
function volKeyRaw(t: string): string {
  const s = listingText(t);
  const n: number[] = [];
  for (const m of s.matchAll(/[0-9]+(?:\.[0-9]+)?/gu)) n.push(Number(m[0]));
  for (const m of s.matchAll(/(?<![A-Za-z])([IVX]+)(?![A-Za-z0-9])/gu)) {
    const v = romanValue(m[1]);
    if (v !== null) n.push(v);
  }
  for (const m of s.matchAll(/第([一二三四五六七八九十]{1,3})/gu)) n.push(kanjiValue(m[1]));
  n.sort((x, y) => x - y);
  const mark = new RegExp(PART_MARK.source, 'u').exec(s);
  return mark ? `${n.join(',')}|${mark[1].replace('編', '')}` : n.join(',');
}

/** A ruby reading set after the title (katakana or Latin letters only). */
const READING = /^[\p{Script=Katakana}ー・a-z]{2,}$/u;
const KANJI = /\p{Script=Han}/u;
/** A subtitle is at least this long (a key's characters) to count on its own. */
const MIN_SUBTITLE = 3;

/** A listing that holds several books, never one book's listing. */
const SET_WORD = /合本|総集編|分冊|セット|全[0-9]+巻|[0-9]+-[0-9]+巻|BOX|ボックス/u;

/** The extra words of a side book or another work of the series, never a subtitle. */
const QUALIFIER =
  /^(?:外伝|番外|短編|特別編|前日譚|後日譚|新説|続|真|新|episode|episodes|extra|ex|ss|another|after|side|short|アフター|サイド|ショート|エピソード|零|0)/iu;

const rules = makeRules(CHOSEN_RULES);

/**
 * How `hitTitle` is the book's title (null: it is not). The volumes (printed numbers and part
 * marks) must agree first. The forms:
 *  - as written, volume marks and edition words aside (狼と香辛料 (2) = 狼と香辛料II);
 *  - the listing adds a ruby reading after a kanji subtitle, numbered volumes only
 *    (緋弾のアリア (2) 燃える銀氷 ダイヤモンドダスト);
 *  - one adds a subtitle the other lacks, only when both print the same volume number right after
 *    the shared words and the extra words are not a side book's (ゼロの使い魔(7) = ゼロの使い魔 7
 *    銀の降臨祭; not 異世界拷問姫外伝3 = 異世界拷問姫3, not 風の大陸 第3部 = 風の大陸 氷の島3);
 *  - the same parts in another order (キメラの刻印: 警察庁α特務班 = 警察庁α特務班 キメラの刻印).
 */
export function sameTitle(hitTitle: string, bookTitle: string): SameHow | null {
  const hv = volKey(hitTitle);
  const bv = volKey(bookTitle);
  if (hv !== bv) return null;
  const kb = titleKey(bookTitle);
  const kh = titleKey(hitTitle);
  if (!kb || !kh) return null;
  if (kh === kb) return 'as-written';
  const numbered = /[0-9]/u.test(bv);
  if (numbered && kh.startsWith(kb)) {
    const tail = kh.slice(kb.length);
    const last =
      nfkc(bookTitle)
        .trim()
        .split(/[\s\u3000]+/u)
        .pop() ?? '';
    if (READING.test(tail) && KANJI.test(last)) return 'reading';
  }
  if (numbered) {
    const [short, long, longRaw] = kb.length < kh.length ? [kb, kh, hitTitle] : [kh, kb, bookTitle];
    const extra = long.slice(short.length);
    if (
      long.startsWith(short) &&
      [...extra].length >= MIN_SUBTITLE &&
      [...short].length >= 2 &&
      !QUALIFIER.test(extra) &&
      numberAfter(longRaw, short)
    )
      return 'subtitle';
  }
  const pb = titleParts(bookTitle).sort();
  const ph = titleParts(hitTitle).sort();
  if (pb.length >= 2 && pb.join('\u0000') === ph.join('\u0000')) return 'order';
  return null;
}

/** The title's first volume number stands right after `key` (風の大陸 第3部, not 氷の島3). */
function numberAfter(title: string, key: string): boolean {
  const t = listingText(title);
  const m = /[(（]?\s*(?:第\s*)?(?:[0-9]+|X{0,3}(?:IX|IV|V?I{1,3}|V)|X{1,3})(?![A-Za-z0-9])/u.exec(
    t,
  );
  if (!m || m.index === 0) return false;
  return titleKey(t.slice(0, m.index)) === key;
}

/** Why `hit` is not another listing of `book`, and how its title agrees (fails empty: it is). */
export function sameBook(
  hit: BookmeterHit,
  book: SameBook,
): { fails: SameFail[]; how: SameHow | null } {
  const fails: SameFail[] = [];
  const row = { au: book.authors } as unknown as BookRow;
  if (!rules.author(row, hit)) fails.push('author');
  const H = nfkc(hit.title);
  const own = book.own.map((t) => nfkc(t));
  const how = sameTitle(hit.title, book.title);
  if (!how) fails.push(volKey(hit.title) === volKey(book.title) ? 'title' : 'volume');
  const set = SET_WORD.exec(H);
  if (set && !own.some((t) => t.includes(set[0]))) fails.push('set');
  if (book.fmt !== 'manga' && book.fmt !== 'image-only') {
    // A comic label outside the book's own title words (エロマンガ先生 is not a comic).
    let rest = H;
    for (const t of [book.series ?? '', book.title]) {
      const w = listingText(t)
        .replace(/\s*[0-9IVX]+\s*$/u, '')
        .trim();
      if (w.length >= 2) rest = rest.split(w).join(' ');
    }
    if (COMIC_LABEL.test(rest)) fails.push('comic');
    if (adaptationListing(book.authors, hit.authors)) fails.push('adaptation');
  }
  return { fails, how };
}

/** Why `hit` is not another listing of `book` (an empty list: it is). */
export function sameBookFails(hit: BookmeterHit, book: SameBook): SameFail[] {
  return sameBook(hit, book).fails;
}

// ---------------------------------------------------------------- memoized

/**
 * The same titles come again and again (an author's pages are judged against every book of the
 * author): each form is worked out once. Bounded: the cache is emptied past MEMO_MAX titles.
 */
const MEMO_MAX = 50_000;
function memo<T>(f: (s: string) => T): (s: string) => T {
  const m = new Map<string, T>();
  return (s) => {
    const had = m.get(s);
    if (had !== undefined) return had;
    if (m.size >= MEMO_MAX) m.clear();
    const v = f(s);
    m.set(s, v);
    return v;
  };
}

/** The title with its trailing labels dropped (a label code's numbers are not a volume). */
export const listingText = memo(listingTextRaw);
/** The title as one key, volume marks set aside. */
export const titleKey = memo(titleKeyRaw);
const titleParts = memo(titlePartsRaw);
/** The printed volume (see volKeyRaw). */
export const volKey = memo(volKeyRaw);
