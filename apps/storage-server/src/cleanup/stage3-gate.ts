/**
 * Stage 3 (WP20c): the gate (plan P8). Nothing is removed until it passes.
 *
 * 1. The measured duplicate pairs (dup_test, 2026-11-12; stage3-pairs.json beside
 *    gold800.json), their Calibre ids mapped through stage 1's undo records where stage 1
 *    removed one copy as identical: each pair, measured with stage 3's own code, gets the
 *    class the measured containment and the kind rules give (before the spread check), and
 *    every expected duplicate or superset is also found by the index (recall).
 * 2. The two spread anchors: the inspected commentary edition has more interleaved extra text
 *    than every inspected edition that has none.
 * 3. The labeled books: every one labeled sample, bonus or omnibus is recognized as such, and
 *    so is every image-only one (these guard removals).
 * 4. Text length: stage 3's length equals the reader's own count for the labeled books whose
 *    file the reader counted.
 */
import fs from 'fs';
import type { PairClass } from './stage3-rules';

export interface GatePairSpec {
  key: string;
  /** The dup_test group (bonus_item, bonus_attached, special, omnibus, sample). */
  group: string;
  a: number;
  b: number;
  aTitle?: string;
  bTitle?: string;
  measured: { aInB: number; bInA: number };
  /** The class before the spread check. */
  expected: Exclude<PairClass, 'keep_both'>;
  /** Inspected by hand: extra text spread through the chapters, or not. */
  anchor?: 'spread' | 'not_spread';
}

export function loadGatePairs(file: string): {
  pairs: GatePairSpec[] | null;
  error: string | null;
} {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { pairs?: unknown };
    if (!Array.isArray(raw.pairs)) return { pairs: null, error: `${file} has no "pairs" list` };
    return { pairs: raw.pairs as GatePairSpec[], error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      pairs: null,
      error:
        code === 'ENOENT' ? `Not found: ${file}` : `Can't read ${file}: ${(err as Error).message}`,
    };
  }
}

export interface GatePairResult {
  key: string;
  group: string;
  a: number;
  b: number;
  expected: string;
  got: string | null;
  measured: { aInB: number; bInA: number };
  ours: { aInB: number; bInA: number } | null;
  foundByIndex: boolean;
  note: string | null;
}

export interface Stage3Gate {
  checkedAt: number;
  passed: boolean;
  problems: string[];
  pairs: {
    file: string;
    total: number;
    /** Pairs whose two copies became one (stage 1 or stage 3 removed one): nothing to check. */
    sameAfterStage1: number;
    /** Pairs with a copy no longer in the library (listed, not checked). */
    notInLibrary: number;
    checked: number;
    asMeasured: number;
    results: GatePairResult[];
  } | null;
  spread: { ok: boolean | null; detail: string } | null;
  kinds: {
    guards: number;
    recognized: number;
    missed: { id: number; label: string; got: string }[];
    imageOnly: number;
    imageOnlyRecognized: number;
    imageOnlyMissed: number[];
  } | null;
  textLength: {
    compared: number;
    equal: number;
    differing: { id: number; ours: number; reader: number }[];
  } | null;
}
