/**
 * The fixed picker's one-time pass (REPICK_VERSION) and the lookups it reopens, on a working
 * copy of the live cleanup.db, answered from a copy or a read-only share of the fetch cache. No
 * fetcher runs: a request the cache can't answer stays queued and is counted. Writes only the
 * working copy.
 *
 *   npx ts-node --transpile-only scripts/repick-live.ts --db <copy/cleanup.db>
 *     --main <ttsu.db copy> --metadata <metadata.db snapshot copy> --calibre <books folder>
 *     --fetchcache <folder holding fetch/…> [--dbdir <DB_DIR>]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { getSettings } from '../src/cleanup/settings';
import { migrateWorkingCopy } from './lib/cleanup-ai';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

async function main() {
  const file = arg('db')!;
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrateWorkingCopy(db);
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const p0 = getStage(db, 4).progress as unknown as Stage4Progress;
  const cacheDir = path.join(path.dirname(file), 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${p0.libraryId}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  if (!fs.existsSync(snap)) fs.copyFileSync(arg('metadata')!, snap);
  const queue = new FetchQueue(db, arg('fetchcache')!, () => getSettings(db).fetch, log);
  const analysis = new Stage4Analysis({
    cleanup: db,
    main,
    calibreDir: arg('calibre')!,
    cacheDir,
    dbDir: arg('dbdir') ?? null,
    queue,
    log,
  });
  const t0 = Date.now();
  let lastWaiting = -1;
  let still = 0;
  for (;;) {
    const done = await analysis.step(() => false);
    const p = analysis.progress()!;
    const waiting = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM stage4_books WHERE library_id = ? AND state = 'waiting'`,
        )
        .get(p.libraryId) as { n: number }
    ).n;
    if (done) break;
    if (p.repick?.phase === 'done' && p.phase === 'lookups') {
      // Only books whose answers the cache can't give are left: stop when nothing moves.
      if (waiting === lastWaiting) still++;
      else still = 0;
      if (still > 50) break;
    }
    lastWaiting = waiting;
  }
  const p = analysis.progress()!;
  const queued = db
    .prepare(`SELECT site, COUNT(*) AS n FROM fetch_requests WHERE state = 'queued' GROUP BY site`)
    .all();
  log(
    JSON.stringify({
      minutes: (Date.now() - t0) / 60000,
      phase: p.phase,
      repick: p.repick,
      waiting: lastWaiting,
      uncached: queued,
    }),
  );
}

void main();
