/**
 * The worker's settings: C:\ttsu-worker\config.json (or the file named by
 * TTSU_WORKER_CONFIG). Only serverUrl and token are required; everything else has a
 * default. Thresholds are settings, not fixed values.
 */
import fs from 'fs';
import path from 'path';

/**
 * The SubPlz image, pinned by digest (decided 2026-11-12): kanjieater/subplz:latest as
 * published on 2025-10-24 (no SubPlz image was on the PC to copy the version from).
 * Changed only on purpose, never to "latest".
 */
export const PINNED_IMAGE =
  'kanjieater/subplz@sha256:58cddc13c51789d65edb2b81ef47b2dd76613e54f9c4726cc96d94f2aff7b310';

export interface WorkerSettings {
  /** The reader's server (the storage server), e.g. http://192.168.1.5:3081. */
  serverUrl: string;
  /** A GPU worker token (`cli token worker`). */
  token: string;
  /** SubPlz's model cache (decided default folder), mounted at /config (see subplz.ts). */
  cacheDir: string;
  /** Temporary job folders; plain ASCII without spaces (the real paths have neither). */
  workDir: string;
  /** Logs (worker.log, worker.log.1). */
  logDir: string;
  image: string;
  /** The docker command. */
  dockerPath: string;
  /** Tests only: arguments put before docker's own (dockerPath = node, this = a script). */
  dockerPrefixArgs: string[];
  /** SubPlz is stopped after this long (hours). */
  maxRunHours: number;
  /** Free space kept on the work folder's drive besides the job's files (GB). */
  minFreeGB: number;
  /** worker.log is rotated at this size (MB). */
  logMaxMB: number;
  /** How often a running job reports to the server (seconds). */
  reportSeconds: number;
  /** Server requests that take longer fail (seconds); downloads have no limit. */
  requestTimeoutSeconds: number;
}

export const DEFAULTS: Omit<WorkerSettings, 'serverUrl' | 'token'> = {
  cacheDir: 'C:\\Data\\Japanese\\Books\\SyncCache',
  workDir: 'C:\\ttsu-worker\\work',
  logDir: 'C:\\ttsu-worker\\logs',
  image: PINNED_IMAGE,
  dockerPath: 'docker',
  dockerPrefixArgs: [],
  maxRunHours: 8,
  minFreeGB: 5,
  logMaxMB: 5,
  reportSeconds: 10,
  requestTimeoutSeconds: 30,
};

export class ConfigError extends Error {}

/** Plain ASCII, no spaces: a path Docker and SubPlz take as it is. */
export function isPlainPath(p: string): boolean {
  return /^[A-Za-z0-9:\\/._-]+$/.test(p);
}

function num(raw: Record<string, unknown>, key: keyof WorkerSettings, min: number): number {
  const v = raw[key];
  const fallback = DEFAULTS[key as keyof typeof DEFAULTS] as number;
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
    throw new ConfigError(`${key} must be a number of at least ${min}`);
  }
  return v;
}

function str(raw: Record<string, unknown>, key: keyof WorkerSettings): string {
  const v = raw[key];
  const fallback = DEFAULTS[key as keyof typeof DEFAULTS] as string;
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string') throw new ConfigError(`${key} must be text`);
  return v.trim();
}

/** Checks a parsed config.json and fills in the defaults. */
export function parseSettings(raw: unknown): WorkerSettings {
  if (!raw || typeof raw !== 'object') throw new ConfigError('config.json must be an object');
  const r = raw as Record<string, unknown>;
  const serverUrl = typeof r.serverUrl === 'string' ? r.serverUrl.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^/]+/.test(serverUrl)) {
    throw new ConfigError('serverUrl must be the server address, e.g. http://192.168.1.5:3081');
  }
  const token = typeof r.token === 'string' ? r.token.trim() : '';
  if (!/^ttsu_[A-Za-z0-9_-]{20,}$/.test(token)) {
    throw new ConfigError(
      'token must be a GPU worker token (made on the NAS with: cli token worker "PC GPU worker")',
    );
  }
  const workDir = str(r, 'workDir');
  if (!isPlainPath(workDir)) {
    throw new ConfigError(
      `workDir must be a plain path without spaces or other special characters: ${workDir}`,
    );
  }
  const prefix = r.dockerPrefixArgs;
  if (
    prefix !== undefined &&
    !(Array.isArray(prefix) && prefix.every((a) => typeof a === 'string'))
  ) {
    throw new ConfigError('dockerPrefixArgs must be a list of text');
  }
  return {
    serverUrl,
    token,
    cacheDir: str(r, 'cacheDir'),
    workDir,
    logDir: str(r, 'logDir'),
    image: str(r, 'image'),
    dockerPath: str(r, 'dockerPath'),
    dockerPrefixArgs: (prefix as string[] | undefined) ?? [],
    maxRunHours: num(r, 'maxRunHours', 0.001),
    minFreeGB: num(r, 'minFreeGB', 0),
    logMaxMB: num(r, 'logMaxMB', 0.01),
    reportSeconds: num(r, 'reportSeconds', 0.05),
    requestTimeoutSeconds: num(r, 'requestTimeoutSeconds', 1),
  };
}

/** The config file: TTSU_WORKER_CONFIG, else config.json next to the app folder. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TTSU_WORKER_CONFIG || path.join(__dirname, '..', 'config.json');
}

export function loadSettings(file: string): WorkerSettings {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`No config file at ${file} (copy config.example.json and fill it in)`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new ConfigError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseSettings(raw);
}
