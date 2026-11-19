/**
 * WP20d: the one-time Bookmeter pass (bookmeterRedoStep) on copies of the live databases, with
 * no fetcher: its steps timed, the longest stretch the event loop was blocked, how many queued
 * searches were pointed at the plain index and how many books ask Bookmeter again.
 *
 *   npx tsx scripts/time-stage4-bookmeter-redo.ts <bench dir> [max steps]
 *
 * <bench dir> as for time-stage4-sweep.ts (db/cleanup.db, db/ttsu.db, cache/calibre/<library>.db,
 * calibre/<library>/metadata.db; copies only).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { CleanupService } from '../src/cleanup/cleanup-service';

const [bench, maxArg] = process.argv.slice(2);
const cleanup = new Database(path.join(bench, 'db', 'cleanup.db'));
const service = new CleanupService({
  cleanup,
  main: new Database(path.join(bench, 'db', 'ttsu.db')),
  calibreDir: path.join(bench, 'calibre'),
  cacheDir: path.join(bench, 'cache'),
  indexerEnabled: () => true,
  dbDir: path.join(bench, 'db'),
  log: (m) => console.log('log:', m),
  logError: (m, e) => console.error(m, e),
});
const a = (
  service as unknown as {
    analysis4: {
      step: (s: () => boolean) => Promise<boolean>;
      progress: () => Record<string, unknown> | null;
    };
  }
).analysis4;
const count = (sql: string) => (cleanup.prepare(sql).get() as { n: number }).n;
const v2Queued = () =>
  count(
    "SELECT COUNT(*) AS n FROM fetch_requests WHERE site = 'bookmeter' AND state = 'queued' AND url LIKE '%type=japanese_v2%'",
  );
const jpQueued = () =>
  count(
    "SELECT COUNT(*) AS n FROM fetch_requests WHERE site = 'bookmeter' AND state = 'queued' AND key LIKE 'search-jp:%'",
  );
(async () => {
  console.log(
    'before: queued old-index searches',
    v2Queued(),
    'new-key searches queued',
    jpQueued(),
    'phase',
    a.progress()?.phase,
  );
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = performance.now();
  const steps: number[] = [];
  const max = Number(maxArg ?? 3000);
  for (let i = 0; i < max; i++) {
    const t = performance.now();
    await a.step(() => false);
    steps.push(performance.now() - t);
    const r = (a.progress() as { bookmeterRedo?: { phase: string } }).bookmeterRedo;
    if (r?.phase === 'done') break;
  }
  h.disable();
  const sorted = [...steps].sort((x, y) => x - y);
  console.log(
    `steps ${steps.length}, total ${Math.round((performance.now() - t0) / 1000)} s, step p50 ${Math.round(sorted[sorted.length >> 1])} ms, max ${Math.round(sorted.at(-1)!)} ms; event loop blocked at most ${Math.round(h.max / 1e6)} ms (p99 ${Math.round(h.percentile(99) / 1e6)} ms)`,
  );
  const p = a.progress() as {
    bookmeterRedo?: unknown;
    times?: Record<string, { ms: number; n: number; max: number }>;
  };
  console.log('pass', JSON.stringify(p.bookmeterRedo));
  for (const [k, v] of Object.entries(p.times ?? {}).filter(
    ([k]) => k.startsWith('bookmeter redo') || k === 'sync slice',
  ))
    console.log(`  ${k}: ${Math.round(v.ms)} ms over ${v.n}, max ${Math.round(v.max)} ms`);
  console.log(
    'after: queued old-index searches',
    v2Queued(),
    'new-key searches queued',
    jpQueued(),
  );
  process.exit(0);
})();
