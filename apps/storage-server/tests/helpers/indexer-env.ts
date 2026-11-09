import type Database from 'better-sqlite3';
import { createApp } from '../../src/app';
import { CalibreIndexer } from '../../src/calibre/indexer';
import { CalibreConfig } from '../../src/config';
import { initDatabase } from '../../src/db/database';
import { createToken } from '../../src/db/tokens';
import { listUsers } from '../../src/db/users';
import { ThumbnailService } from '../../src/thumbnails/thumbnails';
import { testCalibreConfig, testConfig } from './test-app';

export interface IndexerEnv {
  app: ReturnType<typeof createApp>;
  db: Database.Database;
  indexer: CalibreIndexer;
  thumbnails: ThumbnailService;
  calibre: CalibreConfig;
  logs: string[];
  token: () => string;
  close: () => Promise<void>;
}

/** A server app, database, indexer and thumbnail service wired like src/index.ts. */
export function makeIndexerEnv(
  calibreDir: string,
  overrides: Partial<CalibreConfig> = {},
): IndexerEnv {
  const calibre = testCalibreConfig({ dir: calibreDir, thumbBackground: false, ...overrides });
  const config = testConfig({ calibre });
  const state = initDatabase(config.dbDir, config.dataRoot);
  if (!state.ok) throw new Error(state.error);
  const db = state.db;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const logError = (m: string, err?: unknown) =>
    logs.push(`ERROR ${m}${err ? ` ${(err as Error).message ?? err}` : ''}`);
  const thumbnails = new ThumbnailService({
    db,
    calibreDir,
    cacheDir: calibre.cacheDir,
    concurrency: calibre.thumbConcurrency,
    perSecond: calibre.thumbPerSecond,
    background: calibre.thumbBackground,
    log,
    logError,
  });
  const indexer = new CalibreIndexer({
    db,
    config: calibre,
    dbDir: config.dbDir,
    dataRoot: config.dataRoot,
    thumbnails,
    log,
    logError,
  });
  const app = createApp({
    config,
    database: state,
    version: '9.9.9-test',
    catalog: { thumbnails, indexer: indexer.status },
  });
  return {
    app,
    db,
    indexer,
    thumbnails,
    calibre,
    logs,
    token: () => createToken(db, listUsers(db)[0].id, 'test').token,
    close: async () => {
      await indexer.stop();
      await thumbnails.stop();
      db.close();
    },
  };
}

/** Sets a library's language and enables it (what the user does with the CLI). */
export function enableLibrary(db: Database.Database, folder: string, language = 'ja'): string {
  const row = db.prepare('SELECT id FROM libraries WHERE folder = ?').get(folder) as
    | { id: string }
    | undefined;
  if (!row) throw new Error(`library ${folder} not discovered`);
  db.prepare('UPDATE libraries SET language = ?, enabled = 1 WHERE id = ?').run(language, row.id);
  return row.id;
}
