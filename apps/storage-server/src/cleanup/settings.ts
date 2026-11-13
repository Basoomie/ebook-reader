/**
 * The cleanup's settings (edited on /cleanup, stored in cleanup.db). Every behavior
 * threshold is a setting (CLAUDE.md); defaults are here. Bad values are refused with a
 * message, never silently clamped.
 */
import type Database from 'better-sqlite3';

export interface PacingSettings {
  /** Stage 1 hashing speed limit (MB/s); 0 = no limit. */
  hashMbPerSecond: number;
  /** Pause between two items in the sidecar (seconds). */
  itemDelaySeconds: number;
  /** Changes per batch (at most 500, decided). */
  batchSize: number;
  /** Removals per batch as a share of the library's present books (%), far under the
   * reader's 20 % mass-missing guard. */
  maxBatchPercent: number;
}

export interface BackupRecord {
  path: string;
  /** When the backup was verified (free text date, e.g. 2026-11-12). */
  verifiedOn: string;
  /** Set when the user ticked "the full library backup is done". */
  confirmedAt: number | null;
}

export interface CleanupSettings {
  /** The content server, e.g. http://192.168.1.5:8083 (the sidecar adds #<library id>). */
  contentServerUrl: string;
  calibreLibraryId: string;
  calibreUsername: string;
  /** The reader library (id) the cleanup works on; null = not chosen. */
  targetLibraryId: string | null;
  /** Model per task (stored only in WP20a; used from WP20e). */
  models: Record<string, string>;
  pacing: PacingSettings;
  /** The user's own Calibre tags (a trailing * matches any ending). */
  customTags: string[];
  /** A stage stops applying when its measured precision is below this (%). */
  gateThresholdPercent: number;
  /** A stage pauses when its share of review results is above this (%). */
  reviewAlarmPercent: number;
  /**
   * Stage 1 pauses (instead of skipping copies one by one) when more than this share of the
   * next batch's copies changed in Calibre since the analysis (%).
   */
  libraryChangedPausePercent: number;
  backup: BackupRecord;
}

export const MODEL_TASKS = [
  'stage4.primary',
  'stage4.secondary',
  'stage4.upgradePrimary',
  'stage4.upgradeSecondary',
  'stage5.primary',
  'stage5.secondary',
] as const;

export const DEFAULT_SETTINGS: CleanupSettings = {
  contentServerUrl: '',
  calibreLibraryId: '',
  calibreUsername: '',
  targetLibraryId: null,
  models: {
    'stage4.primary': 'claude-haiku-5-5',
    'stage4.secondary': 'gpt-6-luna',
    'stage4.upgradePrimary': 'claude-sonnet-5-5',
    'stage4.upgradeSecondary': 'gpt-6.1-sol',
    'stage5.primary': 'claude-haiku-5-5',
    'stage5.secondary': 'gpt-6-luna',
  },
  pacing: { hashMbPerSecond: 40, itemDelaySeconds: 2, batchSize: 200, maxBatchPercent: 2 },
  customTags: ['PeepoHappyBooks', 'alpindale', 'TMW-collection-*'],
  gateThresholdPercent: 95,
  reviewAlarmPercent: 5,
  libraryChangedPausePercent: 5,
  backup: {
    path: '/mnt/user/data/backups/japanese-library-2026-11-11/',
    verifiedOn: '2026-11-12',
    confirmedAt: null,
  },
};

export const MAX_BATCH_SIZE = 500;
export const MAX_BATCH_PERCENT = 10;

export class SettingsError extends Error {}

type Key = keyof CleanupSettings;

function readRaw(db: Database.Database): Map<string, unknown> {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as {
    key: string;
    value_json: string;
  }[];
  return new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
}

export function getSettings(db: Database.Database): CleanupSettings {
  const raw = readRaw(db);
  const s: CleanupSettings = structuredClone(DEFAULT_SETTINGS);
  for (const key of Object.keys(DEFAULT_SETTINGS) as Key[]) {
    if (!raw.has(key)) continue;
    const value = raw.get(key);
    try {
      (s as unknown as Record<string, unknown>)[key] = validate(key, value, s);
    } catch {
      // A stored value that no longer validates falls back to the default.
    }
  }
  return s;
}

function num(name: string, value: unknown, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new SettingsError(`${name} must be a number from ${min} to ${max}`);
  }
  if (integer && !Number.isInteger(value))
    throw new SettingsError(`${name} must be a whole number`);
  return value;
}

function text(name: string, value: unknown, max = 500): string {
  if (typeof value !== 'string' || value.length > max) {
    throw new SettingsError(`${name} must be text of at most ${max} characters`);
  }
  return value.trim();
}

function validate(key: Key, value: unknown, current: CleanupSettings): unknown {
  switch (key) {
    case 'contentServerUrl': {
      const v = text('Content server address', value);
      if (v === '') return v;
      let url: URL;
      try {
        url = new URL(v);
      } catch {
        throw new SettingsError('Content server address must look like http://192.168.1.5:8083');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new SettingsError('Content server address must start with http:// or https://');
      }
      if (url.hash || url.search || url.username || url.password) {
        throw new SettingsError(
          'Content server address: no #library id, query or login in the address (they have their own fields)',
        );
      }
      return url.toString().replace(/\/$/, '');
    }
    case 'calibreLibraryId': {
      const v = text('Calibre library id', value, 200);
      if (/[#/\s]/.test(v))
        throw new SettingsError('Calibre library id must not contain #, / or spaces');
      return v;
    }
    case 'calibreUsername':
      return text('Calibre user name', value, 200);
    case 'targetLibraryId':
      if (value === null) return null;
      return text('Library', value, 100);
    case 'models': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new SettingsError('Models must be an object');
      }
      const out: Record<string, string> = { ...current.models };
      for (const [task, model] of Object.entries(value as Record<string, unknown>)) {
        if (!(MODEL_TASKS as readonly string[]).includes(task)) {
          throw new SettingsError(`Unknown model task: ${task}`);
        }
        out[task] = text(`Model for ${task}`, model, 100);
      }
      return out;
    }
    case 'pacing': {
      if (typeof value !== 'object' || value === null)
        throw new SettingsError('Pacing must be an object');
      const v = { ...current.pacing, ...(value as Partial<PacingSettings>) };
      return {
        hashMbPerSecond: num('Hashing speed (MB/s)', v.hashMbPerSecond, 0, 2000),
        itemDelaySeconds: num('Pause between items (s)', v.itemDelaySeconds, 0, 600),
        batchSize: num('Batch size', v.batchSize, 1, MAX_BATCH_SIZE, true),
        maxBatchPercent: num(
          'Largest batch (% of the library)',
          v.maxBatchPercent,
          0.1,
          MAX_BATCH_PERCENT,
        ),
      };
    }
    case 'customTags': {
      if (!Array.isArray(value) || value.length > 100) {
        throw new SettingsError('Custom tags must be a list of at most 100 tags');
      }
      const tags = value.map((t) => text('Custom tag', t, 200)).filter((t) => t !== '');
      return [...new Set(tags)];
    }
    case 'gateThresholdPercent':
      return num('Gate threshold (%)', value, 50, 100);
    case 'reviewAlarmPercent':
      return num('Review alarm (%)', value, 0, 100);
    case 'libraryChangedPausePercent':
      return num('Pause when copies changed in Calibre (%)', value, 0, 100);
    case 'backup': {
      if (typeof value !== 'object' || value === null)
        throw new SettingsError('Backup must be an object');
      const v = { ...current.backup, ...(value as Partial<BackupRecord>) };
      const confirmedAt = v.confirmedAt;
      if (
        confirmedAt !== null &&
        (typeof confirmedAt !== 'number' || !Number.isFinite(confirmedAt))
      ) {
        throw new SettingsError('Backup confirmation must be a time or null');
      }
      return {
        path: text('Backup folder', v.path),
        verifiedOn: text('Backup verified on', v.verifiedOn, 50),
        confirmedAt,
      };
    }
  }
}

/** Saves the given keys (each validated against the current values). Returns the new settings. */
export function updateSettings(
  db: Database.Database,
  changes: Record<string, unknown>,
  now = Date.now(),
): CleanupSettings {
  const current = getSettings(db);
  const next: Partial<Record<Key, unknown>> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in DEFAULT_SETTINGS)) throw new SettingsError(`Unknown setting: ${key}`);
    next[key as Key] = validate(key as Key, value, current);
  }
  const put = db.prepare(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(next)) put.run(key, JSON.stringify(value), now);
  })();
  return getSettings(db);
}

/**
 * Matches a tag against the user's custom-tag patterns (a trailing * = any ending).
 * Case-insensitive, like Calibre's tag names.
 */
export function isCustomTag(tag: string, patterns: string[]): boolean {
  const t = tag.toLowerCase();
  return patterns.some((raw) => {
    const p = raw.toLowerCase();
    return p.endsWith('*') ? t.startsWith(p.slice(0, -1)) : t === p;
  });
}
