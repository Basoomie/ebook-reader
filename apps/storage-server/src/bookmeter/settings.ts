/**
 * Bookmeter sync's server settings (2026-11-25, docs/design/bookmeter-sync.md; Settings ›
 * Library › 読書メーター). One JSON value in ttsu.db `bookmeter_settings`, laid over the defaults
 * (as ratings/settings.ts).
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface BookmeterAccount {
  id: string;
  /** The Bookmeter user id (the number in bookmeter.com/users/<id>). */
  userId: string;
  /** The reader libraries this account covers; empty = every library. */
  libraries: string[];
  /** Bookmeter's read and reading books change the reader's statuses. */
  statuses: boolean;
  /** 読みたい本 as a smart collection (bookmeter:wish). */
  wish: boolean;
  addedAt: number;
  /**
   * When the user first applied or skipped this account's changes. Until then every change
   * asks first, however few.
   */
  reviewedAt: number | null;
  /** The smart collection made for 読みたい本 (null until made). */
  collectionId: string | null;
}

export interface BookmeterSettings {
  /** The whole sync: off = nothing is fetched (what was applied stays). */
  enabled: boolean;
  accounts: BookmeterAccount[];
  /** Page 1 of each list every this many minutes (the newest entries). */
  quickMinutes: number;
  /** Every page of each list every this many hours (removals and changed dates). */
  fullHours: number;
  /** More changes than this ask first (Review) instead of being applied. */
  askAbove: number;
  /** A wanted book that arrives in the library is told (Settings › Notifications). */
  notifyArrived: boolean;
}

export const DEFAULT_BOOKMETER_SETTINGS: BookmeterSettings = {
  enabled: true,
  accounts: [],
  quickMinutes: 60,
  fullHours: 24,
  askAbove: 10,
  notifyArrived: true,
};

export const MAX_ACCOUNTS = 4;

export class BookmeterSettingsError extends Error {}

const NUMBERS: Partial<Record<keyof BookmeterSettings, [number, number]>> = {
  quickMinutes: [10, 1440],
  fullHours: [1, 168],
  askAbove: [0, 10000],
};
const FLAGS: (keyof BookmeterSettings)[] = ['enabled', 'notifyArrived'];

function readAccount(v: unknown): BookmeterAccount | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'string' || typeof a.userId !== 'string' || !/^\d{1,12}$/.test(a.userId))
    return null;
  return {
    id: a.id,
    userId: a.userId,
    libraries: Array.isArray(a.libraries)
      ? a.libraries.filter((l): l is string => typeof l === 'string')
      : [],
    statuses: a.statuses !== false,
    wish: a.wish !== false,
    addedAt: typeof a.addedAt === 'number' ? a.addedAt : 0,
    reviewedAt: typeof a.reviewedAt === 'number' ? a.reviewedAt : null,
    collectionId: typeof a.collectionId === 'string' ? a.collectionId : null,
  };
}

export function readBookmeterSettings(db: Database.Database): BookmeterSettings {
  const row = db.prepare('SELECT json FROM bookmeter_settings WHERE id = 1').get() as
    | { json: string }
    | undefined;
  let stored: Record<string, unknown> = {};
  try {
    stored = row ? (JSON.parse(row.json) as Record<string, unknown>) : {};
  } catch {
    stored = {};
  }
  const out: BookmeterSettings = { ...DEFAULT_BOOKMETER_SETTINGS, accounts: [] };
  for (const [key, [min, max]] of Object.entries(NUMBERS) as [
    keyof BookmeterSettings,
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
  if (Array.isArray(stored.accounts)) {
    for (const a of stored.accounts) {
      const acc = readAccount(a);
      if (acc) out.accounts.push(acc);
    }
  }
  return out;
}

function write(db: Database.Database, s: BookmeterSettings): BookmeterSettings {
  db.prepare(
    `INSERT INTO bookmeter_settings (id, json) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
  ).run(JSON.stringify(s));
  return s;
}

/** Saves the given general fields (accounts are changed with the account functions). */
export function saveBookmeterSettings(
  db: Database.Database,
  patch: Record<string, unknown>,
): BookmeterSettings {
  const next = readBookmeterSettings(db) as unknown as Record<string, unknown>;
  for (const [key, v] of Object.entries(patch)) {
    if (FLAGS.includes(key as keyof BookmeterSettings)) {
      if (typeof v !== 'boolean') throw new BookmeterSettingsError(`${key} must be true or false`);
      next[key] = v;
      continue;
    }
    const range = NUMBERS[key as keyof BookmeterSettings];
    if (!range) throw new BookmeterSettingsError(`Unknown setting: ${key}`);
    const [min, max] = range;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new BookmeterSettingsError(`${key} must be a number from ${min} to ${max}`);
    }
    next[key] = v;
  }
  return write(db, next as unknown as BookmeterSettings);
}

function checkLibraries(db: Database.Database, libraries: unknown): string[] {
  if (libraries === undefined) return [];
  if (!Array.isArray(libraries) || libraries.some((l) => typeof l !== 'string'))
    throw new BookmeterSettingsError('libraries must be a list of library ids');
  const known = new Set(
    (db.prepare('SELECT id FROM libraries').all() as { id: string }[]).map((r) => r.id),
  );
  for (const l of libraries as string[]) {
    if (!known.has(l)) throw new BookmeterSettingsError(`No library ${l}`);
  }
  return [...new Set(libraries as string[])];
}

export function addAccount(
  db: Database.Database,
  input: { userId: string; libraries?: unknown; statuses?: unknown; wish?: unknown },
  now: number,
): { settings: BookmeterSettings; account: BookmeterAccount } {
  const s = readBookmeterSettings(db);
  if (s.accounts.length >= MAX_ACCOUNTS)
    throw new BookmeterSettingsError(`At most ${MAX_ACCOUNTS} accounts`);
  if (s.accounts.some((a) => a.userId === input.userId))
    throw new BookmeterSettingsError('That Bookmeter user is already added');
  const account: BookmeterAccount = {
    id: randomUUID(),
    userId: input.userId,
    libraries: checkLibraries(db, input.libraries),
    statuses: input.statuses !== false,
    wish: input.wish !== false,
    addedAt: now,
    reviewedAt: null,
    collectionId: null,
  };
  s.accounts.push(account);
  return { settings: write(db, s), account };
}

export function updateAccount(
  db: Database.Database,
  id: string,
  patch: Record<string, unknown>,
): BookmeterSettings {
  const s = readBookmeterSettings(db);
  const a = s.accounts.find((x) => x.id === id);
  if (!a) throw new BookmeterSettingsError('No such account');
  for (const [key, v] of Object.entries(patch)) {
    if (key === 'libraries') a.libraries = checkLibraries(db, v);
    else if (key === 'statuses' || key === 'wish') {
      if (typeof v !== 'boolean') throw new BookmeterSettingsError(`${key} must be true or false`);
      a[key] = v;
    } else if (key === 'reviewedAt' || key === 'collectionId') {
      if (v !== null && typeof v !== (key === 'reviewedAt' ? 'number' : 'string'))
        throw new BookmeterSettingsError(`bad ${key}`);
      (a as unknown as Record<string, unknown>)[key] = v;
    } else throw new BookmeterSettingsError(`Unknown account setting: ${key}`);
  }
  return write(db, s);
}

export function removeAccount(db: Database.Database, id: string): BookmeterSettings {
  const s = readBookmeterSettings(db);
  const before = s.accounts.length;
  s.accounts = s.accounts.filter((a) => a.id !== id);
  if (s.accounts.length === before) throw new BookmeterSettingsError('No such account');
  return write(db, s);
}

/**
 * The account a book's library belongs to: the first account that names the library, else
 * the first account that covers every library. Null when none covers it.
 */
export function accountForLibrary(
  accounts: BookmeterAccount[],
  libraryId: string,
): BookmeterAccount | null {
  return (
    accounts.find((a) => a.libraries.includes(libraryId)) ??
    accounts.find((a) => a.libraries.length === 0) ??
    null
  );
}
