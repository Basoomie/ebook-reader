import { existsSync } from 'fs';
import path from 'path';

/** A startup error that must stop the server (same messages and exit code as before WP1). */
export class FatalConfigError extends Error {}

export interface SnapshotTime {
  hour: number;
  minute: number;
}

export interface ServerConfig {
  /** Root of the legacy file API (today's sync data). */
  dataRoot: string;
  /** The legacy single static token. Only the legacy endpoints accept it. */
  authToken: string;
  port: number;
  /** '*' (any origin, the pre-WP1 default) or an explicit list of allowed origins. */
  corsOrigins: '*' | string[];
  /** Folder holding the SQLite database and its snapshots. Never inside dataRoot. */
  dbDir: string;
  snapshotTime: SnapshotTime;
  snapshotKeep: number;
  /** Calibre indexer (WP2). */
  calibre: CalibreConfig;
}

export interface CalibreConfig {
  /** Root holding the Calibre libraries (mounted read-only). null = indexer off. */
  dir: string | null;
  /** Regenerable cache: metadata.db snapshots and cover thumbnails. */
  cacheDir: string;
  pollSeconds: number;
  /** metadata.db must be unchanged this long before it is copied. */
  settleSeconds: number;
  /** A snapshot copy that takes longer than this is abandoned and retried on a later poll. */
  snapshotTimeoutSeconds: number;
  /** Skip missing-marking when one index would mark more than this share of a library missing. */
  maxMissingPercent: number;
  /** Refuse to index unless the Calibre root is mounted read-only. */
  requireReadonly: boolean;
  thumbConcurrency: number;
  /** Background thumbnail rate limit (thumbnails per second); 0 = no limit. */
  thumbPerSecond: number;
  /** false = thumbnails are only made when requested. */
  thumbBackground: boolean;
}

export const DEFAULT_CALIBRE: Omit<CalibreConfig, 'dir' | 'cacheDir'> = {
  pollSeconds: 60,
  settleSeconds: 30,
  snapshotTimeoutSeconds: 600,
  maxMissingPercent: 20,
  requireReadonly: true,
  thumbConcurrency: 1,
  thumbPerSecond: 8,
  thumbBackground: true,
};

export const DEFAULT_SNAPSHOT_TIME: SnapshotTime = { hour: 3, minute: 0 };
export const DEFAULT_SNAPSHOT_KEEP = 7;

export interface LoadedConfig {
  config: ServerConfig;
  /** Non-fatal problems; logged at startup. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Reads the environment. Fatal checks (AUTH_TOKEN, DATA_DIR) keep their
 * pre-WP1 order and messages. Everything new in WP1 is non-fatal: a bad
 * value is reported and a safe default is used, so the legacy endpoints
 * always come up.
 */
export function loadConfig(env: Env): LoadedConfig {
  const warnings: string[] = [];

  const authToken = env.AUTH_TOKEN;
  if (!authToken) {
    throw new FatalConfigError('Fatal: AUTH_TOKEN environment variable is required');
  }

  const dataRoot = path.resolve(env.DATA_DIR ?? '/data');
  if (!existsSync(dataRoot)) {
    throw new FatalConfigError(`Fatal: DATA_DIR does not exist: ${dataRoot}`);
  }

  const port = parseInt(env.PORT ?? '3001', 10);

  return {
    config: {
      dataRoot,
      authToken,
      port,
      corsOrigins: parseCorsOrigins(env.CORS_ORIGIN, warnings),
      dbDir: path.resolve(env.DB_DIR ?? '/db'),
      snapshotTime: parseSnapshotTime(env.SNAPSHOT_TIME, warnings),
      snapshotKeep: parseSnapshotKeep(env.SNAPSHOT_KEEP, warnings),
      calibre: parseCalibreConfig(env, warnings),
    },
    warnings,
  };
}

/**
 * CORS_ORIGIN: comma-separated list of exact origins, or '*'.
 * Unset keeps the pre-WP1 default ('*') so an old compose file still works.
 */
export function parseCorsOrigins(value: string | undefined, warnings: string[]): '*' | string[] {
  const raw = (value ?? '').trim();
  if (raw === '' || raw === '*') {
    warnings.push(
      'CORS_ORIGIN allows any origin (*). Set it to the origins you open the reader from, comma-separated.',
    );
    return '*';
  }

  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    if (entry === '*') {
      warnings.push('CORS_ORIGIN: "*" inside a list is ignored; list exact origins only.');
      continue;
    }
    try {
      const url = new URL(entry);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('not http(s)');
      // Normalizes "http://Host:3080/" to "http://host:3080".
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      warnings.push(`CORS_ORIGIN: ignoring invalid origin "${entry}".`);
    }
  }
  if (origins.length === 0) {
    warnings.push('CORS_ORIGIN has no valid origins: browsers will be blocked from every origin.');
  }
  return origins;
}

export function parseSnapshotTime(value: string | undefined, warnings: string[]): SnapshotTime {
  if (value === undefined || value.trim() === '') return { ...DEFAULT_SNAPSHOT_TIME };
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 24 && minute < 60) return { hour, minute };
  }
  warnings.push(
    `SNAPSHOT_TIME: "${value}" is not HH:MM; using ${formatTime(DEFAULT_SNAPSHOT_TIME)}.`,
  );
  return { ...DEFAULT_SNAPSHOT_TIME };
}

export function parseSnapshotKeep(value: string | undefined, warnings: string[]): number {
  if (value === undefined || value.trim() === '') return DEFAULT_SNAPSHOT_KEEP;
  const n = Number(value.trim());
  if (Number.isInteger(n) && n >= 1) return n;
  warnings.push(
    `SNAPSHOT_KEEP: "${value}" is not a whole number >= 1; using ${DEFAULT_SNAPSHOT_KEEP}.`,
  );
  return DEFAULT_SNAPSHOT_KEEP;
}

/**
 * WP2 settings. Like the other WP1+ settings, a bad value is reported and the
 * default is used; nothing here can stop the server.
 */
export function parseCalibreConfig(env: Env, warnings: string[]): CalibreConfig {
  const d = DEFAULT_CALIBRE;
  const dirRaw = (env.CALIBRE_DIR ?? '').trim();
  const num = (name: string, fallback: number, min: number, max: number, integer = false) =>
    parseNumber(name, env[name], fallback, min, max, integer, warnings);
  const bool = (name: string, fallback: boolean) =>
    parseBoolean(name, env[name], fallback, warnings);
  return {
    dir: dirRaw ? path.resolve(dirRaw) : null,
    cacheDir: path.resolve((env.CACHE_DIR ?? '').trim() || '/cache'),
    pollSeconds: num('CALIBRE_POLL_SECONDS', d.pollSeconds, 5, 86_400),
    settleSeconds: num('CALIBRE_SETTLE_SECONDS', d.settleSeconds, 0, 86_400),
    snapshotTimeoutSeconds: num(
      'CALIBRE_SNAPSHOT_TIMEOUT_SECONDS',
      d.snapshotTimeoutSeconds,
      10,
      86_400,
    ),
    maxMissingPercent: num('CALIBRE_MAX_MISSING_PERCENT', d.maxMissingPercent, 0, 100),
    requireReadonly: bool('CALIBRE_REQUIRE_READONLY', d.requireReadonly),
    thumbConcurrency: num('THUMB_CONCURRENCY', d.thumbConcurrency, 1, 8, true),
    thumbPerSecond: num('THUMB_PER_SECOND', d.thumbPerSecond, 0, 1000),
    thumbBackground: bool('THUMB_BACKGROUND', d.thumbBackground),
  };
}

export function parseNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
  warnings: string[],
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value.trim());
  if (Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))) return n;
  const kind = integer ? 'a whole number' : 'a number';
  warnings.push(`${name}: "${value}" is not ${kind} from ${min} to ${max}; using ${fallback}.`);
  return fallback;
}

export function parseBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
  warnings: string[],
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  warnings.push(`${name}: "${value}" is not true or false; using ${fallback}.`);
  return fallback;
}

export function formatTime(t: SnapshotTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}
