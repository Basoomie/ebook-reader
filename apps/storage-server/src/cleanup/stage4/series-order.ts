/**
 * The order of each series (series-order follow-up, plan approved 2026-11-22; pure).
 *
 * Stage 4 decided every book's series number on its own. Measured on 300 random series after
 * On (.tmp-e2e/series-measure): every series whose numbers came from a store record was right,
 * but 16 % of the series with a guessed or missing number were not: a number missing (Calibre
 * shows 1), a side book on a main volume's number, guesses on one number or out of order, a
 * book's title taken as the series name. This step looks at each series as a whole, after the
 * books are decided and the one spelling is chosen, and decides every number again from what
 * the series' own sources print, in this order:
 *
 *   1. the number printed in the book's own title (file, Calibre, colophon) after the name;
 *   2. the number printed in its matched store record's title;
 *   3. the number printed in a store result whose subtitle is the book's own (search results
 *      and series lists of every book of the series), when no other volume shares it;
 *   4. the unnumbered first volume (its title is the series name, the others start at 2);
 *   5. a side book (外伝, SS, SP, Another…; the user, 2026-11-22): N.5 after the main volume
 *      published just before it, N.6 for a second (bonus N.1 and omnibus N.9 stay as decided);
 *   6. a series where nothing prints a number: its place in RanobeDB's list, else the order of
 *      first publication from the colophons (a best guess; the user, 2026-11-22);
 *   7. otherwise the decided number (the models'), a best guess.
 *
 * Then the series checks: two different books on one number, or a book without one, move the
 * guessed book to a free number that keeps the publication order (a best guess with its
 * reason); two books that both print the same number go to review. A series name that is one
 * book's title, or that none of its books or stores show, goes to review. A title gets the
 * store's printed form with its number when the store prints one (the user, 2026-11-22: 「事情3
 * ～…～」), and a number the models added that no source prints is taken out again.
 *
 * Every best guess is written (the user: "I don't mind a best guess, but I should know which
 * items were a best guess") and listed with its reason on the stage-4 card.
 */
import { cleanTitle, lightNormalize, pyStrip } from '../title-rules';
import { nfkc } from './ref-text';
import { titleKey } from './pick';
import { seriesKey } from './series-spelling';

export type ValueFrom = 'store' | 'models' | 'guess' | 'calibre' | 'user';

export interface PoolEntry {
  title: string;
  from: 'amazon' | 'bookwalker' | 'ranobedb';
  /** RanobeDB's place of the book in its series list. */
  order?: number | null;
  /** RanobeDB's kind of entry (main, sub…). */
  type?: string | null;
}

/** One Calibre book of a series as stage 4 On leaves it, and what its sources print. */
export interface SeriesBook {
  uuid: string;
  calibreId: number;
  /** The series name after On (stage 4's decided and spelled name, else Calibre's). */
  name: string;
  /** The number after On; null = none (Calibre shows 1). */
  index: number | null;
  indexFrom: ValueFrom;
  nameFrom: ValueFrom;
  kind: 'full' | 'sample' | 'bonus' | 'special edition' | 'omnibus';
  /** The book's own titles: the file's, Calibre's before stage 4, the colophon's 『…』 titles. */
  own: string[];
  /** The title after On, and how it was decided. */
  title: string;
  titleFrom: ValueFrom | 'file';
  /** The authors after On (for cleaning a store title). */
  authors: string[];
  /** Titles of the records matched to this book (Amazon's product, BookWalker's page, RanobeDB). */
  records: string[];
  /** Series names the stores give for this book. */
  storeSeries: string[];
  /** Search results and series lists this book's lookups saw. */
  pool: PoolEntry[];
  /** The earliest date printed in the colophon, as yyyymmdd; null = none. */
  date: number | null;
  /**
   * The book's place in its store's full series list, from its own matched record (changed-series
   * measurement: Amazon's 「全12冊中6番目」 was thrown away, and the dates of e-books are often one
   * day for the whole series). Absent in facts saved before.
   */
  lists?: {
    amazon: number | null;
    amazonTotal: number | null;
    ranobedb: number | null;
    /** RanobeDB's kind of this book's entry (main, sub…). */
    ranobedbType: string | null;
    /** Which list each place is in (places from two lists are never compared: るるいえ's newer
     * arc is another RanobeDB series where its books are 1 and 2). */
    amazonList?: string | null;
    ranobedbList?: string | null;
  };
  /** The series name Calibre holds now (null: none; absent in facts saved before). */
  calibreName?: string | null;
}

export interface SeriesChoice {
  uuid: string;
  index: number | null;
  /** Where the number came from (shown on the card). */
  from: string;
  /** A best guess: written, and listed with its reason. */
  guess: boolean;
  reason: string | null;
  /** The title, when this step changes it. */
  title?: string;
  titleFrom?: string;
  /** A problem a person decides (the series name, a title, two books printing one number). */
  review?: string;
}

const KANJI: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  壱: 1,
  弐: 2,
  参: 3,
};
/** I-XXXIX (キノの旅XXIII: changed-series batch 2; the table ended at XX). */
const ROMAN: Record<string, number> = (() => {
  const units = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
  const r: Record<string, number> = {};
  for (let t = 0; t < 4; t++)
    for (let u = 0; u < 10; u++) if (t || u) r['X'.repeat(t) + units[u]] = t * 10 + u;
  return r;
})();

function kanjiNumber(s: string): number | null {
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch === '百') {
      total += (cur || 1) * 100;
      cur = 0;
    } else if (ch === '十') {
      total += (cur || 1) * 10;
      cur = 0;
    } else if (ch in KANJI) cur = KANJI[ch];
    else return null;
  }
  return total + cur;
}

/** Spaces, punctuation and brackets: what two spellings of one title may differ in. */
const SQUASH =
  /[\s\u3000~～〜\-‐―—–─・:：!！?？、。,.'"“”‘’「」『』()（）[\]［］【】<>＜＞〈〉《》*＊#＃/／]/gu;
const squash = (s: string) => nfkc(s).replace(SQUASH, '').toLowerCase();

/** One title of the book's own and a record's title are the same, apart from spaces and punctuation. */
export function sameTitle(record: unknown, own: string[]): boolean {
  if (typeof record !== 'string' || !record.trim()) return false;
  const r = squash(plain(record));
  return r.length >= 2 && own.some((t) => squash(plain(t)) === r);
}

/** Store markers, bonus notes and the imprint at the end: not part of a title's words. */
function plain(t: string): string {
  let s = nfkc(t);
  s = s.replace(/【(\d+(?:\.\d+)?)】/gu, ' $1 ');
  s = s.replace(/【[^】]*】/gu, ' ');
  s = s.replace(/〈[^〉]*(?:限定|版)[^〉]*〉/gu, ' ');
  s = s.replace(
    /\s*[(（][^()（）]*(文庫|ノベルス|ノベル|ブックス|BOOKS|Books|NOVELS|新書|コミックス|COMICS|出版|書房|e-FICTIONS|DIGITAL|ラノベ)[^()（）]*[)）]\s*$/u,
    '',
  );
  return s.trim();
}

/**
 * What follows the series name in a title (null when the name is not in it). The name is
 * matched apart from spaces and punctuation; a name with a 〜subtitle〜 also matches by the
 * part before it.
 */
export function afterName(title: string, name: string): string | null {
  const t = plain(title);
  // A name's own 【…】 is dropped from the title by plain() (ハズレ枠の【状態異常スキル】…: its
  // 「… 11.5」 and 「… 12」 were read as no number, changed-series batch 2), so it is too.
  for (const n of [name, nfkc(name).split(/[~～〜]/u)[0], plain(name)]) {
    const sn = squash(n);
    if (sn.length < 2) continue;
    const st = squash(t);
    const at = st.indexOf(sn);
    if (at < 0) continue;
    // Walk the title until its squashed prefix covers the name.
    let i = 0;
    let seen = 0;
    while (i < t.length && seen < at + sn.length) {
      if (squash(t[i]) !== '') seen++;
      i++;
    }
    // Closing punctuation of the name belongs to it (「事情～…～」 keeps its own subtitle).
    return t.slice(i);
  }
  return numberInsideName(t, name);
}

/**
 * A title printing its number inside the series name: the name's head, the number, then the
 * rest of the name (「Only Sense Online 22 ―オンリーセンス・オンライン―」, 「GENEZ―8 ジーンズ」,
 * 「キノの旅V the Beautiful World」: changed-series batch 2). What follows the head, or null.
 */
function numberInsideName(t: string, name: string): string | null {
  const nn = nfkc(name);
  const st = squash(t);
  for (const m of nn.matchAll(/[\s―─\-－~～〜（(【［「『]/gu)) {
    const cut = m.index ?? 0;
    const sh = squash(nn.slice(0, cut));
    const stl = squash(nn.slice(cut));
    if (sh.length < 2 || stl.length < 2) continue;
    const at = st.indexOf(sh);
    if (at < 0) continue;
    const between = st.slice(at + sh.length).split(stl)[0];
    if (between === st.slice(at + sh.length)) continue;
    // Only a number between the two parts (vol/第 and the like with it).
    if (!/^(?:vol|no|第)?(?:\d+(?:\.\d+)?|[ivx]{1,5}|[ⅰ-ⅻ])(?:巻)?$/u.test(between)) continue;
    let i = 0;
    let seen = 0;
    while (i < t.length && seen < at + sh.length) {
      if (squash(t[i]) !== '') seen++;
      i++;
    }
    return t.slice(i);
  }
  return null;
}

/** Words after a number that make it something other than a volume (16人, 18禁, 2001年). */
const NOT_VOLUME =
  /^(?:人|禁|歳|才|年|月|日|時|分|秒|億|万|千|円|%|％|回|個|つ|名|匹|頭|世紀|階|号|度|倍|色|kg|km|cm|分の)/u;
/** Words that make a book a side book of its series (after the series name only). */
const SIDE =
  /外伝|番外|別巻|短編集|短編|アンソロジー|画集|ARTWORKS|設定資料|ガイドブック|ファンブック|スピンオフ|アンコール|サイドストーリー|(?<![A-Za-z])(?:SSP|SS|SP\d*|EX|IF|Another|Encore|Extra ?Story|Side ?(?:of|story)|After ?story|Re[:：]IF)(?![A-Za-z])/iu;

/**
 * 「第二部 西方諸国編4」, 「第1部 ネオサイタマ炎上1」: a part (部) followed by the part's own
 * volume. The part is not the series number (stop 1 found 水属性の魔法使い, 本好きの下剋上 and
 * ニンジャスレイヤー on one number per part): such a title prints no single series number.
 */
const PART_THEN_VOLUME =
  /^部.*(?:\d|(?<![A-Za-z])[IVX]{1,5}(?![A-Za-z])|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|[一二三四五六七八九十]+(?:巻|$))/u;

/** A volume number in the text right after a series name, as printed. */
export function leadingNumber(rest: string): number | null {
  // A name's own closing ?/! can be left before the number (「…思った? Lv.24」).
  const r = nfkc(rest).replace(/^[\s・:：\-‐―─~～〜,、?？!！]+/u, '');
  // 「13.暁の約束」: a full stop after the number is not a decimal point.
  // 「Lv.24 DLC(1)」: a level is the volume (changed-series measurement read the 1).
  // 「disc6」, 「Step2」: words of a volume (not season: 「season3～ 1」 is an arc's volume 1).
  let m =
    /^(?:vol\.?|No\.?|Lv\.?|#|第|disc|step|stage|act|phase|episode)?\s*(\d+(?:\.\d+)?)(?!\d)(?!\.\d)/iu.exec(
      r,
    );
  if (m) {
    const after = r.slice(m[0].length);
    const v = parseFloat(m[1]);
    if (PART_THEN_VOLUME.test(after)) return null;
    if (v < 500 && !NOT_VOLUME.test(after)) return v;
    return null;
  }
  m = /^[(（](\d+(?:\.\d+)?)[)）]/u.exec(r);
  if (m) return parseFloat(m[1]);
  m =
    /^(?:第|その)?([〇零一二三四五六七八九十百壱弐参]+)(?:巻|部|界|章|集|幕|弾|話|編|冊)?(?=$|[\s・～~〜\-‐―─(（]|[^\p{Script=Han}])/u.exec(
      r,
    );
  if (
    m &&
    (r.startsWith('第') ||
      r.startsWith('その') ||
      /^[〇零一二三四五六七八九十百壱弐参]+(?:巻|部|界|章|集|幕|弾|話|編|冊)?(?:$|\s)/u.test(r))
  ) {
    const v = kanjiNumber(m[1]);
    if (PART_THEN_VOLUME.test(r.slice(r.indexOf(m[1]) + m[1].length))) return null;
    if (v !== null && v > 0) return v;
  }
  m = /^([IVX]{1,5})(?![A-Za-z])/u.exec(r);
  if (m && m[1] in ROMAN) return ROMAN[m[1]];
  return null;
}

/** The only volume-like number anywhere after the name ([３], ： 7, Volume 19, 【５】, ０８). */
export function onlyNumber(rest: string): number | null {
  let r = nfkc(rest);
  r = r.replace(/(?:19|20)\d\d\s*年[\d\s/・月日号合併]*/gu, ' ');
  r = r.replace(/(?<![\d.])(?:19|20)\d\d(?![\d.])/gu, ' ');
  const found = new Set<number>();
  // A number glued to a Latin letter is no volume (「Level N4」 is a JLPT level, 「DLC(1)」).
  for (const m of r.matchAll(/(?<![\d.A-Za-z])(\d+(?:\.\d+)?)(?!\d)(?!\.\d)/gu)) {
    const after = r.slice((m.index ?? 0) + m[0].length);
    const v = parseFloat(m[1]);
    if (v < 500 && !NOT_VOLUME.test(after)) found.add(v);
  }
  for (const m of r.matchAll(/(?<![A-Za-z])([IVX]{1,5})(?![A-Za-z])/gu))
    if (m[1] in ROMAN) found.add(ROMAN[m[1]]);
  return found.size === 1 ? [...found][0] : null;
}

/** The volume number a title prints for a series, or null. */
export function printedNumber(title: string, name: string): number | null {
  const rest = afterName(title, name);
  if (rest === null) return null;
  return leadingNumber(rest) ?? onlyNumber(rest);
}

/** 上/中/下 (前編/後編) of one work: its part, as a word of its own after the name. */
export function partOf(rest: string): 'first' | 'middle' | 'last' | null {
  const r = nfkc(rest)
    .replace(/新装版|完全版|決定版|改訂版|愛蔵版/gu, '')
    .replace(/[\s\u3000()（）〈〉<>【】[\]・]/gu, '');
  if (/^(?:上|上巻|前編|前)$/u.test(r)) return 'first';
  if (/^(?:中|中巻|中編)$/u.test(r)) return 'middle';
  if (/^(?:下|下巻|後編|後)$/u.test(r)) return 'last';
  return null;
}

/** An omnibus' last volume (「合本版 4－7」, 「全7巻」, 「1-3巻セット」), or null. */
export function omnibusLast(title: string): number | null {
  const t = nfkc(title);
  // 「【全1-6セット】」 too (changed-series measurement: placed at 5.9, before volume 6).
  let m = /(\d+)\s*[-－~～〜]\s*(\d+)\s*(?:巻|セット|】|\]|$|\s)/u.exec(t);
  if (m && Number(m[2]) > Number(m[1]) && Number(m[2]) < 500) return Number(m[2]);
  m = /全\s*(\d+)\s*巻/u.exec(t);
  if (m && Number(m[1]) < 500) return Number(m[1]);
  return null;
}

/**
 * An omnibus' last volume from the book's own titles: the file's title, Calibre's, and colophon
 * titles that name the series. A colophon also lists the author's other books (「新東亜大戦 全4巻」
 * in ASEAN連合艦隊's made it 4.9: changed-series batch 2).
 */
function omnibusOf(b: SeriesBook, name: string): number | null {
  const texts = [b.own[0], b.title, ...b.own.slice(1).filter((t) => afterName(t, name) !== null)];
  for (const t of texts) {
    if (!t) continue;
    const last = omnibusLast(t);
    if (last !== null) return last;
  }
  return null;
}

/**
 * Two parts of one volume (「…I＜上＞」 and 「…I＜下＞」, 「…1 「虚惑星の魔法使い」上巻」 and 「…下巻」):
 * the titles differ only by the part.
 */
export function partsOfOne(a: string, c: string): boolean {
  const strip = (t: string) =>
    squash(plain(t)).replace(/上巻|中巻|下巻|前編|中編|後編|上|中|下|前|後/gu, '');
  const sa = squash(plain(a));
  const sc = squash(plain(c));
  return sa !== sc && strip(a) === strip(c) && strip(a).length >= 2;
}

/**
 * A part's place in its volume (1 上/前編, 2 中, 3 下/後編), from a part mark standing as a word
 * of its own: 「＜上＞」, 「（下）」, 「〈中〉」, 「」下巻」, 「 前編」 (not the 上 of 「境界線上の」). 0: none.
 */
export function partRank(title: string): number {
  const t = plain(title);
  const re =
    /(?:^|[\s(（〈＜<【［[「『」』〉＞>）)])(上巻|中巻|下巻|前編|中編|後編|上|中|下|前|後)(?=$|[\s)）〉＞>】］\]」』(（〈＜<])/gu;
  let last = 0;
  for (const m of t.matchAll(re)) {
    const p = m[1];
    last = /^(?:上|前)/u.test(p) ? 1 : /^中/u.test(p) ? 2 : 3;
  }
  return last;
}

/**
 * An edition of the same volume: one title is the other's with words added after it
 * (「デート・ア・ライブ 十香デッドエンド」 and its 「… BOOK☆WALKER special edition …」).
 */
export function editionOf(a: string, c: string): boolean {
  const sa = squash(plain(a));
  const sc = squash(plain(c));
  if (sa === sc || Math.min(sa.length, sc.length) < 4) return false;
  const [short, long] = sa.length < sc.length ? [sa, sc] : [sc, sa];
  return long.startsWith(short) && !/^\d/u.test(long.slice(short.length));
}

/** Words of a 【…】 that marks an edition, not a title (【電子特別版】, 【イラスト付】, 【特典SS付き】). */
const EDITION_MARK =
  /版|特典|限定|付き|付|電子|イラスト|特装|特別|新装|完全|初回|記念|BOOK☆WALKER|書き下ろし|書下ろし|SS|カラー|挿絵|合本|セット/giu;
/** A 【…】 that is only an edition mark: little is left once its edition words are set aside. */
const onlyEditionMark = (x: string) => squash(x.replace(EDITION_MARK, '')).length <= 2;

/**
 * Two files of one book: the same title once labels and punctuation are set aside, or apart from
 * a publisher's short Latin code before it (「er-理系男子の…」 and 「理系男子の…」: changed-series
 * batch 2 had the copies on 1 and 2).
 */
export function copyTitles(a: string, c: string): boolean {
  // A 【…】 that is no edition mark is part of the title (「…話。【水泳部顧問編】」 and 「日本編【法隆寺
  // ・完全版】」 are books of their own).
  const marks = (t: string) =>
    [...nfkc(t).matchAll(/【([^】]*)】/gu)]
      .map((m) => m[1])
      .filter((x) => !/^\d+(?:\.\d+)?$/u.test(x) && !onlyEditionMark(x))
      .map(squash)
      .sort()
      .join('|');
  if (marks(a) !== marks(c)) return false;
  const sa = squash(plain(a));
  const sc = squash(plain(c));
  if (sa === sc) return sa.length > 0;
  const [short, long] = sa.length < sc.length ? [sa, sc] : [sc, sa];
  return (
    short.length >= 6 && long.endsWith(short) && /^[a-z]{1,4}$/u.test(long.slice(0, -short.length))
  );
}

/** The numbers a book's own title prints (「王妃のプライド2【９】」: 2 and 9). */
function digitsOf(b: SeriesBook): string {
  return [...nfkc(plain(b.own[0] ?? b.title)).matchAll(/\d+(?:\.\d+)?/gu)]
    .map((m) => String(parseFloat(m[0])))
    .join(',');
}

/** Whether two books' own titles print the same numbers. */
function sameDigits(a: SeriesBook, c: SeriesBook): boolean {
  return digitsOf(a) === digitsOf(c);
}

/**
 * Two files of one book: their own titles and their decided titles are each the same (a file
 * titled only with the series name is no proof: メイジアン・カンパニー's volumes all are).
 */
export function copyBooks(a: SeriesBook, c: SeriesBook): boolean {
  return copyTitles(a.own[0] ?? a.title, c.own[0] ?? c.title) && copyTitles(a.title, c.title);
}

/** Whether a title (after the series name) marks a side book. */
export function isSideTitle(title: string, name: string): boolean {
  const rest = afterName(title, name);
  // A title printing its volume number first is that volume, whatever it comes with (「英雄教室 6
  // 画集＋キャラクター事典収録…特装版」: stop 1's test half).
  return rest !== null && SIDE.test(nfkc(rest)) && leadingNumber(rest) === null;
}

/** The subtitle words after the series name with numbers set aside (for matching volumes). */
/**
 * The title without the series name, wherever the name stands: a name at the end
 * (「蒼穹に雪桜舞う！～新米修祓師退魔録～」) leaves the words before it, the volume's own.
 */
function withoutName(title: string, name: string): string {
  const t = plain(title);
  // A name's own 【…】 is dropped from the title by plain() (ハズレ枠の【状態異常スキル】…: its
  // 「… 11.5」 and 「… 12」 were read as no number, changed-series batch 2), so it is too.
  for (const n of [name, nfkc(name).split(/[~～〜]/u)[0], plain(name)]) {
    const sn = squash(n);
    if (sn.length < 2) continue;
    const at = squash(t).indexOf(sn);
    if (at < 0) continue;
    let start = -1;
    let i = 0;
    let seen = 0;
    while (i < t.length && seen < at + sn.length) {
      if (squash(t[i]) !== '') {
        if (seen === at && start < 0) start = i;
        seen++;
      }
      i++;
    }
    return `${t.slice(0, Math.max(0, start))} ${t.slice(i)}`;
  }
  return t;
}

function subKey(title: string, name: string): string {
  const rest = withoutName(title, name);
  return squash(
    nfkc(rest)
      .replace(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/gu, '')
      .replace(/第?[〇零一二三四五六七八九十百壱弐参]+(?:巻|部|界|章|集|幕|弾|話|編|冊)/gu, '')
      .replace(/(?<![A-Za-z])[IVX]{1,5}(?![A-Za-z])/gu, '')
      .replace(/vol\.?|No\./giu, ''),
  );
}

const COMIC = /MFC|コミック|マンガ|漫画|COMIC|Comic|comic|単話|分冊/u;

/** Words of an edition, not of an arc (「新装版 3」 is volume 3 again). */
const EDITION_WORDS =
  /新装版|完全版|愛蔵版|文庫版|決定版|改訂版|特装版|電子版|限定版|特別版|合本版|合冊版|DL版|web版|Kindle版/iu;

/**
 * The arc a title is in and its number in that arc (the user, 2026-11-22: arcs that number
 * again are counted straight through): the words between the series name and the volume number
 * (「２年生編４．５」 → 2年生編 4.5, 「SH×4」 → SH 4, 「Reborn on the Mars VI」 → reborn… 6), '' for
 * the series' own numbering. Null: the name is not in the title, or the number is an arc's own
 * (「第２部」: a part with no volume number).
 */
export function arcOf(title: string, name: string): { arc: string; n: number | null } | null {
  const rest = afterName(title, name);
  if (rest === null) return null;
  const r = nfkc(rest).replace(/^[\s・:：\-‐―─~～〜,、?？!！]+/u, '');
  let head: string;
  let num: string | null = null;
  // English words (「Reborn on the Mars VI 茨の宝冠」): the words are the arc, a Roman numeral or a
  // number after them its volume.
  const ascii = /^([A-Za-z][A-Za-z ]*)(\d+(?:\.\d+)?)?/u.exec(r);
  const words = ascii ? ascii[1].trim().split(/\s+/u) : [];
  if (ascii && words.length >= 2 && words.some((x) => x.length >= 3)) {
    if (ascii[2]) num = ascii[2];
    else if (words[words.length - 1] in ROMAN) num = words.pop()!;
    head = words.join(' ');
  } else {
    const t0 = r.split(/[\s(（「『【〈<～~]/u)[0];
    const m = /(\d+(?:\.\d+)?)(?!.*\d)/u.exec(t0);
    // 「season2～ 1」: a number right after the arc's own is the volume (the arc is season2).
    const next = /^[\s～~〜・:：-]*(\d+(?:\.\d+)?)(?![\d.])/u.exec(r.slice(t0.length));
    if (m && next) {
      head = t0;
      num = next[1];
    } else if (!m && next && EDITION_WORDS.test(t0)) {
      // 「新装版 3」: an edition word, then the volume.
      head = '';
      num = next[1];
    } else if (m) {
      head = t0.slice(0, m.index);
      num = m[1];
      if (/^\s*(?:部|章|界|巻目?)/u.test(t0.slice(m.index + m[1].length)) && /第\s*$/u.test(head))
        return null;
    } else head = t0;
  }
  head = head.replace(/[×xX#＃.・:：\-‐―─~～〜\s]+$/u, '');
  if (EDITION_WORDS.test(head)) head = '';
  const n = num === null ? null : /^\d/u.test(num) ? parseFloat(num) : (ROMAN[num] ?? null);
  return { arc: squash(head), n };
}

interface Work {
  b: SeriesBook;
  /** Can this step change the book's number (not Calibre's own nor the user's)? */
  ours: boolean;
  printed: number | null;
  printedFrom: string | null;
  side: boolean;
  rdbOrder: number | null;
  key: string;
  index: number | null;
  from: string;
  guess: boolean;
  reason: string | null;
  review?: string;
  /** Not placed by any source yet: the checks place it by date. */
  unplaced?: boolean;
  /** The book's place in the series' store list (RanobeDB's, else Amazon's), or null. */
  listOrder: number | null;
  /** A sub-series word and its own number printed before it (「闇の花３」, 「雅狼1」), or null. */
  sub: { g: string; n: number } | null;
}

/**
 * A sub-series in a title: a word with its own number right after it (「乱れる愛 闇の花３ ～祠☆闘士
 * シリーズ～」 → 闇の花 3, 「安里咲２」 → 安里咲 2), the series name set aside. Changed-series
 * measurement: books placed by date ran against these printed numbers (雅狼 3, 5, 2, 1, 4).
 */
export function subSeriesNumber(title: string, name: string): { g: string; n: number } | null {
  const t = nfkc(withoutName(title, name)).replace(
    /[(（[【<〈＜][^)）\]】>〉＞]*[)）\]】>〉＞]/gu,
    ' ',
  );
  let found: { g: string; n: number } | null = null;
  for (const tok of t.split(/[\s～~〜・:：、,]+/u)) {
    const m = /^(.*?\D)(\d{1,3})$/u.exec(tok);
    if (m && squash(m[1]).length >= 2 && !NOT_VOLUME.test(tok.slice(m[1].length + m[2].length))) {
      if (found) return null; // two numbered words: not one sub-series number
      found = { g: squash(m[1]), n: Number(m[2]) };
    }
  }
  return found;
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);

/** The choices for one series (its books share a seriesKey). */
export function orderSeries(books: SeriesBook[]): SeriesChoice[] {
  if (!books.length) return [];
  const name = books[0].name;
  // The series' pool: every result its books' lookups saw (not comic editions).
  const pool = new Map<string, PoolEntry>();
  for (const b of books)
    for (const e of b.pool) {
      if (COMIC.test(nfkc(e.title))) continue;
      const k = `${e.from}|${e.title}`;
      if (!pool.has(k)) pool.set(k, e);
    }
  const poolList = [...pool.values()];
  // Each result's subtitle once (lessons 3: per book against every result of a big series held
  // the server 1.6 s at stop 1): the numbers per subtitle, RanobeDB's place and kind per subtitle.
  const poolByKey = new Map<string, Set<number | null>>();
  const rdbByKey = new Map<string, { order: number | null; side: boolean; mixed?: boolean }>();
  for (const e of poolList) {
    const k = subKey(e.title, name);
    const s = poolByKey.get(k) ?? new Set<number | null>();
    s.add(printedNumber(e.title, name));
    poolByKey.set(k, s);
    if (e.from === 'ranobedb' && k) {
      const r = rdbByKey.get(k) ?? { order: null, side: false };
      // One subtitle at two places tells neither (「Chrome Closed Chronicle 2/3 ─…─」 are one key
      // once numbers are set aside: all three took place 1, changed-series batch 2).
      if (e.order != null && r.order !== null && r.order !== e.order) r.mixed = true;
      if (r.order === null && e.order != null) r.order = e.order;
      if (e.type && e.type !== 'main') r.side = true;
      rdbByKey.set(k, r);
    }
  }

  const works: Work[] = books.map((b) => {
    const ours = b.indexFrom !== 'calibre' && b.indexFrom !== 'user';
    let printed: number | null = null;
    let printedFrom: string | null = null;
    // The file's title, and colophon titles that are this book's (a colophon also names the
    // author's other books: 「ソード・ワールド2.0リプレイ 1」 in 「剣をつぐもの3」's).
    const k0 = b.own[0] ? subKey(b.own[0], name) : '';
    const own = b.own.filter((t, i) => i === 0 || (k0 !== '' && subKey(t, name) === k0));
    for (const t of own) {
      const n = printedNumber(t, name);
      if (n !== null) {
        printed = n;
        printedFrom = 'its own title';
        break;
      }
    }
    // A record's title only where no store decided the number: a record can be another volume
    // (the picker took volume 1), while a number the rules took from a store was right on every
    // measured series (97/97).
    const key = subKey(b.own[0] ?? b.title, name);
    if (printed === null && b.indexFrom !== 'store')
      for (const t of b.records) {
        const n = printedNumber(t, name);
        // Only a record with the book's own subtitle (a title that is just the series name
        // tells no volume apart, unless it is volume 1).
        if (n !== null && subKey(t, name) === key && (key !== '' || n === 1)) {
          printed = n;
          printedFrom = "its store record's title";
          break;
        }
      }
    if (printed === null && key) {
      // A store result with the book's own subtitle, when that subtitle is one volume's.
      const nums = poolByKey.get(key);
      const set = nums ? [...nums].filter((x): x is number => x !== null) : [];
      if (set.length === 1 && nums!.size === 1) {
        printed = set[0];
        printedFrom = 'a store result with its subtitle';
      }
    }
    const side =
      (b.kind === 'full' || b.kind === 'special edition') &&
      // Only the titles that are this book's: a colophon also lists the series' other books
      // (「僕は友達が少ない⑦」's names CONNECT, a side book: ⑦ was placed as one, 6.5).
      (own.some((t) => isSideTitle(t, name)) || (key !== '' && !!rdbByKey.get(key)?.side));
    const rdbEntry = key ? rdbByKey.get(key) : undefined;
    const rdbOrder: number | null = rdbEntry && !rdbEntry.mixed ? rdbEntry.order : null;
    return {
      b,
      ours,
      printed,
      printedFrom,
      side,
      rdbOrder,
      key,
      listOrder: null,
      sub: subSeriesNumber(b.own[0] ?? b.title, name),
      index: b.index,
      from: ours ? 'decided' : 'Calibre',
      guess: ours && (b.indexFrom === 'guess' || b.indexFrom === 'models'),
      reason:
        b.indexFrom === 'guess'
          ? 'The models disagreed and no source prints the number'
          : b.indexFrom === 'models'
            ? 'The models agreed but no source prints the number'
            : null,
    };
  });

  let listPick: 'ranobedb' | 'amazon' | null = null;
  // The series' store list (changed-series measurement): RanobeDB's when it places at least half
  // the books, else Amazon's. Only an order: it places books no number places (and side books),
  // before dates, which for e-books are often one day for the whole series.
  {
    const full = works.filter((w) => w.b.kind === 'full' || w.b.kind === 'special edition');
    // Each store's most common list among the books: only its places count.
    const listOf = (w: Work, k: 'ranobedb' | 'amazon') =>
      w.b.lists?.[k] == null
        ? null
        : String((k === 'ranobedb' ? w.b.lists.ranobedbList : w.b.lists.amazonList) ?? '');
    const main = (k: 'ranobedb' | 'amazon') => {
      const n = new Map<string, number>();
      for (const w of full) {
        const l = listOf(w, k);
        if (l !== null) n.set(l, (n.get(l) ?? 0) + 1);
      }
      const best = [...n].sort((a, c) => c[1] - a[1])[0];
      return best && best[1] >= 2 && best[1] * 2 >= full.length ? best[0] : null;
    };
    const rdb = main('ranobedb');
    const amz = rdb === null ? main('amazon') : null;
    const pick = rdb !== null ? 'ranobedb' : amz !== null ? 'amazon' : null;
    listPick = pick;
    const list = rdb ?? amz;
    if (pick)
      for (const w of works) w.listOrder = listOf(w, pick) === list ? w.b.lists![pick] : null;
    // A place two different books share tells neither apart (RanobeDB lists るるいえあんてぃーく
    // and るるいえあかでみっく both at 1); copies of one book may share it.
    const at = new Map<number, Work[]>();
    for (const w of works)
      if (w.listOrder !== null) at.set(w.listOrder, [...(at.get(w.listOrder) ?? []), w]);
    for (const ws of at.values())
      if (new Set(ws.map((w) => squash(plain(w.b.own[0] ?? w.b.title)))).size > 1)
        for (const w of ws) w.listOrder = null;
  }
  // Only side books (「プリンスシリーズ番外編１」, ２, ４ and no main volume): their own numbers are
  // the series' numbers (they were placed after a last volume that isn't there: 0.7, 0.6, 0.5).
  if (
    works.every((w) => w.side || (w.b.kind !== 'full' && w.b.kind !== 'special edition')) &&
    works.some((w) => w.side && w.printed !== null)
  )
    for (const w of works) if (w.side && w.printed !== null) w.side = false;

  // Main volumes: full books and special editions (特装版, 電子特別版: the volume with extras).
  const isMain = (w: Work) => (w.b.kind === 'full' || w.b.kind === 'special edition') && !w.side;
  const mains = works.filter(isMain);
  const set = (
    w: Work,
    index: number | null,
    from: string,
    guess: boolean,
    reason: string | null,
  ) => {
    if (!w.ours) return;
    w.index = index;
    w.from = from;
    w.guess = guess;
    w.reason = guess ? reason : null;
  };

  // 1-3. Printed numbers (main books and bonus/omnibus keep their decided N.1 / N.9).
  // A number a store decided stays (right on every measured series, 97/97; a title can print a
  // part's number instead, 「第二部 …4」): the printed numbers fill the others.
  for (const w of mains)
    if (w.b.indexFrom === 'store' && w.index !== null)
      set(w, w.index, 'its store record', false, null);
    else if (w.printed !== null) set(w, w.printed, w.printedFrom!, false, null);

  // 上/中/下 of one work, when every main book is a part (神獣聖戦 Perfect Edition 上 / 下).
  // Also with a subtitle after the part (「徳川幕閣盛衰記（中）―吉宗の陰謀」), when no book prints a
  // volume number.
  // Only one work: every book has the same words before its part (「徳川幕閣盛衰記」; not
  // 春夏秋冬代行者 「春の舞」 上/下 beside 「夏の舞」 上/下, several works each in parts).
  // The words before the part mark (a mark standing as its own word, as partRank reads it: not
  // the 下 of 「下馬将軍」).
  const before = (t: string) => {
    const m = [
      ...plain(t).matchAll(
        /(?:^|[\s(（〈＜<【［[「『」』〉＞>）)])(上巻|中巻|下巻|前編|中編|後編|上|中|下|前|後)(?=$|[\s)）〉＞>】］\]」』(（〈＜<])/gu,
      ),
    ].pop();
    return m && m.index !== undefined ? squash(plain(t).slice(0, m.index + 1)) : null;
  };
  const bases = new Set(mains.map((w) => before(w.b.own[0] ?? w.b.title)));
  const parts = mains.map((w) => {
    const p = partOf(afterName(w.b.own[0] ?? w.b.title, name) ?? '');
    if (p) return p;
    if (w.printed !== null || bases.size !== 1) return null;
    const r = partRank(w.b.own[0] ?? w.b.title);
    return r === 1 ? 'first' : r === 2 ? 'middle' : r === 3 ? 'last' : null;
  });
  // Numbers that already read 上 → 中 → 下, each its own, stay (「…ホームズの帰還」 上 2 / 下 3: the
  // series' first book is not in the library).
  const rankOf = { first: 1, middle: 2, last: 3 } as const;
  const inOrder =
    mains.every((w) => w.index !== null) &&
    new Set(mains.map((w) => w.index)).size === mains.length &&
    mains.every((w, i) =>
      mains.every(
        (o, j) =>
          !parts[i] || !parts[j] || rankOf[parts[i]!] >= rankOf[parts[j]!] || w.index! < o.index!,
      ),
    );
  if (mains.length > 1 && parts.every((x) => x !== null)) {
    // Counted up from the lowest number among them (the work may be the series' second book);
    // numbers already in order stay. Either way the parts' order is printed: dates never
    // reorder them (オトナな副社長と秘密の恋: the 下 file's colophon has the earlier date).
    const hasMiddle = parts.includes('middle');
    // The series is the work itself (「時の鳥籠」 上/下: 1, 2) or the work is one book of it
    // (「女子高生探偵シャーロット・ホームズの帰還」 上/下 in its series: their place stays, 2, 3).
    const known = mains.map((w) => w.index).filter((x): x is number => x !== null);
    const workBase = [...bases][0] ?? '';
    const isWholeSeries = !!workBase && workBase === squash(name);
    const base = isWholeSeries || !known.length ? 1 : Math.max(1, Math.min(...known));
    // A work that is the whole series is always 1, 2(, 3) (神なるオオカミ 上 1 / 下 3 had a gap).
    const keep = inOrder && !isWholeSeries;
    mains.forEach((w, i) => {
      const n = keep
        ? w.index!
        : base + (parts[i] === 'first' ? 0 : parts[i] === 'middle' ? 1 : hasMiddle ? 2 : 1);
      w.printed = n;
      w.printedFrom = 'its own title (上/中/下)';
      set(w, n, w.printedFrom, w.guess && keep, w.guess && keep ? w.reason : null);
    });
  }

  // A store bonus: the number of the volume it belongs to + 0.1 (the agreed rule).
  for (const w of works)
    if (w.b.kind === 'bonus' && w.ours && w.printed !== null) {
      const n = Math.floor(w.printed) === w.printed ? w.printed + 0.1 : w.printed;
      if (w.index !== n)
        set(w, Math.round(n * 10) / 10, `a store bonus for volume ${fmt(w.printed)}`, false, null);
    }

  // Omnibus editions without their number: the last volume + 0.9 (the agreed rule).
  for (const w of works)
    if (
      w.ours &&
      (w.b.kind === 'omnibus' ||
        // A range in its own title is an omnibus whatever its kind was taken for
        // (「【全1-6セット】おおかみさんにおやすみ。」 was 5.9, before volume 6).
        (w.printed === null && omnibusOf(w.b, name) !== null))
    ) {
      const last = omnibusOf(w.b, name);
      if (last !== null && w.index !== last + 0.9)
        set(w, last + 0.9, `an omnibus of volumes up to ${last}`, false, null);
    }

  const printedMains = mains.filter((w) => w.printed !== null);
  const anyPrinted = printedMains.length > 0;

  // 4. The unnumbered first volume: its title is the series name, the others start at 2.
  if (anyPrinted && !printedMains.some((w) => w.printed === 1)) {
    const firsts = mains.filter(
      (w) => w.printed === null && w.key === '' && w.b.indexFrom !== 'store',
    );
    const lowest = Math.min(...printedMains.map((w) => w.printed!));
    // Only one book can be it (copies of it aside): several unnumbered files of the series
    // (「メイジアン・カンパニー」 ③④⑥ with bare file titles) are not all volume 1.
    const titles = new Set(firsts.map((w) => squash(plain(w.b.title))));
    if (lowest === 2 && titles.size === 1)
      for (const w of firsts) set(w, 1, 'the first volume (no number printed)', false, null);
  }

  // 6. Nothing prints a number: RanobeDB's list, else the order of first publication.
  if (!anyPrinted && mains.length > 1) {
    let open = mains.filter((w) => w.ours && w.b.indexFrom !== 'store');
    // RanobeDB's list places the books it has; the others go by date between them (below).
    // The book's own RanobeDB entry first (its matched record), else its subtitle in the list.
    const place = (w: Work) => (listPick === 'ranobedb' ? w.listOrder : null) ?? w.rdbOrder;
    const listed = open.filter((w) => place(w) !== null);
    const listedAll = mains.filter((w) => place(w) !== null);
    if (listedAll.length && listedAll.length * 2 >= mains.length) {
      for (const w of listed) set(w, place(w), "its place in RanobeDB's series list", false, null);
      for (const w of open)
        if (place(w) === null)
          w.reason = 'Not in the series list: placed by first publication date';
      open = open.filter((w) => place(w) === null);
      for (const w of open) w.unplaced = true;
    } else {
      const dated = open.filter((w) => w.b.date !== null);
      // The models' numbers stay when they hold together: each book its own number, none
      // missing, and not against the dates (stop 1's test half: 福音の少年 1, 5, 7 with the
      // volumes between not in the library, and 四季 春夏秋冬 on one e-book date, were right).
      const nums = open.map((w) => w.index);
      const distinct = new Set(nums).size === nums.length && nums.every((x) => x !== null);
      const byDate = [...dated].sort((a, c) => a.b.date! - c.b.date!);
      const againstDates = byDate.some(
        (w, i) => i > 0 && byDate[i - 1].b.date! < w.b.date! && byDate[i - 1].index! > w.index!,
      );
      const datesTell = new Set(dated.map((w) => w.b.date)).size === dated.length;
      if (distinct && !againstDates) {
        // Kept, as the best guesses they are (their reasons stay).
      } else if (dated.length >= 2 && datesTell) {
        const taken = new Set(
          mains.filter((w) => !open.includes(w) && w.index !== null).map((w) => w.index!),
        );
        const order = [...dated].sort(
          (a, c) => a.b.date! - c.b.date! || a.b.calibreId - c.b.calibreId,
        );
        let n = 1;
        // Copies of one work (same subtitle, same date) share a number.
        let last: Work | null = null;
        for (const w of order) {
          if (last && last.key === w.key && last.b.date === w.b.date) {
            set(w, last.index, last.from, true, last.reason);
            continue;
          }
          while (taken.has(n)) n++;
          set(
            w,
            n,
            'the order of first publication',
            true,
            'No source prints a number: numbered by first publication date',
          );
          taken.add(n);
          last = w;
          n++;
        }
      }
    }
  }

  // Volumes in parts (the user, 2026-11-22: "the same volume number means the same book"; 下 was
  // shown before 上): a series with a volume split into 上/中/下 counts every book in reading
  // order, 1, 2, 3… (境界線上のホライゾン I上 1, I下 2, II上 3…). Bonuses and omnibus editions follow
  // the new numbers; side books are placed after them below.
  const split = mains.some(
    (w) =>
      w.index !== null &&
      partRank(w.b.title) > 0 &&
      // Another book on the number with another part mark (each part may have its own subtitle:
      // リビルドワールドI〈上〉 誘う亡霊 / I〈下〉 無理無茶無謀).
      mains.some(
        (o) =>
          o !== w &&
          o.index === w.index &&
          partRank(o.b.title) > 0 &&
          partRank(o.b.title) !== partRank(w.b.title),
      ) &&
      // Every book on the number is a part: 「転生したらスライムだった件 1」 beside a three-part
      // 「1 最強のスライム誕生！？（上）（中）（下）」 is another edition, not volume 1 in parts.
      mains.every((o) => o.index !== w.index || partRank(o.b.title) > 0),
  );
  if (split && mains.every((w) => w.index !== null)) {
    // Positions in the whole series, not only the books in the library (adding a missing part
    // later never moves the others): each volume takes one place, or as many as it has parts,
    // known from the books and from every store result of the series (a 中 anywhere: three).
    // A volume is in parts when two different parts carry its number (a part with a number of
    // its own is a volume: 徳川幕閣盛衰記 （上） 1, （中） 2, （下） 3).
    const ranksOf = new Map<number, Set<number>>();
    const note = (v: number | null, rank: number) => {
      if (v === null || rank === 0 || Math.floor(v) !== v) return;
      ranksOf.set(v, (ranksOf.get(v) ?? new Set<number>()).add(rank));
    };
    for (const w of mains) note(w.index, partRank(w.b.title));
    for (const e of poolList) note(printedNumber(e.title, name), partRank(e.title));
    const places = (v: number) => {
      const r = ranksOf.get(v);
      return !r || r.size < 2 ? 1 : r.has(2) ? 3 : 2;
    };
    const start = (v: number) => {
      let s = 0;
      for (let u = 1; u < v; u++) s += places(u);
      return s;
    };

    for (const w of mains) {
      const v = w.index!;
      const r = partRank(w.b.title);
      let pos: number;
      if (v < 1) pos = v;
      else if (Math.floor(v) !== v)
        pos = start(Math.floor(v)) + places(Math.floor(v)) + (v - Math.floor(v));
      else if (places(v) === 1) pos = start(v) + 1;
      else pos = start(v) + (r === 0 || r === 1 ? 1 : r === 2 ? 2 : places(v));

      const parts = r > 0;
      if (pos !== w.index)
        set(
          w,
          pos,
          parts
            ? 'the reading order (a volume in parts)'
            : 'the reading order (the series has volumes in parts)',
          w.guess,
          w.reason,
        );
    }
    // Bonuses and omnibus editions after the last place of their volume.
    const lastPlace = (v: number) => (v >= 1 ? start(v) + places(v) : v);
    for (const w of works) {
      if (!w.ours) continue;
      if (w.b.kind === 'bonus' && w.printed !== null && Math.floor(w.printed) >= 1)
        set(
          w,
          lastPlace(Math.floor(w.printed)) + 0.1,
          'a store bonus, after its volume',
          false,
          null,
        );
      if (w.b.kind === 'omnibus') {
        const last = omnibusOf(w.b, name);
        if (last !== null)
          set(w, lastPlace(last) + 0.9, `an omnibus of volumes up to ${last}`, false, null);
      }
    }
  }

  // Arcs that number again, counted straight through (the user, 2026-11-22): ようこそ's
  // 2年生編 1 follows 1年生編's 11.5 as 12, デュラララ!!SH follows ×13; arcs a list interleaves
  // (トリニティ・ブラッド's two sub-series) take the list's order. Only where books of two arcs
  // share a number; a series whose numbers the cleanup can't change all is left to review.
  {
    const found = new Map<Work, { arc: string; n: number | null }>();
    for (const w of mains)
      if (w.index !== null) {
        const a = arcOf(w.b.own[0] ?? w.b.title, name);
        // A volume number (under 100, whole or .5): not 「起源8.08」.
        if (a && (a.n === null || (a.n < 100 && (a.n * 2) % 1 === 0))) found.set(w, a);
      }
    // An arc is a numbered run: two books or more with their own numbers in it (a side book
    // 「プラクティカルウォーゲーム」 or a second edition is not one: stop-2 arc check).
    const runs = new Map<string, number>();
    for (const a of found.values()) if (a.n !== null) runs.set(a.arc, (runs.get(a.arc) ?? 0) + 1);
    // Copies are not an arc: an arc whose books' subtitles another arc's books have too
    // (「中の下！ ランク1.…」 is volume 1 again, 「中の下！1 ランク1.…」).
    // A book's own subtitle: its words after the name, numbers and the arc's name set aside
    // (「２年生編４」 has none; 「ランク1.中の下と言われて」 has 中の下と言われて).
    const subtitleOf = (w: Work, arc: string) => {
      const k = squash(
        nfkc(afterName(plain(w.b.own[0] ?? w.b.title), name) ?? '')
          .replace(/\d+(?:\.\d+)?/gu, '')
          .replace(/(?<![A-Za-z])[IVX]{1,5}(?![A-Za-z])/gu, ''),
      );
      const a = arc.replace(/\d+/gu, '');
      return a && k.startsWith(a) ? k.slice(a.length) : k;
    };
    const subs = new Map<Work, string>();
    for (const [w, a] of found) subs.set(w, subtitleOf(w, a.arc));
    const copies = (arc: string) => {
      const mine = [...found].filter(([, a]) => a.arc === arc).map(([w]) => subs.get(w)!);
      const others = [...found].filter(([, a]) => a.arc !== arc).map(([w]) => subs.get(w)!);
      const real = mine.filter((k) => k.length >= 4);
      return (
        real.length > 0 &&
        real.filter((k) => others.some((o) => o.length >= 4 && (o.includes(k) || k.includes(o))))
          .length *
          2 >=
          real.length
      );
    };
    // An arc with a book whose number isn't known yet is left alone (its copies would split).
    // Nor one with a book that is no plain numbered volume here (a side book, a bonus): its
    // books would be numbered apart (魔法戦士リウイ's ファーラムの剣 2-4 were side books).
    const unread = new Set(
      works
        .filter((w) => !mains.includes(w) || w.index === null)
        .map((w) => arcOf(w.b.own[0] ?? w.b.title, name)?.arc)
        // (Never the series' own numbering: side books sit in every long series.)
        .filter((a): a is string => a !== undefined && a !== ''),
    );
    let arcs = new Map(
      [...found].filter(
        ([, a]) => (runs.get(a.arc) ?? 0) >= 2 && !copies(a.arc) && !unread.has(a.arc),
      ),
    );
    // Side books, not an arc: books that sit between the series' own volumes in the list
    // (グロリアスドーン's アイキャッチ 1, 2 between 4 and 5).
    const own = [...arcs].filter(([, a]) => a.arc === '').map(([w]) => w);
    const ownSpan = own.filter((w) => w.listOrder !== null).map((w) => w.listOrder!);
    if (ownSpan.length >= 2) {
      const lo = Math.min(...ownSpan);
      const hi = Math.max(...ownSpan);
      const inside = new Set(
        [...arcs]
          .filter(
            ([w, a]) =>
              a.arc !== '' && w.listOrder !== null && w.listOrder > lo && w.listOrder < hi,
          )
          .map(([, a]) => a.arc),
      );
      arcs = new Map([...arcs].filter(([, a]) => !inside.has(a.arc)));
    }
    // An arc's book without a number of its own is the arc's first volume (「デュラララ!!SH」).
    for (const [w, a] of arcs)
      if (a.n === null && ![...arcs].some(([o, b]) => o !== w && b.arc === a.arc && b.n === 1))
        arcs.set(w, { arc: a.arc, n: 1 });
    const names = new Set([...arcs.values()].map((a) => a.arc));
    const clash = [...arcs].some(([w, a]) =>
      [...arcs].some(([o, b]) => o !== w && b.arc !== a.arc && o.index === w.index),
    );
    if (names.size >= 2 && clash) {
      const part = [...arcs.keys()];
      const listed = part.filter((w) => w.listOrder !== null);
      const byList =
        listed.length === part.length &&
        new Set(listed.map((w) => w.listOrder)).size === part.length;
      const inList = byList ? [...part].sort((a, c) => a.listOrder! - c.listOrder!) : [];
      // Interleaved: an arc's books are not together in the list.
      const seen: string[] = [];
      for (const w of inList) {
        const a = arcs.get(w)!.arc;
        if (seen[seen.length - 1] !== a) seen.push(a);
      }
      // Never where it would lose a printed .5 (ベン・トー's 箸休め 5.5), nor over the series' own
      // numbering (an arc interleaved with it is side books, kept out above).
      const interleaved =
        byList &&
        seen.length > new Set(seen).size &&
        !names.has('') &&
        part.every((w) => Number.isInteger(arcs.get(w)!.n ?? w.index!));
      // Every book it renumbers is listed (the user wants each number not printed as it is seen).
      const arcReason = 'Its arc numbers again: counted straight through in reading order';
      if (interleaved && inList.every((w, i) => w.ours || w.index === i + 1))
        inList.forEach((w, i) => {
          if (w.index !== i + 1)
            set(
              w,
              i + 1,
              'the reading order (the series list; its arcs number again)',
              true,
              arcReason,
            );
        });
      else if (!interleaved) {
        // The arcs in order: by the list, else by first publication, else the series' own
        // numbering first and the arcs by the number in their name (2年生編 before 3年生編).
        const groups = new Map<string, Work[]>();
        for (const w of part)
          groups.set(arcs.get(w)!.arc, [...(groups.get(arcs.get(w)!.arc) ?? []), w]);
        const first = (ws: Work[], f: (w: Work) => number | null) =>
          Math.min(...ws.map((w) => f(w) ?? Infinity));
        const numIn = (a: string) => {
          const m = /\d+/u.exec(a);
          return m ? Number(m[0]) : a === '' ? 0 : 1e6;
        };
        const order = [...groups].sort(
          ([a, x], [c, y]) =>
            first(x, (w) => w.listOrder) - first(y, (w) => w.listOrder) ||
            first(x, (w) => w.b.date) - first(y, (w) => w.b.date) ||
            numIn(a) - numIn(c) ||
            (a < c ? -1 : a > c ? 1 : 0),
        );
        // Planned first: a number the cleanup doesn't own (Calibre's, the user's) that would
        // change leaves the series as it is (to review); one that stays is fine.
        const plan = new Map<Work, number>();
        let offset = 0;
        order.forEach(([, ws], k) => {
          let top = offset;
          // An arc whose own numbers already go on after the arc before keeps them (「王妃の
          // プライド2【７】」-【１０】 after 【6】: changed-series batch 2 had them at 13-16).
          const lowest = Math.min(...ws.map((w) => arcs.get(w)!.n ?? Infinity));
          const shift = k > 0 && lowest > offset ? 0 : offset;
          for (const w of ws) {
            // The first arc keeps its numbers as they are now (護樹騎士団物語 10 is 11 after its
            // volume 7 in parts): the next arc follows them.
            const n =
              k === 0 ? w.index! : Math.round((shift + (arcs.get(w)!.n ?? w.index!)) * 100) / 100;
            top = Math.max(top, n, k === 0 ? w.index! : n);
            if (k > 0) plan.set(w, n);
          }
          offset = Math.floor(top);
        });
        if ([...plan].every(([w, n]) => w.ours || n === w.index))
          for (const [w, n] of plan)
            if (n !== w.index)
              set(w, n, 'the reading order (its arc numbers again)', true, arcReason);
      }
    }
  }

  // 5. Side books: N.5 after the main volume published (or listed) just before them.
  const sides = works.filter((w) => w.side && w.ours);
  if (sides.length) {
    const numbered = mains.filter((w) => w.index !== null);
    const used = new Set(works.filter((w) => !sides.includes(w)).map((w) => w.index));
    // The series list first (dates of e-books are often one day for the series), then dates, then
    // the side books' own numbers (「Girls Side 2」 before 「Girls Side 3」).
    const ordered = [...sides].sort(
      (a, c) =>
        (a.listOrder ?? Infinity) - (c.listOrder ?? Infinity) ||
        (a.b.date ?? Infinity) - (c.b.date ?? Infinity) ||
        (a.rdbOrder ?? Infinity) - (c.rdbOrder ?? Infinity) ||
        (a.printed ?? a.sub?.n ?? Infinity) - (c.printed ?? c.sub?.n ?? Infinity) ||
        a.b.calibreId - c.b.calibreId,
    );
    const placed: Work[] = [];
    for (const w of ordered) {
      // A copy of a side book already placed shares its number (「アンコール4〈電子特別版〉」's two
      // files were 22.6 and 22.7: changed-series batch 2).
      const twin = placed.find((p) => copyBooks(p.b, w.b));
      if (twin) {
        set(w, twin.index, twin.from, twin.guess, twin.reason);
        continue;
      }
      placed.push(w);
      let before: Work | null = null;
      let how = '';
      if (w.listOrder !== null) {
        for (const m of numbered)
          if (
            m.listOrder !== null &&
            m.listOrder < w.listOrder &&
            (!before || m.index! > before.index!)
          )
            before = m;
        if (before) how = 'listed';
      }
      if (!before && w.b.date !== null) {
        for (const m of numbered)
          if (m.b.date !== null && m.b.date <= w.b.date && (!before || m.index! > before.index!))
            before = m;
        how = 'published';
      }
      if (!before && w.rdbOrder !== null) {
        for (const m of numbered)
          if (
            m.rdbOrder !== null &&
            m.rdbOrder < w.rdbOrder &&
            (!before || m.index! > before.index!)
          )
            before = m;
        how = 'listed';
      }
      // Its own RanobeDB place, with the volumes on that list at their own numbers: the volumes
      // before it are its place less the side books listed before it (禁書目録 SS at 14 and SS2 at
      // 18 of the old list, with only volume 1 of the library on it: after 13 and 16, changed-
      // series batch 2). A best guess: side books not in the library would shift it.
      let counted = false;
      const L = w.b.lists?.ranobedbList ?? null;
      const P = w.b.lists?.ranobedb ?? null;
      if (!before && L && P !== null) {
        const onList = numbered.filter(
          (m) => m.b.lists?.ranobedbList === L && m.b.lists.ranobedb != null,
        );
        if (onList.length && onList.every((m) => m.b.lists!.ranobedb === m.index)) {
          const k = sides.filter(
            (o) =>
              o !== w &&
              o.b.lists?.ranobedbList === L &&
              o.b.lists.ranobedb != null &&
              o.b.lists.ranobedb < P,
          ).length;
          const v = P - 1 - k;
          for (const m of numbered)
            if (m.index! <= v && (!before || m.index! > before.index!)) before = m;
          if (before) {
            how = "counted in RanobeDB's list";
            counted = true;
          }
        }
      }
      const known = !!before;
      const base = before
        ? Math.floor(before.index!)
        : Math.max(0, ...numbered.map((m) => Math.floor(m.index!)));
      let n = base + 0.5;
      while (used.has(n) && n < base + 0.95) n = Math.round((n + 0.1) * 10) / 10;
      used.add(n);
      set(
        w,
        n,
        known
          ? `a side book ${how} after volume ${fmt(base)}`
          : 'a side book after the last volume',
        !known || counted,
        !known
          ? 'A side book: no date or list puts it between the volumes'
          : counted
            ? "A side book: placed by its place in RanobeDB's list, counting the volumes before it"
            : null,
      );
    }
  }

  // A guessed copy of a book whose number is confirmed takes that number (「王とサーカス」's second
  // file was guessed 4, its first is the store's 2: changed-series batch 2).
  for (const w of works) {
    if (!w.ours || !(w.guess || w.index === null)) continue;
    const twin = works.find(
      (c) =>
        c !== w &&
        c.index !== null &&
        (!c.ours || !c.guess) &&
        isMain(c) === isMain(w) &&
        copyBooks(c.b, w.b),
    );
    if (twin) set(w, twin.index, `a copy of a book numbered ${fmt(twin.index!)}`, false, null);
  }

  // The checks: two different books on one number, a book without one.
  // Copies of one volume: the same printed title, or the same number and subtitle (「file 3
  // prayer 1」 and 「… prayer 2」 share a subtitle once digits are set aside, but are two books).
  // Copies of one volume: the same title, or the same words (the name and numbers aside) and
  // the same number. 「≪婚礼編≫ …Ⅲ」 and 「≪婚約編≫ …Ⅲ」 are two books.
  const sameWork = (a: Work, c: Work) =>
    squash(plain(a.b.title)) === squash(plain(c.b.title)) ||
    (a.index === c.index && editionOf(a.b.title, c.b.title)) ||
    squash(plain(a.b.own[0] ?? a.b.title)) === squash(plain(c.b.own[0] ?? c.b.title)) ||
    (a.key === c.key && a.index === c.index && sameDigits(a.b, c.b)) ||
    copyBooks(a.b, c.b);
  const byIndex = new Map<number, Work[]>();
  for (const w of works)
    if (w.index !== null && (isMain(w) || w.side))
      byIndex.set(w.index, [...(byIndex.get(w.index) ?? []), w]);
  const movers: Work[] = [];
  // A number its title prints, shared with a different book the store numbered, yields to the
  // series list when the list agrees with every other confirmed number (「王妃のプライド2【７】」-
  // 「【１０】」 all read 2, beside the store's 【2】; Amazon lists them 7-10: changed-series batch 2).
  const storeKept = (w: Work) => !w.ours || w.b.indexFrom === 'store';
  const yields = new Set<Work>();
  for (const [, ws] of byIndex)
    for (const w of ws)
      if (
        w.ours &&
        !w.guess &&
        !storeKept(w) &&
        isMain(w) &&
        w.listOrder !== null &&
        ws.some((k) => k !== w && storeKept(k) && isMain(k) && !sameWork(k, w)) &&
        // Only where the list puts it elsewhere: a store's number on another book can be the
        // wrong one (ノーゲーム・ノーライフ's side book on 10 beside the printed 10).
        works.some(
          (c) =>
            c !== w &&
            isMain(c) &&
            storeKept(c) &&
            c.index !== null &&
            c.listOrder !== null &&
            c.listOrder !== w.listOrder &&
            c.index !== w.index &&
            c.listOrder < w.listOrder! !== c.index < w.index!,
        )
      )
        yields.add(w);
  if (yields.size) {
    const others = works
      .filter(
        (w) =>
          isMain(w) &&
          !yields.has(w) &&
          w.index !== null &&
          (!w.ours || !w.guess) &&
          w.listOrder !== null,
      )
      .sort((a, c) => a.listOrder! - c.listOrder!);
    const agrees =
      others.length >= 2 && others.every((w, i) => i === 0 || others[i - 1].index! < w.index!);
    if (agrees)
      for (const w of yields) {
        w.guess = true;
        movers.push(w);
      }
  }
  for (const [, ws] of byIndex) {
    if (ws.length < 2) continue;
    const distinct: Work[] = [];
    for (const w of ws) if (!distinct.some((d) => sameWork(d, w))) distinct.push(w);
    if (distinct.length < 2) continue;
    // Keep the confirmed one(s); move the guesses. Two confirmed: a person decides.
    const confirmed = ws.filter((w) => !w.ours || !w.guess);
    const keep = confirmed.length
      ? confirmed
      : [
          ws.sort(
            (a, c) =>
              (a.b.date ?? Infinity) - (c.b.date ?? Infinity) || a.b.calibreId - c.b.calibreId,
          )[0],
        ];
    if (confirmed.filter((w, i) => !confirmed.slice(0, i).some((d) => sameWork(d, w))).length > 1)
      for (const w of confirmed)
        if (w.ours) w.review = `Another book of the series also prints number ${fmt(w.index!)}`;
    for (const w of ws)
      if (!keep.includes(w) && w.ours && !keep.some((k) => sameWork(k, w)) && !movers.includes(w))
        movers.push(w);
  }
  if (works.length > 1)
    for (const w of works)
      if (w.ours && (w.index === null || w.unplaced) && isMain(w) && !movers.includes(w))
        movers.push(w);
  // (B) A guessed number against the series list moves (changed-series measurement: 神様とゲーム,
  // listed between ゲーム4 and ゲーム5, was 10). Only when the list agrees with every confirmed
  // number it places (a list that doesn't is not trusted).
  const confirmedListed = works
    .filter((w) => isMain(w) && w.index !== null && (!w.ours || !w.guess) && w.listOrder !== null)
    .sort((a, c) => a.listOrder! - c.listOrder!);
  const listAgrees =
    confirmedListed.length >= 2 &&
    confirmedListed.every((w, i) => i === 0 || confirmedListed[i - 1].index! < w.index!);
  if (listAgrees)
    for (const w of works)
      if (
        w.ours &&
        w.guess &&
        isMain(w) &&
        w.index !== null &&
        w.listOrder !== null &&
        !movers.includes(w) &&
        confirmedListed.some(
          (c) => c.listOrder !== w.listOrder && c.listOrder! < w.listOrder! !== c.index! < w.index!,
        ) &&
        // Only where the list leaves room (not before a book numbered 1).
        Math.min(
          Infinity,
          ...confirmedListed.filter((c) => c.listOrder! > w.listOrder!).map((c) => c.index!),
        ) > 1
      )
        movers.push(w);
  if (movers.length) {
    const taken = new Set(
      works.filter((w) => !movers.includes(w) && w.index !== null).map((w) => w.index!),
    );
    const fixed = works.filter((w) => !movers.includes(w) && w.index !== null && isMain(w));
    // A sub-series moves together, in its own printed order (雅狼 1-5 after 闇の花 1-5): its place
    // is its earliest book's in the list (else by date).
    const groupAt = new Map<string, number>();
    for (const w of movers)
      if (w.sub) {
        const at = w.listOrder ?? (w.b.date !== null ? 1e6 + w.b.date : Infinity);
        groupAt.set(w.sub.g, Math.min(groupAt.get(w.sub.g) ?? Infinity, at));
      }
    const placed = new Set<Work>();
    const placeOf = (w: Work) =>
      w.sub
        ? groupAt.get(w.sub.g)!
        : (w.listOrder ?? (w.b.date !== null ? 1e6 + w.b.date : Infinity));
    for (const w of movers.sort(
      (a, c) =>
        placeOf(a) - placeOf(c) ||
        (a.sub && c.sub && a.sub.g === c.sub.g ? a.sub.n - c.sub.n : 0) ||
        (a.b.date ?? Infinity) - (c.b.date ?? Infinity) ||
        a.b.calibreId - c.b.calibreId,
    )) {
      const had = w.index;
      // Between the volumes listed (else published) before and after it, else after the last one.
      let lo = 0;
      let hi = Infinity;
      const listed = fixed.filter((f) => f.listOrder !== null);
      let byList = w.listOrder !== null && listed.length > 0;
      if (byList) {
        for (const f of listed)
          if (f.listOrder! < w.listOrder!) lo = Math.max(lo, f.index!);
          else if (f.listOrder! > w.listOrder!) hi = Math.min(hi, f.index!);
        // No room before the first volume (るるいえ: listed before a book numbered 1, the list
        // and the numbers count differently): the list doesn't place it.
        if (hi <= 1) {
          byList = false;
          lo = 0;
          hi = Infinity;
        }
      }
      if (byList) {
        // The moved books before it in this order are placed already: after them too.
        lo = Math.max(lo, ...movers.filter((m) => m !== w && placed.has(m)).map((m) => m.index!));
      } else if (w.b.date !== null)
        for (const f of fixed) {
          if (f.b.date === null) continue;
          if (f.b.date <= w.b.date) lo = Math.max(lo, f.index!);
          else hi = Math.min(hi, f.index!);
        }
      else if (!w.sub || !movers.some((m) => placed.has(m) && m.sub?.g === w.sub!.g))
        lo = Math.max(0, ...[...taken]);
      // After the books of its sub-series moved before it (雅狼3 has no list place of its own).
      if (w.sub)
        lo = Math.max(
          lo,
          ...movers.filter((m) => placed.has(m) && m.sub?.g === w.sub!.g).map((m) => m.index!),
        );
      let n = Math.floor(lo) + 1;
      while (taken.has(n) && n < hi) n++;
      if (taken.has(n) || n >= hi) {
        n = Math.floor(lo) + 0.5;
        while (taken.has(n)) n = Math.round((n + 0.1) * 10) / 10;
      }
      taken.add(n);
      placed.add(w);
      set(
        w,
        n,
        'moved to a free number',
        true,
        had === null
          ? `No number was found: placed by ${byList ? "the series' store list" : 'first publication date'}`
          : `Number ${fmt(had)} ${byList ? "is against the series' store list" : 'belongs to another book of the series'}: moved by ${byList ? "the series' store list" : 'first publication date'}`,
      );
    }
  }

  // (C) Nothing confirmed for the list to agree with: the guessed books' numbers follow the list
  // (祠☆闘士: 闇の花 1-5, 雅狼 1-5, 紅孔雀 1-2 by Amazon's list; 雅狼2/3 have no place of their
  // own and go after their listed sub-series sibling). Not when two books share a list place.
  if (confirmedListed.length < 2) {
    const guessed = works.filter((w) => w.ours && w.guess && isMain(w) && w.index !== null);
    const keyOf = new Map<Work, number>();
    for (const w of guessed) if (w.listOrder !== null) keyOf.set(w, w.listOrder);
    for (const w of guessed) {
      if (keyOf.has(w) || !w.sub) continue;
      const sibs = guessed.filter((o) => o.sub?.g === w.sub!.g && o.listOrder !== null);
      const below = sibs.filter((o) => o.sub!.n < w.sub!.n).sort((a, c) => c.sub!.n - a.sub!.n)[0];
      const above = sibs.filter((o) => o.sub!.n > w.sub!.n).sort((a, c) => a.sub!.n - c.sub!.n)[0];
      if (below) keyOf.set(w, below.listOrder! + (w.sub.n - below.sub!.n) * 0.01);
      else if (above) keyOf.set(w, above.listOrder! - (above.sub!.n - w.sub.n) * 0.01);
    }
    const part = [...keyOf.keys()];
    const keys = part.map((w) => keyOf.get(w)!);
    if (part.length >= 2 && new Set(keys).size === keys.length) {
      // The numbers they hold, given out again in the list's order; but where the decided numbers
      // collided (each sub-series counted from 1 by the models), the collision step has already
      // moved them to leftover numbers: then 1, 2, 3… in the list's order, past the numbers others
      // hold (惑星ハシエラ's 32 books were 13.5, 13.6… on the live run, 14-32 on a copy whose
      // numbers were already apart: the live run of 2026-11-22).
      const raw = part.map((w) => w.b.index);
      const collided = new Set(raw).size !== raw.length;
      const held = new Set(
        works
          .filter((w) => !part.includes(w) && w.index !== null && isMain(w))
          .map((w) => w.index!),
      );
      const ranks: number[] = [];
      for (let n = 1; ranks.length < part.length; n++) if (!held.has(n)) ranks.push(n);
      const nums = collided ? ranks : part.map((w) => w.index!).sort((a, c) => a - c);
      if (new Set(nums).size === nums.length)
        [...part]
          .sort((a, c) => keyOf.get(a)! - keyOf.get(c)!)
          .forEach((w, i) => {
            if (w.index !== nums[i])
              set(
                w,
                nums[i],
                "the series' store list",
                true,
                `${w.reason ?? 'A best guess'}; in the order of the series' store list`,
              );
          });
    }
  }

  // A sub-series' guessed numbers follow its own printed numbers (「安里咲１」 was 5, 「安里咲２」 2):
  // the numbers its guessed books hold, given out again in that order. Confirmed numbers stay.
  const groups = new Map<string, Work[]>();
  for (const w of works)
    if (w.ours && w.guess && w.sub && w.index !== null && (isMain(w) || w.side))
      groups.set(w.sub.g, [...(groups.get(w.sub.g) ?? []), w]);
  for (const ws of groups.values()) {
    if (ws.length < 2 || new Set(ws.map((w) => w.sub!.n)).size !== ws.length) continue;
    const nums = ws.map((w) => w.index!).sort((a, c) => a - c);
    const byPrinted = [...ws].sort((a, c) => a.sub!.n - c.sub!.n);
    byPrinted.forEach((w, i) => {
      if (w.index !== nums[i])
        set(
          w,
          nums[i],
          w.from,
          true,
          `${w.reason ?? 'A best guess'}; in its sub-series' printed order`,
        );
    });
  }

  // The series name: a book's own title, or shown by no book and no store.
  const nameKey = squash(name);
  // 「講談名作文庫25 国定忠治」: the name is one book's title with its catalogue number; other
  // books share the words before the number with another number. (A first volume titled as its
  // series, 「クーデレすぎる…7日間」 and its 「(2)」, is not.)
  const nm = /^(.*?\D)(\d+)(\D.*)$/u.exec(nfkc(name));
  // (The book with that title need not be in the library: 「講談名作文庫25 国定忠治」 for 10 and 29.)
  const nameIsTitle =
    !!nm &&
    squash(nm[3]).length >= 2 &&
    books.some((b) =>
      b.own.some((t) => {
        const m = /^(.*?\D)(\d+)/u.exec(plain(t));
        return !!m && squash(m[1]) === squash(nm[1]) && m[2] !== nm[2];
      }),
    );
  const shown =
    books.some((b) =>
      [...b.own, ...b.records, ...b.storeSeries, b.title].some((t) => squash(t).includes(nameKey)),
    ) || poolList.some((e) => squash(e.title).includes(nameKey));
  const nameProblem = nameIsTitle
    ? "The series name is one book's title"
    : !shown && books.some((b) => b.nameFrom === 'models' || b.nameFrom === 'guess')
      ? 'No book and no store shows this series name'
      : null;

  // A book whose series is not the cleanup's (Calibre's own or the user's) and has no number:
  // never changed, but listed (stop 1: 「地にはマのつく星が降る！」, 「倫敦スコーンの謎」).
  if (works.length > 1)
    for (const w of works)
      if (!w.ours && w.index === null && isMain(w))
        w.review = "No number, and the cleanup did not decide this book's series";

  return works
    .filter((w) => w.ours || nameProblem || w.review)
    .map((w) => {
      const c: SeriesChoice = {
        uuid: w.b.uuid,
        index: w.index,
        // 'calibre': the step changes nothing of the book (the review only lists it).
        from: w.ours ? w.from : 'calibre',
        guess: w.guess,
        reason: w.guess ? w.reason : null,
      };
      // A name Calibre holds already is listed, not held for review: holding the numbers back
      // doesn't take the name out of Calibre (自薦短編シリーズ kept 15 books on 1).
      const inCalibre = !!w.b.calibreName && squash(w.b.calibreName) === squash(name);
      const review = nameProblem && w.b.nameFrom !== 'user' && !inCalibre ? nameProblem : w.review;
      if (review) c.review = review;
      else if (nameProblem && inCalibre && w.ours) {
        c.guess = true;
        c.reason = c.reason ? `${c.reason}; ${nameProblem}` : nameProblem;
      }
      const t = w.ours ? titleChoice(w, name) : null;
      if (t) {
        c.title = t.title;
        c.titleFrom = t.from;
        if (t.review && !c.review) c.review = t.review;
      }
      return c;
    });
}

/**
 * The title with its number (the user, 2026-11-22): the store's printed form when a store result
 * with the book's subtitle prints the same number; a number the models put in the title that no
 * source prints is taken out again.
 */
function titleChoice(
  w: Work,
  name: string,
): { title: string; from: string; review?: string } | null {
  const b = w.b;
  if (b.titleFrom === 'user' || b.titleFrom === 'calibre' || b.kind !== 'full' || w.side)
    return null;
  const now = printedNumber(b.title, name);
  const idx = w.index;
  const clean = (t: string) => pyStrip(lightNormalize(cleanTitle(t, b.authors)));
  if (now === null && idx !== null && !w.guess) {
    // The store's form with the number, from the record or a result with the same subtitle.
    for (const t of [...b.records, ...b.pool.map((e) => e.title)]) {
      if (COMIC.test(nfkc(t))) continue;
      if (printedNumber(t, name) !== idx) continue;
      if (subKey(t, name) !== w.key) continue;
      const nt = clean(t);
      if (nt && squash(nt) !== squash(b.title))
        return { title: nt, from: 'the store prints it with its number' };
    }
    return null;
  }
  // A reading-order number differs from the printed volume by design (IV is 7).
  if (now !== null && idx !== null && now !== idx && !w.from.startsWith('the reading order')) {
    const printedByFile = b.own.some((t) => printedNumber(t, name) === now);
    const printedByStore = b.records.some((t) => printedNumber(t, name) === now);
    if (
      !printedByFile &&
      !printedByStore &&
      (b.titleFrom === 'models' || b.titleFrom === 'guess')
    ) {
      // The models added a number no source prints: the file's own title again.
      const own = b.own.find((t) => afterName(t, name) !== null) ?? b.own[0];
      if (own) {
        const nt = clean(own);
        if (nt && squash(nt) !== squash(b.title))
          return {
            title: nt,
            from: "the file's own title (the models' number is not printed anywhere)",
          };
      }
      return null;
    }
    return {
      title: b.title,
      from: 'kept',
      review: `The title prints ${fmt(now)} but the series number is ${fmt(idx)}`,
    };
  }
  return null;
}

/** The library-wide checks after the order (the plan's gate 2), summed over series. */
export interface SeriesChecks {
  series: number;
  /** Series with more than one book. */
  multi: number;
  /** Numbers two different main books share (copies of one volume aside). */
  collisions: number;
  /** ... of them with no book marked a best guess or for review: must be 0. */
  collisionsUnmarked: number;
  /** Main books of a multi-book series without a number (Calibre shows 1). */
  missing: number;
  missingUnmarked: number;
  guesses: number;
  reviews: number;
  /** A few unmarked problems, for the report. */
  examples: string[];
}

export function emptyChecks(): SeriesChecks {
  return {
    series: 0,
    multi: 0,
    collisions: 0,
    collisionsUnmarked: 0,
    missing: 0,
    missingUnmarked: 0,
    guesses: 0,
    reviews: 0,
    examples: [],
  };
}

/** Adds one series' checks (its books and the step's choices for them) to a running total. */
export function addSeriesChecks(
  total: SeriesChecks,
  books: SeriesBook[],
  choices: SeriesChoice[],
): void {
  const by = new Map(choices.map((c) => [c.uuid, c]));
  total.series++;
  if (books.length > 1) total.multi++;
  const main = (b: SeriesBook) => b.kind === 'full' || b.kind === 'special edition';
  const marked = (b: SeriesBook) => {
    const c = by.get(b.uuid);
    return !!c && (c.guess || !!c.review);
  };
  for (const c of choices) {
    if (c.guess) total.guesses++;
    if (c.review) total.reviews++;
  }
  const idx = (b: SeriesBook) => {
    const c = by.get(b.uuid);
    return c ? c.index : b.index;
  };
  const at = new Map<number, SeriesBook[]>();
  for (const b of books) {
    if (!main(b)) continue;
    const i = idx(b);
    if (i === null) {
      if (books.length > 1) {
        total.missing++;
        if (!marked(b)) {
          total.missingUnmarked++;
          if (total.examples.length < 20) total.examples.push(`missing: ${b.name} | ${b.title}`);
        }
      }
      continue;
    }
    at.set(i, [...(at.get(i) ?? []), b]);
  }
  for (const [i, bs] of at) {
    // Copies of one volume: the same title, or the same subtitle and printed number.
    const copy = (a: SeriesBook, c: SeriesBook) =>
      squash(plain(a.title)) === squash(plain(c.title)) ||
      editionOf(a.title, c.title) ||
      squash(plain(a.own[0] ?? a.title)) === squash(plain(c.own[0] ?? c.title)) ||
      (subKey(a.own[0] ?? a.title, a.name) === subKey(c.own[0] ?? c.title, c.name) &&
        sameDigits(a, c)) ||
      copyBooks(a, c);
    const distinct: SeriesBook[] = [];
    for (const b of bs) if (!distinct.some((d) => copy(d, b))) distinct.push(b);
    if (distinct.length < 2) continue;
    total.collisions++;
    if (!bs.some(marked)) {
      total.collisionsUnmarked++;
      if (total.examples.length < 20)
        total.examples.push(
          `shared ${fmt(i)}: ${bs[0].name} | ${bs.map((b) => b.title).join(' / ')}`,
        );
    }
  }
}

/** Groups books by series (the spelling-blind key) and orders each. */
export function orderLibrary(books: SeriesBook[]): SeriesChoice[] {
  const by = new Map<string, SeriesBook[]>();
  for (const b of books) {
    const k = seriesKey(b.name);
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), b]);
  }
  const out: SeriesChoice[] = [];
  for (const [, bs] of by) out.push(...orderSeries(bs));
  return out;
}

/** For tests and the stop-1 tool: whether a title's words (number aside) match. */
export const _test = { subKey, plain, squash, titleKey };
