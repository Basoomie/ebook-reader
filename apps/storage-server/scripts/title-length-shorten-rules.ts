/** Prototype of the proposed repeat removal (stop B of the long-title work; read-only tools). */
import { N, nfkc } from '../src/cleanup/title-rules';
import { nums } from '../src/cleanup/stage4/pick';

// The proposed repeat removal (cleaning): a title that says itself twice keeps one part: not a
// series name (…シリーズ), else the part that holds the other, else the one with the number, else
// the first. Never drops a part whose number the kept part lacks.
const coreOf = (x: string) =>
  (N(x.replace(/[【（(［[][^】）)］\]]*[】）)］\]]/gu, '')) ?? '').replace(/[0-9]+/gu, '');
export function removeRepeat(t: string): string {
  const parts = t.split(/[ \u3000]+/u).filter(Boolean);
  // The split whose two parts are most alike (the last of equals), each at least 6 characters,
  // the shorter at least 60 % of the longer, one starting with the other.
  let best: { l: string; r: string; a: string; b: string; diff: number } | null = null;
  for (let k = 1; k < parts.length; k++) {
    const l = parts.slice(0, k).join(' ');
    const r = parts.slice(k).join(' ');
    const a = coreOf(l);
    const b = coreOf(r);
    if (a.length < 6 || b.length < 6) continue;
    if (Math.min(a.length, b.length) < 0.6 * Math.max(a.length, b.length)) continue;
    if (!(a === b || a.startsWith(b) || b.startsWith(a))) continue;
    // 「wonder wonderful」: the shorter must end where a word of the longer ends.
    const [sh, lo] = a.length <= b.length ? [a, b] : [b, a];
    if (/[a-z]/u.test(lo[sh.length] ?? '') && /[a-z]$/u.test(sh)) continue;
    const diff = Math.abs(a.length - b.length);
    if (!best || diff <= best.diff) best = { l, r, a, b, diff };
  }
  if (!best) return t;
  const { l, r, a, b } = best;
  let keep: string;
  if (/シリーズ$/u.test(nfkc(r))) keep = l;
  else if (/シリーズ$/u.test(nfkc(l))) keep = r;
  else if (a.length !== b.length) keep = a.length > b.length ? l : r;
  else keep = nums(r).size && !nums(l).size ? r : l;
  const drop = keep === l ? r : l;
  if ([...nums(drop)].some((x) => !nums(keep).has(x))) return t;
  return keep.replace(/[\s:：]+$/u, '');
}
