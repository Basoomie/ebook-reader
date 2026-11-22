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
const ROMAN: Record<string, number> = {
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
  for (const n of [name, nfkc(name).split(/[~～〜]/u)[0]]) {
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
  return null;
}

/** Words after a number that make it something other than a volume (16人, 18禁, 2001年). */
const NOT_VOLUME =
  /^(?:人|禁|歳|才|年|月|日|時|分|秒|億|万|千|円|%|％|回|個|つ|名|匹|頭|世紀|階|号|度|倍|色|kg|km|cm|分の)/u;
/** Words that make a book a side book of its series (after the series name only). */
const SIDE =
  /外伝|番外|短編集|短編|アンソロジー|画集|ARTWORKS|設定資料|ガイドブック|ファンブック|スピンオフ|(?<![A-Za-z])(?:SS|SP\d*|EX|IF|Another|Side ?(?:of|story)|After ?story|Re[:：]IF)(?![A-Za-z])/iu;

/** A volume number in the text right after a series name, as printed. */
export function leadingNumber(rest: string): number | null {
  const r = nfkc(rest).replace(/^[\s・:：\-‐―─~～〜,、]+/u, '');
  // 「13.暁の約束」: a full stop after the number is not a decimal point.
  let m = /^(?:vol\.?|No\.?|#|第)?\s*(\d+(?:\.\d+)?)(?!\d)(?!\.\d)/iu.exec(r);
  if (m) {
    const after = r.slice(m[0].length);
    const v = parseFloat(m[1]);
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
  for (const m of r.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)(?!\d)(?!\.\d)/gu)) {
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
  let m = /(\d+)\s*[-－~～〜]\s*(\d+)\s*(?:巻|】|\]|$|\s)/u.exec(t);
  if (m && Number(m[2]) > Number(m[1]) && Number(m[2]) < 500) return Number(m[2]);
  m = /全\s*(\d+)\s*巻/u.exec(t);
  if (m && Number(m[1]) < 500) return Number(m[1]);
  return null;
}

/** Whether a title (after the series name) marks a side book. */
export function isSideTitle(title: string, name: string): boolean {
  const rest = afterName(title, name);
  return rest !== null && SIDE.test(nfkc(rest));
}

/** The subtitle words after the series name with numbers set aside (for matching volumes). */
function subKey(title: string, name: string): string {
  const rest = afterName(title, name) ?? plain(title);
  return squash(
    nfkc(rest)
      .replace(/(?<![\d.])\d+(?:\.\d+)?(?![\d.])/gu, '')
      .replace(/第?[〇零一二三四五六七八九十百壱弐参]+(?:巻|部|界|章|集|幕|弾|話|編|冊)/gu, '')
      .replace(/(?<![A-Za-z])[IVX]{1,5}(?![A-Za-z])/gu, '')
      .replace(/vol\.?|No\./giu, ''),
  );
}

const COMIC = /MFC|コミック|マンガ|漫画|COMIC|Comic|comic|単話|分冊/u;

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
  const poolByKey = new Map<string, Set<number | null>>();
  for (const e of poolList) {
    const k = subKey(e.title, name);
    const s = poolByKey.get(k) ?? new Set<number | null>();
    s.add(printedNumber(e.title, name));
    poolByKey.set(k, s);
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
      (b.own.some((t) => isSideTitle(t, name)) ||
        poolList.some(
          (e) =>
            e.from === 'ranobedb' &&
            e.type &&
            e.type !== 'main' &&
            subKey(e.title, name) === key &&
            key !== '',
        ));
    let rdbOrder: number | null = null;
    for (const e of poolList)
      if (e.from === 'ranobedb' && e.order != null && key && subKey(e.title, name) === key) {
        rdbOrder = e.order;
        break;
      }
    return {
      b,
      ours,
      printed,
      printedFrom,
      side,
      rdbOrder,
      key,
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
  for (const w of mains)
    if (w.printed !== null) set(w, w.printed, w.printedFrom!, false, null);
    else if (w.b.indexFrom === 'store') set(w, w.index, 'its store record', false, null);

  // 上/中/下 of one work, when every main book is a part (神獣聖戦 Perfect Edition 上 / 下).
  const parts = mains.map((w) => partOf(afterName(w.b.own[0] ?? w.b.title, name) ?? ''));
  if (mains.length > 1 && parts.every((x) => x !== null)) {
    const hasMiddle = parts.includes('middle');
    mains.forEach((w, i) => {
      const n = parts[i] === 'first' ? 1 : parts[i] === 'middle' ? 2 : hasMiddle ? 3 : 2;
      w.printed = n;
      w.printedFrom = 'its own title (上/中/下)';
      set(w, n, w.printedFrom, false, null);
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
    if (w.b.kind === 'omnibus' && w.ours) {
      const last = w.b.own.map(omnibusLast).find((x) => x !== null) ?? null;
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
    if (lowest === 2)
      for (const w of firsts) set(w, 1, 'the first volume (no number printed)', false, null);
  }

  // 6. Nothing prints a number: RanobeDB's list, else the order of first publication.
  if (!anyPrinted && mains.length > 1) {
    let open = mains.filter((w) => w.ours && w.b.indexFrom !== 'store');
    // RanobeDB's list places the books it has; the others go by date between them (below).
    const listed = open.filter((w) => w.rdbOrder !== null);
    const listedAll = mains.filter((w) => w.rdbOrder !== null);
    if (listedAll.length && listedAll.length * 2 >= mains.length) {
      for (const w of listed)
        set(w, w.rdbOrder, "its place in RanobeDB's series list", false, null);
      for (const w of open)
        if (w.rdbOrder === null)
          w.reason = 'Not in the series list: placed by first publication date';
      open = open.filter((w) => w.rdbOrder === null);
      for (const w of open) w.unplaced = true;
    } else {
      const dated = open.filter((w) => w.b.date !== null);
      if (dated.length >= 2) {
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

  // 5. Side books: N.5 after the main volume published (or listed) just before them.
  const sides = works.filter((w) => w.side && w.ours);
  if (sides.length) {
    const numbered = mains.filter((w) => w.index !== null);
    const used = new Set(works.filter((w) => !sides.includes(w)).map((w) => w.index));
    const ordered = [...sides].sort(
      (a, c) =>
        (a.b.date ?? Infinity) - (c.b.date ?? Infinity) ||
        (a.rdbOrder ?? Infinity) - (c.rdbOrder ?? Infinity) ||
        a.b.calibreId - c.b.calibreId,
    );
    for (const w of ordered) {
      let before: Work | null = null;
      let how = '';
      if (w.b.date !== null) {
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
        !known,
        known ? null : 'A side book: no date or list puts it between the volumes',
      );
    }
  }

  // The checks: two different books on one number, a book without one.
  // Copies of one volume: the same printed title, or the same number and subtitle (「file 3
  // prayer 1」 and 「… prayer 2」 share a subtitle once digits are set aside, but are two books).
  const sameWork = (a: Work, c: Work) =>
    squash(plain(a.b.own[0] ?? a.b.title)) === squash(plain(c.b.own[0] ?? c.b.title)) ||
    (a.printed !== null && a.printed === c.printed && a.key === c.key);
  const byIndex = new Map<number, Work[]>();
  for (const w of works)
    if (w.index !== null && (isMain(w) || w.side))
      byIndex.set(w.index, [...(byIndex.get(w.index) ?? []), w]);
  const movers: Work[] = [];
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
      if (!keep.includes(w) && w.ours && !keep.some((k) => sameWork(k, w))) movers.push(w);
  }
  if (works.length > 1)
    for (const w of works)
      if (w.ours && (w.index === null || w.unplaced) && isMain(w) && !movers.includes(w))
        movers.push(w);
  if (movers.length) {
    const taken = new Set(
      works.filter((w) => !movers.includes(w) && w.index !== null).map((w) => w.index!),
    );
    const fixed = works.filter((w) => !movers.includes(w) && w.index !== null && isMain(w));
    for (const w of movers.sort(
      (a, c) => (a.b.date ?? Infinity) - (c.b.date ?? Infinity) || a.b.calibreId - c.b.calibreId,
    )) {
      const had = w.index;
      // Between the volumes published before and after it, else after the last one.
      let lo = 0;
      let hi = Infinity;
      if (w.b.date !== null)
        for (const f of fixed) {
          if (f.b.date === null) continue;
          if (f.b.date <= w.b.date) lo = Math.max(lo, f.index!);
          else hi = Math.min(hi, f.index!);
        }
      else lo = Math.max(0, ...[...taken]);
      let n = Math.floor(lo) + 1;
      while (taken.has(n) && n < hi) n++;
      if (taken.has(n) || n >= hi) {
        n = Math.floor(lo) + 0.5;
        while (taken.has(n)) n = Math.round((n + 0.1) * 10) / 10;
      }
      taken.add(n);
      set(
        w,
        n,
        'moved to a free number',
        true,
        had === null
          ? 'No number was found: placed by first publication date'
          : `Number ${fmt(had)} belongs to another book of the series: moved by first publication date`,
      );
    }
  }

  // The series name: a book's own title, or shown by no book and no store.
  const nameKey = squash(name);
  const nameIsTitle =
    /\d/.test(nfkc(name)) &&
    books.some((b) => b.own.some((t) => squash(plain(t)) === nameKey)) &&
    !books.every((b) => b.own.some((t) => squash(plain(t)) === nameKey));
  const shown =
    books.some((b) =>
      [...b.own, ...b.records, ...b.storeSeries, b.title].some((t) => squash(t).includes(nameKey)),
    ) || poolList.some((e) => squash(e.title).includes(nameKey));
  const nameProblem = nameIsTitle
    ? "The series name is one book's title"
    : !shown && books.some((b) => b.nameFrom === 'models' || b.nameFrom === 'guess')
      ? 'No book and no store shows this series name'
      : null;

  return works
    .filter((w) => w.ours || nameProblem)
    .map((w) => {
      const c: SeriesChoice = {
        uuid: w.b.uuid,
        index: w.index,
        from: w.from,
        guess: w.guess,
        reason: w.guess ? w.reason : null,
      };
      const review = nameProblem && w.b.nameFrom !== 'user' ? nameProblem : w.review;
      if (review) c.review = review;
      const t = titleChoice(w, name);
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
  if (now !== null && idx !== null && now !== idx) {
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
    const titles = new Set(bs.map((b) => squash(plain(b.own[0] ?? b.title))));
    if (titles.size < 2) continue;
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
