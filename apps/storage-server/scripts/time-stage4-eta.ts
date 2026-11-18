/**
 * WP20d: stage 4's status and time left on copies of the live databases.
 *   node -r ts-node/register/transpile-only scripts/time-stage4-eta.ts <bench dir>
 * <bench dir> holds db/cleanup.db, db/ttsu.db and calibre/<library>/metadata.db (copies only).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { performance } from 'perf_hooks';
import { CleanupService } from '../src/cleanup/cleanup-service';

const bench = process.argv[2];
const service = new CleanupService({
  cleanup: new Database(path.join(bench, 'db', 'cleanup.db')),
  main: new Database(path.join(bench, 'db', 'ttsu.db')),
  calibreDir: path.join(bench, 'calibre'),
  cacheDir: path.join(bench, 'cache'),
  indexerEnabled: () => true,
  dbDir: path.join(bench, 'db'),
  log: () => {},
  logError: () => {},
});
const target = service.targetLibrary();
const t = performance.now();
const st = service.stage4Status(target) as Record<string, unknown>;
console.log('status ms', Math.round(performance.now() - t));
console.log('read', JSON.stringify(st.read));
console.log('timeLeft', JSON.stringify(st.timeLeft));
for (const s of st.sites as {
  site: string;
  queued: number;
  done: number;
  secondsPerRequest: number;
  secondsLeft: number;
}[])
  console.log(
    s.site,
    'queued',
    s.queued,
    'done',
    s.done,
    's/req',
    s.secondsPerRequest,
    'left h',
    (s.secondsLeft / 3600).toFixed(1),
  );
process.exit(0);
