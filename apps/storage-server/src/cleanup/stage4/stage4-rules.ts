/**
 * Stage 4's rules (WP20d): the measured rules v3 (rules-v3.ts, unchanged) plus what the plan
 * decided after them (section 6) and the fixes from fresh check D:
 *
 * - An Amazon match in a manga category is rejected when the file has text (check D, 8671:
 *   the search matched the manga volume of the same title and pulled the format with it).
 * - ライトノベル anywhere in Amazon's categories (menu path or ranking) = light novel (decided
 *   2026-11-12; v3 read the menu path only).
 * - Edition kind (full, sample, bonus, special edition, omnibus) from the titles, as stage 3
 *   decides it; format and kind stay apart.
 * - The number's best guess where v3 sends it to review: a side volume after its predecessor
 *   (10.5) or its printed decimal; a store bonus = its volume + .1; an omnibus right after the
 *   last volume it covers (1-5 -> 5.9), unknown range = no number. v3's auto/review classes are
 *   kept, so the measured numbers stay comparable; WP20e's flagged fields use these guesses.
 */
import { N, nfkc } from '../title-rules';
import { editionKind, type EditionKind } from '../stage3-kinds';
import { nums } from './pick';
import {
  decide,
  titleNumber,
  type Format,
  type RefRecord,
  type V3Auto,
  type V3Trace,
  type V3Values,
} from './rules-v3';

/**
 * 2 (WP20e, the stage-4 On preparation): BookWalker's series keeps a closing wave dash that
 * pairs with an opening one; the AI step then decides every book again from the stored answers
 * and gives each series one spelling.
 * 3 (series-order follow-up, 2026-11-22): the order of each series (series-order.ts) after the
 * spelling; every book is decided again from the stored answers.
 * 4 (the changed-series measurements, 2026-11-22): store list places, arcs counted straight
 * through, the second batch's fixes; decided again from the stored answers.
 * 5 (the live run of 2026-11-22): sub-series the models each numbered from 1 follow the list as
 * 1, 2, 3… (惑星ハシエラ); decided again from the stored answers.
 * 6 (the stop-3 hold, 2026-11-22): a best guess never overwrites a value Calibre has, the
 * description's spacing, author readings for the authors written, BookWalker's manga editions
 * never a text book's record; decided again from the stored answers.
 * 7 (the live Preview of the stop-3 hold, 2026-11-22): a value the cleanup wrote and Calibre still
 * holds is not changed automatically (to review), the same description text is no change, absence
 * removes no value, the Google run's description rule never clears a written one.
 * 8 (the rehearsal of 2026-11-22): a best guess is never written (also into an empty field), a
 * generated author reading is a guess, a written author reading is kept, a company is no author,
 * the series order's store title only where it adds just the number; arcs that number again are
 * counted straight through automatically only where their order is sure (the series list, or the
 * arcs' own numbers), from dates alone a best guess (the user, 2026-11-22).
 * 9 (the live Preview of rules 8, 2026-11-22): author readings without NDL's notes (a profession,
 * "pub. 2013", "1886- 薬剤師"); a written value that only loses them is corrected; a name whose
 * namesakes NDL reads differently is a best guess.
 * 10 (2026-11-23, (仮)花嫁 still out of order after rules 9): a series number the cleanup wrote as
 * a best guess yields to a confirmed one (titles, authors and illustrators keep rules 7: their
 * confirmed values measured worse); after a write, the series step proposes again a book whose
 * review proposal disagrees with its choice, and no title only loses its volume number.
 * 11 (2026-11-25, the held series reviews measured): 「Ep.N」/「level.N」 are volume numbers, 「N+」
 * is no number and 「N+M」 an omnibus; a book whose own title, part mark or list place backs its
 * number is not moved by date or by another list; a side book nothing places keeps its number.
 * Also: RanobeDB's places beside two volumes on theirs, and side books after the count of the
 * list's main volumes, are automatic; parts in another store list are another edition; deciding
 * again deletes only stage 4's own open proposals.
 * 12 (2026-11-25, 本好き's 第五部 II-XII proposed as 2-12): a volume of a later part (「第五部「女神
 * の化身II」」) prints the part's own count, not the series'; its place in the series list is its
 * number where two volumes of the list sit on theirs (automatic). A side book between two volumes
 * on their list places is counted as a volume; one listed after the volume just before it, none
 * missing between, its date agreeing and both neighbours on their numbers, is automatic.
 */
export const STAGE4_RULES_VERSION = 12;

/** The gold labels' names for the kinds. */
export type Kind = 'full' | 'sample' | 'bonus' | 'special edition' | 'omnibus';
const KIND_NAME: Record<EditionKind, Kind> = {
  full: 'full',
  sample: 'sample',
  bonus: 'bonus',
  special: 'special edition',
  omnibus: 'omnibus',
};

/** Amazon's menu path says manga (rules v3's own test), and not ライトノベル. */
export function amazonSaysManga(breadcrumbs: readonly string[] | null | undefined): boolean {
  const bc = (breadcrumbs || []).join(' ');
  if (bc.includes('ライトノベル')) return false;
  return (
    ['マンガ', 'コミック ', ' コミック'].some((x) => bc.includes(x)) || bc.endsWith('コミック')
  );
}

export interface Stage4Options {
  /** Characters of the book's text; at least this many = "the file has text" (v3: 5,000). */
  textChars?: number;
}

export interface Stage4Decision {
  values: V3Values & { kind: Kind };
  auto: V3Auto & { kind: boolean };
  /** The number's best guess where the rules don't apply one (side volume, bonus, omnibus). */
  numberGuess: { value: number | null; rule: string } | null;
  /** Why an Amazon match was set aside. */
  amazonRejected: string | null;
  kindMarker: string | null;
  trace: V3Trace;
}

export function decideStage4(record: RefRecord, options: Stage4Options = {}): Stage4Decision {
  const textChars = options.textChars ?? 5000;
  let r = record;
  let amazonRejected: string | null = null;
  const product = r.amazon?.product;
  if (product && (r.file.chars || 0) >= textChars && amazonSaysManga(product.breadcrumbs)) {
    amazonRejected = 'Amazon lists it as manga, but the file has text';
    r = { ...r, amazon: { ...r.amazon, product: null } };
  }
  const { P, AU, trace } = decide(r);
  const values = { ...P } as V3Values & { kind: Kind };
  const auto = { ...AU } as V3Auto & { kind: boolean };

  // ライトノベル anywhere in Amazon's categories (menu path or ranking).
  const ap = r.amazon?.product;
  if (
    trace.amazonIdentified &&
    ap &&
    values.fmt !== 'light novel' &&
    values.fmt !== 'image-only' &&
    values.fmt !== 'manga' &&
    (ap.rank_categories || []).some((c) => c.includes('ライトノベル'))
  ) {
    values.fmt = 'light novel' as Format;
  }

  const titles = [r.file.opf_title, r.calibre.cal_title];
  const k = editionKind(titles);
  values.kind = KIND_NAME[k.kind];
  auto.kind = true;

  const numberGuess = guessNumber(values, trace, r, k.kind);
  return { values, auto, numberGuess, amazonRejected, kindMarker: k.marker, trace };
}

/** Half-width digits (with a decimal) out of a title part. */
function numbersIn(s: string): number[] {
  return [...nfkc(s).matchAll(/\d+(?:\.\d+)?/g)]
    .map((m) => parseFloat(m[0]))
    .filter((n) => n < 500);
}

function guessNumber(
  values: V3Values,
  trace: V3Trace,
  r: RefRecord,
  kind: EditionKind,
): Stage4Decision['numberGuess'] {
  const se = values.se;
  if (!se) return null;
  const title = nfkc(r.file.opf_title || r.calibre.cal_title);
  if (kind === 'bonus') {
    // 『<series> 3 ～…』BOOK☆WALKER限定書き下ろし…: the volume it belongs to + .1.
    const quoted = /『([^』]+)』/u.exec(title)?.[1] ?? title;
    const n = titleNumber(quoted, se) ?? numbersIn(quoted).at(-1) ?? null;
    return { value: n === null ? null : Math.floor(n) + 0.1, rule: 'store bonus: its volume + .1' };
  }
  if (kind === 'omnibus') {
    const m = /(\d+)\s*[~〜～\-–・]\s*(\d+)/u.exec(nfkc(values.t));
    return m
      ? { value: parseInt(m[2], 10) + 0.9, rule: 'omnibus: right after the last volume it covers' }
      : { value: null, rule: 'omnibus with unknown volumes: no number' };
  }
  if (!trace.side) return null;
  const printed = titleNumber(values.t, se);
  if (printed !== null && !Number.isInteger(printed))
    return { value: printed, rule: 'side volume: printed number' };
  if (!trace.ranobedb?.sub) {
    // v3's "side": the title carries a number the rules couldn't confirm as the series number.
    const last = numbersIn(values.t).at(-1);
    if (last !== undefined)
      return { value: last, rule: 'number not confirmed: the number printed in the title' };
    const part = /[(（〈]?(上|中|下|前編|中編|後編)[)）〉]?\s*$/u.exec(nfkc(values.t));
    if (part) {
      const n = { 上: 1, 前編: 1, 中: 2, 中編: 2, 下: 2, 後編: 2 }[part[1]]!;
      return { value: n, rule: 'number not confirmed: (上)/(下) in the title' };
    }
    const other = [...nums(values.t)];
    return other.length === 1
      ? { value: other[0], rule: 'number not confirmed: a roman or kanji number in the title' }
      : { value: null, rule: 'number not confirmed: none printed' };
  }
  // A side volume (RanobeDB "sub"): after its predecessor.
  const books = (r.ranobedb?.series?.books || []).filter((b) => typeof b.sort_order === 'number');
  const me = r.ranobedb?.book?.id;
  const sorted = [...books].sort((a, b) => (a.sort_order as number) - (b.sort_order as number));
  const at = sorted.findIndex((b) => b.id === me);
  for (let i = at - 1; i >= 0; i--) {
    const prev = sorted[i] as { type?: string | null; title_orig?: string | null };
    if (prev.type === 'sub') continue;
    const n =
      titleNumber(prev.title_orig, se) ??
      titleNumber(prev.title_orig, r.ranobedb?.series?.title_orig);
    if (n !== null)
      return { value: Math.floor(n) + 0.5, rule: 'side volume: after its predecessor' };
  }
  return { value: null, rule: 'side volume: predecessor not known' };
}

/** The series name as the gold labels compare it (for reports). */
export const sameSeries = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : N(a) === N(b);
