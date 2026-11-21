/**
 * Stage 4's one-record rule (WP21c follow-up (3), user 2026-11-21). Pure.
 *
 * Two recordings that are not the same may never both match one store record automatically
 * (`モテモテな僕は…(入門)` and `(妄想)` both matched Audible B00WK0IARS). Whether two recordings
 * are the same is decided by their fingerprints (the user's answer while planning):
 *   - stage 3 compared them: alike (byte-identical, or every window or some windows the same)
 *     keeps the match; different applies the rule; windows that couldn't be read (unknown)
 *     send both to review;
 *   - stage 3 never compared them: stage 4 compares them now with stage 3's own windows (the
 *     caller), then as above.
 * The rule for a different pair, tie-breaks in this order (user, 2026-11-21):
 *   1. exactly one of the two has the record's ASIN in its file name (`asinInName`: that ASIN
 *      chose the record): it keeps the record;
 *   2. else exactly one has the store's title exactly (`exactTitle`): it keeps the record;
 * the other is looked up again without it. Otherwise both go to review ("shared"). A unit that
 * loses in any pair loses: looked up again wins over review (another recording keeps the
 * record), review over keeping. Windows that couldn't be read send both to review whatever
 * their names say.
 */

export type PairLook = 'alike' | 'different' | 'unknown';

export interface SharingUnit {
  id: number;
  name: string;
  /** The file's own title is the record's title exactly. */
  exact: boolean;
  /** The ASIN in the file's name is this record's (Audible; the name chose it). */
  asinInName?: boolean;
}

export interface RecordOutcome {
  /** Units sent to review, with the names of the recordings they share the record with. */
  review: Map<number, string[]>;
  /** Units looked up again without the record, with the recording that keeps it. */
  exclude: Map<number, string>;
}

/** Stage 3's measure of one copy pair as a look (null: the pair was never compared). */
export function stage3Look(row: {
  test: string;
  verdict: string;
  fp_verdict: string | null;
}): PairLook | null {
  if (row.test === 'identical') return 'alike';
  switch (row.fp_verdict) {
    case 'same':
    case 'partly':
      return 'alike';
    case 'different':
      return 'different';
    case 'unknown':
      return 'unknown';
    default:
      return null;
  }
}

/**
 * The look of two units from their copy pairs' looks: any different pair makes them different
 * (a unit's copies are one recording, so one different pair is enough to doubt), else any
 * alike pair makes them alike, else unknown; null when no copy pair was measured.
 */
export function combineLooks(looks: (PairLook | null)[]): PairLook | null {
  const known = looks.filter((l): l is PairLook => l !== null);
  if (!known.length) return null;
  if (known.includes('different')) return 'different';
  if (known.includes('alike')) return 'alike';
  return 'unknown';
}

/** The rule on the units of one record, given each pair's look. */
export function applyOneRecord(
  units: SharingUnit[],
  look: (a: SharingUnit, b: SharingUnit) => PairLook,
): RecordOutcome {
  const review = new Map<number, string[]>();
  const exclude = new Map<number, string>();
  const toReview = (u: SharingUnit, other: SharingUnit) => {
    const l = review.get(u.id) ?? [];
    if (!l.includes(other.name)) l.push(other.name);
    review.set(u.id, l);
  };
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      const l = look(a, b);
      if (l === 'alike') continue;
      if (l === 'different') {
        const winner = (x: SharingUnit, y: SharingUnit): SharingUnit | null =>
          !!x.asinInName !== !!y.asinInName
            ? x.asinInName
              ? x
              : y
            : x.exact !== y.exact
              ? x.exact
                ? x
                : y
              : null;
        const keep = winner(a, b);
        if (keep) {
          const lose = keep === a ? b : a;
          if (!exclude.has(lose.id)) exclude.set(lose.id, keep.name);
          continue;
        }
      }
      toReview(a, b);
      toReview(b, a);
    }
  }
  for (const id of exclude.keys()) review.delete(id);
  return { review, exclude };
}
