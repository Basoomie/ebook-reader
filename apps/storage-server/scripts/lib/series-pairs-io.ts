/** Reading and trimming series-pairs-extract.ts's rows for the sample and measure scripts. */
import fs from 'fs';
import { PAIR_GROUPS, answerPair } from '../../src/cleanup/series-pairs/pairs';
import type {
  NamePair,
  PairGroup,
  PairAnswer,
  PairRule,
  PairBook,
  PairSignals,
} from '../../src/cleanup/series-pairs/pairs';

export interface PairRow extends NamePair {
  common: { name: string; cut: boolean };
  decided: string | null;
  signals: PairSignals;
  answer: PairAnswer;
  rule: string | null;
  held?: 'collision' | null;
  shortSide: PairBook[];
  longSide: PairBook[];
}

export type Truth = 'same' | 'different';

export interface SampleRow extends PairRow {
  truth: Truth | null;
  evidence: string | null;
}

export function readPairs(file: string): PairRow[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PairRow);
}

/** Books shown per side in the sample (the most first, lowest numbers first). */
export const SAMPLE_BOOKS = 8;

export function sampleRows(rows: PairRow[]): SampleRow[] {
  const trim = (bs: PairBook[]) =>
    [...bs]
      .sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9) || a.calibreId - b.calibreId)
      .slice(0, SAMPLE_BOOKS);
  return rows.map((r) => ({
    ...r,
    shortSide: trim(r.shortSide),
    longSide: trim(r.longSide),
    truth: null,
    evidence: null,
  }));
}

/**
 * Each group's share of the sample: `least` of each group first (all of a smaller one), then the
 * rest of `n` in proportion to what each group has left (largest remainders), so the sample is
 * `n` pairs when the list has that many.
 */
export function shares(
  totals: Record<PairGroup, number>,
  n: number,
  least: number,
): Record<PairGroup, number> {
  const out = {} as Record<PairGroup, number>;
  for (const g of PAIR_GROUPS) out[g] = Math.min(totals[g], least);
  const left = PAIR_GROUPS.reduce((s, g) => s + totals[g] - out[g], 0);
  let rest = Math.min(left, Math.max(0, n - PAIR_GROUPS.reduce((s, g) => s + out[g], 0)));
  if (rest === 0) return out;
  const exact = PAIR_GROUPS.map((g) => ({ g, x: ((totals[g] - out[g]) / left) * rest }));
  for (const e of exact) out[e.g] += Math.floor(e.x);
  rest -= exact.reduce((s, e) => s + Math.floor(e.x), 0);
  for (const e of [...exact].sort((a, b) => b.x - Math.floor(b.x) - (a.x - Math.floor(a.x)))) {
    if (rest <= 0) break;
    if (out[e.g] < totals[e.g]) {
      out[e.g]++;
      rest--;
    }
  }
  return out;
}

export interface RuleCount {
  rule: string;
  merge: number;
  mergeWrong: number;
  separate: number;
  separateWrong: number;
}

/** Each rule alone and the list in order on the checked pairs of a sample. */
export function measureRules(
  sample: SampleRow[],
  rules: PairRule[],
): {
  checked: number;
  same: number;
  different: number;
  alone: RuleCount[];
  list: RuleCount & { review: number; wrong: string[] };
} {
  const checked = sample.filter((s) => s.truth !== null);
  const wrongOf = (a: 'merge' | 'separate', t: Truth) =>
    (a === 'merge' && t === 'different') || (a === 'separate' && t === 'same');
  const alone = rules.map((r) => {
    const c: RuleCount = { rule: r.id, merge: 0, mergeWrong: 0, separate: 0, separateWrong: 0 };
    for (const s of checked) {
      const a = r.says(s, s.signals);
      if (a === 'merge' || a === 'separate') {
        c[a]++;
        if (wrongOf(a, s.truth!)) c[a === 'merge' ? 'mergeWrong' : 'separateWrong']++;
      }
    }
    return c;
  });
  const list = {
    rule: 'list',
    merge: 0,
    mergeWrong: 0,
    separate: 0,
    separateWrong: 0,
    review: 0,
    wrong: [] as string[],
  };
  for (const s of checked) {
    const { answer, rule } = answerPair(s, s.signals, rules);
    if (answer === 'review') {
      list.review++;
      continue;
    }
    list[answer]++;
    if (wrongOf(answer, s.truth!)) {
      list[answer === 'merge' ? 'mergeWrong' : 'separateWrong']++;
      list.wrong.push(`${s.short} / ${s.long}: ${answer} by ${rule}, checked ${s.truth}`);
    }
  }
  return {
    checked: checked.length,
    same: checked.filter((s) => s.truth === 'same').length,
    different: checked.filter((s) => s.truth === 'different').length,
    alone,
    list,
  };
}
