/**
 * WP20d: "Amazon where needed" on copies of the live databases, with no fetcher: the one-time
 * sweep's steps and the decisions it makes, timed, with the longest stretch the event loop
 * was blocked. Counts the books BookWalker settled and the Amazon requests left afterwards.
 *
 *   node -r ts-node/register/transpile-only scripts/time-stage4-sweep.ts <bench dir> [max steps]
 *
 * <bench dir> holds db/cleanup.db, db/ttsu.db, cache/calibre/<library>.db and
 * calibre/<library>/metadata.db (copies only). Answers whose cache file isn't in the bench are
 * read as missing, so a few books' counts can differ from the NAS; the timing doesn't.
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
  log: () => {},
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
const amazonQueued = () =>
  count(
    "SELECT COUNT(*) AS n FROM fetch_requests WHERE site IN ('amazon-dp','amazon-search') AND state = 'queued'",
  );
(async () => {
  console.log('before: amazon queued', amazonQueued(), 'phase', a.progress()?.phase);
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = performance.now();
  const steps: number[] = [];
  const max = Number(maxArg ?? 2000);
  for (let i = 0; i < max; i++) {
    const t = performance.now();
    await a.step(() => false);
    steps.push(performance.now() - t);
    const sw = (a.progress() as { amazonSweep?: { phase: string } }).amazonSweep;
    if (sw?.phase === 'done') break;
  }
  h.disable();
  const sorted = [...steps].sort((x, y) => x - y);
  console.log(
    `steps ${steps.length}, total ${Math.round((performance.now() - t0) / 1000)} s, step p50 ${Math.round(sorted[sorted.length >> 1])} ms, max ${Math.round(sorted.at(-1)!)} ms; event loop blocked at most ${Math.round(h.max / 1e6)} ms (p99 ${Math.round(h.percentile(99) / 1e6)} ms)`,
  );
  const p = a.progress() as {
    amazonSweep?: unknown;
    times?: Record<string, { ms: number; n: number; max: number }>;
  };
  console.log('sweep', JSON.stringify(p.amazonSweep));
  for (const [k, v] of Object.entries(p.times ?? {}).filter(
    ([k]) => k.startsWith('amazon sweep') || k === 'sync slice',
  ))
    console.log(`  ${k}: ${Math.round(v.ms)} ms over ${v.n}, max ${Math.round(v.max)} ms`);
  console.log('after: amazon queued', amazonQueued());
  const ev = cleanup.prepare("SELECT data FROM evidence_records WHERE kind = 'online'").all() as {
    data: Buffer;
  }[];
  const z = await import('zlib');
  let standin = 0;
  let asked = 0;
  let pending = 0;
  for (const r of ev) {
    const e = JSON.parse(z.gunzipSync(r.data).toString()) as {
      amazon: { standin?: string; asked?: boolean };
      open: string[];
    };
    if (e.amazon.standin) standin++;
    else if (e.amazon.asked) asked++;
    else if (e.open.includes('amazon')) pending++;
  }
  console.log({
    books: ev.length,
    settledByBookWalker: standin,
    askedAmazon: asked,
    amazonWaitsForBwOrRdb: pending,
  });
  process.exit(0);
})();
