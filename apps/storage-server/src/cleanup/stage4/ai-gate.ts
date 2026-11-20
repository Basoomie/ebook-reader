/**
 * The AI step's gate (WP20e, pure): the decided values of the labeled books scored with the
 * stage-4 gate's comparison (score.ts fieldRight, the labels' alternatives), two ways:
 *
 *   - automatic: only values applied as confirmed (the rules' or both models'): the gate's bar;
 *   - no review at all: every value, unconfirmed guesses included (the bake-off's measure of
 *     setup E, "the library with no manual review"), plus books with every field right.
 *
 * Reported for the 600 and check D apart, next to E's figures on check D (plan section 6).
 */
import { SCORED_FIELDS, fieldRight, percent, type ScoredField, type Stage4Gold } from './score';
import { isConfirmed, type Stage4AiValues } from './ai-decide';

/** E on check D after the audit (library-cleanup-plan.md section 6), % right with no review. */
export const MEASURED_E_D: Record<ScoredField, number> = {
  t: 98.0,
  au: 99.5,
  il: 99.0,
  se: 100.0,
  ix: 99.5,
  fmt: 99.0,
};

export interface AiGateField {
  scored: number;
  auto: number;
  autoRight: number;
  autoPercent: number | null;
  allRight: number;
  allPercent: number | null;
  wrong: string[];
}
export interface AiGateGroup {
  books: number;
  everyFieldRight: number;
  everyFieldPercent: number | null;
  fields: Record<ScoredField, AiGateField>;
}
export interface AiGate {
  books: number;
  all: AiGateGroup;
  the600: AiGateGroup;
  checkD: AiGateGroup;
  /** Labeled books the models were not asked about (labeledOnly off and not yet asked, errors). */
  notAsked: number;
}

/** A decided value as the gate compares it. */
export function gateValue(f: ScoredField, ai: Stage4AiValues): unknown {
  switch (f) {
    case 'se':
      return (ai.se?.value as { name?: string | null } | null)?.name ?? null;
    case 'ix': {
      const name = (ai.se?.value as { name?: string | null } | null)?.name ?? null;
      return name ? ((ai.ix?.value as { n?: number | null } | null)?.n ?? null) : null;
    }
    default:
      return ai[f]?.value ?? null;
  }
}

function emptyGroup(): AiGateGroup {
  const fields = {} as Record<ScoredField, AiGateField>;
  for (const f of SCORED_FIELDS)
    fields[f] = {
      scored: 0,
      auto: 0,
      autoRight: 0,
      autoPercent: null,
      allRight: 0,
      allPercent: null,
      wrong: [],
    };
  return { books: 0, everyFieldRight: 0, everyFieldPercent: null, fields };
}

export function scoreAiGate(
  books: { gid: string; gold: Stage4Gold; ai: (Stage4AiValues & { asked: boolean }) | null }[],
): AiGate {
  const all = emptyGroup();
  const the600 = emptyGroup();
  const checkD = emptyGroup();
  let notAsked = 0;
  for (const b of books) {
    if (!b.ai || !b.ai.asked) {
      notAsked++;
      continue;
    }
    const groups = [all, b.gold.sample === 'D' ? checkD : the600];
    let bookRight = true;
    for (const g of groups) g.books++;
    for (const f of SCORED_FIELDS) {
      const ok = fieldRight(f, gateValue(f, b.ai), b.gold);
      if (ok === null) continue;
      // The number goes with the series: it is confirmed only when both are.
      const confirmed =
        f === 'ix'
          ? isConfirmed(b.ai.se) && (gateValue('se', b.ai) === null || isConfirmed(b.ai.ix))
          : isConfirmed(b.ai[f]);
      if (!ok) bookRight = false;
      for (const g of groups) {
        const s = g.fields[f];
        s.scored++;
        if (ok) s.allRight++;
        if (confirmed) {
          s.auto++;
          if (ok) s.autoRight++;
        }
        if (!ok && s.wrong.length < 60)
          s.wrong.push(`${b.gid}${confirmed ? '' : ' (unconfirmed)'}`);
      }
    }
    if (bookRight) for (const g of groups) g.everyFieldRight++;
  }
  for (const g of [all, the600, checkD]) {
    g.everyFieldPercent = percent(g.everyFieldRight, g.books);
    for (const f of SCORED_FIELDS) {
      const s = g.fields[f];
      s.autoPercent = percent(s.autoRight, s.auto);
      s.allPercent = percent(s.allRight, s.scored);
    }
  }
  return { books: all.books, all, the600, checkD, notAsked };
}
