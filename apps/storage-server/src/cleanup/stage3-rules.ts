/**
 * Stage 3 (WP20c): what a measured pair of books is (plan section 5 and P3/P4), which copy
 * is the better one (P5), and which copy of a set stays (P6). Pure functions, no I/O.
 *
 * Order of the pair rules:
 *   1. image-only books are never compared by text (their own review list);
 *   2. a sample or a store-bonus SS is never a duplicate of another kind;
 *   3. an omnibus is never a duplicate of a book with other content (one-way containment);
 *   4. ≥ bothWays both ways = duplicate; ≥ superset one way = superset (keep the superset);
 *   5. the spread check on 4 (extra text inside the chapters: keep both, or review);
 *   6. anything else reaching the review floor = review; below = different books.
 */
import type { EditionKind } from './stage3-kinds';
import type { ExtraText } from './stage3-sketch';

export interface DuplicateSettings {
  /** Containment both ways for "same text" (0.8). */
  bothWays: number;
  /** One-way containment for a superset (0.95). */
  superset: number;
  /** Below this in both directions: different books (0.1). */
  reviewFloor: number;
  /** Interleaved extra share at or above which both copies stay; null = not set yet. */
  spreadKeepBoth: number | null;
  /** Interleaved extra share below which the richer copy is kept; null = not set yet. */
  spreadIgnore: number | null;
  /** Fewer counted characters than this with images: an image-only book (1,000). */
  imageOnlyMaxChars: number;
  /** pHash distance (of 64 bits) at which two illustrations are the same picture (10). */
  imageMatchDistance: number;
  /** Sketch samples found in more books than this are dropped from the index (50). */
  commonWindowBooks: number;
  /** Time limit for reading one book's text (s). */
  textTimeoutSeconds: number;
  /** Books read at the same time (one reader process each). */
  textWorkers: number;
}

export const DEFAULT_DUPLICATE_SETTINGS: DuplicateSettings = {
  bothWays: 0.8,
  superset: 0.95,
  reviewFloor: 0.1,
  spreadKeepBoth: null,
  spreadIgnore: null,
  imageOnlyMaxChars: 1000,
  imageMatchDistance: 10,
  commonWindowBooks: 50,
  textTimeoutSeconds: 120,
  textWorkers: 2,
};

export type PairClass = 'duplicate' | 'superset' | 'keep_both' | 'review' | 'never' | 'different';

export interface PairBook {
  calibreId: number;
  kind: EditionKind;
  chars: number;
}

export interface PairMeasure {
  /** Share of a's windows found in b, and of b's in a (exact). */
  aInB: number;
  bInA: number;
  /** a's text that isn't in b, and b's that isn't in a. */
  extraA: ExtraText | null;
  extraB: ExtraText | null;
}

export interface PairVerdict {
  cls: PairClass;
  /** Short code of the rule that decided (stored, used by the report and tests). */
  rule: string;
  /** Plain words for the page. */
  reason: string;
  /** Superset: the copy that contains the other. */
  container?: 'a' | 'b';
}

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;

const KIND_WORDS: Record<EditionKind, string> = {
  sample: 'a free preview',
  bonus: 'a store-bonus story',
  omnibus: 'an omnibus',
  special: 'a special edition',
  full: 'a book',
};

/** The spread check (P4) on a duplicate or superset pair. null = it doesn't change the class. */
function spreadVerdict(m: PairMeasure, s: DuplicateSettings): PairVerdict | null {
  const extras = [m.extraA, m.extraB].filter((e): e is ExtraText => e !== null);
  if (extras.length === 0) return null;
  const share = Math.max(...extras.map((e) => e.interleavedShare));
  const runs = Math.max(...extras.map((e) => e.interleavedRuns));
  if (runs === 0) return null;
  const words = `${pct(share)} of one copy is extra text inside the chapters (${runs} passages)`;
  if (s.spreadKeepBoth === null || s.spreadIgnore === null) {
    return {
      cls: 'review',
      rule: 'spread_unset',
      reason: `${words}; the limit for keeping both copies isn't set yet`,
    };
  }
  if (share >= s.spreadKeepBoth) {
    return { cls: 'keep_both', rule: 'spread_keep_both', reason: `${words}: both copies stay` };
  }
  if (share >= s.spreadIgnore) {
    return { cls: 'review', rule: 'spread_borderline', reason: `${words}: close to the limit` };
  }
  return null;
}

/** The class of a measured pair (rules 2-6; image-only books never reach this). */
export function classifyPair(
  a: PairBook,
  b: PairBook,
  m: PairMeasure,
  s: DuplicateSettings,
): PairVerdict {
  const both = Math.min(m.aInB, m.bInA) >= s.bothWays;
  const most = Math.max(m.aInB, m.bInA);
  const overlap = `${pct(m.aInB)} / ${pct(m.bInA)} of the text in common`;

  const small = (k: EditionKind) => k === 'sample' || k === 'bonus';
  if ((small(a.kind) || small(b.kind)) && a.kind !== b.kind) {
    const which = small(a.kind) ? a.kind : b.kind;
    return {
      cls: 'never',
      rule: which === 'sample' ? 'sample' : 'bonus',
      reason: `${KIND_WORDS[which].replace(/^./, (c) => c.toUpperCase())} is never a duplicate of the full book`,
    };
  }
  // An omnibus sharing (almost) no text with the other book is simply another book.
  if ((a.kind === 'omnibus' || b.kind === 'omnibus') && most >= s.reviewFloor) {
    if (both) {
      return {
        cls: 'duplicate',
        rule: 'omnibus_same',
        reason: `Same text both ways (${overlap}): the same omnibus`,
      };
    }
    return {
      cls: 'never',
      rule: 'omnibus',
      reason: 'An omnibus is its own book, never a duplicate of the volumes it holds',
    };
  }
  let verdict: PairVerdict | null = null;
  if (both) {
    verdict = { cls: 'duplicate', rule: 'both_ways', reason: `Same text (${overlap})` };
  } else if (most >= s.superset && !small(a.kind)) {
    // Decided 2026-11-17 (Preview): a copy holding the other's whole text and at least a
    // quarter more (less would be "same text" above) is in practice a collection, a set or a
    // split edition holding one work, not a book with an added bonus: review, never removed
    // automatically (unless the extra text inside the chapters says both stay).
    const container = m.aInB >= m.bInA ? 'b' : 'a';
    const spread = spreadVerdict(m, s);
    if (spread?.cls === 'keep_both') return spread;
    return {
      cls: 'review',
      rule: 'holds_other',
      reason: `One copy holds the other's whole text and much more (${overlap}): a collection or set, not removed automatically`,
      container,
    };
  }
  if (verdict) return spreadVerdict(m, s) ?? verdict;
  if (most >= s.reviewFloor) {
    return { cls: 'review', rule: 'partial', reason: `Part of the text in common (${overlap})` };
  }
  return { cls: 'different', rule: 'different', reason: `Different books (${overlap})` };
}

/**
 * An omnibus by its text (P2): a book holding (≥ superset) at least two other books of real
 * length (full, special or omnibus kind, ≥ minChars) that don't overlap each other. `holds`
 * lists, per containing book, the books it holds; `overlap(x, y)` says whether two of them
 * share text (a candidate pair at all).
 */
export function omnibusByText(
  held: PairBook[],
  overlap: (x: number, y: number) => boolean,
  minChars = 10_000,
): boolean {
  const real = held.filter((h) => h.kind !== 'sample' && h.kind !== 'bonus' && h.chars >= minChars);
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length; j++) {
      if (!overlap(real[i].calibreId, real[j].calibreId)) return true;
    }
  }
  return false;
}

// ---- Best copy (P5) ----

export interface ImageFact {
  /** 64-bit perceptual hash as 16 hex digits. */
  phash: string;
  /** Longest side in pixels. */
  side: number;
  /** Mean JPEG luminance quantization (lower = better); null for PNG/GIF/WebP. */
  quant: number | null;
}

export interface QualityFacts {
  calibreId: number;
  chars: number;
  images: ImageFact[];
  ruby: number;
  tocEntries: number;
  /** true = vertical, false = horizontal, null = not known. */
  vertical: boolean | null;
  coverSide: number | null;
  /** Your own tags (custom-tag list) and when Calibre added the record, for a tie. */
  customTags: number;
  addedAt: number | null;
}

export type Side = 'a' | 'b' | 'tie' | 'tradeoff';

export interface Measure {
  name: 'text' | 'images' | 'artwork' | 'ruby' | 'toc' | 'cover' | 'direction';
  winner: Side;
  detail: string;
}

export interface BestCopy {
  /** The copy to keep, or null for a trade-off (review). */
  keep: 'a' | 'b' | null;
  /** 'measures' = it won or tied every measure; 'tie' = all tied, stage 1's rule decided. */
  by: 'measures' | 'tie' | 'tradeoff';
  measures: Measure[];
  reason: string;
}

/** Illustrations smaller than this (ornaments, gaiji) are not compared. */
export const MIN_ILLUSTRATION_SIDE = 200;
/** Full-size illustrations (the artwork of an edition): at least this long side. */
export const FULL_ILLUSTRATION_SIDE = 800;
const BLANK_PHASH = '0000000000000000';

/**
 * Different artwork (2026-11-17, found in the Preview): both copies have at least 3 full-size
 * illustrations the other lacks, and fewer than half of the smaller set match. Same text with
 * other art is another edition (新装版 and the like): not a duplicate, both stay (design:
 * "Different editions = not duplicates; keep both"; unsure = review).
 */
export function differentArtwork(
  a: ImageFact[],
  b: ImageFact[],
  maxDistance: number,
): { different: boolean; matched: number; a: number; b: number } {
  const full = (xs: ImageFact[]) =>
    xs.filter((i) => i.side >= FULL_ILLUSTRATION_SIDE && i.phash !== BLANK_PHASH);
  const fa = full(a);
  const fb = full(b);
  const matched = matchImages(fa, fb, maxDistance).length;
  const different =
    fa.length - matched >= 3 &&
    fb.length - matched >= 3 &&
    matched < 0.5 * Math.min(fa.length, fb.length);
  return { different, matched, a: fa.length, b: fb.length };
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}

/** Each picture of one copy matched with the closest unused picture of the other. */
export function matchImages(
  a: ImageFact[],
  b: ImageFact[],
  maxDistance: number,
): { a: ImageFact; b: ImageFact; distance: number }[] {
  const candidates: { i: number; j: number; d: number }[] = [];
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const d = hamming(x.phash, y.phash);
      if (d <= maxDistance) candidates.push({ i, j, d });
    }),
  );
  candidates.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const out: { a: ImageFact; b: ImageFact; distance: number }[] = [];
  for (const c of candidates) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    out.push({ a: a[c.i], b: b[c.j], distance: c.d });
  }
  return out;
}

/** One matched picture: larger (≥ 2 %) and better quantized (≥ 1 lower) wins; both ways = trade-off. */
function imageSide(x: ImageFact, y: ImageFact): Side {
  const size = x.side > y.side * 1.02 ? 'a' : y.side > x.side * 1.02 ? 'b' : 'tie';
  const q =
    x.quant === null || y.quant === null
      ? 'tie'
      : x.quant < y.quant - 1
        ? 'a'
        : y.quant < x.quant - 1
          ? 'b'
          : 'tie';
  if (size === 'tie') return q;
  if (q === 'tie' || q === size) return size;
  return 'tradeoff';
}

function combine(sides: Side[]): Side {
  const won = new Set(sides.filter((s) => s !== 'tie'));
  if (won.has('tradeoff') || (won.has('a') && won.has('b'))) return 'tradeoff';
  if (won.has('a')) return 'a';
  if (won.has('b')) return 'b';
  return 'tie';
}

/** Which copy is better on every measure (P5). `superset` names the copy holding the other's text. */
export function bestCopy(
  a: QualityFacts,
  b: QualityFacts,
  options: {
    superset?: 'a' | 'b';
    imageMatchDistance: number;
    coverLargerPercent: number;
  },
): BestCopy {
  const measures: Measure[] = [];

  // Text
  if (options.superset) {
    measures.push({
      name: 'text',
      winner: options.superset,
      detail: `${a.chars} / ${b.chars} characters; the ${options.superset === 'a' ? 'first' : 'second'} holds the other's text`,
    });
  } else {
    const diff = Math.abs(a.chars - b.chars) / Math.max(a.chars, b.chars, 1);
    measures.push({
      name: 'text',
      winner: diff < 0.01 ? 'tie' : a.chars > b.chars ? 'a' : 'b',
      detail: `${a.chars} / ${b.chars} characters`,
    });
  }

  // Illustrations
  const ia = a.images.filter((i) => i.side >= MIN_ILLUSTRATION_SIDE);
  const ib = b.images.filter((i) => i.side >= MIN_ILLUSTRATION_SIDE);
  const matched = matchImages(ia, ib, options.imageMatchDistance);
  const perImage = matched.map((m) => imageSide(m.a, m.b));
  const count: Side = ia.length > ib.length ? 'a' : ib.length > ia.length ? 'b' : 'tie';
  const images = combine([...perImage, count]);
  const wonA = perImage.filter((s) => s === 'a').length;
  const wonB = perImage.filter((s) => s === 'b').length;
  const mixed = perImage.filter((s) => s === 'tradeoff').length;
  measures.push({
    name: 'images',
    winner: images,
    detail: `${ia.length} / ${ib.length} pictures, ${matched.length} matched (better in the first ${wonA}, in the second ${wonB}${mixed ? `, larger in one but more compressed: ${mixed}` : ''})`,
  });

  // Artwork: another edition's illustrations make the pair a trade-off (review).
  const art = differentArtwork(a.images, b.images, options.imageMatchDistance);
  if (art.different) {
    measures.push({
      name: 'artwork',
      winner: 'tradeoff',
      detail: `different artwork: ${art.matched} of ${art.a} / ${art.b} full-size illustrations match`,
    });
  }

  // Ruby
  measures.push({
    name: 'ruby',
    winner: a.ruby > 0 && b.ruby === 0 ? 'a' : b.ruby > 0 && a.ruby === 0 ? 'b' : 'tie',
    detail: `${a.ruby} / ${b.ruby} ruby`,
  });

  // Table of contents
  const toc = (n: number) => n >= 2;
  measures.push({
    name: 'toc',
    winner:
      toc(a.tocEntries) && !toc(b.tocEntries)
        ? 'a'
        : toc(b.tocEntries) && !toc(a.tocEntries)
          ? 'b'
          : 'tie',
    detail: `${a.tocEntries} / ${b.tocEntries} chapters in the contents`,
  });

  // Cover
  const larger = 1 + options.coverLargerPercent / 100;
  const ca = a.coverSide ?? 0;
  const cb = b.coverSide ?? 0;
  measures.push({
    name: 'cover',
    winner: ca >= cb * larger && ca > cb ? 'a' : cb >= ca * larger && cb > ca ? 'b' : 'tie',
    detail: `cover ${a.coverSide ?? 'none'} / ${b.coverSide ?? 'none'} px`,
  });

  // Writing direction: a difference is a trade-off (横書き版 is its own edition).
  const differs = a.vertical !== null && b.vertical !== null && a.vertical !== b.vertical;
  measures.push({
    name: 'direction',
    winner: differs ? 'tradeoff' : 'tie',
    detail:
      a.vertical === null || b.vertical === null
        ? 'writing direction not known for one copy'
        : `${a.vertical ? 'vertical' : 'horizontal'} / ${b.vertical ? 'vertical' : 'horizontal'}`,
  });

  const overall = combine(measures.map((m) => m.winner));
  if (overall === 'tradeoff') {
    const names = measures.filter((m) => m.winner !== 'tie').map((m) => m.name);
    return {
      keep: null,
      by: 'tradeoff',
      measures,
      reason: art.different
        ? 'The copies have different artwork: another edition, not removed automatically'
        : `Each copy is better somewhere (${names.join(', ')})`,
    };
  }
  if (overall !== 'tie') {
    const names = measures.filter((m) => m.winner === overall).map((m) => m.name);
    return {
      keep: overall,
      by: 'measures',
      measures,
      reason: `Better or the same on every measure (better: ${names.join(', ')})`,
    };
  }
  // All tied: stage 1's rule (more of your own tags, then the older record, then the lower id).
  const older =
    a.customTags !== b.customTags
      ? a.customTags > b.customTags
        ? 'a'
        : 'b'
      : (a.addedAt ?? Infinity) !== (b.addedAt ?? Infinity)
        ? (a.addedAt ?? Infinity) < (b.addedAt ?? Infinity)
          ? 'a'
          : 'b'
        : a.calibreId < b.calibreId
          ? 'a'
          : 'b';
  return {
    keep: older,
    by: 'tie',
    measures,
    reason:
      a.customTags !== b.customTags
        ? 'The same on every measure; the copy with more of your tags stays'
        : 'The same on every measure; the older record stays',
  };
}

// ---- Sets (P6) ----

export interface SetEdge {
  a: number;
  b: number;
  /** The copy to keep between the two, or null (trade-off). */
  keep: number | null;
}

export interface SetDecision {
  members: number[];
  /** null: no copy is at least as good as every other one (more than one copy stays). */
  keeper: number | null;
  removed: number[];
  /** Each removed copy and the copy it is removed in favour of (the keeper, when there is one). */
  removals: { id: number; keep: number }[];
}

/**
 * Sets of copies joined by duplicate/superset pairs. A copy stays when, against every other
 * copy of the set, a measured pair says it is the one to keep; the others are removed.
 * When no copy qualifies, the copies that every other copy beats are removed, one at a time
 * (each copy left then still beats it), in favour of the copy left that beats the most others;
 * the rest stay (decided 2026-11-17: in 78 such sets one copy lost to all the others).
 */
export function decideSets(edges: SetEdge[]): SetDecision[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y)! !== r) {
      const next = parent.get(y)!;
      parent.set(y, r);
      y = next;
    }
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  const groups = new Map<number, number[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  const keepOf = new Map<string, number | null>();
  for (const e of edges) keepOf.set(`${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`, e.keep);

  const keepBetween = (m: number, o: number) => keepOf.get(`${Math.min(m, o)}:${Math.max(m, o)}`);
  const out: SetDecision[] = [];
  for (const members of groups.values()) {
    members.sort((x, y) => x - y);
    const keeper =
      members.find((m) => members.every((o) => o === m || keepBetween(m, o) === m)) ?? null;
    if (keeper !== null) {
      const removed = members.filter((m) => m !== keeper);
      out.push({ members, keeper, removed, removals: removed.map((id) => ({ id, keep: keeper })) });
      continue;
    }
    // No single winner: a copy every other copy left beats goes, one at a time. Two such copies
    // can't exist at once (each would beat the other), and no copy left can become a single
    // winner (it would have beaten the removed one too, and so been the keeper already).
    let left = [...members];
    const removals: { id: number; keep: number }[] = [];
    for (;;) {
      const loser = left.find(
        (m) => left.length > 1 && left.every((o) => o === m || keepBetween(m, o) === o),
      );
      if (loser === undefined) break;
      left = left.filter((x) => x !== loser);
      const wins = (c: number) => left.filter((o) => o !== c && keepBetween(c, o) === c).length;
      const keep = [...left].sort((x, y) => wins(y) - wins(x) || x - y)[0];
      removals.push({ id: loser, keep });
    }
    out.push({ members, keeper: null, removed: removals.map((r) => r.id), removals });
  }
  return out.sort((x, y) => x.members[0] - y.members[0]);
}
