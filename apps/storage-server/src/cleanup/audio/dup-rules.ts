/**
 * Best copy among copies of the same recording (WP21b; design "Best-copy order", decided
 * 2026-11-16). Pure.
 *
 * The first rule that separates two copies decides. A copy that wins on a later rule but loses
 * on an earlier one goes to review with the best guess recorded (taken literally: any later rule
 * that favors the loser makes the result a review item; the counts per rule pair are reported).
 *
 *   0  damaged or incomplete loses (decode errors confirmed by a second decoder; noticeably
 *      shorter than its twin)
 *   1  keeps the original chapters (both have real chapters that differ → review: which ones are
 *      original is unknown)
 *   2  single file over multi-file
 *   3  chapters over none
 *   4  AAC over MP3 (other codec pairs → review)
 *   5  higher bitrate within the same codec, then higher sample rate
 *   6  has a cover
 *   7  ASIN in the torrent name
 *   tie: the first by path (shown as a tie)
 *
 * Lengths that differ by more than `lengthEqualSeconds` but less than `incompleteSeconds` are
 * not explained yet (the Discord vs TMW copies: 15 s, design "Reference sample"): when the
 * shorter copy would win, or nothing separates the copies, the group goes to review.
 */

export interface ChapterSpan {
  start: number;
  end: number;
}

export interface CopyFacts {
  key: string;
  /** For the tie and for the page. */
  path: string;
  files: number;
  seconds: number | null;
  /** 'aac', 'mp3', …; 'mixed' when the files differ; null when unknown. */
  codec: string | null;
  /** Bits per second (the files' average, weighted by length). */
  bitrate: number | null;
  sampleRate: number | null;
  /** The copy's chapters on its own timeline (files one after another). */
  chapters: ChapterSpan[];
  hasCover: boolean;
  asinInName: boolean;
  /**
   * Rule 0 from the file checks (`damageOf` in stage3-dups.ts): 'damaged' when the full ffmpeg
   * decode reports more than `dupNoticeableErrors` bad frames or doesn't get through the file;
   * 'ok' when it gets through with none or a few (they play normally); null when no full decode
   * ran. faad2 decides nothing (it stops at the first bad frame). 'suspect' is no longer given.
   */
  damage: 'damaged' | 'suspect' | 'ok' | null;
  damageDetail?: string | null;
}

export interface RuleSettings {
  lengthEqualSeconds: number;
  incompleteSeconds: number;
  bitrateMarginPercent: number;
  chapterToleranceSeconds: number;
}

export type RuleId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** -1: a is better; 1: b is better; 0: no difference; 'review': can't tell which is better. */
type Cmp = -1 | 0 | 1 | 'review';

export const RULE_NAMES: Record<RuleId, string> = {
  0: 'damaged or incomplete',
  1: 'keeps the original chapters',
  2: 'single file',
  3: 'has chapters',
  4: 'AAC over MP3',
  5: 'bitrate / sample rate',
  6: 'has a cover',
  7: 'ASIN in the torrent name',
};

/** Real chapters: more than one, and not just one per file (a split copy's file boundaries). */
export function hasRealChapters(c: CopyFacts): boolean {
  return c.chapters.length >= 2 && c.chapters.length > c.files;
}

/**
 * Same chapters: same count and every chapter as long as its twin, except that the first and
 * the last chapter may carry the copies' length difference (an opening or closing that one copy
 * has and the other doesn't, as in the 15 s pairs: 7.8 s in the first chapter, 7.3 s in the
 * last, every other chapter equal).
 */
export function sameChapters(a: CopyFacts, b: CopyFacts, tol: number): boolean {
  if (a.chapters.length !== b.chapters.length) return false;
  const n = a.chapters.length;
  if (n === 0) return true;
  const len = (c: ChapterSpan) => c.end - c.start;
  for (let i = 1; i < n - 1; i++) {
    if (Math.abs(len(a.chapters[i]) - len(b.chapters[i])) > tol) return false;
  }
  if (n === 1) return true;
  const edgeA = len(a.chapters[0]) + len(a.chapters[n - 1]);
  const edgeB = len(b.chapters[0]) + len(b.chapters[n - 1]);
  const total = (a.seconds ?? 0) - (b.seconds ?? 0);
  return Math.abs(edgeA - edgeB - total) <= tol + 1;
}

function cmpBool(a: boolean, b: boolean): Cmp {
  return a === b ? 0 : a ? -1 : 1;
}

function compareRule(rule: RuleId, a: CopyFacts, b: CopyFacts, s: RuleSettings): Cmp {
  switch (rule) {
    case 0: {
      const da = a.damage === 'damaged';
      const db = b.damage === 'damaged';
      if (da !== db) return da ? 1 : -1;
      if (a.seconds !== null && b.seconds !== null) {
        const d = a.seconds - b.seconds;
        if (Math.abs(d) >= s.incompleteSeconds) return d > 0 ? -1 : 1;
      }
      return 0;
    }
    case 1: {
      if (!hasRealChapters(a) || !hasRealChapters(b)) return 0;
      return sameChapters(a, b, s.chapterToleranceSeconds) ? 0 : 'review';
    }
    case 2:
      return cmpBool(a.files === 1, b.files === 1);
    case 3:
      return cmpBool(hasRealChapters(a), hasRealChapters(b));
    case 4: {
      if (a.codec === b.codec && a.codec !== 'mixed') return 0;
      const rank = (c: string | null) => (c === 'aac' ? 2 : c === 'mp3' ? 1 : 0);
      if (rank(a.codec) > 0 && rank(b.codec) > 0) return rank(a.codec) > rank(b.codec) ? -1 : 1;
      return 'review';
    }
    case 5: {
      if (a.codec !== b.codec) return 0;
      if (a.bitrate && b.bitrate) {
        const hi = Math.max(a.bitrate, b.bitrate);
        if (Math.abs(a.bitrate - b.bitrate) > (hi * s.bitrateMarginPercent) / 100) {
          return a.bitrate > b.bitrate ? -1 : 1;
        }
      }
      if (a.sampleRate && b.sampleRate && a.sampleRate !== b.sampleRate) {
        return a.sampleRate > b.sampleRate ? -1 : 1;
      }
      return 0;
    }
    case 6:
      return cmpBool(a.hasCover, b.hasCover);
    case 7:
      return cmpBool(a.asinInName, b.asinInName);
  }
}

const RULES: RuleId[] = [0, 1, 2, 3, 4, 5, 6, 7];

export interface PairResult {
  /** The better copy's key (the best guess when the result is a review). */
  best: string;
  other: string;
  /** The rule that decided, or 'tie' (nothing separates them; the first by path). */
  rule: RuleId | 'tie';
  /** Later rules that favor the other copy. */
  conflicts: RuleId[];
  /** Why this pair can't be decided automatically, or null. */
  review: string | null;
}

/** Compares two copies of the same recording by the decided order. */
export function comparePair(a: CopyFacts, b: CopyFacts, s: RuleSettings): PairResult {
  let decided: { rule: RuleId; aBetter: boolean } | null = null;
  const reviews: string[] = [];
  const conflicts: RuleId[] = [];
  for (const r of RULES) {
    const c = compareRule(r, a, b, s);
    if (c === 'review') {
      if (!decided) {
        reviews.push(
          r === 1
            ? `both have chapters, but different ones (${a.chapters.length} vs ${b.chapters.length}): which are the original?`
            : `codecs ${a.codec ?? '?'} and ${b.codec ?? '?'} have no rule`,
        );
      }
      continue;
    }
    if (c === 0) continue;
    if (!decided) decided = { rule: r, aBetter: c === -1 };
    else if ((c === -1) !== decided.aBetter) conflicts.push(r);
  }
  let aBetter: boolean;
  let rule: RuleId | 'tie';
  if (decided) {
    aBetter = decided.aBetter;
    rule = decided.rule;
  } else {
    aBetter = a.path.localeCompare(b.path) <= 0;
    rule = 'tie';
  }
  const best = aBetter ? a : b;
  const other = aBetter ? b : a;
  // Rule 0 is absolute ("a damaged or incomplete copy always loses"): later rules that favor
  // the damaged or incomplete copy are recorded but don't make it a review item.
  if (conflicts.length && rule !== 0) {
    reviews.push(
      `${RULE_NAMES[rule as RuleId]} picks it, but the other copy wins on ${conflicts
        .map((r) => RULE_NAMES[r])
        .join(', ')}`,
    );
  }
  // Lengths that differ by an amount nothing explains yet: fine when the longer copy wins
  // anyway; otherwise review.
  if (best.seconds !== null && other.seconds !== null) {
    const d = other.seconds - best.seconds;
    const abs = Math.abs(d);
    if (abs > s.lengthEqualSeconds && abs < s.incompleteSeconds && (d > 0 || rule === 'tie')) {
      reviews.push(
        rule === 'tie'
          ? `nothing separates them, and their lengths differ by ${abs.toFixed(1)} s`
          : `the chosen copy is ${abs.toFixed(1)} s shorter, and why is not known`,
      );
    }
  }
  for (const c of [a, b]) {
    if (c.damage === 'suspect' && c === best) {
      reviews.push(`the chosen copy has decode errors not confirmed by a second decoder`);
    }
  }
  return {
    best: best.key,
    other: other.key,
    rule,
    conflicts,
    review: reviews.length ? reviews.join('; ') : null,
  };
}

export interface GroupDecision {
  best: string;
  rule: RuleId | 'tie';
  /** Each other copy with how it compares to the best one. */
  against: PairResult[];
  review: string | null;
}

/**
 * The best copy of a group: the one no other copy beats (copies are ranked pairwise by the
 * order; a cycle cannot happen because the first separating rule is a strict order on the
 * facts, except where lengths or 'review' rules make it ambiguous: then review).
 */
export function decideGroup(copies: CopyFacts[], s: RuleSettings): GroupDecision {
  if (copies.length < 2) throw new Error('A group has at least two copies');
  let best = copies[0];
  for (const c of copies.slice(1)) {
    const r = comparePair(best, c, s);
    if (r.best === c.key) best = c;
  }
  const against = copies.filter((c) => c !== best).map((c) => comparePair(best, c, s));
  const lost = against.filter((r) => r.best !== best.key);
  const reviews = against.filter((r) => r.review).map((r) => r.review as string);
  if (lost.length) reviews.unshift('the copies can’t be put in one order');
  // The group's deciding rule: the one that separated the best copy from its closest rival
  // (the latest rule among the pairs; a tie counts as the latest).
  const deciding = against
    .map((r) => r.rule)
    .sort((x, y) => (y === 'tie' ? 99 : y) - (x === 'tie' ? 99 : x))[0];
  return {
    best: best.key,
    rule: deciding,
    against,
    review: reviews.length ? [...new Set(reviews)].join('; ') : null,
  };
}
