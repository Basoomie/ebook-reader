/**
 * Frame-by-frame proof that two copies hold the same recording (WP21b follow-up; user,
 * 2026-11-18: "No guessing, I'd rather have a duplicate than be missing a unique recording").
 * Pure: no files, no processes (probe.ts streams ffmpeg's framemd5 into a FrameList).
 *
 * An audiobook file is a sequence of compressed audio frames (AAC: 1,024 samples, about 43
 * per second). Copies cut from the same download share those frames byte for byte; a copy
 * re-encoded at another bitrate shares none. ffmpeg's framemd5 muxer (stream copy, nothing
 * decoded) prints one MD5 per frame; the first 8 bytes of each are kept.
 *
 * The shorter copy is proven to be inside the longer one when, frame for frame, it equals the
 * longer copy with extra frames only at its start, at its end and in at most one stretch in
 * between. Anything else (one differing frame, a re-encode) is not proof.
 */

/** A copy's frames: 8 bytes of each frame's MD5, and each frame's length in seconds. */
export interface FrameList {
  hashes: BigUint64Array;
  seconds: Float32Array;
}

/** Collects framemd5 output as it streams in (one copy may be several files, in order). */
export class FrameCollector {
  private hashParts: BigUint64Array[] = [];
  private secParts: Float32Array[] = [];
  private hashBuf = new BigUint64Array(65536);
  private secBuf = new Float32Array(65536);
  private n = 0;
  private rest = '';
  private timeBase = 0;
  /** Lines that could not be read (a broken listing is not proof). */
  bad = 0;

  /** Starts the next file (its own time base). */
  nextFile(): void {
    this.rest = '';
    this.timeBase = 0;
  }

  push(chunk: Buffer | string): void {
    const text = this.rest + (typeof chunk === 'string' ? chunk : chunk.toString('latin1'));
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  end(): void {
    if (this.rest) this.line(this.rest);
    this.rest = '';
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      const tb = /^#tb\s+0:\s*(\d+)\/(\d+)/.exec(line);
      if (tb) this.timeBase = Number(tb[1]) / Number(tb[2]);
      return;
    }
    const parts = line.split(',');
    if (parts.length < 6 || parts[0].trim() !== '0') {
      this.bad++;
      return;
    }
    const hex = parts[5].trim();
    const dur = Number(parts[3]);
    if (!/^[0-9a-f]{32}$/.test(hex) || !Number.isFinite(dur)) {
      this.bad++;
      return;
    }
    if (this.n === this.hashBuf.length) {
      this.hashParts.push(this.hashBuf);
      this.secParts.push(this.secBuf);
      this.hashBuf = new BigUint64Array(65536);
      this.secBuf = new Float32Array(65536);
      this.n = 0;
    }
    this.hashBuf[this.n] = BigInt(`0x${hex.slice(0, 16)}`);
    this.secBuf[this.n] = dur * (this.timeBase || 0);
    this.n++;
  }

  result(): FrameList {
    const total = this.hashParts.reduce((a, p) => a + p.length, 0) + this.n;
    const hashes = new BigUint64Array(total);
    const seconds = new Float32Array(total);
    let o = 0;
    for (let i = 0; i < this.hashParts.length; i++) {
      hashes.set(this.hashParts[i], o);
      seconds.set(this.secParts[i], o);
      o += this.hashParts[i].length;
    }
    hashes.set(this.hashBuf.subarray(0, this.n), o);
    seconds.set(this.secBuf.subarray(0, this.n), o);
    return { hashes, seconds };
  }
}

export interface FrameComparison {
  /** Same frames, same count. */
  identical: boolean;
  /** The shorter copy is inside the longer one (extras only at its ends and in one stretch). */
  contained: boolean;
  /** Which copy is longer in frames ('a', 'b' or 'same'). */
  longer: 'a' | 'b' | 'same';
  framesA: number;
  framesB: number;
  /** Extra seconds in the longer copy: before, after, and in one stretch in between. */
  startExtra: number;
  endExtra: number;
  middleExtra: number;
  /** Where the middle stretch is in the longer copy (seconds from its start), or null. */
  middleAt: number | null;
  /** Why the shorter copy is not inside the longer one, or null. */
  detail: string | null;
}

function sum(s: Float32Array, from: number, to: number): number {
  let t = 0;
  for (let i = Math.max(0, from); i < Math.min(s.length, to); i++) t += s[i];
  return Math.round(t * 1000) / 1000;
}

function equalRun(
  x: BigUint64Array,
  xi: number,
  y: BigUint64Array,
  yi: number,
  n: number,
): boolean {
  if (xi + n > x.length || yi + n > y.length || xi < 0 || yi < 0) return false;
  for (let i = 0; i < n; i++) if (x[xi + i] !== y[yi + i]) return false;
  return true;
}

/**
 * Compares two copies' frames. `maxShiftFrames` limits how many extra frames the longer copy
 * may have before (and after) the shorter copy's first (and last) frame.
 */
export function compareFrames(a: FrameList, b: FrameList, maxShiftFrames = 6000): FrameComparison {
  const na = a.hashes.length;
  const nb = b.hashes.length;
  const swap = nb < na;
  const X = swap ? b : a; // shorter
  const Y = swap ? a : b; // longer
  const n = X.hashes.length;
  const m = Y.hashes.length;
  const base: FrameComparison = {
    identical: false,
    contained: false,
    longer: na === nb ? 'same' : swap ? 'a' : 'b',
    framesA: na,
    framesB: nb,
    startExtra: 0,
    endExtra: 0,
    middleExtra: 0,
    middleAt: null,
    detail: null,
  };
  if (n === 0) return { ...base, detail: 'no frames could be read' };
  if (n === m && equalRun(X.hashes, 0, Y.hashes, 0, n)) {
    return { ...base, identical: true, contained: true };
  }
  // Where the shorter copy starts in the longer one: its first frames (an anchor long enough
  // that silence can't match by chance) found in the longer copy's opening.
  const anchor = Math.min(n, 256);
  let k = -1;
  for (let i = 0; i <= Math.min(m - n, maxShiftFrames); i++) {
    if (Y.hashes[i] === X.hashes[0] && equalRun(X.hashes, 0, Y.hashes, i, anchor)) {
      k = i;
      break;
    }
  }
  if (k < 0)
    return { ...base, detail: 'the shorter copy’s opening frames are not in the longer copy' };
  let p = 0;
  while (p < n && k + p < m && X.hashes[p] === Y.hashes[k + p]) p++;
  if (p === n) {
    return {
      ...base,
      contained: true,
      startExtra: sum(Y.seconds, 0, k),
      endExtra: sum(Y.seconds, k + n, m),
    };
  }
  // The rest from the end: the shorter copy's closing frames in the longer copy's closing part.
  let e = -1;
  for (let i = 0; i <= Math.min(m - n - k, maxShiftFrames); i++) {
    const yi = m - i - anchor;
    if (
      Y.hashes[m - 1 - i] === X.hashes[n - 1] &&
      equalRun(X.hashes, n - anchor, Y.hashes, yi, anchor)
    ) {
      e = i;
      break;
    }
  }
  if (e < 0) {
    return {
      ...base,
      detail: `the copies match for ${Math.round(sum(X.seconds, 0, p))} s, then differ, and the shorter copy’s closing frames are not in the longer copy`,
    };
  }
  let q = 0;
  while (q < n && m - e - 1 - q >= 0 && X.hashes[n - 1 - q] === Y.hashes[m - e - 1 - q]) q++;
  if (p + q < n) {
    return {
      ...base,
      detail: `the copies differ between ${Math.round(sum(X.seconds, 0, p))} s and ${Math.round(sum(X.seconds, 0, n - q))} s of the shorter copy`,
    };
  }
  // One stretch of extra frames in the longer copy, between the matched start and end.
  const middleFrames = m - k - e - n;
  if (middleFrames < 0) {
    return {
      ...base,
      detail: 'the matched start and end overlap in a way that is not one inserted stretch',
    };
  }
  return {
    ...base,
    contained: true,
    startExtra: sum(Y.seconds, 0, k),
    endExtra: sum(Y.seconds, m - e, m),
    middleExtra: sum(Y.seconds, k + p, k + p + middleFrames),
    middleAt: sum(Y.seconds, 0, k + p),
  };
}
