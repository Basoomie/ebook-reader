/**
 * WP20a test environment: a synthetic Calibre root with a "japanese-library", the reader's
 * database and indexer (holding ingest while a cleanup batch runs, as in src/index.ts),
 * cleanup.db, the CleanupService (no timer) and an app with the cleanup routes.
 */
import type Database from 'better-sqlite3';
import { createApp } from '../../src/app';
import { CalibreIndexer } from '../../src/calibre/indexer';
import { listLibraries, updateLibrary } from '../../src/calibre/libraries';
import { createApplyToken } from '../../src/cleanup/apply-tokens';
import { initCleanupDatabase } from '../../src/cleanup/cleanup-db';
import { CleanupService } from '../../src/cleanup/cleanup-service';
import type { CleanupOptions } from '../../src/cleanup/routes';
import { initDatabase } from '../../src/db/database';
import { createToken } from '../../src/db/tokens';
import { listUsers } from '../../src/db/users';
import { CalibreRoot, type LibraryFixture } from './calibre-fixture';
import { testCalibreConfig, testConfig } from './test-app';

export interface CleanupEnv {
  root: CalibreRoot;
  lib: LibraryFixture;
  db: Database.Database;
  cleanupDb: Database.Database;
  indexer: CalibreIndexer;
  service: CleanupService;
  app: ReturnType<typeof createApp>;
  libraryId: () => string;
  userToken: () => string;
  applyToken: () => string;
  /** Snapshot + ingest now (the indexer's next poll). */
  index: () => Promise<void>;
  /** Writes a synced record for a reader book (reader data). */
  addReaderData: (bookId: string, kind?: string) => void;
  readerBook: (calibreUuid: string) => { bookId: string; missing: boolean } | null;
  logs: string[];
  close: () => Promise<void>;
}

let rev = 1000;

export async function makeCleanupEnv({ leaseSeconds }: { leaseSeconds?: number } = {}): Promise<{
  env: CleanupEnv;
  setup: () => Promise<void>;
}> {
  const root = new CalibreRoot();
  const lib = root.library('japanese-library');
  const calibre = testCalibreConfig({ dir: root.dir, thumbBackground: false });
  const config = testConfig({ calibre });
  const state = initDatabase(config.dbDir, config.dataRoot);
  if (!state.ok) throw new Error(state.error);
  const cleanupState = initCleanupDatabase(config.dbDir);
  if (!cleanupState.ok) throw new Error(cleanupState.error);
  const db = state.db;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const logError = (m: string, err?: unknown) =>
    logs.push(`ERROR ${m}${err ? ` ${(err as Error).message ?? err}` : ''}`);
  // The indexer asks the service (made just below) whether a batch holds the library.
  const indexer = new CalibreIndexer({
    db,
    config: calibre,
    dbDir: config.dbDir,
    dataRoot: config.dataRoot,
    log,
    logError,
    holdIngest: (id) => service.holdsIngest(id),
  });
  const service = new CleanupService({
    cleanup: cleanupState.db,
    main: db,
    calibreDir: root.dir,
    cacheDir: calibre.cacheDir,
    indexerEnabled: () => indexer.status.enabled,
    leaseSeconds,
    log,
    logError,
  });
  const cleanup: CleanupOptions = { service };
  const app = createApp({
    config,
    database: state,
    version: '9.9.9-test',
    catalog: { thumbnails: null, indexer: indexer.status, calibreDir: root.dir },
    cleanup,
  });
  const libraryId = () => {
    const l = listLibraries(db).find((x) => x.folder === 'japanese-library');
    if (!l) throw new Error('library not discovered');
    return l.id;
  };
  const env: CleanupEnv = {
    root,
    lib,
    db,
    cleanupDb: cleanupState.db,
    indexer,
    service,
    app,
    libraryId,
    userToken: () => createToken(db, listUsers(db)[0].id, 'test').token,
    applyToken: () => createApplyToken(cleanupState.db, 'sidecar').token,
    index: async () => {
      lib.age();
      await indexer.checkLibrary(listLibraries(db).find((l) => l.id === libraryId())!);
    },
    addReaderData: (bookId, kind = 'book-favorite') => {
      const user = listUsers(db)[0];
      rev++;
      db.prepare(
        `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
         VALUES (?, ?, ?, ?, 'test-device', ?, NULL, ?, '{"favorite":true}', ?)`,
      ).run(user.id, kind, `${bookId}:${rev}`, bookId, Date.now(), rev, Date.now());
    },
    readerBook: (uuid) => {
      const r = db
        .prepare(
          `SELECT book_id, missing_at FROM book_sources WHERE kind = 'calibre' AND calibre_uuid = ?`,
        )
        .get(uuid) as { book_id: string; missing_at: number | null } | undefined;
      return r ? { bookId: r.book_id, missing: r.missing_at !== null } : null;
    },
    logs,
    close: async () => {
      await service.stop();
      await indexer.stop();
      cleanupState.db.close();
      db.close();
    },
  };
  return {
    env,
    setup: async () => {
      await indexer.start({ timer: false });
      updateLibrary(db, libraryId(), { language: 'ja', enabled: true });
      await env.index();
    },
  };
}

/** A heartbeat in which every sidecar check passes. */
export function healthyHeartbeat(trashRestore = true) {
  const names = [
    'content_server',
    'login',
    'library_found',
    'versions_match',
    'illustrator_column',
    'quarantine_writable',
    'trash_restore',
  ];
  return {
    version: 'test',
    calibredb: 'calibredb (calibre 9.18.0)',
    serverVersion: 'calibre 9.18.0',
    trashRestore,
    checks: names.map((name) => ({ name, ok: name === 'trash_restore' ? trashRestore : true })),
  };
}
