import type { CatalogOptions } from './api/catalog-routes';
import { createApp } from './app';
import { CalibreIndexer } from './calibre/indexer';
import { SearchRunner } from './catalog/search-runner';
import { CharCountService } from './counts/count-service';
import { ThumbnailService } from './thumbnails/thumbnails';
import { FatalConfigError, formatTime, loadConfig, LoadedConfig } from './config';
import { initDatabase } from './db/database';
import { scheduleSnapshots, snapshotDir, SnapshotScheduler } from './snapshot';
import { UploadService } from './uploads/service';
import { UploadStore } from './uploads/upload-store';
import { SERVER_VERSION } from './version';

let loaded: LoadedConfig;
try {
  loaded = loadConfig(process.env);
} catch (err) {
  if (err instanceof FatalConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { config, warnings } = loaded;
for (const warning of warnings) console.warn(`Warning: ${warning}`);

// The database is optional for the legacy endpoints: if it can't be opened,
// today's sync keeps working and /api/v1 answers 503.
const database = initDatabase(config.dbDir, config.dataRoot);
if (!database.ok) console.error(`Error: database unavailable: ${database.error}`);

let snapshots: SnapshotScheduler | null = null;
if (database.ok) {
  try {
    snapshots = scheduleSnapshots({
      db: database.db,
      dir: snapshotDir(config.dbDir),
      time: config.snapshotTime,
      keep: config.snapshotKeep,
    });
  } catch (err) {
    console.error('Error: could not schedule database snapshots:', err);
  }
}

// Calibre indexer and thumbnails (WP2). Optional: when CALIBRE_DIR is unset or
// unusable, the catalog routes report it and everything else works.
let indexer: CalibreIndexer | null = null;
let thumbnails: ThumbnailService | null = null;
let counts: CharCountService | null = null;
const catalog: CatalogOptions = {
  thumbnails: null,
  counts: null,
  indexer: { enabled: false, error: 'CALIBRE_DIR is not set' },
};
// Uploads (WP7b): files in DATA_DIR/.uploads, books in an indexed library.
let uploadStore: UploadStore | null = null;
if (database.ok && config.calibre.dir) {
  const store = new UploadStore(config.dataRoot);
  try {
    store.init();
    uploadStore = store;
  } catch (err) {
    console.error('Error: uploads are off, the upload folder is unusable:', err);
  }
}

if (database.ok && config.calibre.dir) {
  try {
    thumbnails = new ThumbnailService({
      db: database.db,
      calibreDir: config.calibre.dir,
      cacheDir: config.calibre.cacheDir,
      concurrency: config.calibre.thumbConcurrency,
      perSecond: config.calibre.thumbPerSecond,
      background: config.calibre.thumbBackground,
      uploads: uploadStore,
    });
    // Character counts (WP3b) are optional too: without the counter the library
    // just shows counts as pending.
    try {
      counts = new CharCountService({
        db: database.db,
        calibreDir: config.calibre.dir,
        config: config.counts,
        uploads: uploadStore,
      });
      console.log(
        `Character counts: ${config.counts.background ? 'on' : 'off (COUNT_BACKGROUND=false)'}, ` +
          `spec ${counts.spec}, counter build ${counts.counter.build}`,
      );
    } catch (err) {
      console.error('Error: character counts are off, the counter is unavailable:', err);
    }
    indexer = new CalibreIndexer({
      db: database.db,
      config: config.calibre,
      dbDir: config.dbDir,
      dataRoot: config.dataRoot,
      thumbnails,
      counts,
    });
    catalog.indexer = indexer.status;
    catalog.thumbnails = thumbnails;
    catalog.counts = counts;
    catalog.calibreDir = config.calibre.dir;
    if (uploadStore) {
      const uploads = new UploadService({
        db: database.db,
        store: uploadStore,
        config: config.uploads,
        calibreDir: config.calibre.dir,
        onAdded: () => {
          thumbnails?.wake();
          counts?.wake();
        },
      });
      uploads.start();
      catalog.uploads = uploads;
      console.log(`Uploads: on, up to ${config.uploads.maxMb} MB, in ${uploadStore.root}`);
    }
    indexer
      .start()
      .catch((err) => console.error('Error: the Calibre indexer could not start:', err));
  } catch (err) {
    console.error('Error: the Calibre indexer could not start:', err);
  }
} else if (!config.calibre.dir) {
  console.log('Calibre indexer is off: CALIBRE_DIR is not set');
}

// Searches with a /regex/ run in a worker thread that can be stopped (WP7a).
const search = database.ok
  ? new SearchRunner({
      db: database.db,
      file: database.file,
      timeoutSeconds: config.search.regexTimeoutSeconds,
      logError: (m, err) => console.error(`Error: ${m}:`, err),
    })
  : null;
catalog.search = search;

const app = createApp({ config, database, version: SERVER_VERSION, catalog });

app.listen(config.port, () => {
  console.log(`ttsu storage server running on port ${config.port}`);
  console.log(`Data root: ${config.dataRoot}`);
  console.log(
    `CORS origin: ${config.corsOrigins === '*' ? '*' : config.corsOrigins.join(', ') || '(none)'}`,
  );
  if (database.ok) {
    console.log(`Database: ${database.file} (schema v${database.schemaVersion})`);
    console.log(
      `Snapshots: daily at ${formatTime(config.snapshotTime)} (TZ=${process.env.TZ ?? 'unset'}), keeping ${config.snapshotKeep}`,
    );
  }
});

// Docker stops containers with SIGTERM; node as PID 1 ignores it by default.
// Close the database cleanly (checkpoints the WAL) and exit.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  snapshots?.stop();
  void indexer?.stop();
  void thumbnails?.stop();
  void counts?.stop();
  void search?.close();
  if (database.ok) {
    try {
      database.db.close();
    } catch (err) {
      console.error('Error closing the database:', err);
    }
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
