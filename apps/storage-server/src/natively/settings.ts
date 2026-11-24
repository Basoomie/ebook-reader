/**
 * The Natively level's settings (2026-11-24; Settings › Library › Book page): how old a level may
 * get before the book page reads it again, and the fetcher's pace. One JSON value in ttsu.db
 * `natively_settings`, laid over the defaults (as summaries/settings.ts).
 */
import type Database from 'better-sqlite3';

export interface NativelySettings {
  /** A level older than this is read again when its book page opens. */
  maxAgeDays: number;
  /** At least this long between two requests to Natively (one request at a time). */
  requestSeconds: number;
  /** A refused or failed request waits twice as long each time, up to this. */
  maxBackoffMinutes: number;
}

export const DEFAULT_NATIVELY_SETTINGS: NativelySettings = {
  maxAgeDays: 7,
  requestSeconds: 5,
  maxBackoffMinutes: 60,
};

export class NativelySettingsError extends Error {}

const LIMITS: Record<keyof NativelySettings, [number, number]> = {
  maxAgeDays: [1, 365],
  requestSeconds: [1, 600],
  maxBackoffMinutes: [1, 1440],
};

export function readNativelySettings(db: Database.Database): NativelySettings {
  const row = db.prepare('SELECT json FROM natively_settings WHERE id = 1').get() as
    | { json: string }
    | undefined;
  let stored: Record<string, unknown> = {};
  try {
    stored = row ? (JSON.parse(row.json) as Record<string, unknown>) : {};
  } catch {
    stored = {};
  }
  const out = { ...DEFAULT_NATIVELY_SETTINGS };
  for (const key of Object.keys(LIMITS) as (keyof NativelySettings)[]) {
    const v = stored[key];
    const [min, max] = LIMITS[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) out[key] = v;
  }
  return out;
}

/** Saves the given fields (others kept); throws NativelySettingsError on a bad value. */
export function saveNativelySettings(
  db: Database.Database,
  patch: Record<string, unknown>,
): NativelySettings {
  const next = readNativelySettings(db);
  for (const [key, v] of Object.entries(patch)) {
    if (!(key in LIMITS)) throw new NativelySettingsError(`Unknown setting: ${key}`);
    const [min, max] = LIMITS[key as keyof NativelySettings];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new NativelySettingsError(`${key} must be a number from ${min} to ${max}`);
    }
    next[key as keyof NativelySettings] = v;
  }
  db.prepare(
    `INSERT INTO natively_settings (id, json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  ).run(JSON.stringify(next));
  return next;
}
