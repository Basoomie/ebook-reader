/**
 * Store ratings' server settings (2026-11-25; Settings › Library › Book page › Ratings). One JSON
 * value in ttsu.db `store_rating_settings`, laid over the defaults (as natively/settings.ts).
 */
import type Database from 'better-sqlite3';

export interface RatingSettings {
  /**
   * Fetching through the cleanup's fetch container. Off after deploy: the first fill reads only
   * the cleanup's cached pages; requests start on the user's word.
   */
  refresh: boolean;
  /** Read again after this many days: books published in the last 6 months. */
  newDays: number;
  /** … published in the last 2 years. */
  recentDays: number;
  /** … older (or no date). */
  oldDays: number;
  /** A book page whose rating is older than this asks again on open (needs `refresh`). */
  openMaxAgeDays: number;
  /** The Rating sort's pull: a book starts with this many imagined ratings at the median. */
  scoreRatings: number;
  /** Requests waiting in the fetch queue at once, per site (the queue paces them). */
  queuedPerSite: number;
  /**
   * A book new to the reader waits this many hours before its first rating is fetched: the
   * cleanup's stage 4 (new arrivals) fetches the same store pages, and the first fill reads the
   * rating from its saved copy. Also held while stage 4's own request for the page is open.
   */
  newBookWaitHours: number;
}

export const DEFAULT_RATING_SETTINGS: RatingSettings = {
  refresh: false,
  newDays: 7,
  recentDays: 30,
  oldDays: 90,
  openMaxAgeDays: 30,
  scoreRatings: 20,
  queuedPerSite: 20,
  newBookWaitHours: 48,
};

export class RatingSettingsError extends Error {}

const NUMBERS: Partial<Record<keyof RatingSettings, [number, number]>> = {
  newDays: [1, 365],
  recentDays: [1, 730],
  oldDays: [1, 1825],
  openMaxAgeDays: [1, 3650],
  scoreRatings: [0, 1000],
  queuedPerSite: [1, 500],
  newBookWaitHours: [0, 720],
};
const FLAGS: (keyof RatingSettings)[] = ['refresh'];
/**
 * Settings that no longer exist, accepted and dropped: `bookmeter` (読書メーター had its own switch
 * until its link fix was deployed; since 2026-11-25 it is fetched with the other stores).
 */
const RETIRED = new Set(['bookmeter']);

export function readRatingSettings(db: Database.Database): RatingSettings {
  const row = db.prepare('SELECT json FROM store_rating_settings WHERE id = 1').get() as
    | { json: string }
    | undefined;
  let stored: Record<string, unknown> = {};
  try {
    stored = row ? (JSON.parse(row.json) as Record<string, unknown>) : {};
  } catch {
    stored = {};
  }
  const out: RatingSettings = { ...DEFAULT_RATING_SETTINGS };
  for (const [key, [min, max]] of Object.entries(NUMBERS) as [
    keyof RatingSettings,
    [number, number],
  ][]) {
    const v = stored[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) {
      (out as unknown as Record<string, unknown>)[key] = v;
    }
  }
  for (const key of FLAGS) {
    if (typeof stored[key] === 'boolean')
      (out as unknown as Record<string, unknown>)[key] = stored[key];
  }
  return out;
}

/** Saves the given fields (others kept); throws RatingSettingsError on a bad value. */
export function saveRatingSettings(
  db: Database.Database,
  patch: Record<string, unknown>,
): RatingSettings {
  const next = readRatingSettings(db) as unknown as Record<string, unknown>;
  for (const [key, v] of Object.entries(patch)) {
    if (RETIRED.has(key)) continue;
    if (FLAGS.includes(key as keyof RatingSettings)) {
      if (typeof v !== 'boolean') throw new RatingSettingsError(`${key} must be true or false`);
      next[key] = v;
      continue;
    }
    const range = NUMBERS[key as keyof RatingSettings];
    if (!range) throw new RatingSettingsError(`Unknown setting: ${key}`);
    const [min, max] = range;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new RatingSettingsError(`${key} must be a number from ${min} to ${max}`);
    }
    next[key] = v;
  }
  db.prepare(
    `INSERT INTO store_rating_settings (id, json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  ).run(JSON.stringify(next));
  return next as unknown as RatingSettings;
}
