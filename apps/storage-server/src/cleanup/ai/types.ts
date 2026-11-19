/**
 * The cleanup's AI framework (WP21d; decided design: library-cleanup-plan.md section 6, "AI
 * setup (decided 2026-11-12)"). Shared by every stage that asks the models: the audiobook
 * stage 5 now, the Calibre stage 4 (WP20e) later. Nothing in this folder knows about
 * audiobooks or Calibre: a stage plugs in through `AiStageSpec` and `AiField`.
 *
 * The models judge candidates and parse unclear values from the evidence; they never invent
 * values (a model's string that is not in the evidence is dropped).
 */

export type Provider = 'anthropic' | 'openai';

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

/**
 * How a stage asks the models. The prompt is the stage's: shared rule text from
 * `prompt-blocks.ts` plus its own rules (Calibre's bonus N.1 and omnibus rules belong in
 * WP20e's block, not in the audiobook prompt).
 */
export interface AiStageSpec<E = unknown> {
  /** cleanup.db key of the stage: "audio5", "calibre4", ... */
  stage: string;
  /** Raised when the prompt or the schema changes: answers to other versions are not used. */
  promptVersion: string;
  /** settings.models keys of each role (e.g. primary -> "audio5.primary"). */
  tasks: Record<Role, string>;
  /** The system prompt (identical for every item, so the providers can cache it). */
  system: string;
  /** The item's evidence as the user message. Labels are never in it. */
  userText(evidence: E): string;
  /** The answer's JSON schema (structured outputs; every object closed, every key required). */
  schema: Record<string, unknown>;
  schemaName: string;
  /** Validates a parsed answer; null = unusable (counted as `invalid`). */
  parseAnswer(raw: unknown): Record<string, unknown> | null;
  /** The text the never-invent check searches (names, tags, records, ...). */
  evidenceText(evidence: E): string;
}

/** A model's stored answer for an item. */
export interface StoredAnswer {
  model: string;
  state: 'answered' | 'blocked' | 'invalid' | 'failed';
  answer: Record<string, unknown> | null;
}
