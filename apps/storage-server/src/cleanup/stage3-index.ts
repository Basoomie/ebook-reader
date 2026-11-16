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
 * Memory: 8 bytes per posting (about 500 per average book), plus the pair counts.
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
  if (books.length >= BOOK_BITS) throw new Error(`Too many books for the index (${books.length})`);
  let total = 0;
  for (const b of books) total += b.sketch.length;
  const postings = new Float64Array(total);
  let n = 0;
  books.forEach((b, i) => {
    for (let k = 0; k < b.sketch.length; k++) postings[n++] = b.sketch[k] * BOOK_BITS + i;
  });
  postings.sort();

  // Pair counts keyed by i * books + j (i < j); a Map keeps only pairs that occur.
  const counts = new Map<number, number>();
  const N = books.length;
  let commonSamples = 0;
  const bucket: number[] = [];
  const flush = () => {
    if (bucket.length > commonBooks) {
      commonSamples++;
    } else if (bucket.length > 1) {
      for (let x = 0; x < bucket.length; x++) {
        for (let y = x + 1; y < bucket.length; y++) {
          const i = Math.min(bucket[x], bucket[y]);
          const j = Math.max(bucket[x], bucket[y]);
          if (i === j) continue;
          const key = i * N + j;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    bucket.length = 0;
  };
  let current = -1;
  for (let p = 0; p < postings.length; p++) {
    const sample = Math.floor(postings[p] / BOOK_BITS);
    const book = postings[p] - sample * BOOK_BITS;
    if (sample !== current) {
      flush();
      current = sample;
    }
    bucket.push(book);
  }
  flush();

  const pairs: CandidatePair[] = [];
  for (const [key, shared] of counts) {
    if (shared < minShared) continue;
    const i = Math.floor(key / N);
    const j = key - i * N;
    const a = books[i];
    const b = books[j];
    const estAInB = a.sketch.length ? shared / a.sketch.length : 0;
    const estBInA = b.sketch.length ? shared / b.sketch.length : 0;
    if (Math.max(estAInB, estBInA) < minEstimate) continue;
    pairs.push({ a: a.calibreId, b: b.calibreId, shared, estAInB, estBInA });
  }
  pairs.sort((x, y) => x.a - y.a || x.b - y.b);
  return {
    pairs,
    stats: {
      books: books.length,
      postings: total,
      commonSamples,
      pairsCounted: counts.size,
      candidates: pairs.length,
      ms: Date.now() - started,
    },
  };
}
