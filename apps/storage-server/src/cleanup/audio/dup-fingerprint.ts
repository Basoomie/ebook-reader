/**
 * Audio fingerprints for stage 3 (WP21b): which windows of two copies are compared, and how
 * two Chromaprint fingerprints are compared. Pure: no files, no processes (probe.ts makes the
 * fingerprints).
 *
 * Measured on the reference sample (2026-11-17, design "Reference sample"): windows at the same
 * fraction of the length can't line up copies whose lengths differ by minutes (風花帖, 342 s
 * apart), so the windows are anchored at the start and at the end of each copy, and the middle
 * window searches the region between "the same time from the start" and "the same time from
 * the end".
 *
 * Chromaprint's raw fingerprint: one 32-bit item per 4096/3 samples at 11,025 Hz (about 8.07
 * items per second). The score of two windows is the share of equal bits at the best offset
 * (as the sample's fpsim.py): about 0.5 for unrelated audio, 1 for the same file.
 */

/** Chromaprint's sample rate and item step (samples). */
export const FP_RATE = 11025;
export const FP_ITEM_SAMPLES = 4096 / 3;
/** Items per second of audio. */
export const ITEMS_PER_SECOND = FP_RATE / FP_ITEM_SAMPLES;

export function secondsToItems(s: number): number {
  return Math.round(s * ITEMS_PER_SECOND);
}

export function itemsToSeconds(n: number): number {
  return n / ITEMS_PER_SECOND;
}

function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

export interface Alignment {
  /** Share of equal bits at the best offset (0..1); null when no offset had enough overlap. */
  score: number | null;
  /** Position of a[0] in b (items) at the best offset: b[i + offset] is compared with a[i]. */
  offset: number;
  /** Items compared at that offset. */
  overlap: number;
}

/**
 * Best bit agreement of `a` against `b` over offsets `minOffset..maxOffset` (a[i] against
 * b[i + offset]), counting only offsets where at least `minOverlap` items overlap.
 */
export function bestAlignment(
  a: Uint32Array,
  b: Uint32Array,
  minOffset: number,
  maxOffset: number,
  minOverlap: number,
): Alignment {
  let best: Alignment = { score: null, offset: 0, overlap: 0 };
  for (let off = minOffset; off <= maxOffset; off++) {
    const i0 = Math.max(0, -off);
    const i1 = Math.min(a.length, b.length - off);
    const n = i1 - i0;
    if (n < minOverlap || n <= 0) continue;
    let diff = 0;
    for (let i = i0; i < i1; i++) diff += popcount32((a[i] ^ b[i + off]) >>> 0);
    const score = 1 - diff / (32 * n);
    if (best.score === null || score > best.score) best = { score, offset: off, overlap: n };
  }
  return best;
}

/** A stretch of one copy's timeline: seconds from the copy's start. */
export interface Span {
  start: number;
  length: number;
}

export type WindowName = 'start' | 'middle' | 'end';

export interface WindowPlan {
  name: WindowName;
  a: Span;
  b: Span;
  /** Offsets (items) of a's window inside b's span to try. */
  minOffset: number;
  maxOffset: number;
  minOverlap: number;
}

export interface WindowSettings {
  /** Window length compared (seconds). */
  windowSeconds: number;
  /** How far the copies may be shifted against each other at the start and at the end. */
  shiftSeconds: number;
  /** The middle window searches at most this many minutes of the other copy. */
  middleSearchMinutes: number;
}

/**
 * The three windows to compare for two copies of lengths `durA` and `durB` (seconds). Returns
 * the plans and, for a middle window that can't be searched (lengths too far apart), why.
 */
export function planWindows(
  durA: number,
  durB: number,
  s: WindowSettings,
): { plans: WindowPlan[]; skipped: { name: WindowName; reason: string }[] } {
  const W = s.windowSeconds;
  const S = s.shiftSeconds;
  const plans: WindowPlan[] = [];
  const skipped: { name: WindowName; reason: string }[] = [];
  const minLen = Math.min(durA, durB);
  if (!(minLen > 5)) {
    return {
      plans,
      skipped: (['start', 'middle', 'end'] as const).map((name) => ({
        name,
        reason: 'too short to compare',
      })),
    };
  }
  const edge = Math.min(W + S, minLen);
  const edgeOverlap = secondsToItems(Math.min(W, edge * 0.6));
  const shift = secondsToItems(Math.min(S, Math.max(0, edge - Math.min(W, edge * 0.6))));
  plans.push({
    name: 'start',
    a: { start: 0, length: edge },
    b: { start: 0, length: edge },
    minOffset: -shift,
    maxOffset: shift,
    minOverlap: edgeOverlap,
  });
  plans.push({
    name: 'end',
    a: { start: durA - edge, length: edge },
    b: { start: durB - edge, length: edge },
    minOffset: -shift,
    maxOffset: shift,
    minOverlap: edgeOverlap,
  });
  // The middle: a's window at its half; in b, every position between "the same time from
  // the start" and "the same time from the end", plus the shift on both sides.
  const wm = Math.min(W, minLen / 3);
  const mA = Math.max(0, durA / 2 - wm / 2);
  const delta = durB - durA;
  if (Math.abs(delta) > s.middleSearchMinutes * 60) {
    skipped.push({
      name: 'middle',
      reason: `the lengths differ by ${Math.round(Math.abs(delta))} s (more than the ${s.middleSearchMinutes} min searched)`,
    });
  } else {
    const lo = Math.max(0, Math.min(mA, mA + delta) - S);
    const hi = Math.min(durB, Math.max(mA, mA + delta) + wm + S);
    if (hi - lo >= wm) {
      const aItems = secondsToItems(wm);
      const bItems = secondsToItems(hi - lo);
      plans.push({
        name: 'middle',
        a: { start: mA, length: wm },
        b: { start: lo, length: hi - lo },
        minOffset: 0,
        maxOffset: Math.max(0, bItems - aItems),
        minOverlap: Math.max(1, Math.round(aItems * 0.95)),
      });
    } else skipped.push({ name: 'middle', reason: 'too short to compare' });
  }
  return { plans, skipped };
}

export interface WindowScore {
  name: WindowName;
  score: number | null;
  /** b's position minus a's position at the best offset (seconds): how much later b runs. */
  shiftSeconds: number | null;
  reason?: string;
}

/** Scores one planned window from the two fingerprints. */
export function scoreWindow(plan: WindowPlan, a: Uint32Array, b: Uint32Array): WindowScore {
  // Chromaprint gives about 20 items fewer than the window's length (its filters need a run-in;
  // 342 instead of 363 for 45 s in the sample's fp.jsonl), so the overlap asked for is capped at
  // 90 % of what a's fingerprint really holds.
  const minOverlap = Math.min(plan.minOverlap, Math.max(1, Math.floor(a.length * 0.9)));
  const al = bestAlignment(a, b, plan.minOffset, plan.maxOffset, minOverlap);
  if (al.score === null) return { name: plan.name, score: null, shiftSeconds: null };
  const shift = plan.b.start + itemsToSeconds(al.offset) - plan.a.start;
  return {
    name: plan.name,
    score: Math.round(al.score * 1000) / 1000,
    shiftSeconds: Math.round(shift * 100) / 100,
  };
}

export type FingerprintVerdict = 'same' | 'different' | 'partly' | 'unknown';

/**
 * Same recording: every window at or above `sameScore`. Different: every window below it.
 * Anything else (a window missing, some windows the same and some not: e.g. an edition with
 * a new prologue, or a cut copy) is "partly" or "unknown" and goes to review.
 */
export function fingerprintVerdict(scores: WindowScore[], sameScore: number): FingerprintVerdict {
  const known = scores.filter((s) => s.score !== null);
  if (known.length === 0) return 'unknown';
  const same = known.filter((s) => (s.score as number) >= sameScore).length;
  if (same === 0) return 'different';
  if (known.length < 3) return 'unknown';
  return same === known.length ? 'same' : 'partly';
}

/** Raw fingerprint bytes (little-endian uint32) <-> array. */
export function fpToBuffer(fp: Uint32Array): Buffer {
  const b = Buffer.alloc(fp.length * 4);
  for (let i = 0; i < fp.length; i++) b.writeUInt32LE(fp[i] >>> 0, i * 4);
  return b;
}

export function fpFromBuffer(b: Buffer): Uint32Array {
  const out = new Uint32Array(Math.floor(b.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = b.readUInt32LE(i * 4);
  return out;
}

/** fpcalc -raw prints "FINGERPRINT=1,2,3"; values may be signed in some versions. */
export function parseFpcalc(stdout: string): Uint32Array | null {
  const m = /FINGERPRINT=([-0-9,]*)/.exec(stdout);
  if (!m || !m[1]) return null;
  const parts = m[1].split(',').filter((x) => x !== '');
  const out = new Uint32Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]) >>> 0;
  return out;
}
