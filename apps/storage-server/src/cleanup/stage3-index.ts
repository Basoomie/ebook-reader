/**
 * Stage 3 (WP20c): candidate pairs from the books' sketches (plan P1).
 *
 * An inverted index done as one sort: every (sample, book) posting is packed into one
 * float64 (sample * 2^17 + book index), the array is sorted natively, and each run of equal
 * samples is one bucket. Samples found in more than `commonBooks` books (publisher notices,
 * legal text) are dropped as uninformative. Pairs sharing at least `minShared` samples whose
 * estimated containment reaches `minEstimate` in either direction are candidates; each one
 * is measured exactly afterwards, so this only decides what gets measured.
 *
 * The shared samples are counted one book at a time (for book i, every later book j in each of
 * i's buckets gets one count in a reused typed array), not in one map of every pair that shares
 * a sample: in the whole library (62,225 books, 24 million samples) that map passed the 2^24
 * entries a JavaScript Map can hold. The counts, pairs and stats are the same.
 *
 * Memory: about 20 bytes per posting (the sorted postings, the book of each posting, each
 * book's buckets) plus 4 bytes per book; nothing grows with the number of pairs counted.
 */

export interface SketchedBook {
  calibreId: number;
  sketch: Uint32Array;
}

export interface CandidatePair {
  a: number;
  b: number;
  shared: number;
  /** Estimated share of a's text found in b, and of b's in a. */
  estAInB: number;
  estBInA: number;
}

export interface IndexOptions {
  commonBooks: number;
  minShared?: number;
  minEstimate?: number;
}

export interface IndexStats {
  books: number;
  postings: number;
  commonSamples: number;
  pairsCounted: number;
  candidates: number;
  ms: number;
}

const BOOK_BITS = 2 ** 17;

export function candidatePairs(
  books: SketchedBook[],
  { commonBooks, minShared = 2, minEstimate = 0.05 }: IndexOptions,
): { pairs: CandidatePair[]; stats: IndexStats } {
  const started = Date.now();
  const N = books.length;
  if (N >= BOOK_BITS) throw new Error(`Too many books for the index (${N})`);
  let total = 0;
  for (const b of books) total += b.sketch.length;
  let postings: Float64Array | null = new Float64Array(total);
  let n = 0;
  books.forEach((b, i) => {
    for (let k = 0; k < b.sketch.length; k++) postings![n++] = b.sketch[k] * BOOK_BITS + i;
  });
  postings.sort();

  // The book of each posting, in sorted order; buckets are runs of one sample. Kept buckets
  // (2 to commonBooks books) are [keptStart[r], keptEnd[r]) in bookAt.
  const bookAt = new Int32Array(total);
  const keptStart: number[] = [];
  const keptEnd: number[] = [];
  const perBook = new Int32Array(N + 1);
  let commonSamples = 0;
  let runStart = 0;
  let runSample = -1;
  const closeRun = (end: number) => {
    const size = end - runStart;
    if (size > commonBooks) commonSamples++;
    else if (size > 1) {
      keptStart.push(runStart);
      keptEnd.push(end);
      for (let x = runStart; x < end; x++) perBook[bookAt[x] + 1]++;
    }
  };
  for (let p = 0; p < total; p++) {
    const sample = Math.floor(postings[p] / BOOK_BITS);
    bookAt[p] = postings[p] - sample * BOOK_BITS;
    if (sample !== runSample) {
      if (p > 0) closeRun(p);
      runStart = p;
      runSample = sample;
    }
  }
  if (total > 0) closeRun(total);
  postings = null;
  for (let i = 0; i < N; i++) perBook[i + 1] += perBook[i];
  const bucketsOf = new Int32Array(perBook[N]);
  const fill = perBook.slice(0, N);
  for (let r = 0; r < keptStart.length; r++) {
    for (let x = keptStart[r]; x < keptEnd[r]; x++) bucketsOf[fill[bookAt[x]]++] = r;
  }

  // Shared samples of book i with every later book j, one book i at a time.
  const shared = new Int32Array(N);
  const touched = new Int32Array(N);
  let pairsCounted = 0;
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < N; i++) {
    let t = 0;
    for (let k = perBook[i]; k < perBook[i + 1]; k++) {
      const r = bucketsOf[k];
      for (let x = keptStart[r]; x < keptEnd[r]; x++) {
        const j = bookAt[x];
        if (j <= i) continue;
        if (shared[j] === 0) touched[t++] = j;
        shared[j]++;
      }
    }
    pairsCounted += t;
    const a = books[i];
    for (let u = 0; u < t; u++) {
      const j = touched[u];
      const count = shared[j];
      shared[j] = 0;
      if (count < minShared) continue;
      const b = books[j];
      const estAInB = a.sketch.length ? count / a.sketch.length : 0;
      const estBInA = b.sketch.length ? count / b.sketch.length : 0;
      if (Math.max(estAInB, estBInA) < minEstimate) continue;
      pairs.push({ a: a.calibreId, b: b.calibreId, shared: count, estAInB, estBInA });
    }
  }
  pairs.sort((x, y) => x.a - y.a || x.b - y.b);
  return {
    pairs,
    stats: {
      books: N,
      postings: total,
      commonSamples,
      pairsCounted,
      candidates: pairs.length,
      ms: Date.now() - started,
    },
  };
}
