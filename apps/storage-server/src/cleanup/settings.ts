/**
 * The cleanup's settings (edited on /cleanup, stored in cleanup.db). Every behavior
 * threshold is a setting (CLAUDE.md); defaults are here. Bad values are refused with a
 * message, never silently clamped.
 *
 * Settings are shared by every stage (decided with the user 2026-11-14): one pacing, one gate
 * with per-field exceptions, one cover group, one set of safety thresholds. A later stage adds
 * a field exception or a group about a thing (covers, sources), never a copy per stage.
 * Values stored in the earlier per-stage shape are carried over when read (`fromLegacy`).
 */
import type Database from 'better-sqlite3';
import { DEFAULT_DUPLICATE_SETTINGS, type DuplicateSettings } from './stage3-rules';

export interface PacingSettings {
  /** How fast an analysis reads book files (MB/s); 0 = no limit. */
  readMbPerSecond: number;
  /** Pause between two items in the sidecar (seconds). */
  itemDelaySeconds: number;
  /** Items per batch (copies for removals, books for metadata; at most 500). */
  batchSize: number;
  /** Items per batch as a share of the library's present books (%), far under the reader's
   * 20 % mass-missing guard. */
  maxBatchPercent: number;
  /** Books the sidecar looks up in Calibre with one call (before and after its writes). */
  lookupChunk: number;
}

/** The check on the labeled books, for every stage and field. */
export interface GateSettings {
  /** A field must be right on the labeled books at least this often (%). */
  defaultPercent: number;
  /** Fields with their own bar (decided: titles 85 % for stage 2). */
  fieldPercent: Record<string, number>;
  /** Titles from the file must also be this many points better than Calibre's current ones. */
  marginPoints: number;
  /** A group with fewer labeled books than this is shown but not checked. */
  minBooks: number;
  /** The labeled books (gold800.json); empty = <DB_DIR>/cleanup/reference-sample/gold800.json. */
  labeledBooksFile: string;
  /**
   * Stage 3: the measured duplicate pairs with their expected classes; empty =
   * <DB_DIR>/cleanup/reference-sample/stage3-pairs.json.
   */
  duplicatePairsFile: string;
}

export interface CoverSettings {
  /** Covers up to this size (MB) are handed to Calibre unchanged (JPEG/PNG). */
  maxMb: number;
  /** Covers longer than this (px) on their longest side are scaled down (JPEG). */
  maxSide: number;
  /** Two covers within this difference-hash distance are the same picture. */
  sameDistance: number;
  /** A cover counts as larger when its longest side is at least this much bigger (%). */
  largerPercent: number;
}

/** The audiobook cleanup (WP21a). Audiobookshelf is only read. */
export interface AudiobookSettings {
  /** Audiobookshelf's address as the storage server reaches it, e.g. http://192.168.1.5:13378. */
  absUrl: string;
  /** Stage 1: how fast files are hashed (MB/s); 0 = no limit (it holds the disk lock alone). */
  readMbPerSecond: number;
  /** Stage 2: audio files checked per second (headers and two short decodes each). */
  healthFilesPerSecond: number;
  /** Stage 2: seconds decoded at the start and at the end of every file. */
  decodeSeconds: number;
  /** Stage 2: time limit for one ffprobe or ffmpeg run (s). */
  toolTimeoutSeconds: number;
  /** A folder's files look like full copies when each is at least this long (minutes) ... */
  copyHintMinMinutes: number;
  /** ... and their lengths are within this share of the longest (%). */
  copyHintPercent: number;
  /** Time limit for one request to Audiobookshelf (s). */
  absTimeoutSeconds: number;
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
  gate: GateSettings;
  /** A field pauses when its share of review results is this many points above the labeled books'. */
  reviewAlarmPercent: number;
  /**
   * A stage pauses (instead of skipping items one by one) when more than this share of the
   * next batch changed in Calibre since the analysis (%).
   */
  libraryChangedPausePercent: number;
  /**
   * A batch pauses its stage only when more than this share of its items failed (%); fewer
   * failed items are listed in the batch and the run goes on. 0 = any failure pauses.
   */
  failedPausePercent: number;
  covers: CoverSettings;
  /** Stage 3: content duplicates (thresholds of plan section 5). */
  duplicates: DuplicateSettings;
  /** The audiobook cleanup (WP21a). */
  audiobooks: AudiobookSettings;
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
  pacing: {
    readMbPerSecond: 40,
    itemDelaySeconds: 0,
    batchSize: 500,
    maxBatchPercent: 2,
    lookupChunk: 25,
  },
  customTags: ['PeepoHappyBooks', 'alpindale', 'TMW-collection-*'],
  gate: {
    defaultPercent: 95,
    fieldPercent: { title: 85 },
    marginPoints: 20,
    minBooks: 20,
    labeledBooksFile: '',
    duplicatePairsFile: '',
  },
  reviewAlarmPercent: 5,
  libraryChangedPausePercent: 5,
  failedPausePercent: 1,
  covers: { maxMb: 10, maxSide: 4096, sameDistance: 5, largerPercent: 10 },
  duplicates: { ...DEFAULT_DUPLICATE_SETTINGS },
  audiobooks: {
    absUrl: '',
    readMbPerSecond: 0,
    healthFilesPerSecond: 2,
    decodeSeconds: 20,
    toolTimeoutSeconds: 60,
    copyHintMinMinutes: 60,
    copyHintPercent: 3,
    absTimeoutSeconds: 30,
  },
  backup: {
    path: '/mnt/user/data/backups/japanese-library-2026-11-11/',
    verifiedOn: '2026-11-12',
    confirmedAt: null,
  },
};

export const MAX_BATCH_SIZE = 500;
export const MAX_BATCH_PERCENT = 10;
/** Fields the gate knows (a bar for anything else is refused). */
export const GATE_FIELDS = [
  'title',
  'authors',
  'illustrators',
  'series',
  'number',
  'format',
] as const;

export class SettingsError extends Error {}

type Key = keyof CleanupSettings;
/** Keys of the earlier per-stage shape, removed when the settings are saved again. */
const LEGACY_KEYS = ['gateThresholdPercent', 'stage2'];

function readRaw(db: Database.Database): Map<string, unknown> {
  const rows = db.prepare('SELECT key, value_json FROM settings').all() as {
    key: string;
    value_json: string;
  }[];
  return new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Settings stored in the earlier per-stage shape (WP20a's pacing with hashMbPerSecond, the
 * unused gateThresholdPercent, WP20b's stage2 group) in today's shape. The old page saved every
 * field, so the old defaults it stored (200 per batch, a 2 s pause) become today's
 * recommendations (500, none); any other stored value is kept.
 */
export function fromLegacy(raw: Map<string, unknown>): Map<string, unknown> {
  const out = new Map(raw);
  const pacing = raw.get('pacing');
  if (isObj(pacing) && 'hashMbPerSecond' in pacing) {
    const { hashMbPerSecond, ...rest } = pacing;
    out.set('pacing', {
      ...rest,
      readMbPerSecond: hashMbPerSecond,
      batchSize: rest.batchSize === 200 ? 500 : rest.batchSize,
      itemDelaySeconds: rest.itemDelaySeconds === 2 ? 0 : rest.itemDelaySeconds,
    });
  }
  const stage2 = raw.get('stage2');
  const oldGate = raw.get('gateThresholdPercent');
  if (!raw.has('gate') && (isObj(stage2) || typeof oldGate === 'number')) {
    const gate: Obj = {};
    if (typeof oldGate === 'number') gate.defaultPercent = oldGate;
    if (isObj(stage2)) {
      const fieldPercent: Obj = {};
      if (typeof stage2.titleMinPercent === 'number') fieldPercent.title = stage2.titleMinPercent;
      if (
        typeof stage2.authorsMinPercent === 'number' &&
        stage2.authorsMinPercent !== (gate.defaultPercent ?? 95)
      ) {
        fieldPercent.authors = stage2.authorsMinPercent;
      }
      gate.fieldPercent = fieldPercent;
      if (stage2.titleMarginPoints !== undefined) gate.marginPoints = stage2.titleMarginPoints;
      if (stage2.gateMinBooks !== undefined) gate.minBooks = stage2.gateMinBooks;
      if (stage2.referenceFile !== undefined) gate.labeledBooksFile = stage2.referenceFile;
    }
    out.set('gate', gate);
  }
  if (!raw.has('covers') && isObj(stage2)) {
    const covers: Obj = {};
    if (stage2.coverMaxMb !== undefined) covers.maxMb = stage2.coverMaxMb;
    if (stage2.coverMaxSide !== undefined) covers.maxSide = stage2.coverMaxSide;
    if (stage2.coverSameDistance !== undefined) covers.sameDistance = stage2.coverSameDistance;
    if (stage2.coverLargerPercent !== undefined) covers.largerPercent = stage2.coverLargerPercent;
    out.set('covers', covers);
  }
  if (isObj(stage2) && typeof stage2.chunkSize === 'number') {
    const p = out.get('pacing');
    out.set('pacing', { ...(isObj(p) ? p : {}), lookupChunk: stage2.chunkSize });
  }
  for (const k of LEGACY_KEYS) out.delete(k);
  return out;
}

export function getSettings(db: Database.Database): CleanupSettings {
  const raw = fromLegacy(readRaw(db));
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

function group<T extends object>(name: string, value: unknown, current: T): T {
  if (!isObj(value)) throw new SettingsError(`${name} must be an object`);
  for (const k of Object.keys(value)) {
    if (!(k in current)) throw new SettingsError(`Unknown ${name.toLowerCase()} setting: ${k}`);
  }
  return { ...current, ...(value as Partial<T>) };
}

/** Audiobookshelf's address: http(s), no query, fragment or login; '' = not set. */
function absAddress(value: unknown): string {
  const v = text('Audiobookshelf address', value);
  if (v === '') return v;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new SettingsError('Audiobookshelf address must look like http://192.168.1.5:13378');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SettingsError('Audiobookshelf address must start with http:// or https://');
  }
  if (url.hash || url.search || url.username || url.password) {
    throw new SettingsError(
      'Audiobookshelf address: no #, query or login in the address (the API key has its own field)',
    );
  }
  return url.toString().replace(/\/$/, '');
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
    case 'audiobooks': {
      const v = group('Audiobooks', value, current.audiobooks);
      return {
        absUrl: absAddress(v.absUrl),
        readMbPerSecond: num('Hashing speed (MB/s)', v.readMbPerSecond, 0, 2000),
        healthFilesPerSecond: num('Files checked per second', v.healthFilesPerSecond, 0.1, 50),
        decodeSeconds: num('Seconds decoded at each end', v.decodeSeconds, 1, 600, true),
        toolTimeoutSeconds: num(
          'Time limit for one check (s)',
          v.toolTimeoutSeconds,
          5,
          3600,
          true,
        ),
        copyHintMinMinutes: num(
          'Copies: each file at least (minutes)',
          v.copyHintMinMinutes,
          0,
          6000,
        ),
        copyHintPercent: num('Copies: lengths within (%)', v.copyHintPercent, 0, 50),
        absTimeoutSeconds: num('Audiobookshelf time limit (s)', v.absTimeoutSeconds, 1, 600, true),
      };
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
      if (!isObj(value)) throw new SettingsError('Models must be an object');
      const out: Record<string, string> = { ...current.models };
      for (const [task, model] of Object.entries(value)) {
        if (!(MODEL_TASKS as readonly string[]).includes(task)) {
          throw new SettingsError(`Unknown model task: ${task}`);
        }
        out[task] = text(`Model for ${task}`, model, 100);
      }
      return out;
    }
    case 'pacing': {
      const v = group('Pacing', value, current.pacing);
      return {
        readMbPerSecond: num('Reading speed (MB/s)', v.readMbPerSecond, 0, 2000),
        itemDelaySeconds: num('Pause between items (s)', v.itemDelaySeconds, 0, 600),
        batchSize: num('Batch size', v.batchSize, 1, MAX_BATCH_SIZE, true),
        maxBatchPercent: num(
          'Largest batch (% of the library)',
          v.maxBatchPercent,
          0.1,
          MAX_BATCH_PERCENT,
        ),
        lookupChunk: num('Books per Calibre look-up', v.lookupChunk, 1, 100, true),
      };
    }
    case 'customTags': {
      if (!Array.isArray(value) || value.length > 100) {
        throw new SettingsError('Custom tags must be a list of at most 100 tags');
      }
      const tags = value.map((t) => text('Custom tag', t, 200)).filter((t) => t !== '');
      return [...new Set(tags)];
    }
    case 'gate': {
      const v = group('Gate', value, current.gate);
      if (!isObj(v.fieldPercent)) throw new SettingsError('Field bars must be an object');
      const fieldPercent: Record<string, number> = {};
      for (const [f, p] of Object.entries(v.fieldPercent)) {
        if (!(GATE_FIELDS as readonly string[]).includes(f))
          throw new SettingsError(`No such field: ${f}`);
        fieldPercent[f] = num(`Bar for ${f} (%)`, p, 50, 100);
      }
      return {
        defaultPercent: num('Bar for every field (%)', v.defaultPercent, 50, 100),
        fieldPercent,
        marginPoints: num('Better than Calibre by (points)', v.marginPoints, 0, 100),
        minBooks: num('Smallest group checked (books)', v.minBooks, 1, 800, true),
        labeledBooksFile: text('Labeled books file', v.labeledBooksFile, 1000),
        duplicatePairsFile: text('Measured duplicate pairs file', v.duplicatePairsFile, 1000),
      };
    }
    case 'reviewAlarmPercent':
      return num('Review alarm (points)', value, 0, 100);
    case 'libraryChangedPausePercent':
      return num('Pause when items changed in Calibre (%)', value, 0, 100);
    case 'failedPausePercent':
      return num('Pause when items of a batch failed (%)', value, 0, 100);
    case 'covers': {
      const v = group('Covers', value, current.covers);
      return {
        maxMb: num('Covers passed on unchanged up to (MB)', v.maxMb, 1, 32),
        maxSide: num('Longest cover side (px)', v.maxSide, 500, 20000, true),
        sameDistance: num('Same cover picture up to (hash distance)', v.sameDistance, 0, 32, true),
        largerPercent: num('A cover is larger by (%)', v.largerPercent, 0, 500),
      };
    }
    case 'duplicates': {
      const v = group('Duplicates', value, current.duplicates);
      const share = (name: string, x: unknown) => num(name, x, 0, 1);
      const optional = (name: string, x: unknown) => (x === null ? null : share(name, x));
      const out: DuplicateSettings = {
        bothWays: share('Same text both ways from', v.bothWays),
        superset: share('One copy holds the other from', v.superset),
        reviewFloor: share('Different books below', v.reviewFloor),
        spreadKeepBoth: optional(
          'Keep both copies from (extra text inside the chapters)',
          v.spreadKeepBoth,
        ),
        spreadIgnore: optional('Extra text inside the chapters ignored below', v.spreadIgnore),
        imageOnlyMaxChars: num(
          'Image-only books: fewer characters than',
          v.imageOnlyMaxChars,
          0,
          100_000,
          true,
        ),
        imageMatchDistance: num(
          'Same picture up to (hash distance)',
          v.imageMatchDistance,
          0,
          32,
          true,
        ),
        commonWindowBooks: num(
          'Text shared by more books than this is ignored',
          v.commonWindowBooks,
          2,
          10_000,
          true,
        ),
        textTimeoutSeconds: num(
          'Time limit to read one book (s)',
          v.textTimeoutSeconds,
          10,
          3600,
          true,
        ),
        textWorkers: num('Books read at the same time', v.textWorkers, 1, 8, true),
      };
      if (out.reviewFloor > out.bothWays || out.bothWays > out.superset) {
        throw new SettingsError(
          'The limits must go up: different books below ≤ same text both ways ≤ one copy holds the other',
        );
      }
      if ((out.spreadKeepBoth === null) !== (out.spreadIgnore === null)) {
        throw new SettingsError('Set both limits for extra text inside the chapters, or neither');
      }
      if (out.spreadKeepBoth !== null && out.spreadIgnore! > out.spreadKeepBoth) {
        throw new SettingsError('"Ignored below" must not be above "keep both copies from"');
      }
      return out;
    }
    case 'backup': {
      const v = group('Backup', value, current.backup);
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

/** The bar a field must reach on the labeled books (its own, else the shared one). */
export function gateBar(s: CleanupSettings, field: string): number {
  return s.gate.fieldPercent[field] ?? s.gate.defaultPercent;
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
    // The earlier per-stage shape goes once today's shape is stored (everything carried over).
    const raw = readRaw(db);
    if (
      LEGACY_KEYS.some((k) => raw.has(k)) ||
      (isObj(raw.get('pacing')) && 'hashMbPerSecond' in (raw.get('pacing') as Obj))
    ) {
      for (const k of ['pacing', 'gate', 'covers'] as const)
        put.run(k, JSON.stringify(current[k]), now);
      for (const k of LEGACY_KEYS) db.prepare('DELETE FROM settings WHERE key = ?').run(k);
    }
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
