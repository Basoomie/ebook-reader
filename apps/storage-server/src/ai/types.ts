/**
 * The shared AI layer (book summaries session 1; first built for the cleanup as WP21d's
 * framework). Any feature that asks the models plugs in here: the Calibre cleanup, the
 * audiobook cleanup, later the book summaries. Nothing in this folder knows about a feature:
 * a feature describes how it asks with `AiStageSpec`, keeps its questions and answers in its
 * own database (the queue tables of runner.ts), and shares the providers, the keys, the
 * provider settings, the model checks and the one monthly spending limit (ttsu.db) with the
 * others.
 */

export type Provider = 'anthropic' | 'openai';

/**
 * How a stage of a feature asks the models. The prompt is the feature's own.
 * R: the stage's roles (each mapped to the feature's model-choice key in `tasks`).
 */
export interface AiStageSpec<E = unknown, R extends string = string> {
  /** The stage's key in the feature's queue: "audio5", "calibre4", ... */
  stage: string;
  /** Raised when the prompt or the schema changes: answers to other versions are not used. */
  promptVersion: string;
  /** The feature's model-choice key of each role (e.g. primary -> "audio5.primary"). */
  tasks: Record<R, string>;
  /** The system prompt (identical for every item, so the providers can cache it). */
  system: string;
  /** The item's evidence as the user message. */
  userText(evidence: E): string;
  /** The answer's JSON schema (structured outputs; every object closed, every key required). */
  schema: Record<string, unknown>;
  schemaName: string;
  /** Validates a parsed answer; null = unusable (counted as `invalid`). */
  parseAnswer(raw: unknown): Record<string, unknown> | null;
  /** The text the never-invent check searches (evidence-check.ts). */
  evidenceText(evidence: E): string;
  /**
   * What the stage does when the monthly spending limit leaves no room. pause (default): the
   * wait needs the user (the cleanup's stages pause and notify, as before). queue: its
   * questions wait in the queue until the next month or a higher limit, and one alert says so
   * (`ai_limit_waiting`).
   */
  onLimit?: 'pause' | 'queue';
  /**
   * Per-stage request options (book summaries session 2: whole-book requests need long answers
   * and long calls). Absent = the requests are exactly what they were before (the cleanup's).
   */
  request?: AiRequestOptions;
}

export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AiRequestOptions {
  /** Output tokens allowed (thinking included); replaces the settings' maxTokens, also for GPT. */
  maxTokens?: number;
  /** One call's time limit; replaces the settings' requestTimeoutSeconds. */
  timeoutSeconds?: number;
  /** The model's effort (Claude output_config.effort, GPT reasoning_effort). */
  effort?: AiEffort;
  /** Direct calls stream the answer (a long answer never sits on an idle connection). */
  stream?: boolean;
  /**
   * Output tokens one answer is expected to have before this stage has answers of its own; the
   * estimate then follows this stage's own answers (not the model's answers of every stage).
   */
  expectedOutputTokens?: number;
  /**
   * Always one direct call each, whatever the model's mode in Settings > AI (book summaries
   * session 4b: a book description is translated while the user waits). Absent = the mode.
   */
  direct?: boolean;
}

/** A model's stored answer for an item. */
export interface StoredAnswer {
  model: string;
  state: 'answered' | 'blocked' | 'invalid' | 'failed';
  answer: Record<string, unknown> | null;
}
