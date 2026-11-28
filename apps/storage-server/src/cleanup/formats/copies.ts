/**
 * Books without an EPUB: is a converted book a copy of an EPUB book with the same title? Stage
 * 3's own text code measures the pair (the reader processes read both, exact containment both
 * ways), stage 3's pair rules classify it (classifyPair, with the edition kinds from the
 * titles), and the decision at stop 1 (user, 2026-11-26) applies:
 *   same text (stage 3's duplicate, and at least `sameMin` both ways: stop 1's line, 95 %, that
 *   the user's numbers were based on; お兄ちゃんだけど… at 93-95 % stays in review)
 *                                              -> folded into the twin's record;
 *   wholly inside the twin (the twin has more) -> folded too;
 *   and for both: stage 3's review principle (a copy goes only if the book kept has everything
 *   it has): the copy's text that the twin lacks is at most `copyExtraMax` of the copy (the
 *   real-calibre e2e: お兄ちゃんだけど… 8 is 99.7 % / 99.3 % by stage 3's exact measure, a
 *   duplicate by stage 3's rules, but has 192 characters its twin lacks: review, as decided);
 *   part of the text in common                 -> review (the "near" ones);
 *   different                                  -> a book of its own (converted).
 * A sample or bonus story never folds into a full book (stage 3: never a duplicate), and a book
 * with hardly any text (a picture book) is not compared by text: it is converted, and the next
 * new-arrivals run compares its pictures with stage 3's picture rule.
 */
import { editionKind } from '../stage3-kinds';
import { classifyPair, type DuplicateSettings } from '../stage3-rules';
import type { ExtraText } from '../stage3-sketch';

export interface TwinMeasure {
  twinId: number;
  twinUuid: string;
  twinTitle: string;
  /** Share of the copy's text found in the twin, and of the twin's in the copy. */
  copyInTwin: number | null;
  twinInCopy: number | null;
  extraCopy?: ExtraText | null;
  extraTwin?: ExtraText | null;
  copyChars?: number | null;
  twinChars?: number | null;
  error: string | null;
}

export type CopyVerdict =
  | { verdict: 'fold'; how: 'same' | 'inside'; twin: TwinMeasure; reason: string }
  | { verdict: 'near'; twin: TwinMeasure; reason: string }
  | { verdict: 'convert'; reason: string };

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;

/** The decision for one copy from its measured twins (in their order: the copy's authors first). */
export function decideCopy(
  copyTitle: string,
  copyChars: number,
  measures: TwinMeasure[],
  s: DuplicateSettings,
  sameMin: number,
  copyExtraMax = 0.001,
): CopyVerdict {
  if (measures.length === 0) return { verdict: 'convert', reason: 'No EPUB book with this title' };
  if (copyChars < s.imageOnlyMaxChars)
    return {
      verdict: 'convert',
      reason: 'Hardly any text: not compared by text (the new arrivals compare its pictures)',
    };
  const copyKind = editionKind([copyTitle]).kind;
  let inside: CopyVerdict | null = null;
  let near: CopyVerdict | null = null;
  for (const m of measures) {
    if (m.error || m.copyInTwin === null || m.twinInCopy === null) continue;
    const v = classifyPair(
      { calibreId: -1, kind: copyKind, chars: copyChars },
      { calibreId: m.twinId, kind: editionKind([m.twinTitle]).kind, chars: m.twinChars ?? 0 },
      {
        aInB: m.copyInTwin,
        bInA: m.twinInCopy,
        extraA: m.extraCopy ?? null,
        extraB: m.extraTwin ?? null,
      },
      s,
    );
    const overlap = `${pct(m.copyInTwin)} of the copy in the EPUB book, ${pct(m.twinInCopy)} of the EPUB book in the copy`;
    // The copy's own text the twin lacks (its extra text, counted as the reader counts).
    const extra = m.extraCopy ? m.extraCopy.extraChars : copyChars * (1 - m.copyInTwin);
    const nothingLost = extra <= copyExtraMax * copyChars;
    if (v.cls === 'duplicate' && Math.min(m.copyInTwin, m.twinInCopy) >= sameMin && nothingLost)
      return { verdict: 'fold', how: 'same', twin: m, reason: `Same text (${overlap})` };
    if (v.cls === 'never') continue;
    // Wholly inside: the copy's text in the twin, the twin clearly more (below the "same" line),
    // and not a pair stage 3's spread check keeps apart (extra text inside the chapters).
    if (
      !inside &&
      v.cls !== 'keep_both' &&
      m.copyInTwin >= s.superset &&
      m.twinInCopy < sameMin &&
      nothingLost &&
      v.container !== 'a'
    )
      inside = {
        verdict: 'fold',
        how: 'inside',
        twin: m,
        reason: `Wholly inside the EPUB book, which has more (${overlap})`,
      };
    else if (!near && Math.max(m.copyInTwin, m.twinInCopy) >= s.reviewFloor)
      near = {
        verdict: 'near',
        twin: m,
        reason: nothingLost
          ? `Part of the text in common (${overlap})`
          : `Nearly the same, but the copy has ${Math.round(extra).toLocaleString('en-US')} characters the EPUB book lacks (${overlap})`,
      };
  }
  if (inside) return inside;
  if (near) return near;
  const measured = measures.filter((m) => !m.error && m.copyInTwin !== null);
  if (measured.length === 0)
    return { verdict: 'convert', reason: 'The EPUB books with this title could not be read' };
  return { verdict: 'convert', reason: 'A different book with the same title' };
}
