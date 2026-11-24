/**
 * The summaries' own settings (book summaries session 3; their screen comes in session 4):
 * which models make a summary and in which fallback order, who translates, and the job limits.
 * The provider settings (keys, prices, modes, the monthly limit) are Settings > AI's (src/ai/).
 * One JSON value in summaries.db `summary_settings`, laid over the defaults.
 */
import type Database from 'better-sqlite3';

/** One setup: who finds the items (one or two models, each checks the other's), who writes. */
export interface RouteSetup {
  finders: string[];
  writer: string;
}

export interface SummarySettings {
  /**
   * The setups in the order they are tried (decided by the user from the accuracy test,
   * 2026-11-23): the mixed setup, then Sonnet + Sol written by Sonnet, then Opus alone. When
   * every one fails: no summary, a note on the book and one alert.
   */
  route: RouteSetup[];
  /** Who translates a summary (item by item). */
  translator: string;
  /**
   * A setup that can't send for this long (no key, key refused, model missing, provider busy or
   * down; never the spending limit, which only queues) counts as failed: the next one is tried.
   */
  fallbackAfterMinutes: number;
  /** Books summarized at the same time (a series' volumes always one after another). */
  parallelBooks: number;
  /**
   * The estimate's cost per 100,000 characters until the app has measured its own (3 summaries):
   * the accuracy test's measured $1.30 (mixed setup, effort high, Sol direct).
   */
  costPer100kChars: number;
  /**
   * The series recap ("story so far", session 5) is rebuilt once no volume summary of its
   * series changed for this long, so several edits make one rebuild (0: at once).
   */
  recapDelayMinutes: number;
}

export const SONNET = 'claude-sonnet-5-5';
export const SOL = 'gpt-6.1-sol';
export const OPUS = 'claude-opus-5-5';

export const DEFAULT_SUMMARY_SETTINGS: SummarySettings = {
  route: [
    { finders: [SONNET, SOL], writer: OPUS },
    { finders: [SONNET, SOL], writer: SONNET },
    { finders: [OPUS], writer: OPUS },
  ],
  translator: SONNET,
  fallbackAfterMinutes: 60,
  parallelBooks: 2,
  costPer100kChars: 1.3,
  recapDelayMinutes: 10,
};

export class SummarySettingsError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function num(name: string, v: unknown, min: number, max: number, integer = false): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new SummarySettingsError(`${name} must be a number from ${min} to ${max}`);
  if (integer && !Number.isInteger(v))
    throw new SummarySettingsError(`${name} must be a whole number`);
  return v;
}

function model(name: string, v: unknown, known: (m: string) => boolean): string {
  if (typeof v !== 'string' || !v.trim()) throw new SummarySettingsError(`${name}: a model id`);
  const id = v.trim();
  if (!known(id)) throw new SummarySettingsError(`${name}: ${id} is not in Settings > AI's list`);
  return id;
}

/**
 * The settings from a stored or sent value laid over `current`; `known` says which model ids
 * may be used (Settings > AI's list). Throws SummarySettingsError on a value that doesn't fit.
 */
export function validateSummarySettings(
  value: unknown,
  current: SummarySettings,
  known: (model: string) => boolean = () => true,
): SummarySettings {
  if (!isObj(value)) throw new SummarySettingsError('Summary settings must be an object');
  const extra = Object.keys(value).filter((k) => !(k in DEFAULT_SUMMARY_SETTINGS));
  if (extra.length) throw new SummarySettingsError(`Unknown summary setting: ${extra[0]}`);
  const v: Obj = { ...current, ...value };
  if (!Array.isArray(v.route) || v.route.length < 1 || v.route.length > 6)
    throw new SummarySettingsError('The route must list 1 to 6 setups');
  const route = (v.route as unknown[]).map((r, i) => {
    if (!isObj(r) || !Array.isArray(r.finders))
      throw new SummarySettingsError(`Setup ${i + 1}: finders and a writer`);
    const finders = (r.finders as unknown[]).map((f) => model(`Setup ${i + 1}`, f, known));
    if (finders.length < 1 || finders.length > 2 || new Set(finders).size !== finders.length)
      throw new SummarySettingsError(`Setup ${i + 1}: one or two different finders`);
    return { finders, writer: model(`Setup ${i + 1}`, r.writer, known) };
  });
  return {
    route,
    translator: model('Translator', v.translator, known),
    fallbackAfterMinutes: num(
      'Try the next setup after waiting (min)',
      v.fallbackAfterMinutes,
      1,
      1440,
      true,
    ),
    parallelBooks: num('Books at the same time', v.parallelBooks, 1, 10, true),
    costPer100kChars: num('Cost per 100,000 characters ($)', v.costPer100kChars, 0, 100),
    recapDelayMinutes: num(
      'Update the story so far after (min)',
      v.recapDelayMinutes,
      0,
      1440,
      true,
    ),
  };
}

const KEY = 'settings';

export function readSummarySettings(db: Database.Database): SummarySettings {
  const defaults = structuredClone(DEFAULT_SUMMARY_SETTINGS);
  const row = db.prepare('SELECT value_json FROM summary_settings WHERE key = ?').get(KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return defaults;
  try {
    return validateSummarySettings(JSON.parse(row.value_json), defaults);
  } catch {
    return defaults;
  }
}

export function updateSummarySettings(
  db: Database.Database,
  changes: unknown,
  known: (model: string) => boolean,
  now = Date.now(),
): SummarySettings {
  const next = validateSummarySettings(changes, readSummarySettings(db), known);
  db.prepare(
    `INSERT INTO summary_settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(next), now);
  return next;
}

/** Every model the settings use (Settings > AI keeps them from being deleted). */
export function modelsInUse(s: SummarySettings): string[] {
  return [...new Set([...s.route.flatMap((r) => [...r.finders, r.writer]), s.translator])];
}

/** "claude-opus-5-5" → "Claude Opus 5.5", "gpt-6.1-sol" → "GPT-6.1 Sol" (as the web's modelName). */
export function modelDisplayName(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(id);
  if (claude)
    return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  const gpt = /^gpt-([\d.]+)(?:-([a-z][a-z0-9-]*))?$/.exec(id);
  if (gpt) {
    const rest = (gpt[2] ?? '')
      .split('-')
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ');
    return `GPT-${gpt[1]}${rest ? ` ${rest}` : ''}`;
  }
  return id;
}

/** A setup's short name: the test's names for the decided setups, else the models. */
export function setupLabel(r: RouteSetup): string {
  const f = r.finders.join('+');
  if (f === `${SONNET}+${SOL}` && r.writer === OPUS) return 'mixed';
  if (f === `${SONNET}+${SOL}` && r.writer === SONNET) return 'two';
  if (f === OPUS && r.writer === OPUS) return 'opus';
  return `${f}>${r.writer}`;
}
