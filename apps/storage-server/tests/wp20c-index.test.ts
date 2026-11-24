import { describe, expect, it } from 'vitest';
import {
  buildLookup,
  candidatePairs,
  lookupCandidates,
  type SketchedBook,
} from '../src/cleanup/stage3-index';

/** The index as first built (one Map of every pair sharing a sample): the reference. */
function candidatePairsMap(
  books: SketchedBook[],
  {
    commonBooks,
    minShared = 2,
    minEstimate = 0.05,
  }: { commonBooks: number; minShared?: number; minEstimate?: number },
) {
  const B = 2 ** 17;
  let total = 0;
  for (const b of books) total += b.sketch.length;
  const postings = new Float64Array(total);
  let n = 0;
  books.forEach((b, i) => {
    for (let k = 0; k < b.sketch.length; k++) postings[n++] = b.sketch[k] * B + i;
  });
  postings.sort();
  const counts = new Map<number, number>();
  const N = books.length;
  let commonSamples = 0;
  const bucket: number[] = [];
  const flush = () => {
    if (bucket.length > commonBooks) commonSamples++;
    else if (bucket.length > 1) {
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
    const sample = Math.floor(postings[p] / B);
    const book = postings[p] - sample * B;
    if (sample !== current) {
      flush();
      current = sample;
    }
    bucket.push(book);
  }
  flush();
  const pairs = [];
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
      books: N,
      postings: total,
      commonSamples,
      pairsCounted: counts.size,
      candidates: pairs.length,
    },
  };
}

/** Deterministic random sketches: some books copy parts of others, some samples are common. */
function library(seed: number, count: number): SketchedBook[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const common = Array.from({ length: 30 }, () => Math.floor(rnd() * 2 ** 32));
  const books: Set<number>[] = [];
  for (let i = 0; i < count; i++) {
    const set = new Set<number>();
    const size = 5 + Math.floor(rnd() * 300);
    for (let k = 0; k < size; k++) set.add(Math.floor(rnd() * 2 ** 20)); // a small space: chance overlaps
    if (rnd() < 0.5) for (const c of common) if (rnd() < 0.6) set.add(c);
    if (i > 0 && rnd() < 0.3) {
      const other = books[Math.floor(rnd() * i)];
      const share = rnd();
      for (const v of other) if (rnd() < share) set.add(v);
    }
    books.push(set);
  }
  return books.map((set, i) => ({
    calibreId: 1000 + i * 3,
    sketch: Uint32Array.from([...set].sort((x, y) => x - y)),
  }));
}

describe('stage 3 candidate index', () => {
  it.each([
    [1, 300, 50],
    [2, 1500, 50],
    [3, 1500, 5],
    [4, 800, 2],
  ])(
    'seed %i, %i books, common above %i: the same pairs, counts and stats as the map version',
    (seed, count, commonBooks) => {
      const books = library(seed, count);
      const opts = { commonBooks, minShared: 2, minEstimate: 0.05 };
      const want = candidatePairsMap(books, opts);
      const got = candidatePairs(books, opts);
      expect(want.pairs.length).toBeGreaterThan(0);
      expect(got.pairs).toEqual(want.pairs);
      const { ms: _ms, ...stats } = got.stats;
      expect(stats).toEqual(want.stats);
    },
  );

  it('other thresholds give the same result too', () => {
    const books = library(9, 1000);
    for (const opts of [
      { commonBooks: 50, minShared: 1, minEstimate: 0 },
      { commonBooks: 50, minShared: 5, minEstimate: 0.2 },
    ]) {
      const want = candidatePairsMap(books, opts);
      const got = candidatePairs(books, opts);
      expect(got.pairs).toEqual(want.pairs);
      expect(got.stats.pairsCounted).toBe(want.stats.pairsCounted);
    }
  });

  it('handles empty input, empty sketches and a single book', () => {
    expect(candidatePairs([], { commonBooks: 50 }).pairs).toEqual([]);
    const one = [{ calibreId: 1, sketch: Uint32Array.from([1, 2, 3]) }];
    expect(candidatePairs(one, { commonBooks: 50 }).pairs).toEqual([]);
    const withEmpty = [
      { calibreId: 1, sketch: new Uint32Array(0) },
      { calibreId: 2, sketch: Uint32Array.from([5, 6, 7]) },
      { calibreId: 3, sketch: Uint32Array.from([5, 6, 7]) },
    ];
    expect(candidatePairs(withEmpty, { commonBooks: 50 }).pairs).toEqual(
      candidatePairsMap(withEmpty, { commonBooks: 50 }).pairs,
    );
  });

  it('counts far more pairs than a Map can hold without failing', () => {
    // Many buckets of 50 books among 12,000: 1,225 pairs each, 25,000 buckets = 30.6 million
    // pair counts, about 28 million of them distinct (more than the 2^24 a Map holds).
    const N = 12_000;
    const sketches: number[][] = Array.from({ length: N }, () => []);
    let s = 7;
    const rnd = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    for (let sample = 0; sample < 25_000; sample++) {
      const members = new Set<number>();
      while (members.size < 50) members.add(Math.floor(rnd() * N));
      for (const m of members) sketches[m].push(sample);
    }
    const books = sketches.map((x, i) => ({ calibreId: i + 1, sketch: Uint32Array.from(x) }));
    const out = candidatePairs(books, { commonBooks: 50, minShared: 2, minEstimate: 0.05 });
    expect(out.stats.pairsCounted).toBeGreaterThan(2 ** 24);
    expect(out.stats.postings).toBe(1_250_000);
  });
});

describe('stage 3 candidate index past 2^17 books (WP20g, 2026-11-24)', () => {
  it('indexes 140,000 books (the library and a large import together)', () => {
    // Books 2k and 2k+1 share two samples; every book has one sample of its own.
    const n = 140_000;
    const books: SketchedBook[] = Array.from({ length: n }, (_, i) => ({
      calibreId: i + 1,
      sketch: Uint32Array.from(
        [Math.floor(i / 2) * 3, Math.floor(i / 2) * 3 + 1, 4_000_000_000 - i].sort((x, y) => x - y),
      ),
    }));
    const { pairs } = candidatePairs(books, { commonBooks: 50 });
    expect(pairs).toHaveLength(n / 2);
    expect(pairs.at(-1)).toMatchObject({ a: n - 1, b: n, shared: 2 });
    const lookup = buildLookup(books.slice(0, n - 1));
    expect(
      lookupCandidates(lookup, books[n - 1].sketch, { commonBooks: 50 }).map((c) => c.b),
    ).toEqual([n - 1]);
  });
});
