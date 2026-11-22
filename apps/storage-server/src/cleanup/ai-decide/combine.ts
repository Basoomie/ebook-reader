/**
 * Setup E and its upgrades, per field (pure). The designs are the bake-off's
 * (`bake/designs2.py`, reference-sample.md "AI model bake-off"; library-cleanup-plan.md
 * section 6):
 *
 * E (both cheap models read every item):
 *   - a rules field that is automatic stays the rules' value unless both models agree with each
 *     other and not with it: then it is flagged;
 *   - an open field (the rules are not sure, or know nothing) is applied when both models give
 *     the same answer, otherwise flagged.
 *   - A flagged field is never left empty: it gets the best guess, marked unconfirmed: the second
 *     model's answer (Luna's), else the rules' value, else "unknown".
 *
 * F (upgrade): the stronger pair reads only what E flagged; it settles a flagged field when both
 *   agree (an automatic rules field only back to the rules' value).
 * J (upgrade): the stronger pair also decides every open field E's pair agreed on, and an
 *   automatic rules field takes the answer all four models agree on against the rules.
 */
import { inEvidence } from '../../ai/evidence-check';
import type { AiField, FieldDecision, RulesValue } from './types';

/** A model's answer for a field, or undefined when it has none or it is not in the evidence. */
export function answerOf<V>(
  field: AiField<V>,
  answer: Record<string, unknown> | null | undefined,
  evidence: string,
): { value: V | undefined; invented: boolean } {
  if (!answer) return { value: undefined, invented: false };
  const v = field.fromAnswer(answer);
  if (v === undefined || v === null) return { value: undefined, invented: false };
  if (field.strings && !inEvidence(field.strings(v), evidence))
    return { value: undefined, invented: true };
  return { value: v, invented: false };
}

function same<V>(field: AiField<V>, a: V | null | undefined, b: V | null | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === b;
  return field.same(a, b);
}

/** The best guess of a flagged field: the second model's answer, else the rules', else unknown. */
function guess<V>(
  secondary: V | undefined,
  rules: RulesValue<V>,
  reason: string,
): FieldDecision<V> {
  if (secondary !== undefined)
    return { value: secondary, source: 'secondary_guess', flagged: true, reason };
  if (rules.value !== null)
    return { value: rules.value, source: 'rules_guess', flagged: true, reason };
  return { value: null, source: 'unknown', flagged: true, reason };
}

/** Setup E for one field. `primary`/`secondary` are the models' answers (undefined = none). */
export function combineE<V>(
  field: AiField<V>,
  rules: RulesValue<V>,
  primary: V | undefined,
  secondary: V | undefined,
): FieldDecision<V> {
  const agree = same(field, primary, secondary);
  if (rules.final && rules.value !== null)
    return { value: rules.value, source: 'rules', flagged: false, reason: null };
  if (rules.auto && rules.value !== null) {
    if (agree && !same(field, primary, rules.value))
      return guess(secondary, rules, 'Both models disagree with the rules');
    return { value: rules.value, source: 'rules', flagged: false, reason: null };
  }
  if (agree) return { value: primary as V, source: 'both_models', flagged: false, reason: null };
  const why =
    primary === undefined && secondary === undefined
      ? 'Neither model answered'
      : primary === undefined || secondary === undefined
        ? 'Only one model answered'
        : 'The models disagree';
  return guess(secondary, rules, rules.reason ? `${rules.reason}; ${why.toLowerCase()}` : why);
}

export type UpgradeDesign = 'F' | 'J';

/**
 * An upgrade (F or J) for one field E decided or guessed: `cheap` = E's pair, `strong` = the
 * upgrade pair. Returns the new decision (source upgrade_models when the strong pair settles
 * it, otherwise the best guess: the strong pair's second model, else E's guess).
 */
export function combineUpgrade<V>(
  design: UpgradeDesign,
  field: AiField<V>,
  rules: RulesValue<V>,
  cheap: { primary: V | undefined; secondary: V | undefined },
  strong: { primary: V | undefined; secondary: V | undefined },
): FieldDecision<V> {
  const e = combineE(field, rules, cheap.primary, cheap.secondary);
  const strongAgree = same(field, strong.primary, strong.secondary);
  const strongGuess = (reason: string): FieldDecision<V> =>
    strong.secondary !== undefined
      ? { value: strong.secondary, source: 'secondary_guess', flagged: true, reason }
      : { ...e, flagged: true, reason };
  if (rules.auto && rules.value !== null) {
    if (!e.flagged) return e;
    // E's pair agreed against the rules.
    if (strongAgree && same(field, strong.primary, rules.value))
      return { value: rules.value, source: 'rules', flagged: false, reason: null };
    if (
      design === 'J' &&
      strongAgree &&
      same(field, strong.primary, cheap.primary) &&
      same(field, cheap.primary, cheap.secondary)
    )
      return { value: strong.primary as V, source: 'upgrade_models', flagged: false, reason: null };
    return strongGuess('The stronger models do not settle it');
  }
  // An open field.
  if (design === 'F' && !e.flagged) return e;
  if (strongAgree)
    return { value: strong.primary as V, source: 'upgrade_models', flagged: false, reason: null };
  return strongGuess('The stronger models disagree');
}
