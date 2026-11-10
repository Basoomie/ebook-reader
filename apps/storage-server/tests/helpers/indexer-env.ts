import type Database from 'better-sqlite3';
import { createApp } from '../../src/app';
import { CalibreIndexer } from '../../src/calibre/indexer';
import { SearchRunner } from '../../src/catalog/search-runner';
import type { CalibreConfig, CountsConfig, ServerConfig } from '../../src/config';
import { CharCountService } from '../../src/counts/count-service';
import { initDatabase } from '../../src/db/database';
import { createToken } from '../../src/db/tokens';
import { listUsers } from '../../src/db/users';
import { ThumbnailService } from '../../src/thumbnails/thumbnails';
import { UploadService } from '../../src/uploads/service';
import { UploadStore } from '../../src/uploads/upload-store';
import { testCalibreConfig, testConfig } from './test-app';

export interface IndexerEnv {
  app: ReturnType<typeof createApp>;
  db: Database.Database;
  indexer: CalibreIndexer;
  thumbnails: ThumbnailService;
  counts: CharCountService;
  search: SearchRunner;
  calibre: CalibreConfig;
  config: ServerConfig;
  /** Present when made with `uploads: true` (WP7b). */
  uploads: UploadService | null;
  logs: string[];
  token: () => string;
  close: () => Promise<void>;
}

/** A server app, database, indexer and thumbnail service wired like src/index.ts. */
export function makeIndexerEnv(
  calibreDir: string,
  overrides: Partial<CalibreConfig> = {},
  serverOverrides: Partial<ServerConfig> = {},
  countOptions: { config?: Partial<CountsConfig>; counterFile?: string } = {},
  { seedDefaults = false, uploads = false }: { seedDefaults?: boolean; uploads?: boolean } = {},
): IndexerEnv {
  const calibre = testCalibreConfig({ dir: calibreDir, thumbBackground: false, ...overrides });
  const config = testConfig({ calibre, ...serverOverrides });
  config.counts = { ...config.counts, ...countOptions.config };
  const state = initDatabase(config.dbDir, config.dataRoot);
  if (!state.ok) throw new Error(state.error);
  const db = state.db;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const logError = (m: string, err?: unknown) =>
    logs.push(`ERROR ${m}${err ? ` ${(err as Error).message ?? err}` : ''}`);
  let uploadStore: UploadStore | null = null;
  if (uploads) {
    uploadStore = new UploadStore(config.dataRoot);
    uploadStore.init();
  }
  const thumbnails = new ThumbnailService({
    db,
    calibreDir,
    cacheDir: calibre.cacheDir,
    concurrency: calibre.thumbConcurrency,
    perSecond: calibre.thumbPerSecond,
    background: calibre.thumbBackground,
    uploads: uploadStore,
    log,
    logError,
  });
  const counts = new CharCountService({
    db,
    calibreDir,
    config: config.counts,
    counterFile: countOptions.counterFile,
    uploads: uploadStore,
    log,
    logError,
  });
  const indexer = new CalibreIndexer({
    db,
    config: calibre,
    dbDir: config.dbDir,
    dataRoot: config.dataRoot,
    thumbnails,
    counts,
    log,
    logError,
  });
  const search = new SearchRunner({
    db,
    file: state.file,
    timeoutSeconds: config.search.regexTimeoutSeconds,
    logError,
  });
  const uploadService = uploadStore
    ? new UploadService({
        db,
        store: uploadStore,
        config: config.uploads,
        calibreDir,
        onAdded: () => {
          thumbnails.wake();
          counts.wake();
        },
        log,
        logError,
      })
    : null;
  const app = createApp({
    config,
    database: state,
    version: '9.9.9-test',
    catalog: {
      thumbnails,
      counts,
      indexer: indexer.status,
      calibreDir,
      search,
      uploads: uploadService,
    },
    seedDefaults,
  });
  return {
    app,
    db,
    indexer,
    thumbnails,
    counts,
    search,
    calibre,
    config,
    uploads: uploadService,
    logs,
    token: () => createToken(db, listUsers(db)[0].id, 'test').token,
    close: async () => {
      await indexer.stop();
      await thumbnails.stop();
      await counts.stop();
      await search.close();
      uploadService?.stop();
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
