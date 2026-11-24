/**
 * Series under a short and a full name (tier 4, Part 3; design cleanup-finish.md; pure).
 *
 * Stage 4 kept one spelling per series (seriesKey), but a short and a full name are different
 * keys (十津川警部 / 十津川警部シリーズ, 本好きの下剋上 / 本好きの下剋上 〜司書に…〜), so one
 * series can sit under two names. Spin-offs and unrelated books look the same
 * (ソードアート・オンライン / … プログレッシブ, 源氏物語 / 源氏物語が面白いほどわかる本), so names
 * alone don't decide: this module finds the pairs, groups them as the WP20e report did, and
 * gathers the signals the measuring compares (decided with the user 2026-11-23: volume numbers
 * colliding when merged, authors in common, the stores' stored series answers, spin-off words).
 *
 * The pair rule is the series editor's (edits/series.ts seriesPairsOf): one name's key is the
 * start of the other's, with the WP20e report's minimum for the shorter key (MIN_KEY 3; the
 * editor's suggestions take 2): checked on a copy of the library, 440 of the report's 444 pairs
 * are found this way (the other 4 were respelled since), and a 2-letter key adds 156 pairs such
 * as 物語 / 〈物語〉シリーズ and 転生 / 転生したらスライムだった件. Nothing here reads a database.
 */
import { nfkc } from '../title-rules';
import { SIDE, addSeriesChecks, emptyChecks, type SeriesBook } from '../stage4/series-order';
import { seriesKey } from '../stage4/series-spelling';

/** The shorter key must be at least this long (the WP20e report's list). */
export const MIN_KEY = 3;

/** The WP20e report's five groups (wp20e-series-pairs.md). */
export type PairGroup =
  /** Only a trailing シリーズ added. */
  | 'series_word'
  /** Only a 〜subtitle〜 (or ―subtitle―) added. */
  | 'subtitle'
  /** A spin-off, extra or set word in the added text. */
  | 'spinoff'
  /** Any other added text. */
  | 'other'
  /** The keys nest, the names as written don't (「顔のない刑事」シリーズ / 顔のない刑事). */
  | 'spelled';

export const PAIR_GROUPS: PairGroup[] = ['series_word', 'subtitle', 'spinoff', 'other', 'spelled'];

export interface NamePair {
  short: string;
  long: string;
  shortBooks: number;
  longBooks: number;
  group: PairGroup;
  /** The long name's text after the short name (as written; from the key for 'spelled'). */
  added: string;
}

const codepoints = (s: string) => Array.from(s);

/**
 * Every pair in the library (no cap per name, unlike the editor's suggestions). Each name's
 * key prefixes are looked up in a map of the keys, so the cost grows with the names' lengths,
 * not with the square of the number of series (8,909 on the NAS).
 */
export function libraryPairs(series: { name: string; books: number }[]): NamePair[] {
  const byKey = new Map<string, { name: string; books: number }[]>();
  for (const s of series) {
    const k = seriesKey(s.name);
    if (codepoints(k).length < MIN_KEY) continue;
    const list = byKey.get(k);
    if (list) list.push(s);
    else byKey.set(k, [s]);
  }
  const out: NamePair[] = [];
  for (const [k, longs] of byKey) {
    const cps = codepoints(k);
    for (let n = MIN_KEY; n < cps.length; n++) {
      const shorts = byKey.get(cps.slice(0, n).join(''));
      if (!shorts) continue;
      for (const s of shorts) for (const l of longs) out.push(makePair(s, l));
    }
  }
  out.sort(
    (a, b) =>
      b.shortBooks + b.longBooks - (a.shortBooks + a.longBooks) ||
      (a.short < b.short ? -1 : a.short > b.short ? 1 : a.long < b.long ? -1 : 1),
  );
  return out;
}

function makePair(
  s: { name: string; books: number },
  l: { name: string; books: number },
): NamePair {
  const { group, added } = pairGroup(s.name, l.name);
  return { short: s.name, long: l.name, shortBooks: s.books, longBooks: l.books, group, added };
}

/** Separators between a name and the text added to it. */
const SEP = /^[\s\u3000・:：\-‐―—–]+|[\s\u3000・:：\-‐―—–]+$/gu;

/**
 * Spin-off, extra and set words: the series order's side-book words, and the extras the WP20e
 * report's lists show (フラグメント, マテリアル, プログレッシブ, 合本版, Art Works Re:BOX …).
 */
const SPINOFF_EXTRA =
  /アナザー|フラグメント|マテリアル|プログレッシブ|オルタナティブ|エピソード|エクストラ|すぺしゃる|スペシャル|特別編|盤外編|掌編集|サプリメント|リコレクション|ファンブック|ふぁんぶっく|公式|セット|合本|全\d+巻|(?<![A-Za-z])(?:Appendix|APPEND|Art ?Works|BOX|DLC|Memorial|Secret File|Collector's Edition|Fandisc|addon)(?![A-Za-z])/iu;

/** Whether text added to a series name marks a spin-off, an extra or a set. */
export function spinoffWord(added: string): string | null {
  const t = nfkc(added);
  const m = SIDE.exec(t) ?? SPINOFF_EXTRA.exec(t);
  return m ? m[0] : null;
}

const WAVE_SUBTITLE = /^[~～〜][^~～〜]+[~～〜]?$/u;
const DASH_SUBTITLE = /^[―—–\-‐][^―—–\-‐]+[―—–\-‐]?$/u;

/** The report's group of a pair, and the text the long name adds. */
export function pairGroup(short: string, long: string): { group: PairGroup; added: string } {
  const s = nfkc(short).trim();
  const l = nfkc(long).trim();
  if (!l.startsWith(s)) {
    const sk = codepoints(seriesKey(short)).length;
    return { group: 'spelled', added: codepoints(seriesKey(long)).slice(sk).join('') };
  }
  const raw = l.slice(s.length);
  const added = raw.replace(SEP, '');
  if (added === 'シリーズ') return { group: 'series_word', added: raw.trim() };
  // A spin-off word wins over a subtitle (「…〜司書に…〜 短編集」 is the short stories).
  if (spinoffWord(added)) return { group: 'spinoff', added: raw.trim() };
  if (WAVE_SUBTITLE.test(raw.trim()) || DASH_SUBTITLE.test(raw.trim()))
    return { group: 'subtitle', added: raw.trim() };
  return { group: 'other', added: raw.trim() };
}

/**
 * The name a merge keeps (the user, 2026-11-23: "the name without シリーズ or the subtitle (The
 * common name)"): the short name as written, without a trailing シリーズ, a trailing 〜subtitle〜
 * or a separator left at its end (「デューン・」). A short name that is the long one cut before
 * its long vowel mark (寄せ集めたファンタジ / 寄せ集めたファンタジー) keeps the long name: `cut` says so.
 */
export function commonName(short: string, long: string): { name: string; cut: boolean } {
  const added = codepoints(seriesKey(long)).slice(codepoints(seriesKey(short)).length);
  if (added.length === 1 && added[0] === 'ー') return { name: long.trim(), cut: true };
  let n = short.trim();
  for (let i = 0; i < 3; i++) {
    const before = n;
    n = n.replace(/\s*シリーズ$/u, '');
    n = n.replace(/\s*[~～〜][^~～〜]+[~～〜]$/u, '');
    n = n.replace(/[\s\u3000・:：\-‐]+$/u, '');
    if (n === before) break;
  }
  return { name: n || short.trim(), cut: false };
}

/** One Calibre book under one of the two names, with what stage 4 stored about its series. */
export interface PairBook {
  uuid: string;
  calibreId: number;
  title: string;
  authors: string[];
  /** Calibre's series number (Calibre always holds one for a book in a series). */
  index: number | null;
  /** Stage 4's kind (side books and omnibus editions are not main volumes). */
  kind: SeriesBook['kind'];
  /** The book's own titles (file, colophon) for telling copies of one volume apart. */
  own: string[];
  /** Amazon's series text for the book (「全12冊中6番目の本」 removed), or null. */
  amazonSeries: string | null;
  /** RanobeDB's series of the book: id and name. */
  ranobedbSeries: { id: string; name: string | null } | null;
  /** Store pages for the sample (Amazon dp, BookWalker, RanobeDB, Bookmeter). */
  links: { site: string; url: string }[];
}

export type StoreVerdict = 'same' | 'different' | 'none';

export interface PairSignals {
  /**
   * Numbers two different main books would share under one name that neither name has on its
   * own (copies of a volume aside): what a merge adds. A merge that adds any goes to review.
   */
  collisions: number;
  /** Numbers already shared inside one of the two names (the series' own numbering). */
  collisionsWithin: number;
  /** Examples of the numbers a book of each name shares (for the sample). */
  collisionExamples: string[];
  /** Both names have a main book numbered 1. */
  bothHaveOne: boolean;
  /** Authors the two names' books have in common (normalized). */
  sharedAuthors: string[];
  /** The share of the long name's books with an author of the short name's books. */
  longWithShortAuthor: number;
  /** The share of the long name's books whose title starts with the short name. */
  longTitlesStartShort: number;
  /** RanobeDB: one series id on both sides (same), only different ids (different), else none. */
  ranobedb: StoreVerdict;
  /** Amazon's series text, compared by key the same way. */
  amazon: StoreVerdict;
  /** A store gives a book of one side the other side's name. */
  storeNamesOther: boolean;
  /** The spin-off, extra or set word in the added text. */
  spinoff: string | null;
}

const authorKey = (a: string) =>
  nfkc(a)
    .replace(/[\s\u3000・=＝]/gu, '')
    .toLowerCase();

const compare = (a: Set<string>, b: Set<string>): StoreVerdict => {
  if (a.size === 0 || b.size === 0) return 'none';
  for (const x of a) if (b.has(x)) return 'same';
  return 'different';
};

const MAIN = (b: PairBook) => b.kind === 'full' || b.kind === 'special edition';

/** The signals of one pair from its two sides' books. */
export function pairSignals(pair: NamePair, short: PairBook[], long: PairBook[]): PairSignals {
  const merged = commonName(pair.short, pair.long).name;
  // The union under one name through the series order's own check (copies of one volume, side
  // books and omnibus editions are not collisions).
  const asSeries = (b: PairBook): SeriesBook => ({
    uuid: b.uuid,
    calibreId: b.calibreId,
    name: merged,
    index: b.index,
    indexFrom: 'calibre',
    nameFrom: 'calibre',
    kind: b.kind,
    own: b.own.length ? b.own : [b.title],
    title: b.title,
    titleFrom: 'calibre',
    authors: b.authors,
    records: [],
    storeSeries: [],
    pool: [],
    date: null,
  });
  const count = (bs: PairBook[]) => {
    const c = emptyChecks();
    addSeriesChecks(c, bs.map(asSeries), []);
    return c.collisions;
  };
  const union = [...short, ...long].map(asSeries);
  const within = count(short) + count(long);
  const shortAuthors = new Set(short.flatMap((b) => b.authors.map(authorKey)));
  const longAuthors = new Set(long.flatMap((b) => b.authors.map(authorKey)));
  const shared = [...shortAuthors].filter((a) => longAuthors.has(a));
  const share = (bs: PairBook[], f: (b: PairBook) => boolean) =>
    bs.length ? bs.filter(f).length / bs.length : 0;
  const shortKey = seriesKey(pair.short);
  const longKey = seriesKey(pair.long);
  const ids = (bs: PairBook[]) =>
    new Set(bs.map((b) => b.ranobedbSeries?.id).filter((x): x is string => !!x));
  const amz = (bs: PairBook[]) =>
    new Set(
      bs
        .map((b) => (b.amazonSeries ? seriesKey(b.amazonSeries) : ''))
        .filter((x) => x.length >= MIN_KEY),
    );
  const storeKeys = (b: PairBook) =>
    [b.amazonSeries, b.ranobedbSeries?.name]
      .filter((x): x is string => !!x)
      .map((x) => seriesKey(x));
  const storeNamesOther =
    short.some((b) => storeKeys(b).includes(longKey)) ||
    long.some((b) => storeKeys(b).includes(shortKey));
  return {
    collisions: Math.max(0, count([...short, ...long]) - within),
    collisionsWithin: within,
    collisionExamples: collisionExamples(union, new Set(short.map((b) => b.uuid))),
    bothHaveOne:
      short.some((b) => MAIN(b) && b.index === 1) && long.some((b) => MAIN(b) && b.index === 1),
    sharedAuthors: shared,
    longWithShortAuthor: share(long, (b) => b.authors.some((a) => shortAuthors.has(authorKey(a)))),
    longTitlesStartShort: share(long, (b) => seriesKey(b.title).startsWith(shortKey)),
    ranobedb: compare(ids(short), ids(long)),
    amazon: compare(amz(short), amz(long)),
    storeNamesOther,
    spinoff: spinoffWord(pair.added),
  };
}

/**
 * Numbers a main book of each name holds with different titles (a few, for the sample). The
 * check itself is addSeriesChecks'; this only shows where to look.
 */
function collisionExamples(union: SeriesBook[], shortIds: Set<string>): string[] {
  const at = new Map<number, SeriesBook[]>();
  for (const b of union) {
    if (b.kind !== 'full' && b.kind !== 'special edition') continue;
    if (b.index === null) continue;
    at.set(b.index, [...(at.get(b.index) ?? []), b]);
  }
  const out: string[] = [];
  for (const [i, bs] of [...at].sort((a, b) => a[0] - b[0])) {
    const titles = [...new Set(bs.map((b) => b.title))];
    if (titles.length < 2) continue;
    if (!bs.some((b) => shortIds.has(b.uuid)) || bs.every((b) => shortIds.has(b.uuid))) continue;
    out.push(`${i}: ${titles.slice(0, 3).join(' / ')}`);
    if (out.length >= 3) break;
  }
  return out;
}

export type PairAnswer = 'merge' | 'separate' | 'review';

export interface PairRule {
  id: string;
  /** What the rule says about a pair; null = it has nothing to say (the next rule decides). */
  says: (p: NamePair, s: PairSignals) => PairAnswer | null;
}

/**
 * Candidate rules for the measuring (stop 1 measures each on the sample; only rules with 0
 * wrong are used, decided with the user). Ordered: the first rule with an answer decides; a pair
 * no rule decides goes to review.
 */
export const CANDIDATE_RULES: PairRule[] = [
  {
    id: 'collision',
    says: (_p, s) => (s.collisions > 0 ? 'separate' : null),
  },
  {
    id: 'ranobedb-different',
    says: (_p, s) => (s.ranobedb === 'different' ? 'separate' : null),
  },
  {
    id: 'no-shared-author',
    says: (_p, s) => (s.sharedAuthors.length === 0 ? 'separate' : null),
  },
  {
    id: 'spinoff-word',
    says: (_p, s) => (s.spinoff ? 'separate' : null),
  },
  {
    // An omnibus or set of the series' own books belongs to it (the series order's N.9): the
    // sample's 懲役警察 B Side Diary(合本版) is the short stories' 合本版.
    id: 'spinoff-not-omnibus',
    says: (_p, s) => (s.spinoff && !OMNIBUS_WORD.test(s.spinoff) ? 'separate' : null),
  },
  {
    id: 'store-same',
    says: (_p, s) =>
      (s.ranobedb === 'same' || s.amazon === 'same' || s.storeNamesOther) &&
      s.amazon !== 'different'
        ? 'merge'
        : null,
  },
  {
    id: 'series-word',
    says: (p, s) => (p.group === 'series_word' && s.longWithShortAuthor >= 1 ? 'merge' : null),
  },
  {
    id: 'spelled-series-word',
    says: (p, s) =>
      p.group === 'spelled' && p.added === 'シリーズ' && s.longWithShortAuthor >= 1
        ? 'merge'
        : null,
  },
  {
    id: 'subtitle',
    says: (p, s) => (p.group === 'subtitle' && s.longWithShortAuthor >= 1 ? 'merge' : null),
  },
];

/** Words that mark an omnibus or a set of the series' own books, not a spin-off. */
const OMNIBUS_WORD = /合本|セット|全\d+巻/u;

/**
 * The rules proposed from the 80-pair sample (stop 1, 2026-11-23; 0 wrong there): separate
 * where RanobeDB lists the names as different series, where no author is shared, or where the
 * long name adds a spin-off word (not an omnibus or set word); merge where the stores name one
 * series, or the names differ only by シリーズ or a 〜subtitle〜. A clash is not taken as proof
 * of two series (はにとらっ! and ネロ・ウルフ are one series with a misnumbered book): a merge
 * that adds one goes to review, like every pair no rule decides.
 */
export const PROPOSED_RULE_IDS = [
  'ranobedb-different',
  'no-shared-author',
  'spinoff-not-omnibus',
  'store-same',
  'series-word',
  'spelled-series-word',
  'subtitle',
];

/**
 * The answer of a list of rules, and the rule that gave it. A merge that would put two different
 * books on one number goes to review whatever the rule (decided: a merge never makes duplicate
 * volume numbers).
 */
export function answerPair(
  p: NamePair,
  s: PairSignals,
  rules: PairRule[] = CANDIDATE_RULES,
): { answer: PairAnswer; rule: string | null; held?: 'collision' } {
  for (const r of rules) {
    const a = r.says(p, s);
    if (a === 'merge' && s.collisions > 0)
      return { answer: 'review', rule: r.id, held: 'collision' };
    if (a) return { answer: a, rule: r.id };
  }
  return { answer: 'review', rule: null };
}
