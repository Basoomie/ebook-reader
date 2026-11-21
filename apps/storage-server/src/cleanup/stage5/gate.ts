/**
 * Stage 5's gate (WP20f) on the genre test's blind labels (`genre/glabels_*.py`: 80 books,
 * genres and nonfiction subjects; `genre/tlabels_*.py`: 63 fiction books, tags; labeled before
 * any model answer was seen). Each label is (core, ok): core terms must be found, ok terms are
 * also right. Scored exactly as the test was (reproduced from its stored answers):
 *
 *   found share  core labels applied / core labels
 *   right share  applied terms in core ∪ ok / applied terms
 *   fully right  every core term applied and nothing applied outside core ∪ ok
 *
 * The test: Haiku AND Luna, genres 91.3 % / 99.3 % / 70 of 80, tags 77.1 % / 99.0 % / 42 of 63.
 */
import fs from 'fs';

export interface GenreLabels {
  /** Label id (Calibre id before stage 1) → [core, ok]; genres and subjects together. */
  genres: Record<string, [string[], string[]]>;
  tags: Record<string, [string[], string[]]>;
}

/** The genre test's own numbers (Haiku AND Luna), shown beside the gate. */
export const TEST_SCORES = {
  genres: { found: 91.3, right: 99.3, full: 70, books: 80 },
  tags: { found: 77.1, right: 99.0, full: 42, books: 63 },
} as const;

export function loadGenreLabels(file: string): GenreLabels | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GenreLabels>;
    if (!v || typeof v.genres !== 'object' || typeof v.tags !== 'object') return null;
    return { genres: v.genres ?? {}, tags: v.tags ?? {} };
  } catch {
    return null;
  }
}

export interface SetScore {
  books: number;
  core: number;
  found: number;
  applied: number;
  right: number;
  full: number;
  foundPercent: number | null;
  rightPercent: number | null;
  /** Applied terms outside core ∪ ok, and core terms not applied (for the page). */
  wrong: { gid: string; id: string }[];
  missed: { gid: string; id: string }[];
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);

/** Scores one label set; `applied` gives each labeled book's terms (missing = not in the library). */
export function scoreSet(
  labels: Record<string, [string[], string[]]>,
  applied: (gid: string) => ReadonlySet<string> | null,
  keep: (id: string) => boolean,
): SetScore {
  const s: SetScore = {
    books: 0,
    core: 0,
    found: 0,
    applied: 0,
    right: 0,
    full: 0,
    foundPercent: null,
    rightPercent: null,
    wrong: [],
    missed: [],
  };
  for (const [gid, [core, ok]] of Object.entries(labels)) {
    const got = applied(gid);
    if (!got) continue;
    const a = [...got].filter(keep);
    const good = new Set([...core, ...ok]);
    s.books += 1;
    s.core += core.length;
    const found = core.filter((c) => a.includes(c));
    s.found += found.length;
    s.applied += a.length;
    const right = a.filter((x) => good.has(x));
    s.right += right.length;
    if (found.length === core.length && right.length === a.length) s.full += 1;
    for (const x of a) if (!good.has(x)) s.wrong.push({ gid, id: x });
    for (const c of core) if (!a.includes(c)) s.missed.push({ gid, id: c });
  }
  s.foundPercent = pct(s.found, s.core);
  s.rightPercent = pct(s.right, s.applied);
  return s;
}

export interface Stage5Bars {
  genresRight: number;
  tagsRight: number;
  genresFound: number;
  tagsFound: number;
}

/** Which sets fall below their bars (only with labeled books in the library). */
export function belowBars(g: { genres: SetScore; tags: SetScore }, bars: Stage5Bars): string[] {
  const below: string[] = [];
  const check = (name: 'genres' | 'tags', s: SetScore, right: number, found: number) => {
    if (s.books === 0) return;
    if ((s.rightPercent ?? 100) < right)
      below.push(`${name}: ${s.rightPercent} % right (bar ${right} %)`);
    if ((s.foundPercent ?? 0) < found)
      below.push(`${name}: ${s.foundPercent} % found (bar ${found} %)`);
  };
  check('genres', g.genres, bars.genresRight, bars.genresFound);
  check('tags', g.tags, bars.tagsRight, bars.tagsFound);
  return below;
}
