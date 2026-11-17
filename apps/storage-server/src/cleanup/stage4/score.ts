/**
 * Scoring stage 4 against the labeled books (gold800.json): the comparison of the measured
 * rules (rules_v3's N and NA, accepted alternative forms, '?' = unscored, a series label of
 * None = "no series"). Pure functions; the gate and the measurement script use them.
 */
import { N, NA } from '../title-rules';

export interface Stage4Gold {
  t: string;
  au: string[] | string;
  il: string[] | string;
  se: string | null;
  ix: number | string | null;
  fmt: string;
  kind?: string;
  amz?: boolean;
  sample?: string;
  alt_t?: unknown;
  alt_au?: unknown;
  alt_il?: unknown;
  alt_se?: unknown;
  alt_ix?: unknown;
  alt_fmt?: unknown;
  [key: string]: unknown;
}

export const SCORED_FIELDS = ['t', 'au', 'il', 'se', 'ix', 'fmt'] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];
/** The page's names for the gate fields. */
export const FIELD_NAMES: Record<ScoredField, string> = {
  t: 'title',
  au: 'authors',
  il: 'illustrators',
  se: 'series',
  ix: 'number',
  fmt: 'format',
};

const list = (x: unknown): unknown[] =>
  Array.isArray(x) ? x : x === null || x === undefined || x === '' ? [] : [x];
const nameSet = (xs: unknown[]) =>
  new Set(xs.filter((x): x is string => typeof x === 'string').map((x) => NA(x)));
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** true / false, or null when the label doesn't score this field. */
export function fieldRight(f: ScoredField, v: unknown, g: Stage4Gold): boolean | null {
  const gv = g[f];
  if (gv === '?' || (Array.isArray(gv) && gv.includes('?'))) return null;
  switch (f) {
    case 't': {
      if (typeof v !== 'string') return false;
      const n = N(v);
      return [gv, ...list(g.alt_t)].some((a) => typeof a === 'string' && N(a) === n);
    }
    case 'au':
    case 'il': {
      if (!Array.isArray(v)) return false;
      const got = nameSet(v);
      const alts = [gv, ...list(g[`alt_${f}`]).filter((a) => Array.isArray(a))];
      return alts.some((a) => sameSet(got, nameSet(list(a))));
    }
    case 'se': {
      const cands = [gv, ...(Array.isArray(g.alt_se) ? g.alt_se : list(g.alt_se))];
      return cands.some((a) =>
        !a ? v === null || v === undefined : typeof v === 'string' && N(v) === N(a as string),
      );
    }
    case 'ix':
      return v === gv || (Array.isArray(g.alt_ix) ? g.alt_ix : list(g.alt_ix)).some((a) => a === v);
    case 'fmt':
      return v === g.fmt || v === g.alt_fmt || (Array.isArray(g.alt_fmt) && g.alt_fmt.includes(v));
  }
}

export interface FieldScore {
  /** Books whose label scores the field. */
  scored: number;
  /** Of those, the rules would apply automatically. */
  auto: number;
  /** Of the automatic ones, right. */
  right: number;
  /** Ids of automatic values that are wrong. */
  wrong: string[];
}

export function emptyScores(): Record<ScoredField, FieldScore> {
  const out = {} as Record<ScoredField, FieldScore>;
  for (const f of SCORED_FIELDS) out[f] = { scored: 0, auto: 0, right: 0, wrong: [] };
  return out;
}

export function addScore(
  scores: Record<ScoredField, FieldScore>,
  id: string,
  values: Record<ScoredField, unknown>,
  auto: Record<ScoredField, boolean>,
  g: Stage4Gold,
): void {
  for (const f of SCORED_FIELDS) {
    const ok = fieldRight(f, values[f], g);
    if (ok === null) continue;
    const s = scores[f];
    s.scored += 1;
    if (!auto[f]) continue;
    s.auto += 1;
    if (ok) s.right += 1;
    else s.wrong.push(id);
  }
}

export const percent = (part: number, whole: number): number | null =>
  whole > 0 ? (100 * part) / whole : null;

/**
 * The measured rules-v3 numbers (correct when applied automatically, %), recomputed 2026-11-17
 * from rules_v3.py on the stored records with gold800.json (labels v3 for the 600, the audited
 * check D). Plan section 6 lists 97.6 for the 600's format (gold600v2 keeps a "novel"
 * alternative for 61450 that gold800 dropped) and 99.4 / 99.3 for D's series and number (the
 * blind D labels).
 */
export const MEASURED_V3: Record<'ABC' | 'D', Record<ScoredField, number>> = {
  ABC: { t: 98.2, au: 99.0, il: 96.8, se: 97.8, ix: 98.6, fmt: 97.4 },
  D: { t: 96.9, au: 98.2, il: 98.0, se: 100.0, ix: 100.0, fmt: 96.9 },
};
