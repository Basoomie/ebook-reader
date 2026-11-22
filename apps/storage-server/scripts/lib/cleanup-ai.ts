/**
 * The shared AI layer for the stop tools that run the cleanup's AI stages on a working copy of
 * cleanup.db (book summaries session 1 moved the keys, the provider settings and the spending
 * to ttsu.db). The layer runs on an in-memory ttsu.db, seeded with the copy's own keys and
 * provider settings: from a ttsu.db copy that has them (with DB_DIR's ai-secrets.key), else
 * from a cleanup.db copy from before v21 (read before the working copy is migrated).
 *
 *   const seed = readAiSeed(db, main, aiKeyDir);  // before migrateWorkingCopy
 *   migrateWorkingCopy(db);
 *   const { core, runner } = cleanupAi(db, { seed, log });
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AiCore, type AiCoreDeps } from '../../src/ai/core';
import { AiRunner } from '../../src/ai/runner';
import { AI_SECRET_NAMES, AiSecretStore, type AiSecretName } from '../../src/ai/secrets';
import { AI_SETTING_KEYS, readAiSettings, type AiSettings } from '../../src/ai/settings';
import { CLEANUP_AI_SOURCE, cleanupFeatureOf } from '../../src/cleanup/ai-features';
import { migrateCleanup } from '../../src/cleanup/cleanup-db';
import { readCleanupSecret } from '../../src/cleanup/secrets';
import { getSettings } from '../../src/cleanup/settings';
import { migrate } from '../../src/db/migrations';

export interface AiSeed {
  keys: Record<AiSecretName, string | null>;
  settings: Partial<AiSettings> | null;
}

const hasTable = (db: Database.Database, name: string) =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

/** The copy's keys and provider settings (call before migrateWorkingCopy). */
export function readAiSeed(
  cleanupDb: Database.Database,
  main: Database.Database | null,
  aiKeyDir: string | null = null,
): AiSeed {
  const keys = Object.fromEntries(AI_SECRET_NAMES.map((n) => [n, null])) as AiSeed['keys'];
  let settings: Partial<AiSettings> | null = null;
  if (main && hasTable(main, 'ai_settings')) {
    if (aiKeyDir) {
      const store = new AiSecretStore(main, aiKeyDir);
      for (const n of AI_SECRET_NAMES) keys[n] = store.read(n);
    }
    if (main.prepare(`SELECT 1 FROM ai_settings WHERE key = 'settings'`).get())
      settings = readAiSettings(main);
  }
  if (main && Object.values(keys).every((v) => v === null))
    for (const n of AI_SECRET_NAMES) keys[n] = readCleanupSecret(cleanupDb, main, n);
  if (!settings) {
    const raw = cleanupDb.prepare(`SELECT value_json FROM settings WHERE key = 'ai'`).get() as
      | { value_json: string }
      | undefined;
    if (raw) {
      const old = JSON.parse(raw.value_json) as Record<string, unknown>;
      const picked: Record<string, unknown> = {};
      for (const k of AI_SETTING_KEYS) if (k in old) picked[k] = old[k];
      if (Object.keys(picked).length) settings = picked as Partial<AiSettings>;
    }
  }
  return { keys, settings };
}

/** Migrates a working copy; its AI keys and settings were read into a seed first. */
export function migrateWorkingCopy(db: Database.Database): number {
  return migrateCleanup(db, { beforeAiMove: () => undefined });
}

export function cleanupAi(
  db: Database.Database,
  opts: {
    seed?: AiSeed | null;
    providers?: AiCoreDeps['providers'];
    log?: (m: string) => void;
    now?: () => number;
  } = {},
): { core: AiCore; runner: AiRunner } {
  const main = new Database(':memory:');
  const log = console.log;
  console.log = () => undefined; // the in-memory ttsu.db's migration lines
  try {
    migrate(main);
  } finally {
    console.log = log;
  }
  const keys = opts.seed?.keys ?? null;
  const core = new AiCore({
    db: main,
    dbDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-ai-')),
    keys: { read: (n) => keys?.[n] ?? null },
    providers: opts.providers,
    now: opts.now,
    log: opts.log,
  });
  if (opts.seed?.settings) core.updateSettings(opts.seed.settings);
  const runner = new AiRunner({
    db,
    core,
    source: CLEANUP_AI_SOURCE,
    featureOf: cleanupFeatureOf,
    modelFor: (task) => getSettings(db).models[task] ?? '',
    onlyLabeled: () => getSettings(db).ai.labeledOnly,
    now: opts.now,
    log: opts.log,
  });
  return { core, runner };
}
