/**
 * One person, one spelling (WP21d follow-up (2), user 2026-11-20), pure. Names that differ only
 * by ・ (or a full stop in its place: ジョーン・G.ロビンソン / ジョーン・G・ロビンソン, WP21f-2
 * stop B3), spaces or letter case are the same person (エミリー・ロッダ / エミリーロッダ,
 * TESTOSTERONE / Testosterone): every recording gets the spelling most recordings in the library
 * have, on a tie the one with ・, then the one with spaces, then the first in code order (so the
 * choice never depends on the order of the library). Authors and narrators count together (a
 * person who is both has one spelling). A user's own value is counted but never changed.
 */

/** The identity of a name: no ・ (or ･ · • or a full stop), no spaces, one case, full-width folded. */
export function personKey(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\s\u00a0\u3000・･·•.]/gu, '')
    .toLowerCase();
}

export interface NameUnit {
  key: string;
  authors: string[] | null;
  narrators: string[] | null;
  /** The value is the user's own (never changed). */
  userAuthors?: boolean;
  userNarrators?: boolean;
}

export interface NameGroup {
  /** The spelling everything is changed to. */
  canonical: string;
  /** Every spelling in the library, with the number of recordings that have it. */
  spellings: { name: string; recordings: number }[];
}

const dots = (s: string) => (s.match(/[・･·•]/gu) ?? []).length;
const spaces = (s: string) => (s.match(/[\s\u00a0\u3000]/gu) ?? []).length;

/** Every person with more than one spelling in the library, and the spelling that stands. */
export function nameGroups(units: NameUnit[]): Map<string, NameGroup> {
  const counts = new Map<string, Map<string, number>>();
  for (const u of units) {
    const mine = new Set<string>();
    for (const n of [...(u.authors ?? []), ...(u.narrators ?? [])]) mine.add(n);
    for (const n of mine) {
      const k = personKey(n);
      if (!k) continue;
      const m = counts.get(k) ?? new Map<string, number>();
      m.set(n, (m.get(n) ?? 0) + 1);
      counts.set(k, m);
    }
  }
  const out = new Map<string, NameGroup>();
  for (const [k, m] of counts) {
    if (m.size < 2) continue;
    const spellings = [...m]
      .map(([name, recordings]) => ({ name, recordings }))
      .sort(
        (a, b) =>
          b.recordings - a.recordings ||
          dots(b.name) - dots(a.name) ||
          spaces(b.name) - spaces(a.name) ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
      );
    out.set(k, { canonical: spellings[0].name, spellings });
  }
  return out;
}

/** A list with each name in its group's spelling; a person named twice stays once. */
export function respell(list: string[], groups: Map<string, NameGroup>): string[] | null {
  let changed = false;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of list) {
    const g = groups.get(personKey(n));
    const next = g ? g.canonical : n;
    if (next !== n) changed = true;
    const k = personKey(next);
    if (seen.has(k)) {
      changed = true;
      continue;
    }
    seen.add(k);
    out.push(next);
  }
  return changed ? out : null;
}

/** The new author and narrator lists by recording key (only recordings that change). */
export function respellAll(
  units: NameUnit[],
  groups = nameGroups(units),
): Map<string, { authors?: string[]; narrators?: string[] }> {
  const out = new Map<string, { authors?: string[]; narrators?: string[] }>();
  if (!groups.size) return out;
  for (const u of units) {
    const a = u.authors && !u.userAuthors ? respell(u.authors, groups) : null;
    const n = u.narrators && !u.userNarrators ? respell(u.narrators, groups) : null;
    if (a || n) out.set(u.key, { ...(a ? { authors: a } : {}), ...(n ? { narrators: n } : {}) });
  }
  return out;
}
