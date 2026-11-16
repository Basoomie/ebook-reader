/**
 * Stage 3 (WP20c): text fingerprints of a book's counted text (the reader's own text, from
 * the counter bundle's bookTextForServer).
 *
 * - Every 8-character window (code points) gets a 32-bit hash.
 * - The sketch keeps the windows whose hash is 0 mod SAMPLE_MOD: the same windows are kept
 *   in every book, so shared samples / own samples estimates containment in each direction,
 *   whatever the two lengths (plan P1). It only proposes candidates.
 * - The exact measure uses every window (sorted unique hashes), as dup_test.py did with
 *   sets of strings: containment of A in B = |A ∩ B| / |A|.
 * - Extra text: the characters of the longer copy that no matched window covers, grouped in
 *   runs; a run is "interleaved" when matched text comes both before and after it (plan P4).
 *
 * Pure functions, no I/O.
 */

export const WINDOW = 8;
export const SAMPLE_MOD = 256;

/** The text's code points. */
export function toCodePoints(text: string): Uint32Array {
  const out = new Uint32Array(text.length);
  let n = 0;
  for (const ch of text) out[n++] = ch.codePointAt(0)!;
  return out.subarray(0, n);
}

/** murmur3's finalizer: spreads every input bit over the low bits used for sampling. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** One hash per window start (length - WINDOW + 1 of them; none for shorter texts). */
export function windowHashes(cps: Uint32Array): Uint32Array {
  const n = cps.length - WINDOW + 1;
  if (n <= 0) return new Uint32Array(0);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let h = 0x811c9dc5;
    for (let k = 0; k < WINDOW; k++) h = Math.imul(h ^ cps[i + k], 0x01000193);
    out[i] = fmix32(h);
  }
  return out;
}

/** Sorted, without repeats. */
export function sortedUnique(values: Uint32Array): Uint32Array {
  const sorted = Uint32Array.from(values).sort();
  let n = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[n++] = sorted[i];
  }
  return sorted.slice(0, n);
}

/** The sketch: the window hashes that are 0 mod SAMPLE_MOD, sorted, without repeats. */
export function sketchOf(hashes: Uint32Array, mod = SAMPLE_MOD): Uint32Array {
  const kept: number[] = [];
  for (let i = 0; i < hashes.length; i++) if (hashes[i] % mod === 0) kept.push(hashes[i]);
  return sortedUnique(Uint32Array.from(kept));
}

/** |A ∩ B| of two sorted unique arrays. */
export function intersectCount(a: Uint32Array, b: Uint32Array): number {
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      n++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return n;
}

export interface Containment {
  /** Share of A's windows found in B. */
  aInB: number;
  /** Share of B's windows found in A. */
  bInA: number;
  shared: number;
}

/** Containment both ways from two sorted unique window sets (exact) or two sketches (estimate). */
export function containment(a: Uint32Array, b: Uint32Array): Containment {
  const shared = intersectCount(a, b);
  return {
    aInB: a.length ? shared / a.length : 0,
    bInA: b.length ? shared / b.length : 0,
    shared,
  };
}

function has(sorted: Uint32Array, v: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const x = sorted[mid];
    if (x === v) return true;
    if (x < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

export interface ExtraRun {
  /** Code point offset in the longer copy's text. */
  start: number;
  length: number;
  /** Matched characters before and after the run in the whole book. */
  interleaved: boolean;
}

export interface ExtraText {
  /** Characters of the copy that no matched window covers. */
  extraChars: number;
  /** Runs of at least `minRun` extra characters (shorter ones are typesetting noise). */
  runs: ExtraRun[];
  interleavedRuns: number;
  interleavedChars: number;
  /** Share of the copy's characters in interleaved runs. */
  interleavedShare: number;
  /** Chapters (by start offset) that an interleaved run touches. */
  chaptersTouched: number;
}

export interface ExtraOptions {
  /** Runs shorter than this are ignored (default 100). */
  minRun?: number;
  /** Matched characters needed on both sides of a run for it to count as interleaved (500). */
  minContext?: number;
}

/**
 * The extra text of `hashes` (the window hashes of one copy, in text order, for a text of
 * `length` code points) against `other` (the other copy's sorted unique windows). A
 * character is extra when every window covering it is missing from the other copy.
 */
export function extraText(
  hashes: Uint32Array,
  length: number,
  other: Uint32Array,
  chapterStarts: number[] = [],
  { minRun = 100, minContext = 500 }: ExtraOptions = {},
): ExtraText {
  // covered[j] = 1 when a matched window covers character j.
  const covered = new Uint8Array(length);
  for (let i = 0; i < hashes.length; i++) {
    if (has(other, hashes[i])) covered.fill(1, i, Math.min(length, i + WINDOW));
  }
  // A text too short for any window has nothing matched.
  let extraChars = 0;
  for (let j = 0; j < length; j++) if (!covered[j]) extraChars++;
  const totalMatched = length - extraChars;

  const allRuns: { start: number; length: number }[] = [];
  let j = 0;
  while (j < length) {
    if (covered[j]) {
      j++;
      continue;
    }
    const start = j;
    while (j < length && !covered[j]) j++;
    allRuns.push({ start, length: j - start });
  }

  const runs: ExtraRun[] = [];
  let matchedBefore = 0;
  let cursor = 0;
  for (const r of allRuns) {
    matchedBefore += r.start - cursor;
    cursor = r.start + r.length;
    if (r.length < minRun) continue;
    const matchedAfter = totalMatched - matchedBefore;
    runs.push({
      start: r.start,
      length: r.length,
      interleaved: matchedBefore >= minContext && matchedAfter >= minContext,
    });
  }

  const starts = [...chapterStarts].sort((a, b) => a - b);
  const chapterOf = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (starts[mid] <= pos) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const touched = new Set<number>();
  let interleavedRuns = 0;
  let interleavedChars = 0;
  for (const r of runs) {
    if (!r.interleaved) continue;
    interleavedRuns++;
    interleavedChars += r.length;
    const first = chapterOf(r.start);
    const last = chapterOf(r.start + r.length - 1);
    for (let c = first; c <= last; c++) touched.add(c);
  }
  return {
    extraChars,
    runs,
    interleavedRuns,
    interleavedChars,
    interleavedShare: length ? interleavedChars / length : 0,
    chaptersTouched: touched.size,
  };
}

/** Sketch as bytes for storage (little-endian Uint32). */
export function sketchToBlob(sketch: Uint32Array): Buffer {
  const buf = Buffer.alloc(sketch.length * 4);
  for (let i = 0; i < sketch.length; i++) buf.writeUInt32LE(sketch[i], i * 4);
  return buf;
}

export function sketchFromBlob(blob: Buffer): Uint32Array {
  const out = new Uint32Array(blob.length >>> 2);
  for (let i = 0; i < out.length; i++) out[i] = blob.readUInt32LE(i * 4);
  return out;
}
