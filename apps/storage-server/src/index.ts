import type { CatalogOptions } from './api/catalog-routes';
import { createApp } from './app';
import { CalibreIndexer } from './calibre/indexer';
import { ThumbnailService } from './thumbnails/thumbnails';
import { FatalConfigError, formatTime, loadConfig, LoadedConfig } from './config';
import { initDatabase } from './db/database';
import { scheduleSnapshots, snapshotDir, SnapshotScheduler } from './snapshot';
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
const catalog: CatalogOptions = {
  thumbnails: null,
  indexer: { enabled: false, error: 'CALIBRE_DIR is not set' },
};
if (database.ok && config.calibre.dir) {
  try {
    thumbnails = new ThumbnailService({
      db: database.db,
      calibreDir: config.calibre.dir,
      cacheDir: config.calibre.cacheDir,
      concurrency: config.calibre.thumbConcurrency,
      perSecond: config.calibre.thumbPerSecond,
      background: config.calibre.thumbBackground,
    });
    indexer = new CalibreIndexer({
      db: database.db,
      config: config.calibre,
      dbDir: config.dbDir,
      dataRoot: config.dataRoot,
      thumbnails,
    });
    catalog.indexer = indexer.status;
    catalog.thumbnails = thumbnails;
    indexer
      .start()
      .catch((err) => console.error('Error: the Calibre indexer could not start:', err));
  } catch (err) {
    console.error('Error: the Calibre indexer could not start:', err);
  }
} else if (!config.calibre.dir) {
  console.log('Calibre indexer is off: CALIBRE_DIR is not set');
}

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
