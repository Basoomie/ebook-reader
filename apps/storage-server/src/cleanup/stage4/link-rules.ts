/**
 * More direct links (design `link-discovery.md`; plan approved by the user 2026-11-24): the two
 * rules that save a store id for a book from answers stage 4 already has. Pure.
 *
 * Stage 4 saves an Amazon, RanobeDB or BOOK☆WALKER id only when its rules, before the AI check,
 * were sure of the title, the author, the format and the series number (proposals.ts). A book
 * whose title or number the AI check settled never got its ids, although the right record was
 * found. Measured 2026-11-24 on the labeled books (scripts/link-discovery-measure.ts): rule A
 * 151 new ids, rule B 105, none wrong.
 *
 * - Rule A, the record already found (`recordPick`): the record stage 4 picked, when its title,
 *   an author and the volume agree with stage 4's decided values AND with what Calibre holds now
 *   (the checks the user chose for Bookmeter, CHOSEN_RULES).
 * - Rule B, series neighbours (`seriesEntries`, `seriesPick`): an entry of a stored list
 *   (RanobeDB's series list, BOOK☆WALKER's series list, Amazon's result list) that holds the
 *   saved id of another book of the same Calibre series by the same author, when exactly one
 *   entry has the book's title and volume.
 *
 * The guards the first measuring pass showed were needed: Kindle ids only for Amazon (a print
 * page's id is its ISBN-10), a BOOK☆WALKER page filed under manga only for a book decided as
 * manga or image-only, an edition word anywhere in the store title the book's own texts lack,
 * and a series list only when it holds at least half of the series' saved ids.
 */
import { N, NA, nfkc } from '../title-rules';
import {
  CHOSEN_RULES,
  failedWith,
  makeRules,
  type BookRow,
  type CandidateRules,
  type Check,
  type Hit,
} from './bookmeter-rules';
import { amazonSaysManga } from './stage4-rules';
import { editionNotes } from './store-links';

export type LinkSite = 'amazon' | 'ranobedb' | 'bookwalker';
export const LINK_SITES: readonly LinkSite[] = ['amazon', 'ranobedb', 'bookwalker'];
/** The Calibre identifier key of each site (stage 4's own keys). */
export const LINK_KEY: Record<LinkSite, string> = {
  amazon: 'amazon_jp',
  ranobedb: 'ranobedb',
  bookwalker: 'bookwalker',
};
export type LinkHow = 'record' | 'series';

/** The book's page at a site, for the spot check and the lists. */
export function linkUrl(site: LinkSite, id: string): string {
  if (site === 'amazon') return `https://www.amazon.co.jp/dp/${id}`;
  if (site === 'ranobedb') return `https://ranobedb.org/book/${id}`;
  return `https://bookwalker.jp/de${id}/`;
}

/** One book as the rules read it (Stage4Analysis.linkFacts). */
export interface LinkFacts {
  uuid: string;
  calibreId: number;
  /** Stage 4's decided values (the rules', before the AI check). */
  decided: {
    t: string;
    au: string[];
    se: string | null;
    ix: number | null;
    fmt: string | null;
  };
  /** Calibre's values as the reader's snapshot has them now. */
  calibre: {
    title: string;
    authors: string[];
    series: string | null;
    index: number | null;
    ids: Record<string, string>;
  };
  opfTitle: string | null;
  /** The book's own texts (its titles, the identified Amazon title, first and last pages). */
  own: string[];
  amazonRejected: string | null;
  amazon: {
    id: string;
    title: string;
    authors: string[];
    roles: string[];
    breadcrumbs: string[];
  } | null;
  /** Amazon's search results: [ASIN, title]. */
  amazonList: [string, string][];
  ranobedb: { id: string; title: string; authors: string[] } | null;
  /** RanobeDB's series list: [id, title]. */
  ranobedbList: [string, string][];
  /** BOOK☆WALKER's page data has no author list; its keywords name the authors. */
  bookwalker: { id: string; title: string; keywords: string } | null;
  /** BOOK☆WALKER's series list: [id, title]. */
  bookwalkerList: [string, string][];
}

/**
 * An edition word anywhere in a store title (＜特別版＞, [改版], 新装版: not only in 【…】) that none
 * of the book's own texts has = another edition (found on the labeled books: 29243, 60667).
 */
const EDITION_WORD =
  /特別版|新装版|特装版|完全版|増補|改訂|改版|大活字|合本|総集編|愛蔵版|復刻|決定版|無料|試し読み|お試し|分冊|単話/gu;
const BW_MANGA = /マンガ|コミック|COMIC/iu;
const ILLUSTRATOR = /イラスト|絵|画|illust/iu;
/** A Kindle page's id; a print page's is its ISBN-10. */
export const KINDLE_ID = /^B0[0-9A-Z]{8}$/;

/** The store title names no edition the book's own texts lack. */
export function sameEdition(own: readonly string[], title: string): boolean {
  if (editionNotes(title).some((x) => !own.some((t) => t.includes(x)))) return false;
  return ![...nfkc(title).matchAll(EDITION_WORD)].some((m) => !own.some((t) => t.includes(m[0])));
}

function bookRow(f: LinkFacts, which: 'decided' | 'calibre'): BookRow {
  const base = {
    uuid: f.uuid,
    cid: f.calibreId,
    gid: null,
    kind: null,
    fmt: f.decided.fmt,
    opfTitle: f.opfTitle,
    hits: [],
    searched: true,
    stored: null,
    base: null,
    stores: null,
    searchFile: null,
  };
  return which === 'decided'
    ? {
        ...base,
        t: f.decided.t,
        au: f.decided.au,
        se: f.decided.se,
        ix: f.decided.ix,
        // The volume guard: no match when the decided title lost the number Calibre's has.
        calTitle: f.calibre.title,
      }
    : {
        ...base,
        t: f.calibre.title,
        au: f.calibre.authors,
        se: f.calibre.series,
        ix: f.calibre.index,
        calTitle: f.calibre.title,
      };
}

/** The record stage 4 picked at a site, as a search result. */
export function recordHit(f: LinkFacts, site: LinkSite): Hit | null {
  if (site === 'amazon' && f.amazon) {
    const authors = f.amazon.authors.filter((_, i) => !ILLUSTRATOR.test(f.amazon!.roles[i] ?? ''));
    return {
      id: f.amazon.id,
      title: f.amazon.title,
      authors: authors.length ? authors : f.amazon.authors,
      pages: null,
      edOk: sameEdition(f.own, f.amazon.title),
    };
  }
  if (site === 'ranobedb' && f.ranobedb)
    return {
      id: f.ranobedb.id,
      title: f.ranobedb.title,
      authors: f.ranobedb.authors,
      pages: null,
      edOk: sameEdition(f.own, f.ranobedb.title),
    };
  if (site === 'bookwalker' && f.bookwalker)
    return {
      id: f.bookwalker.id,
      title: f.bookwalker.title,
      authors: f.bookwalker.keywords.split(/[,、]/u).map((s) => s.trim()),
      pages: null,
      edOk: sameEdition(f.own, f.bookwalker.title),
    };
  return null;
}

const textBook = (f: LinkFacts) => f.decided.fmt !== 'manga' && f.decided.fmt !== 'image-only';

/** The checks the picked record fails against the book's decided or Calibre values. */
export function recordFails(
  rules: CandidateRules,
  f: LinkFacts,
  site: LinkSite,
  which: 'decided' | 'calibre',
): Check[] | null {
  const h = recordHit(f, site);
  if (!h) return null;
  const b = bookRow(f, which);
  if (!(N(b.t) ?? '')) return ['title'];
  const fails = failedWith(rules, b, h);
  if (fails.includes('edition')) return fails;
  const other =
    site === 'amazon'
      ? !KINDLE_ID.test(h.id) ||
        (textBook(f) && (!!f.amazonRejected || amazonSaysManga(f.amazon!.breadcrumbs)))
      : site === 'bookwalker'
        ? textBook(f) && BW_MANGA.test(f.bookwalker!.keywords)
        : false;
  if (other) fails.push('edition');
  return fails;
}

export interface LinkPick {
  id: string;
  /** The store's title of the page (the evidence shown with the link). */
  title: string;
}

/**
 * Rule A: the id of the record stage 4 picked, when it passes every check against the decided
 * values and against Calibre's. Null when there is no record or a check fails. A fresh rule set
 * per call (makeRules' caches are per call: a long-running server keeps no memory between books).
 */
export function recordPick(f: LinkFacts, site: LinkSite): LinkPick | null {
  const h = recordHit(f, site);
  if (!h) return null;
  const rules = makeRules(CHOSEN_RULES);
  if (recordFails(rules, f, site, 'calibre')!.length) return null;
  if (recordFails(rules, f, site, 'decided')!.length) return null;
  return { id: h.id, title: h.title };
}

const listOf = (f: LinkFacts, site: LinkSite): [string, string][] =>
  site === 'amazon'
    ? f.amazonList.filter(([id]) => KINDLE_ID.test(id))
    : site === 'ranobedb'
      ? f.ranobedbList
      : f.bookwalkerList;

const authorKeys = (f: LinkFacts) => new Set(f.calibre.authors.map((x) => NA(x)));

export interface SeriesEntry {
  title: string;
  /** The authors of the book whose saved id proves the list is this series'. */
  anchorAuthors: Set<string>;
}

/**
 * Rule B, the lists that count for one Calibre series at one site: every entry of a member's
 * stored list that holds a saved id of a member (the anchor). RanobeDB's and BOOK☆WALKER's lists
 * count only when they hold at least half of the series' saved ids (a list of the manga, or of
 * another edition, holds few of them).
 */
export function seriesEntries(
  group: readonly LinkFacts[],
  site: LinkSite,
): Map<string, SeriesEntry> {
  const key = LINK_KEY[site];
  const anchors = new Map<string, LinkFacts>();
  for (const f of group) if (f.calibre.ids[key]) anchors.set(f.calibre.ids[key], f);
  const entries = new Map<string, SeriesEntry>();
  if (!anchors.size) return entries;
  for (const f of group) {
    const list = listOf(f, site);
    const hit = list.find(([id]) => anchors.has(id));
    if (!hit) continue;
    const held = new Set(list.map(([id]) => id).filter((id) => anchors.has(id))).size;
    if (site !== 'amazon' && held * 2 < anchors.size) continue;
    const anchorAuthors = authorKeys(anchors.get(hit[0])!);
    for (const [id, title] of list) if (!entries.has(id)) entries.set(id, { title, anchorAuthors });
  }
  return entries;
}

/**
 * Rule B for one book of the series: the one entry with the book's title and volume (by
 * Calibre's values), from a list anchored by a book that shares an author with it. `taken`: an
 * id Calibre already holds (on any book) is never a candidate. Null when no entry or several pass.
 */
export function seriesPick(
  rules: CandidateRules,
  f: LinkFacts,
  entries: ReadonlyMap<string, SeriesEntry>,
  taken: (id: string) => boolean,
): LinkPick | null {
  const b = bookRow(f, 'calibre');
  if (!(N(b.t) ?? '')) return null;
  const mine = authorKeys(f);
  let pick: LinkPick | null = null;
  for (const [id, e] of entries) {
    if (taken(id)) continue;
    if (![...e.anchorAuthors].some((x) => mine.has(x))) continue;
    const h: Hit = {
      id,
      title: e.title,
      authors: [],
      pages: null,
      edOk: sameEdition(f.own, e.title),
    };
    // The list has no authors: the anchor's author stands in for the check.
    if (failedWith(rules, b, h).some((x) => x !== 'author')) continue;
    if (pick) return null;
    pick = { id, title: e.title };
  }
  return pick;
}

/** The rule set for one unit of work (one series group). */
export const linkRules = (): CandidateRules => makeRules(CHOSEN_RULES);

/** A Calibre series' key (books of one series are neighbours). */
export const seriesGroupKey = (series: string | null | undefined): string => N(series) ?? '';

// ---------------------------------------------------------------- the spot check's draw

/** A slot of the spot check: one site by one rule. */
export const spotSlot = (site: LinkSite, how: LinkHow): string => `${site}:${how}`;
export const SPOT_SLOTS: readonly string[] = LINK_SITES.flatMap((s) =>
  (['record', 'series'] as const).map((h) => spotSlot(s, h)),
);
/**
 * BOOK☆WALKER's links count double in the draw: it carries the largest known risk (the same
 * title as two listings: 0.6 % of its picks differ from an id saved before).
 */
const SLOT_WEIGHT = (slot: string) => (slot.startsWith('bookwalker:') ? 2 : 1);

/**
 * How many of the spot check's links each slot gets: in proportion to what it adds (weighted,
 * largest remainder), never more than it has, at least one from every slot that added any. Pure.
 */
export function linkSpotShares(adds: Record<string, number>, size: number): Record<string, number> {
  const slots = SPOT_SLOTS.filter((s) => (adds[s] ?? 0) > 0);
  const out: Record<string, number> = {};
  for (const s of SPOT_SLOTS) out[s] = 0;
  const have = slots.reduce((a, s) => a + adds[s], 0);
  if (!have) return out;
  const n = Math.min(size, have);
  const weight = slots.reduce((a, s) => a + adds[s] * SLOT_WEIGHT(s), 0);
  const exact = slots.map((s) => ({ s, x: (adds[s] * SLOT_WEIGHT(s) * n) / weight }));
  for (const e of exact) out[e.s] = Math.min(adds[e.s], Math.floor(e.x));
  let left = n - slots.reduce((a, s) => a + out[s], 0);
  // The largest remainders first, then whoever still has links (a slot at its cap gives way).
  const order = [...exact].sort((a, b) => b.x - Math.floor(b.x) - (a.x - Math.floor(a.x)));
  while (left > 0) {
    let gave = false;
    for (const e of order) {
      if (left <= 0) break;
      if (adds[e.s] > out[e.s]) {
        out[e.s]++;
        left--;
        gave = true;
      }
    }
    if (!gave) break;
  }
  for (const s of slots) {
    if (out[s] > 0) continue;
    const from = slots.filter((x) => x !== s).sort((a, b) => out[b] - out[a])[0];
    if (from && out[from] > 1) {
      out[from]--;
      out[s]++;
    }
  }
  return out;
}
