import { existsSync } from 'fs';
import path from 'path';

/** A startup error that must stop the server (same messages and exit code as before WP1). */
export class FatalConfigError extends Error {}

export interface SnapshotTime {
  hour: number;
  minute: number;
}

export interface ServerConfig {
  /** The app's data folder: uploads, fonts, attachments, and the old sync's files (read by the migration). */
  dataRoot: string;
  /**
   * The old sync's single static token (WP15e: no endpoint accepts it any more). Kept only
   * so it is still removed from log lines; null when unset.
   */
  authToken: string | null;
  port: number;
  /** '*' (any origin, the pre-WP1 default) or an explicit list of allowed origins. */
  corsOrigins: '*' | string[];
  /** Folder holding the SQLite database and its snapshots. Never inside dataRoot. */
  dbDir: string;
  snapshotTime: SnapshotTime;
  snapshotKeep: number;
  /** Calibre indexer (WP2). */
  calibre: CalibreConfig;
  /** Device pairing codes (WP6). */
  pairing: PairingConfig;
  /** Record sync (WP4). */
  sync: SyncConfig;
  /** Background character counts (WP3b). */
  counts: CountsConfig;
  /** Library search (WP7a). */
  search: SearchConfig;
  /** Uploads (WP7b). */
  uploads: UploadConfig;
  /** Custom fonts (WP13). */
  fonts: FontConfig;
  /** Book attachments: whispersync's saved subtitles and match (WP15c). */
  attachments: AttachmentConfig;
  /** Recent log lines kept for the bug report (WP18). */
  logs: LogConfig;
  /** Audiobook folder index and streaming (WP15). */
  audio: AudioConfig;
}

export interface AudioConfig {
  /** Root of the audiobooks folder (mounted read-only). null = audio linking off. */
  dir: string | null;
  /** Refuse to scan unless the audiobooks root is mounted read-only. */
  requireReadonly: boolean;
  /** Full rescan interval (hours); 0 = only at start and on request. */
  scanHours: number;
  /** How often the server checks for a scan requested from the CLI (seconds). */
  pollSeconds: number;
}

export const DEFAULT_AUDIO: Omit<AudioConfig, 'dir'> = {
  requireReadonly: true,
  scanHours: 24,
  pollSeconds: 60,
};

export interface SearchConfig {
  /** A search with a /regex/ that runs longer is stopped (SEARCH_REGEX_TIMEOUT_SECONDS). */
  regexTimeoutSeconds: number;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = { regexTimeoutSeconds: 5 };

/** The two reader import settings that change a book's character count. */
export type CountFixMode = 'Off' | 'Standard' | 'Extended';

export interface CountsConfig {
  /** false = no background counting (counts stay pending). */
  background: boolean;
  /** Books counted at the same time (one counter process each). */
  concurrency: number;
  /** Background rate limit (books per minute); 0 = no limit. */
  perMinute: number;
  /** A book that takes longer is recorded as an error (timeout) and its counter restarted. */
  timeoutSeconds: number;
  /** A counter process that is not ready after this long pauses the pass (loading jsdom takes seconds). */
  startTimeoutSeconds: number;
  /** Heap limit of each counter process. */
  maxMemoryMb: number;
  /** A counter process is replaced after this many books (bounds memory growth). */
  booksPerProcess: number;
  /** Scheduling priority of the counter processes (0-19, higher = lower priority). */
  nice: number;
  /** The pass pauses after this many timeouts or crashes in a row (until the next wake). */
  maxConsecutiveFailures: number;
  /** Counted with these reader import settings (the reader's defaults: Off, anchor only). */
  importFixMode: CountFixMode;
  restrictFixToAnchor: boolean;
}

export const DEFAULT_COUNTS_CONFIG: CountsConfig = {
  background: true,
  concurrency: 1,
  perMinute: 0,
  timeoutSeconds: 120,
  startTimeoutSeconds: 60,
  maxMemoryMb: 768,
  booksPerProcess: 500,
  nice: 10,
  maxConsecutiveFailures: 5,
  importFixMode: 'Off',
  restrictFixToAnchor: true,
};

export interface SyncConfig {
  /** A change stamped further ahead of the server clock than this gets the server time. */
  maxClockSkewSeconds: number;
  /**
   * Record kinds devices may no longer change (WP12: `stat-day` is frozen as
   * "before device tracking"). The server's own writes (the WP5 migration) are
   * not affected. `SYNC_FROZEN_KINDS=none` lifts it.
   */
  frozenKinds: string[];
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  maxClockSkewSeconds: 300,
  frozenKinds: ['stat-day'],
};

/** Kind names as the sync engine spells them. */
const KIND_NAME_RE = /^[a-z][a-z0-9-]{0,49}$/;

/** A comma-separated list of kind names; empty = the default, `none` = no kind. */
export function parseKindList(
  name: string,
  value: string | undefined,
  fallback: string[],
  warnings: string[],
): string[] {
  if (value === undefined || value.trim() === '') return [...fallback];
  if (value.trim().toLowerCase() === 'none') return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const kind = part.trim();
    if (!kind) continue;
    if (!KIND_NAME_RE.test(kind)) {
      warnings.push(`${name}: "${kind}" is not a record kind name; ignored.`);
      continue;
    }
    if (!out.includes(kind)) out.push(kind);
  }
  return out;
}

export interface PairingConfig {
  /** How long a code from `cli token pair` stays valid. */
  codeMinutes: number;
  /** Failed pairing attempts allowed per minute, all clients together. */
  maxFailuresPerMinute: number;
}

export const DEFAULT_PAIRING_CONFIG: PairingConfig = { codeMinutes: 10, maxFailuresPerMinute: 10 };

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
 * Reads the environment. DATA_DIR is the only fatal check (same message and exit
 * code as before WP1). Everything else is non-fatal: a bad value is reported and a
 * safe default is used. AUTH_TOKEN is optional since WP15e removed the old sync's
 * endpoints: when it is still set, a warning says it is unused.
 */
export function loadConfig(env: Env): LoadedConfig {
  const warnings: string[] = [];

  const authToken = env.AUTH_TOKEN || null;
  if (authToken) {
    warnings.push(
      'AUTH_TOKEN is set but no longer used (the old sync was removed); it can be left out',
    );
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
      pairing: parsePairingConfig(env, warnings),
      sync: parseSyncConfig(env, warnings),
      counts: parseCountsConfig(env, warnings),
      search: parseSearchConfig(env, warnings),
      uploads: parseUploadConfig(env, warnings),
      fonts: parseFontConfig(env, warnings),
      attachments: parseAttachmentConfig(env, warnings),
      logs: parseLogConfig(env, warnings),
      audio: parseAudioConfig(env, warnings),
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

/** WP6 settings; bad values fall back to the defaults like the other WP1+ settings. */
export function parsePairingConfig(env: Env, warnings: string[]): PairingConfig {
  const d = DEFAULT_PAIRING_CONFIG;
  return {
    codeMinutes: parseNumber(
      'PAIR_CODE_MINUTES',
      env.PAIR_CODE_MINUTES,
      d.codeMinutes,
      1,
      1440,
      false,
      warnings,
    ),
    maxFailuresPerMinute: parseNumber(
      'PAIR_MAX_FAILURES_PER_MINUTE',
      env.PAIR_MAX_FAILURES_PER_MINUTE,
      d.maxFailuresPerMinute,
      1,
      1000,
      true,
      warnings,
    ),
  };
}

/** WP4 settings; bad values fall back to the defaults like the other WP1+ settings. */
export function parseSyncConfig(env: Env, warnings: string[]): SyncConfig {
  return {
    maxClockSkewSeconds: parseNumber(
      'SYNC_MAX_CLOCK_SKEW_SECONDS',
      env.SYNC_MAX_CLOCK_SKEW_SECONDS,
      DEFAULT_SYNC_CONFIG.maxClockSkewSeconds,
      0,
      86_400,
      true,
      warnings,
    ),
    frozenKinds: parseKindList(
      'SYNC_FROZEN_KINDS',
      env.SYNC_FROZEN_KINDS,
      DEFAULT_SYNC_CONFIG.frozenKinds,
      warnings,
    ),
  };
}

/** WP7a settings; bad values fall back to the defaults. */
export function parseSearchConfig(env: Env, warnings: string[]): SearchConfig {
  return {
    regexTimeoutSeconds: parseNumber(
      'SEARCH_REGEX_TIMEOUT_SECONDS',
      env.SEARCH_REGEX_TIMEOUT_SECONDS,
      DEFAULT_SEARCH_CONFIG.regexTimeoutSeconds,
      0.1,
      600,
      false,
      warnings,
    ),
  };
}

export interface UploadConfig {
  /** Largest accepted EPUB (UPLOAD_MAX_MB). */
  maxMb: number;
  /** Staged files older than this are deleted (UPLOAD_STAGED_HOURS). */
  stagedHours: number;
}

export const DEFAULT_UPLOAD_CONFIG: UploadConfig = { maxMb: 200, stagedHours: 24 };

/** WP7b settings; bad values fall back to the defaults. */
export function parseUploadConfig(env: Env, warnings: string[]): UploadConfig {
  const d = DEFAULT_UPLOAD_CONFIG;
  return {
    maxMb: parseNumber('UPLOAD_MAX_MB', env.UPLOAD_MAX_MB, d.maxMb, 1, 4000, true, warnings),
    stagedHours: parseNumber(
      'UPLOAD_STAGED_HOURS',
      env.UPLOAD_STAGED_HOURS,
      d.stagedHours,
      1,
      24 * 365,
      true,
      warnings,
    ),
  };
}

export interface FontConfig {
  /** Largest accepted font file (FONT_MAX_MB). */
  maxMb: number;
}

export const DEFAULT_FONT_CONFIG: FontConfig = { maxMb: 64 };

export interface AttachmentConfig {
  /** Largest accepted book attachment (ATTACHMENT_MAX_MB): a matched book's text. */
  maxMb: number;
}

export const DEFAULT_ATTACHMENT_CONFIG: AttachmentConfig = { maxMb: 100 };

/** WP15c settings; bad values fall back to the defaults. */
export function parseAttachmentConfig(env: Env, warnings: string[]): AttachmentConfig {
  return {
    maxMb: parseNumber(
      'ATTACHMENT_MAX_MB',
      env.ATTACHMENT_MAX_MB,
      DEFAULT_ATTACHMENT_CONFIG.maxMb,
      1,
      2000,
      true,
      warnings,
    ),
  };
}

export interface LogConfig {
  /** Log lines kept in memory for the bug report (LOG_BUFFER_LINES). */
  bufferLines: number;
}

export const DEFAULT_LOG_CONFIG: LogConfig = { bufferLines: 2000 };

/** WP18 settings; bad values fall back to the defaults. */
export function parseLogConfig(env: Env, warnings: string[]): LogConfig {
  return {
    bufferLines: parseNumber(
      'LOG_BUFFER_LINES',
      env.LOG_BUFFER_LINES,
      DEFAULT_LOG_CONFIG.bufferLines,
      100,
      100_000,
      true,
      warnings,
    ),
  };
}

/** WP15 settings; like the other WP1+ settings, a bad value is reported and the default used. */
export function parseAudioConfig(env: Env, warnings: string[]): AudioConfig {
  const d = DEFAULT_AUDIO;
  const dirRaw = (env.AUDIOBOOKS_DIR ?? '').trim();
  return {
    dir: dirRaw ? path.resolve(dirRaw) : null,
    requireReadonly: parseBoolean(
      'AUDIOBOOKS_REQUIRE_READONLY',
      env.AUDIOBOOKS_REQUIRE_READONLY,
      d.requireReadonly,
      warnings,
    ),
    scanHours: parseNumber(
      'AUDIO_SCAN_HOURS',
      env.AUDIO_SCAN_HOURS,
      d.scanHours,
      0,
      24 * 365,
      false,
      warnings,
    ),
    pollSeconds: parseNumber(
      'AUDIO_POLL_SECONDS',
      env.AUDIO_POLL_SECONDS,
      d.pollSeconds,
      1,
      86_400,
      false,
      warnings,
    ),
  };
}

/** WP13 settings; bad values fall back to the defaults. */
export function parseFontConfig(env: Env, warnings: string[]): FontConfig {
  return {
    maxMb: parseNumber(
      'FONT_MAX_MB',
      env.FONT_MAX_MB,
      DEFAULT_FONT_CONFIG.maxMb,
      1,
      1000,
      true,
      warnings,
    ),
  };
}

/** WP3b settings; bad values fall back to the defaults like the other WP1+ settings. */
export function parseCountsConfig(env: Env, warnings: string[]): CountsConfig {
  const d = DEFAULT_COUNTS_CONFIG;
  const num = (name: string, fallback: number, min: number, max: number, integer = true) =>
    parseNumber(name, env[name], fallback, min, max, integer, warnings);
  const bool = (name: string, fallback: boolean) =>
    parseBoolean(name, env[name], fallback, warnings);
  return {
    background: bool('COUNT_BACKGROUND', d.background),
    concurrency: num('COUNT_CONCURRENCY', d.concurrency, 1, 4),
    perMinute: num('COUNT_PER_MINUTE', d.perMinute, 0, 100_000, false),
    timeoutSeconds: num('COUNT_TIMEOUT_SECONDS', d.timeoutSeconds, 5, 3600),
    startTimeoutSeconds: num('COUNT_START_TIMEOUT_SECONDS', d.startTimeoutSeconds, 5, 3600),
    maxMemoryMb: num('COUNT_MAX_MEMORY_MB', d.maxMemoryMb, 128, 16_384),
    booksPerProcess: num('COUNT_BOOKS_PER_PROCESS', d.booksPerProcess, 1, 1_000_000),
    nice: num('COUNT_NICE', d.nice, 0, 19),
    maxConsecutiveFailures: num(
      'COUNT_MAX_CONSECUTIVE_FAILURES',
      d.maxConsecutiveFailures,
      1,
      1_000_000,
    ),
    importFixMode: parseFixMode(env.COUNT_IMPORT_FIX_MODE, d.importFixMode, warnings),
    restrictFixToAnchor: bool('COUNT_RESTRICT_FIX_TO_ANCHOR', d.restrictFixToAnchor),
  };
}

function parseFixMode(
  value: string | undefined,
  fallback: CountFixMode,
  warnings: string[],
): CountFixMode {
  if (value === undefined || value.trim() === '') return fallback;
  const modes: CountFixMode[] = ['Off', 'Standard', 'Extended'];
  const mode = modes.find((m) => m.toLowerCase() === value.trim().toLowerCase());
  if (mode) return mode;
  warnings.push(
    `COUNT_IMPORT_FIX_MODE: "${value}" is not one of ${modes.join(', ')}; using ${fallback}.`,
  );
  return fallback;
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
