/**
 * The provider settings (Settings > AI), shared by every AI feature: one JSON value in ttsu.db
 * ai_settings, laid over the defaults (a value added later starts at its default). Moved from
 * cleanup.db's `ai` group (WP21d) with the same defaults and checks; the limit is now monthly.
 * Which models a feature uses for what stays with the feature (the cleanup's `models`).
 */
import type Database from 'better-sqlite3';
import { DEFAULT_MODELS, isBuiltIn } from './prices';

/** A price tier per million tokens (US$). */
export interface AiPriceTier {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cached input read back (default: a tenth of the input price). */
  cacheReadPerMTok?: number;
}

/**
 * A model's list price (prices.ts): its tier for ordinary prompts, and a higher one for prompts
 * over `longAboveTokens` (Haiku 5.5 above 100K, OpenAI's above 272K input tokens).
 */
export interface AiPrice extends AiPriceTier {
  longAboveTokens?: number;
  long?: AiPriceTier;
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
   * The models listed in Settings > AI, the ones a feature can choose (in this order). Added
   * there from the providers' own model lists (checked: offered to the key, a known price, one
   * test request answered); any can be deleted unless a feature's task uses it.
   */
  models: string[];
  /**
   * A batch with nothing answered after this many minutes is cancelled (answers it has are kept)
   * and its questions are sent directly. 0 = wait for the provider (up to its 24 h).
   */
  batchStallMinutes: number;
  /**
   * After a batch the provider refused as a whole (its status "failed"), that model sends no
   * batch for this many minutes, doubled with each failure in a row up to batchFailMaxWaitMinutes
   * (2026-11-22: 926 gpt-6-luna batches failed in 31 minutes, a new one sent within seconds of
   * each).
   */
  batchFailWaitMinutes: number;
  /** The longest wait between batches while they fail (and the paused model's try interval). */
  batchFailMaxWaitMinutes: number;
  /** After this many failed batches in a row, the model's batches are paused (with an alert). */
  batchFailPauseAfter: number;
  /**
   * While a model's batches are paused: wait (try one batch now and then), or ask its questions
   * one call each (full price) for the rest of the run. The model's mode is not changed.
   */
  batchFailFallback: 'wait' | 'direct';
  /**
   * The most estimated prompt tokens one model may have in batches at its provider (0 = no
   * cap), unless batchQueueTokens names the model. The provider's own limit (OpenAI's enqueued
   * tokens per model, on the account's Limits page) is the user's to look up.
   */
  batchQueueTokensDefault: number;
  /** Per model id: its own cap on tokens in batches at the provider (0 = no cap). */
  batchQueueTokens: Record<string, number>;
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
  /**
   * Models added in Settings before the prices were built in (prices.ts), with the price typed
   * then. Kept only until deleted in Settings > AI; nothing adds to it any more, and a built-in
   * model's price always comes from prices.ts.
   */
  prices: Record<string, AiPrice>;
  /** Ask for the answer in the stage's JSON schema (the providers' structured outputs). */
  structuredOutputs: boolean;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  spendLimitUsd: null,
  modes: { 'gpt-6-luna': 'direct' },
  models: [...DEFAULT_MODELS],
  batchStallMinutes: 30,
  batchFailWaitMinutes: 5,
  batchFailMaxWaitMinutes: 60,
  batchFailPauseAfter: 3,
  batchFailFallback: 'wait',
  batchQueueTokensDefault: 2_000_000,
  batchQueueTokens: {},
  connectAttemptMs: 5000,
  batchTurnaroundMinutes: 3,
  directWorkers: 3,
  batchSize: 500,
  batchPollSeconds: 60,
  maxTokens: 16000,
  requestTimeoutSeconds: 180,
  attempts: 4,
  batchPriceFactor: 0.5,
  // The known models' prices are built in (prices.ts).
  prices: {},
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
  if (!Array.isArray(v.models) || v.models.length > 60)
    throw new AiSettingsError('AI: models must be a list of at most 60 model ids');
  const models: string[] = [];
  for (const m of v.models) {
    if (typeof m !== 'string') throw new AiSettingsError('AI: a model id must be text');
    const id = modelId(m);
    if (id && !models.includes(id)) models.push(id);
  }
  const queueRaw = v.batchQueueTokens ?? {};
  if (!isObj(queueRaw)) throw new AiSettingsError('AI: batchQueueTokens must be an object');
  if (Object.keys(queueRaw).length > 30)
    throw new AiSettingsError('AI: at most 30 batch queue caps');
  const batchQueueTokens: Record<string, number> = {};
  for (const [model, n] of Object.entries(queueRaw)) {
    const id = modelId(model);
    if (id)
      batchQueueTokens[id] = num(`${id}: most tokens in batches at the provider`, n, 0, 1e9, true);
  }
  const fallback = v.batchFailFallback ?? 'wait';
  if (fallback !== 'wait' && fallback !== 'direct')
    throw new AiSettingsError('AI: batchFailFallback must be wait or direct');
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
    models,
    batchStallMinutes: num(
      'Cancel a batch with no answers after (min; 0 = never)',
      v.batchStallMinutes,
      0,
      1440,
      true,
    ),
    batchFailWaitMinutes: num(
      'Wait after a failed batch (min)',
      v.batchFailWaitMinutes ?? 5,
      1,
      1440,
      true,
    ),
    batchFailMaxWaitMinutes: num(
      'Longest wait between failing batches (min)',
      v.batchFailMaxWaitMinutes ?? 60,
      1,
      1440,
      true,
    ),
    batchFailPauseAfter: num(
      'Pause batches after this many failures in a row',
      v.batchFailPauseAfter ?? 3,
      1,
      100,
      true,
    ),
    batchFailFallback: fallback,
    batchQueueTokensDefault: num(
      'Most tokens in batches at the provider, per model (0 = no cap)',
      v.batchQueueTokensDefault ?? 2_000_000,
      0,
      1e9,
      true,
    ),
    batchQueueTokens,
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

/**
 * The list of settings saved before the model list existed: the default models, then any model
 * typed in Settings before the prices were built in (kept until deleted there).
 */
export function listBeforeModels(prices: unknown): string[] {
  const typed = Object.keys(isObj(prices) ? prices : {}).filter(
    (m) => !isBuiltIn(m) && !DEFAULT_MODELS.includes(m),
  );
  return [...DEFAULT_MODELS, ...typed];
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
    const raw = JSON.parse(row.value_json) as Obj;
    // Saved before the model list existed: the default models, then any model typed in Settings
    // before the prices were built in (kept until deleted there).
    if (isObj(raw) && !Array.isArray(raw.models)) raw.models = listBeforeModels(raw.prices);
    return validateAiSettings(raw, defaults);
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
