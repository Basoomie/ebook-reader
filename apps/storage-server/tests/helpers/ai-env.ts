/**
 * The shared AI layer for tests: a ttsu.db with its migrations in a temp folder, an AiCore on
 * it (stand-in providers and keys, a fixed time zone), and the cleanup's runner on a cleanup.db.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { AiCore, type AiCoreDeps } from '../../src/ai/core';
import { AiRunner, type AiRunnerDeps } from '../../src/ai/runner';
import { CLEANUP_AI_SOURCE, cleanupFeatureOf } from '../../src/cleanup/ai-features';
import { getSettings } from '../../src/cleanup/settings';
import { migrate } from '../../src/db/migrations';
import { makeTempDir } from './spawn-server';

export function makeAiCore(
  o: Partial<Omit<AiCoreDeps, 'db' | 'dbDir'>> & { dir?: string; db?: Database.Database } = {},
): { core: AiCore; db: Database.Database; dir: string } {
  const dir = o.dir ?? makeTempDir('ai-core');
  const db = o.db ?? new Database(path.join(dir, 'ttsu.db'));
  if (!o.db) migrate(db);
  const core = new AiCore({
    db,
    dbDir: dir,
    providers: o.providers,
    keys: o.keys,
    now: o.now,
    timeZone: o.timeZone ?? (() => 'UTC'),
    log: o.log,
  });
  return { core, db, dir };
}

/** The cleanup's runner (as CleanupService makes it) on a cleanup.db and a core. */
export function cleanupRunner(
  cleanupDb: Database.Database,
  core: AiCore,
  extra: Partial<Pick<AiRunnerDeps, 'now' | 'sleep' | 'log'>> = {},
): AiRunner {
  return new AiRunner({
    db: cleanupDb,
    core,
    source: CLEANUP_AI_SOURCE,
    featureOf: cleanupFeatureOf,
    modelFor: (task) => getSettings(cleanupDb).models[task] ?? '',
    onlyLabeled: () => getSettings(cleanupDb).ai.labeledOnly,
    ...extra,
  });
}
