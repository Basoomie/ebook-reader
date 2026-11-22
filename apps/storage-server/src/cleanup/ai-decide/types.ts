/**
 * The cleanup's AI decisions (WP21d; decided design: library-cleanup-plan.md section 6, "AI
 * setup (decided 2026-11-12)"): the rules' values weighed against two models per field
 * (setup E and its upgrades F/J, combine.ts), and every value's source (values.ts). The
 * questions themselves go through the shared AI layer (src/ai/).
 *
 * The models judge candidates and parse unclear values from the evidence; they never invent
 * values (a model's string that is not in the evidence is dropped).
 */
import type { AiStageSpec } from '../../ai/types';

/**
 * The models of a setup. E: primary (Claude Haiku 5.5) and secondary (GPT-6 Luna) read every
 * item. F/J (upgrades): upgradePrimary and upgradeSecondary (Sonnet 5.5, GPT-6.1 Sol) read the
 * fields E's models decided or guessed.
 */
export type Role = 'primary' | 'secondary' | 'upgradePrimary' | 'upgradeSecondary';
export const ROLES: readonly Role[] = [
  'primary',
  'secondary',
  'upgradePrimary',
  'upgradeSecondary',
];

/** A cleanup stage's spec: its roles are setup E's and the upgrades'. */
export type CleanupAiSpec<E = unknown> = AiStageSpec<E, Role>;

/**
 * Where a value came from (cleanup.db ai_values.source):
 *   rules            the rules' value (automatic, not contradicted by both models)
 *   both_models      an open field both models answered the same
 *   secondary_guess  flagged: the second model's answer (Luna's in E), marked unconfirmed
 *   rules_guess      flagged: the rules' value (no second-model answer), marked unconfirmed
 *   unknown          flagged: nobody knows ("unknown", never "none")
 *   user             the user's value: never replaced by a later pass
 *   upgrade_models   decided by the stronger pair of an upgrade (F/J)
 */
export type ValueSource =
  | 'rules'
  | 'both_models'
  | 'secondary_guess'
  | 'rules_guess'
  | 'unknown'
  | 'user'
  | 'upgrade_models';

/** Sources a later pass may replace (it never replaces `user`, nor its own `rules`). */
export const MODEL_SOURCES: readonly ValueSource[] = [
  'both_models',
  'secondary_guess',
  'rules_guess',
  'unknown',
  'upgrade_models',
];

/** A field's value from the rules. value null = unknown. */
export interface RulesValue<V> {
  value: V | null;
  /** True: the rules are sure (automatic unless both models agree against it). */
  auto: boolean;
  /** Why the rules are not sure (shown with a flagged field). */
  reason?: string | null;
  /**
   * True: the value is the store's own structured data, which the models only see as well; it
   * stands even when both models answer otherwise (never flagged, never upgraded). Implies auto.
   */
  final?: boolean;
}

/** One field as a stage defines it. */
export interface AiField<V = unknown> {
  name: string;
  /**
   * This field's value in a model's (already validated) answer; undefined = no answer for it.
   * A model answering "can't tell" (null) is no answer: agreement needs real values.
   */
  fromAnswer(answer: Record<string, unknown>): V | undefined;
  /** The stage's comparison (titles ignoring spaces, names as sets, ...). */
  same(a: V, b: V): boolean;
  /**
   * The strings of a value that must appear in the item's evidence (never invent). Return only
   * what the evidence must contain (e.g. a series name without a suffix the rules add).
   */
  strings?(v: V): string[];
}

/** A field's decision. */
export interface FieldDecision<V = unknown> {
  /** null = unknown. */
  value: V | null;
  source: ValueSource;
  flagged: boolean;
  reason: string | null;
}
