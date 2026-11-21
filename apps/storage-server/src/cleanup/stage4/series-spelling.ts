/**
 * One spelling per series across the library (WP20e, the stage-4 On preparation, decided with
 * the user 2026-11-21: "most books' spelling").
 *
 * Calibre keeps every spelling of a series name as its own series. Measured on the live Preview
 * (2026-11-20): 200 series and 1,510 books would have been split across spellings that differ
 * only in width (Re:ゼロ / Re：ゼロ), wave dashes (〜 / ～ / ~), spaces or other punctuation,
 * because the sources and the models spell the same series differently.
 *
 * Names with the same key (seriesKey) are one series. Each such series takes, in order:
 *   1. a spelling whose wave dashes, dash subtitle and brackets pair up, when one does (a
 *      cut-off 「無職転生 ~異世界行ったら本気だす」 or 「喰 -kuu」 never wins over the whole name);
 *   2. not a spelling that is another one cut before its closing punctuation (「F‐エフ」 of
 *      「F‐エフ‐」, 「ぷりぷり」 of 「ぷりぷり!!」: measured in the spot check, 2026-11-21);
 *   3. the spelling most of its books would have after stage 4 On;
 *   4. on a tie, the spelling most of its books have in Calibre now;
 *   5. then the first in code-point order (the same answer on every run).
 * A value the user set is counted and never changed. Short and full names (本好きの下剋上 and
 * the name with its subtitle) are different keys: spin-offs look the same, so they are not
 * merged here.
 */
import { nfkc } from '../title-rules';
import { OPEN_DASH } from './bw-standin';

/** Spaces, dashes, wave dashes, ・, colons, ! and ?, Japanese punctuation, quotes and brackets. */
const IGNORED =
  /[\s\u3000~～〜\-‐―—–・:：!！?？、。,.'"“”「」『』()（）[\]［］【】<>＜＞〈〉《》]/gu;

/** Closing punctuation a cut-off name lost (not a stray ・ or space: 「シャーロック・ホームズ・」). */
const CLOSING = /^[\s・]*[!?~〜\-‐―)\]」』】〉》>]/u;

/** The key two spellings of one series share. */
export function seriesKey(name: string): string {
  return nfkc(name).replace(IGNORED, '').toLowerCase();
}

const PAIRS: [string, string][] = [
  ['(', ')'],
  ['（', '）'],
  ['[', ']'],
  ['［', '］'],
  ['【', '】'],
  ['「', '」'],
  ['『', '』'],
  ['〈', '〉'],
  ['《', '》'],
  ['<', '>'],
  ['＜', '＞'],
];

/** Whether the name's wave dashes pair up, a dash subtitle is closed and each bracket is closed. */
export function balanced(name: string): boolean {
  if ((name.match(/[~～〜]/gu) ?? []).length % 2 === 1) return false;
  if (OPEN_DASH.test(name)) return false;
  for (const [o, c] of PAIRS) {
    let depth = 0;
    for (const ch of name) {
      if (ch === o) depth++;
      else if (ch === c && --depth < 0) return false;
    }
    if (depth !== 0) return false;
  }
  return true;
}

export interface SpellingBook {
  /** The series name the book would have after stage 4 On, before this choice (null = none). */
  after: string | null;
  /** The series name Calibre has for the book now (null = none). */
  now: string | null;
}

/**
 * The chosen spelling of every series that has more than one, by its key. Series with one
 * spelling are left out.
 */
export function chooseSpellings(books: Iterable<SpellingBook>): Map<string, string> {
  const groups = new Map<string, Map<string, { after: number; now: number }>>();
  const count = (name: string | null, which: 'after' | 'now') => {
    if (!name) return;
    const key = seriesKey(name);
    if (!key) return;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = new Map()));
    const c = g.get(name) ?? { after: 0, now: 0 };
    c[which]++;
    g.set(name, c);
  };
  for (const b of books) {
    count(b.after, 'after');
    count(b.now, 'now');
  }
  const out = new Map<string, string>();
  for (const [key, g] of groups) {
    // Only the spellings books would have after On compete; Calibre's own count breaks ties.
    let names = [...g].filter(([, c]) => c.after > 0);
    if (names.length < 2) continue;
    // A spelling that is another one without its closing punctuation is that name cut off
    // (「F‐エフ」 of 「F‐エフ‐」, 「ぷりぷり」 of 「ぷりぷり!!」): the whole name is kept.
    const whole = names.filter(
      ([n]) =>
        !names.some(([m]) => {
          const a = nfkc(n);
          const b = nfkc(m);
          return (
            b.length > a.length && b.startsWith(a) && CLOSING.test(b.slice(a.length)) && balanced(m)
          );
        }),
    );
    if (whole.length) names = whole;
    if (names.length === 1) {
      out.set(key, names[0][0]);
      continue;
    }
    const anyBalanced = names.some(([n]) => balanced(n));
    names.sort(
      ([a, ca], [b, cb]) =>
        (anyBalanced ? Number(balanced(b)) - Number(balanced(a)) : 0) ||
        cb.after - ca.after ||
        cb.now - ca.now ||
        (a < b ? -1 : a > b ? 1 : 0),
    );
    out.set(key, names[0][0]);
  }
  return out;
}

/** The chosen spelling of a name, or the name itself. */
export function spellingOf(
  map: ReadonlyMap<string, string> | null | undefined,
  name: string,
): string {
  return map?.get(seriesKey(name)) ?? name;
}
