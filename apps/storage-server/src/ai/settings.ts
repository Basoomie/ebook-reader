/**
 * The provider settings (Settings > AI), shared by every AI feature: one JSON value in ttsu.db
 * ai_settings, laid over the defaults (a value added later starts at its default). Moved from
 * cleanup.db's `ai` group (WP21d) with the same defaults and checks; the limit is now monthly.
 * Which models a feature uses for what stays with the feature (the cleanup's `models`).
 */
import type Database from 'better-sqlite3';

/** A model's list price per million tokens (US$). */
export interface AiPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface AiSettings {
  /**
   * All AI spending of every feature together may reach this in a calendar month (US$; the
   * month starts on the 1st in the Notifications time zone). null = not set: nothing is asked.
   */
  spendLimitUsd: number | null;
  /**
   * Per model id: batch = its provider's Batch API (half price, answered when the provider runs
   * it); direct = one call each (full price, answered at once). A model not listed: batch.
   * Measured 2026-11-19: Anthropic answered a batch of 195 questions for claude-haiku-5-5 in 2 min;
   * OpenAI ran no batch for gpt-6-luna (six batches, none answered in 15-75 min, on both of its
   * endpoints) while a gpt-6.1-sol batch finished in 80 s and Luna answers one call in ~7 s.
   */
  modes: Record<string, 'batch' | 'direct'>;
  /**
   * A batch with nothing answered after this many minutes is cancelled (answers it has are kept)
   * and its questions are sent directly. 0 = wait for the provider (up to its 24 h).
   */
  batchStallMinutes: number;
  /**
   * How long one address may take to connect before the next is tried (ms). Node's default,
   * 250, failed every call from the live server on 2026-11-19: the NAS's DNS answers with IPv6
   * addresses it has no route to, so the IPv4 attempt was cut off after 250 ms (the busy
   * server took longer) and the IPv6 one failed at once. Process-wide while the AI is used.
   */
  connectAttemptMs: number;
  /** Time left before a stage has a batch back: the expected batch turnaround (minutes). */
  batchTurnaroundMinutes: number;
  /** Direct mode: calls at the same time per model. */
  directWorkers: number;
  /** Batch mode: requests per batch. */
  batchSize: number;
  /** Batch mode: how often a batch at the provider is checked (s). */
  batchPollSeconds: number;
  /** Claude: max_tokens, which includes the adaptive thinking (leave room). */
  maxTokens: number;
  /** Direct mode: time limit for one call (s). */
  requestTimeoutSeconds: number;
  /** Busy (429), server errors and network errors are tried this many times in all. */
  attempts: number;
  /** The Batch APIs' price as a share of the list price. */
  batchPriceFactor: number;
  /** List prices per model id (models not listed are refused: their cost can't be counted). */
  prices: Record<string, AiPrice>;
  /** Ask for the answer in the stage's JSON schema (the providers' structured outputs). */
  structuredOutputs: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  spendLimitUsd: null,
  modes: { 'gpt-6-luna': 'direct' },
  batchStallMinutes: 30,
  connectAttemptMs: 5000,
  batchTurnaroundMinutes: 3,
  directWorkers: 3,
  batchSize: 500,
  batchPollSeconds: 60,
  maxTokens: 16000,
  requestTimeoutSeconds: 180,
  attempts: 4,
  batchPriceFactor: 0.5,
  // The bake-off's measured list prices (reference-sample.md, 2026-11-12).
  prices: {
    'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    'gpt-6-luna': { inputPerMTok: 0.1, outputPerMTok: 0.5 },
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'gpt-6.1-sol': { inputPerMTok: 2, outputPerMTok: 10 },
  },
  structuredOutputs: true,
};

/** The keys of the provider settings (what the one-time move carries over). */
export const AI_SETTING_KEYS = Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[];

export class AiSettingsError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(name: string, value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AiSettingsError(`${name} must be a number from ${min} to ${max}`);
  }
  if (integer && !Number.isInteger(value))
    throw new AiSettingsError(`${name} must be a whole number`);
  return value;
}

function modelId(value: string): string {
  const id = value.trim();
  if (id.length > 100) throw new AiSettingsError('Model id must be at most 100 characters');
  return id;
}

/**
 * The provider settings from a stored or sent value laid over `current` (keys not given keep
 * their current value). Throws AiSettingsError on a value that does not fit.
 */
export function validateAiSettings(value: unknown, current: AiSettings): AiSettings {
  if (!isObj(value)) throw new AiSettingsError('AI settings must be an object');
  const unknown = Object.keys(value).filter((k) => !(k in DEFAULT_AI_SETTINGS));
  if (unknown.length) throw new AiSettingsError(`Unknown AI setting: ${unknown[0]}`);
  const v: Obj = { ...current, ...value };
  if (!isObj(v.modes)) throw new AiSettingsError('AI: modes must be an object');
  if (Object.keys(v.modes).length > 30) throw new AiSettingsError('AI: at most 30 model modes');
  const modes: Record<string, 'batch' | 'direct'> = {};
  for (const [model, m] of Object.entries(v.modes)) {
    const id = modelId(model);
    if (m !== 'batch' && m !== 'direct')
      throw new AiSettingsError(`AI: ${id} must be batch or direct`);
    if (id) modes[id] = m;
  }
  if (!isObj(v.prices)) throw new AiSettingsError('AI: prices must be an object');
  const entries = Object.entries(v.prices);
  if (entries.length > 30) throw new AiSettingsError('AI: at most 30 prices');
  const prices: Record<string, AiPrice> = {};
  for (const [model, p] of entries) {
    const id = modelId(model);
    if (!id) continue;
    if (!isObj(p)) throw new AiSettingsError(`AI: the price of ${id} must be an object`);
    prices[id] = {
      inputPerMTok: num(`${id}: input price ($ per million tokens)`, p.inputPerMTok, 0, 1000),
      outputPerMTok: num(`${id}: output price ($ per million tokens)`, p.outputPerMTok, 0, 1000),
    };
  }
  return {
    spendLimitUsd:
      v.spendLimitUsd === null || (v.spendLimitUsd as unknown) === ''
        ? null
        : num('Monthly spending limit ($)', v.spendLimitUsd, 0, 10000),
    modes,
    batchStallMinutes: num(
      'Cancel a batch with no answers after (min; 0 = never)',
      v.batchStallMinutes,
      0,
      1440,
      true,
    ),
    connectAttemptMs: num(
      'Wait for each address when connecting (ms)',
      v.connectAttemptMs ?? 5000,
      250,
      60000,
      true,
    ),
    batchTurnaroundMinutes: num(
      'Expected batch time before one is measured (min)',
      v.batchTurnaroundMinutes ?? 3,
      0.1,
      1440,
    ),
    directWorkers: num('Calls at the same time', v.directWorkers, 1, 100, true),
    batchSize: num('Requests per batch', v.batchSize, 1, 10000, true),
    batchPollSeconds: num('Batch check every (s)', v.batchPollSeconds, 5, 3600, true),
    maxTokens: num('Claude max_tokens (thinking included)', v.maxTokens, 1000, 64000, true),
    requestTimeoutSeconds: num('Time limit per call (s)', v.requestTimeoutSeconds, 10, 900, true),
    attempts: num('Tries per call', v.attempts, 1, 10, true),
    batchPriceFactor: num('Batch price (share of the list price)', v.batchPriceFactor, 0, 1),
    prices,
    structuredOutputs: v.structuredOutputs === true,
  };
}

const KEY = 'settings';

/** The stored value laid over the defaults; a value that no longer fits: the defaults. */
export function readAiSettings(db: Database.Database): AiSettings {
  const row = db.prepare('SELECT value_json FROM ai_settings WHERE key = ?').get(KEY) as
    | { value_json: string }
    | undefined;
  const defaults = structuredClone(DEFAULT_AI_SETTINGS);
  if (!row) return defaults;
  try {
    return validateAiSettings(JSON.parse(row.value_json), defaults);
  } catch {
    return defaults;
  }
}

/** True once anything was saved (the one-time move never overwrites it). */
export function aiSettingsSaved(db: Database.Database): boolean {
  return !!db.prepare('SELECT 1 FROM ai_settings WHERE key = ?').get(KEY);
}

/** Saves the given keys (checked against the current values). Returns the new settings. */
export function updateAiSettings(
  db: Database.Database,
  changes: unknown,
  now = Date.now(),
): AiSettings {
  const next = validateAiSettings(changes, readAiSettings(db));
  db.prepare(
    `INSERT INTO ai_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(next), now);
  return next;
}
