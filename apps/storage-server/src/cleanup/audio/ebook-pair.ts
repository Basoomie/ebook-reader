/**
 * Audiobook stage 8 (WP21g): which Calibre book is a recording's exact volume. Pure.
 *
 * Decided with the user (2026-11-22): a recording is paired by its cleaned title, author and
 * printed volume (Kindle and Audible ids differ, so ids can't pair them); AI books, radio clips
 * and drama CDs are never paired; a part of one printed volume (前編/後編, 上/下 of one volume)
 * pairs with that volume, while an ebook in parts against a whole recording goes to review. No
 * wrong automatic pair: anything unsure is review.
 *
 * Per candidate (found through an author index, else an exact title index), the checks:
 *   title    the titles without their numbers are the same; or one is inside the other (from
 *            the guard's length and share) or their pair share is high (stage 4's `sim`), and
 *            then the series agree too (else review); a subtitle in a bracket at the end must
 *            agree (`titleBracket`); a side book (外伝, 短編集, Ex, SS) is never a main volume
 *   author   some author is the same person (`personKey`, containment from two characters)
 *   volume   the number each title prints after the part both titles share (a common prefix
 *            never ends inside a number), else the series number (the recording's store label,
 *            Calibre's series_index): equal; none on either side is a standalone
 *   parts    上/中/下 and 前編/中編/後編 marks agree, except a recording in parts against its whole
 *            volume (decided)
 *   edition  never a sample, a bonus item, an omnibus, a manga or an image-only book
 * Exactly one candidate passing (or one with the same title as the recording among those that
 * pass, or several that are editions of one volume with the same series, number and terms) is a
 * pair; several different books, a check that is only nearly met, or a recording without an
 * author go to review.
 */
import { nfkc } from '../title-rules';
import { editionKind } from '../stage3-kinds';
import { nums, sim } from '../stage4/pick';
import { BY_ID, termId, type Kind } from '../stage5/vocab';
import { searchTitle, titleBracket, personKey } from './online-names';
import { storeTitle } from './online-match';
import { seriesKey } from '../stage4/series-spelling';
import { SIDE } from '../stage4/series-order';
import type { SeriesEntry } from './meta-rules';

/** Raised when the rules change (stage 8 decides again from what is stored). */
export const EBOOK_RULES_VERSION = 1;

export interface AudioFacts {
  unitKey: string;
  kind: 'record' | 'no_record' | 'ai' | 'radio';
  /** Stage 5's decided title. */
  title: string;
  /** Other titles of the recording (the store record's title as written). */
  otherTitles: string[];
  authors: string[];
  /** Stage 5's decided series (null = unknown, [] = none). */
  series: SeriesEntry[] | null;
  drama: boolean;
}

export interface EbookFacts {
  id: number;
  title: string;
  authors: string[];
  /** Calibre's series name and number (null: the book has no series). */
  series: string | null;
  index: number | null;
  tags: string[];
}

export interface PairSettings {
  titleScore: number;
  titleMinChars: number;
  titleMinShare: number;
}

export type PairClass = 'auto' | 'review' | 'none' | 'excluded';

export interface CandidateVerdict {
  id: number;
  title: string;
  /** pass: every check; near: one check only nearly met (review); fail: not this book. */
  outcome: 'pass' | 'near' | 'fail';
  exactTitle: boolean;
  split: boolean;
  why: string;
}

export interface PairResult {
  class: PairClass;
  calibreId: number | null;
  reason: string;
  /** The recording's facts as read (for the lists). */
  volume: string | null;
  candidates: CandidateVerdict[];
}

// ---------------------------------------------------------------------------------------------
// The recording

/** Why a recording is never paired (null: it is looked up). */
export function excludedWhy(a: AudioFacts): string | null {
  if (a.kind === 'ai') return 'An AI book (made from an ebook by the reader): not paired';
  if (a.kind === 'radio') return 'A radio clip: not paired';
  if (a.drama || /ドラマ\s*CD|\[CD\d*\]/i.test(nfkc(a.title)))
    return 'A drama CD (an original audio story, not a printed volume): not paired';
  if ((a.series ?? []).some((s) => /ドラマ\s*CD$/i.test(nfkc(s.name))))
    return 'A drama CD (an original audio story, not a printed volume): not paired';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Titles, numbers and parts

/** The comparison form: NFKC, lower case, spaces and punctuation removed (numbers kept). */
export function titleForm(s: string): string {
  return nfkc(s)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\u3000ー]/gu, '');
}

/**
 * The exact form: NFKC, lower case, spaces, punctuation and dashes removed, every other symbol
 * kept (「GJ部◎」 is not 「GJ部」).
 */
function exactForm(s: string): string {
  return nfkc(s)
    .toLowerCase()
    .replace(/[\s\p{P}~ー\-‐－]/gu, '');
}

/** A title as the index looks it up (the file-name cleaning, as stage 4 searches). */
function cleaned(t: string): string {
  return storeTitle(searchTitle(t));
}

/** An imprint or publisher in a bracket at the end (角川文庫, 講談社ＢＯＸ, 電撃文庫). */
const IMPRINT_BRACKET =
  /\s*[(（][^()（）]*(?:文庫|新書|ノベルス|ノベル|ブックス|BOOKS|Books|BOX|出版|書房|書店|コミックス|レーベル|Kindle)[^()（）]*[)）]\s*$/u;

/**
 * The title both sides are compared with: an Audible prefix ([17巻], [西尾維新]), store markers
 * (【電子特典付き】) and an imprint bracket at the end removed; every other bracket kept (its
 * number or part: （9）, （前）, ＜下＞).
 */
export function pairTitle(t: string): string {
  let s = nfkc(t);
  s = s.replace(/^\s*\[[^\]]*\]\s*/u, '');
  s = s.replace(/【[^】]*】/gu, ' ');
  s = s.replace(IMPRINT_BRACKET, '');
  return s.replace(/\s+/g, ' ').trim();
}

const OPEN = '\\s・:：_\\-ー―(（<＜〈《\\[［【「『';
const CLOSE = '\\s・:：_\\-ー―)）>＞〉》\\]］】」』';
const PART = new RegExp(`(^|[${OPEN}])(上|中|下|前編|中編|後編|前|後)(?:巻)?(?=$|[${CLOSE}])`, 'u');
/** 前/後 alone count only in brackets (（前）, 〈後〉): 「前」 alone is a word. */
const BRACKETED = /[(（<＜〈《[［【]$/u;

/** The part mark a title prints (上/中/下; 前編/中編/後編 and （前）/（後） read as 上/中/下). */
export function partOf(t: string): string | null {
  const s = nfkc(t);
  const re = new RegExp(PART.source, 'gu');
  for (const m of s.matchAll(re)) {
    const mark = m[2];
    if ((mark === '前' || mark === '後') && !BRACKETED.test(m[1])) continue;
    return mark === '前編' || mark === '前'
      ? '上'
      : mark === '中編'
        ? '中'
        : mark === '後編' || mark === '後'
          ? '下'
          : mark;
  }
  return null;
}

/** The title without its part mark (a recording in parts against its whole volume). */
function withoutPart(t: string): string {
  const s = nfkc(t);
  const re = new RegExp(PART.source, 'gu');
  let out = s;
  for (const m of s.matchAll(re)) {
    if ((m[2] === '前' || m[2] === '後') && !BRACKETED.test(m[1])) continue;
    out = s.slice(0, m.index! + m[1].length) + s.slice(m.index! + m[0].length);
    break;
  }
  return out
    .replace(/[(（<＜〈《[［【]\s*[)）>＞〉》\]］】]/gu, ' ')
    .replace(/[\s\-ー―]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A number followed by a word that makes it something else than a volume (4月, 8万枚, 16人, 2年;
 * series-order.ts's NOT_VOLUME), and years.
 */
const NOT_A_VOLUME =
  /\d+(?:\.\d+)?\s*(?:人|禁|歳|才|年|月|日|時|分|秒|億|万|千|円|%|％|回|個|つ|名|匹|頭|世紀|階|号|度|倍|色|kg|km|cm|分の)|\d{4}/gu;

/** The volume numbers a title prints (dates, counts and years left out). */
function volumeNums(s: string): number[] {
  const out = [...nums(s.replace(NOT_A_VOLUME, ' '))].filter((n) => n > 0 && n < 500);
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * The numbers each title prints after the part both share (the shared part's numbers are the
 * series' own: 8万枚, 86, 2年生編). The shared prefix never ends inside a number (1 / 11).
 * Case is kept for the numbers (Roman numerals are capitals).
 */
export function ownNumbers(a: string, b: string): { a: number[]; b: number[] } {
  const ox = nfkc(a).replace(/\s+/g, '');
  const oy = nfkc(b).replace(/\s+/g, '');
  const x = ox.toLowerCase();
  const y = oy.toLowerCase();
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  // Back off out of a number the prefix would cut, within one kind of numeral (digits, Roman
  // numerals, kanji numerals): 「X 1」 / 「X 11」 back off to 「X」, never into the X.
  const kinds = [/[0-9.]/, /[ivxl]/i, /[一二三四五六七八九十]/];
  const kind = kinds.find(
    (k) =>
      i > 0 &&
      k.test(x[i - 1]) &&
      ((i < x.length && k.test(x[i])) || (i < y.length && k.test(y[i]))),
  );
  if (kind) while (i > 0 && kind.test(x[i - 1])) i--;
  // A kanji numeral at the end is read only after a space (nums()); keep a space before it.
  return { a: volumeNums(' ' + ox.slice(i)), b: volumeNums(' ' + oy.slice(i)) };
}

const sameSet = (a: number[], b: number[]) =>
  a.length === b.length && a.every((n, i) => n === b[i]);

/** A store label's plain number ("11巻・後編" → 11, "5.5" → 5.5; "セカンドシーズン : 13" → null). */
export function labelNumber(label: string | null): number | null {
  if (!label) return null;
  // A bracket around it counts (kikubon's ＜3＞, 〈8〉).
  const m = /^\s*[<＜〈《(（[［【]?\s*(\d{1,3}(?:\.\d+)?)(?!\d)/.exec(nfkc(label));
  return m ? Number(m[1]) : null;
}

/** The recording's series numbers (its store labels' plain numbers, else positions). */
function audioSeriesNumbers(a: AudioFacts): number[] {
  const out = new Set<number>();
  for (const s of a.series ?? []) {
    const l = labelNumber(s.label);
    if (l !== null) out.add(l);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// People

function peopleAgree(a: string[], b: string[]): boolean {
  const ak = a.map(personKey).filter((x) => x !== '');
  const bk = b.map(personKey).filter((x) => x !== '');
  return ak.some((x) =>
    bk.some((y) => x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)))),
  );
}

// ---------------------------------------------------------------------------------------------
// The ebook

/** Why a Calibre book is never a recording's pair (null: it can be). */
export function ebookExcludedWhy(e: EbookFacts): string | null {
  const k = editionKind([e.title]);
  if (k.kind === 'sample') return `a sample (${k.marker})`;
  if (k.kind === 'bonus') return `a bonus item (${k.marker})`;
  if (k.kind === 'omnibus') return `an omnibus (${k.marker})`;
  const fmt = new Set(e.tags.map((t) => termId(t, FORMAT_IDS)).filter((x) => x !== null));
  if (fmt.has('fmt_manga')) return 'a manga';
  if (fmt.has('fmt_image_only')) return 'image-only';
  return null;
}

const FORMAT_IDS = new Set([...BY_ID.values()].filter((t) => t.kind === 'format').map((t) => t.id));
const ALL_IDS = new Set(BY_ID.keys());

/**
 * The ebook's genres and tags as ABS gets them (decided 2026-11-22): `genres` the genres and
 * subjects, `tags` the story tags, adaptations and format; in the vocabulary's order. Tags outside
 * the vocabulary (yours, the kept keywords) are never taken.
 */
export function ebookTerms(tags: string[]): { genres: string[]; tags: string[]; ids: string[] } {
  const ids = new Set<string>();
  for (const t of tags) {
    const id = termId(t, ALL_IDS);
    if (id) ids.add(id);
  }
  const genres: string[] = [];
  const out: string[] = [];
  const ordered: string[] = [];
  for (const [id, t] of BY_ID) {
    if (!ids.has(id)) continue;
    ordered.push(id);
    const k: Kind = t.kind;
    if (k === 'genre' || k === 'subject') genres.push(t.ja);
    else out.push(t.ja);
  }
  return { genres, tags: out, ids: ordered };
}

// ---------------------------------------------------------------------------------------------
// One candidate

/**
 * The title without its numbers (digits, Roman numerals, 第N巻/部, a kanji numeral at the end),
 * in the comparison form: the volume check compares the numbers, the title check the rest.
 */
export function bareTitle(t: string): string {
  let s = withoutEditionWords(pairTitle(t));
  s = s.replace(/第\s*[一二三四五六七八九十百]+\s*(?:巻|部|話|章)/gu, ' ');
  s = s.replace(/(?<![A-Za-z])(?=[IVXL])(?:XL|L?X{0,3})(?:IX|IV|V?I{0,3})(?![A-Za-z])/g, ' ');
  s = s.replace(/第?\s*\d+(?:\.\d+)?\s*(?:巻|部|話|章)?/gu, ' ');
  s = s.replace(/[\s\u3000][一二三四五六七八九十]+\s*$/u, ' ');
  return titleForm(s);
}

/** Edition words at the front (新装版 不祥事, 新版 おくのほそ道, 小説 天気の子) say nothing of the book. */
function withoutEditionWords(s: string): string {
  return s.replace(
    /^\s*(?:新装版|新装改訂版|新版|改訂版|完全版|決定版|愛蔵版|文庫版|小説)\s*/u,
    '',
  );
}

/**
 * The recording's own titles for the title check: the decided title, and the same without a
 * leading author name (「エドガー・アラン・ポー「黄金虫」」 is 黄金虫).
 */
function ownTitles(a: AudioFacts, t: string): string[] {
  const out = [t];
  const s = nfkc(t);
  for (const name of a.authors) {
    const n = nfkc(name);
    if (n.length >= 2 && s.startsWith(n)) {
      const rest = s
        .slice(n.length)
        .trim()
        .replace(/^[「『](.*)[」』]$/u, '$1')
        .trim();
      if (rest) out.push(rest);
    }
  }
  return out;
}

/** The title form with its numbers (an exact title is preferred among books that pass). */
function fullForm(t: string): string {
  return exactForm(pairTitle(t));
}

/** Calibre's series and the recording's are one (both none, or the same name). */
function seriesAgree(a: AudioFacts, e: EbookFacts): boolean {
  const mine = (a.series ?? []).map((x) => seriesKey(x.name)).filter((x) => x !== '');
  if (!e.series) return mine.length === 0;
  return mine.includes(seriesKey(e.series));
}

type TitleMatch =
  | { how: 'same' }
  | {
      how: 'contains';
      score: number;
      /** Whose title is the longer one. */
      longer: 'audio' | 'ebook';
      /** The shorter title begins the longer. */
      prefix: boolean;
      /** The longer adds another work after it (杜子春・南京の基督). */
      anotherWork: boolean;
      /** The longer adds a subtitle after a separator (嫌われる勇気―――自己啓発の源流…). */
      subtitle: boolean;
      /** The words only the longer has (brackets left out), in the comparison form. */
      extra: string;
    }
  | { how: 'similar'; score: number }
  | { how: 'no'; why: string };

/** Bracketed words (readings, 〈8〉, 〈4月－6月〉) left out. */
function withoutBrackets(s: string): string {
  return s.replace(/[〈《(（［[【<＜][^〉》)）］\]】>＞]*[〉》)）］\]】>＞]/gu, ' ');
}

/**
 * The recording's own titles against the ebook's (the store record's title is never used: its
 * short 「三国志 02」 is the same as another edition's 「三国志（二）」, a different volume).
 */
function titleMatch(own: string[], e: string, s: PairSettings): TitleMatch {
  const eb = bareTitle(e);
  if (!eb) return { how: 'no', why: 'title: none' };
  for (const t of own) if (bareTitle(t) === eb) return { how: 'same' };
  let best: TitleMatch = { how: 'no', why: 'title: 0' };
  let bestScore = 0;
  for (const t of own) {
    const ab = bareTitle(t);
    if (!ab) continue;
    const [short, long] = ab.length <= eb.length ? [ab, eb] : [eb, ab];
    const n = [...short].length;
    const m = [...long].length;
    if (long.includes(short)) {
      if (n >= s.titleMinChars && n / m >= s.titleMinShare) {
        const longer = ab.length <= eb.length ? 'ebook' : 'audio';
        const longRaw = withoutEditionWords(pairTitle(longer === 'ebook' ? e : t));
        const shortRaw = withoutEditionWords(pairTitle(longer === 'ebook' ? t : e)).trim();
        const at = longRaw.indexOf(shortRaw);
        const after = at >= 0 ? longRaw.slice(at + shortRaw.length) : '';
        const lb = bareTitle(withoutBrackets(longRaw));
        const sb = bareTitle(withoutBrackets(shortRaw));
        best = {
          how: 'contains',
          score: 1,
          longer,
          prefix: long.startsWith(short),
          anotherWork: /^\s*[・、,，&＆]/u.test(after),
          subtitle: at === 0 && /^\s*[―〜~:：\-－‐–—\s]/u.test(after),
          extra: lb.includes(sb) ? lb.replace(sb, '') : long.replace(short, ''),
        };
        bestScore = 1;
      } else if (bestScore < 1) best = { how: 'no', why: `title: only ${n} of ${m} characters` };
      continue;
    }
    const sc = Math.max(sim(ab, eb), sim(eb, ab));
    if (sc > bestScore) {
      bestScore = sc;
      best =
        sc >= s.titleScore
          ? { how: 'similar', score: sc }
          : { how: 'no', why: `title: ${Math.round(sc * 100) / 100}` };
    }
  }
  return best;
}

export function judge(a: AudioFacts, e: EbookFacts, s: PairSettings): CandidateVerdict {
  const v = (
    outcome: CandidateVerdict['outcome'],
    why: string,
    x: Partial<CandidateVerdict> = {},
  ) =>
    ({
      id: e.id,
      title: e.title,
      outcome,
      exactTitle: false,
      split: false,
      why,
      ...x,
    }) as CandidateVerdict;
  const notThis = ebookExcludedWhy(e);
  const aPart = partOf(a.title);
  const ePart = partOf(e.title);
  // A recording in parts against its whole volume: the title without the mark.
  const split = aPart !== null && ePart === null;
  const fix = (t: string) => (split ? withoutPart(t) : t);
  const own = ownTitles(a, a.title).map(fix);
  const exact = own.some((t) => fullForm(t) === fullForm(e.title));
  const t = titleMatch(own, e.title, s);
  if (t.how === 'no') return v('fail', t.why);
  // A sample or a bonus story is never the book (放課後…：描き下ろしショートストーリー).
  const aKind = editionKind([a.title]).kind;
  const eKind = editionKind([e.title]).kind;
  if ((aKind === 'sample' || aKind === 'bonus') && aKind !== eKind)
    return v(
      t.how === 'same' ? 'near' : 'fail',
      `the recording is a ${aKind === 'sample' ? 'sample' : 'bonus story'}`,
    );
  const ab = titleBracket(a.title);
  const eb = titleBracket(e.title);
  if (ab && eb && titleForm(ab) !== titleForm(eb)) return v('fail', `subtitle: (${ab}) / (${eb})`);
  if (aPart && ePart && aPart !== ePart) return v('fail', `part: ${aPart} / ${ePart}`);
  let near: string | null = null;
  // A side book (外伝, 短編集, Ex, SS …) is never a main volume.
  const aSide = SIDE.test(nfkc(a.title));
  const eSide = SIDE.test(nfkc(e.title));
  if (aSide !== eSide) {
    if (t.how !== 'same')
      return v('fail', `one is a side book (${aSide ? 'the recording' : 'the ebook'})`);
    near = `one is a side book (${aSide ? 'the recording' : 'the ebook'})`;
  }
  // A title that only partly agrees needs the series to agree too.
  const partly =
    t.how === 'contains'
      ? 'by one inside the other'
      : t.how === 'similar'
        ? `at ${Math.round(t.score * 100) / 100}`
        : null;
  if (partly && !seriesAgree(a, e))
    near ??= `the titles agree only ${partly} and the series differ (${e.series ?? 'none'})`;
  if (t.how === 'contains' && !near) {
    // The words only the longer title has must say nothing of another book: the series' name
    // (半沢直樹4 銀翼のイカロス, 非正規レジスタンス―池袋ウエストゲートパーク〈8〉), a part mark,
    // the ebook's own subtitle or edition after its title (コップクラフト3 DRAGNET MIRAGE RELOADED),
    // or a standalone's subtitle; never a volume's own name (三国志 02 群青の巻 / 三国志（二）) or
    // another work (杜子春・南京の基督).
    const keys = [
      ...(a.series ?? []).map((x) => titleForm(x.name)),
      e.series ? titleForm(e.series) : '',
    ].filter((k) => k !== '');
    const extra = t.extra;
    const seriesWords = extra !== '' && keys.some((k) => k.includes(extra));
    const partWords = /^(上|中|下|前編|中編|後編|上巻|中巻|下巻)$/u.test(extra);
    const standalone = !(a.series ?? []).length && !e.series;
    const ok =
      !t.anotherWork &&
      (extra === '' ||
        seriesWords ||
        partWords ||
        (t.longer === 'ebook' && t.prefix) ||
        (t.longer === 'audio' && standalone && t.subtitle));
    if (!ok)
      near = `one title is inside the other and the ${t.longer === 'audio' ? "recording's" : "ebook's"} title adds ${t.anotherWork ? 'another work' : `「${extra}」`}`;
  }
  // The volume.
  const nums2 = ownNumbers(pairTitle(split ? withoutPart(a.title) : a.title), pairTitle(e.title));
  const aSeries = audioSeriesNumbers(a);
  const eSeries = e.series !== null && e.index !== null ? [e.index] : [];
  const aVol = nums2.a.length ? nums2.a : aSeries;
  const eVol = nums2.b.length ? nums2.b : eSeries;
  const volText = `${aVol.join('/') || '-'} / ${eVol.join('/') || '-'}`;
  /** A number on each side and they agree (the volume is known, not only "none on either side"). */
  let confirmed = false;
  if (nums2.a.length && nums2.b.length) {
    // Every number the same (第一部「兵士の娘2」 is not 第一部 兵士の娘3, though both print 1).
    if (!sameSet(nums2.a, nums2.b)) return v('fail', `volume: ${volText}`);
    confirmed = true;
  } else if (nums2.a.length || nums2.b.length) {
    // One title prints a number, the other doesn't: its series number must say the same.
    const printed = nums2.a.length ? nums2.a : nums2.b;
    const otherSide = nums2.a.length ? eSeries : aSeries;
    if (otherSide.length) {
      if (!printed.some((n) => otherSide.includes(n))) return v('fail', `volume: ${volText}`);
      confirmed = true;
    } else if (printed.includes(1)) near = `volume 1 on one side only (${volText})`;
    else return v('fail', `volume: ${volText}`);
  } else if (aSeries.length && eSeries.length) {
    // Neither title prints a number. With exactly the same title (and author) it is the same
    // book whatever the two series count (エピクロスの処方箋: the store's 2, Calibre's 1).
    if (aSeries.some((n) => eSeries.includes(n))) confirmed = true;
    else if (!exact) near = `the series numbers differ (${volText})`;
  }
  // A title that only partly agrees: the series numbers may not differ either (やはり俺の青春ラブコメ
  // はまちがっている。結1 is the series' 15th book, not its 1st).
  if (partly && aSeries.length && eSeries.length && !aSeries.some((n) => eSeries.includes(n)))
    near ??= `the titles agree only ${partly} and the series numbers differ (${aSeries.join('/')} / ${eSeries.join('/')})`;
  if (t.how === 'same' && !exact && !confirmed) {
    // The same title but for numbers or marks (GJ部◎ / GJ部): a series book needs a number that
    // confirms the volume.
    const numbered = nums2.a.length || nums2.b.length || aSeries.length || eSeries.length;
    if (numbered)
      near ??= `the titles differ in a number or mark and nothing confirms the volume (${volText})`;
  }
  if (partly && !confirmed) {
    // A title that only partly agrees, with no number to confirm the volume: only a standalone
    // whose shorter title begins the longer (a subtitle after it), never another work joined on
    // (杜子春・南京の基督) or a series book (スマホを落としただけなのに 囚われの殺人鬼 is not vol. 1).
    const standalone = !(a.series ?? []).length && !e.series;
    const subtitle = t.how === 'similar' || (t.how === 'contains' && t.prefix && !t.anotherWork);
    if (!standalone || !subtitle)
      near ??= `the titles agree only ${partly} and no number confirms the volume (${volText})`;
  }
  if (ePart && !aPart) near ??= `the ebook is in parts (${ePart}), the recording is whole`;
  // The author: a book with exactly this title by someone else is only nearly it (review).
  if (!a.authors.length) near ??= 'the recording has no author to compare';
  else if (!peopleAgree(a.authors, e.authors)) {
    if (!exact) return v('fail', `author: ${e.authors.join(', ') || 'none'}`);
    near ??= `another author: ${e.authors.join(', ') || 'none'}`;
  }
  const x = { exactTitle: exact, split };
  if (notThis)
    return exact
      ? v('near', `the ebook is ${notThis}`, x)
      : v('fail', `the ebook is ${notThis}`, x);
  if (near) return v('near', near, x);
  return v(
    'pass',
    `title ${exact ? 'the same' : t.how === 'same' ? 'the same but for numbers' : t.how === 'contains' ? 'one inside the other' : `similar (${Math.round(t.score * 100) / 100})`}, volume ${volText}${split ? ', a part of the volume' : ''}`,
    x,
  );
}

// ---------------------------------------------------------------------------------------------
// The recording against its candidates

export function pairRecording(
  a: AudioFacts,
  candidates: EbookFacts[],
  s: PairSettings,
): PairResult {
  const ex = excludedWhy(a);
  const volume = null;
  if (ex) return { class: 'excluded', calibreId: null, reason: ex, volume, candidates: [] };
  const verdicts = candidates.map((e) => judge(a, e, s));
  const byId = new Map(candidates.map((e) => [e.id, e]));
  const pass = verdicts.filter((x) => x.outcome === 'pass');
  const near = verdicts.filter((x) => x.outcome === 'near');
  const shown = [...pass, ...near, ...verdicts.filter((x) => x.outcome === 'fail')].slice(0, 8);
  const done = (cls: PairClass, id: number | null, reason: string): PairResult => ({
    class: cls,
    calibreId: id,
    reason,
    volume,
    candidates: shown,
  });
  if (pass.length === 0) {
    if (near.length) return done('review', near[0].id, `Nearly: ${near[0].why}`);
    return done(
      'none',
      null,
      candidates.length
        ? 'No Calibre book passes the checks'
        : 'No Calibre book by this author or with this title',
    );
  }
  if (!a.authors.length)
    return done('review', pass[0].id, 'The recording has no author to compare');
  // One exact title among several passing.
  const exact = pass.filter((x) => x.exactTitle);
  const chosen = exact.length >= 1 && exact.length < pass.length ? exact : pass;
  if (chosen.length === 1) {
    if (near.some((x) => x.exactTitle) && !chosen[0].exactTitle)
      return done(
        'review',
        chosen[0].id,
        `Another book with the same title nearly passes: ${near.find((x) => x.exactTitle)!.why}`,
      );
    return done('auto', chosen[0].id, chosen[0].why);
  }
  // Copies of one volume in Calibre: the same title (an imprint in brackets aside), or the same
  // series, number and terms. The copy with its series, then the most genres and tags, then the
  // first is the pair (each is the exact volume).
  const books = chosen.map((x) => byId.get(x.id)!);
  const titleKey = (e: EbookFacts) => fullForm(e.title);
  const key = (e: EbookFacts) =>
    JSON.stringify([
      e.series ? seriesKey(e.series) : null,
      e.series ? e.index : null,
      ebookTerms(e.tags).ids,
    ]);
  if (books.every((e) => titleKey(e) === titleKey(books[0]) || key(e) === key(books[0]))) {
    const best = [...books].sort(
      (p, q) =>
        Number(q.series !== null) - Number(p.series !== null) ||
        ebookTerms(q.tags).ids.length - ebookTerms(p.tags).ids.length ||
        p.id - q.id,
    )[0];
    return done(
      'auto',
      best.id,
      `${books.length} copies of this volume in Calibre (${books.map((e) => e.id).join(', ')}): the one with its series and the most genres and tags`,
    );
  }
  return done(
    'review',
    chosen[0].id,
    `${chosen.length} Calibre books pass: ${chosen.map((x) => x.id).join(', ')}`,
  );
}

// ---------------------------------------------------------------------------------------------
// The index

export interface EbookIndex {
  byAuthor: Map<string, EbookFacts[]>;
  byTitle: Map<string, EbookFacts[]>;
}

export function buildIndex(books: Iterable<EbookFacts>): EbookIndex {
  const byAuthor = new Map<string, EbookFacts[]>();
  const byTitle = new Map<string, EbookFacts[]>();
  const add = (m: Map<string, EbookFacts[]>, k: string, e: EbookFacts) => {
    if (!k) return;
    const l = m.get(k);
    if (l) l.push(e);
    else m.set(k, [e]);
  };
  for (const e of books) {
    for (const a of new Set(e.authors.map(personKey))) add(byAuthor, a, e);
    add(byTitle, titleForm(cleaned(e.title)), e);
  }
  return { byAuthor, byTitle };
}

/** A recording's candidates: books by one of its authors, and books with exactly its title. */
export function candidatesOf(a: AudioFacts, idx: EbookIndex): EbookFacts[] {
  const out = new Map<number, EbookFacts>();
  for (const name of a.authors) {
    const k = personKey(name);
    if (!k) continue;
    for (const e of idx.byAuthor.get(k) ?? []) out.set(e.id, e);
  }
  for (const t of [a.title, ...a.otherTitles]) {
    for (const v of [t, withoutPart(t)])
      for (const e of idx.byTitle.get(titleForm(cleaned(v))) ?? []) out.set(e.id, e);
  }
  return [...out.values()].sort((x, y) => x.id - y.id);
}
