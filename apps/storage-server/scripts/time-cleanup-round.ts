/**
 * WP20d: times one cleanup round (tick) and its parts on copies of the live databases.
 *   node -r ts-node/register/transpile-only scripts/time-cleanup-round.ts <bench dir> <rounds>
 * <bench dir> holds db/cleanup.db, db/ttsu.db and calibre/<library>/metadata.db (copies only).
 */
import Database from 'better-sqlite3';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { CleanupService } from '../src/cleanup/cleanup-service';

const [bench, roundsArg] = process.argv.slice(2);
const cleanup = new Database(path.join(bench, 'db', 'cleanup.db'));
const main = new Database(path.join(bench, 'db', 'ttsu.db'));
const service = new CleanupService({
  cleanup,
  main,
  calibreDir: path.join(bench, 'calibre'),
  cacheDir: path.join(bench, 'cache'),
  indexerEnabled: () => true,
  dbDir: path.join(bench, 'db'),
  log: () => {},
  logError: () => {},
});
const svc = service as unknown as Record<string, (...a: unknown[]) => unknown>;
const times: Record<string, number[]> = {};
for (const name of ['round1', 'round2', 'round3', 'round4']) {
  const orig = svc[name].bind(service);
  svc[name] = (...a: unknown[]) => {
    const t = performance.now();
    const r = orig(...a);
    const done = () => (times[name] ??= []).push(performance.now() - t);
    if (r && typeof (r as Promise<unknown>).then === 'function')
      return (r as Promise<unknown>).finally(done);
    done();
    return r;
  };
}
async function main2() {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const all: number[] = [];
  for (let i = 0; i < Number(roundsArg); i++) {
    const t = performance.now();
    await service.tick();
    all.push(performance.now() - t);
  }
  h.disable();
  console.log('tick ms', all.map((x) => Math.round(x)).join(' '));
  for (const [k, v] of Object.entries(times)) console.log(k, v.map((x) => Math.round(x)).join(' '));
  console.log(
    'event loop max block',
    Math.round(h.max / 1e6),
    'ms, p50',
    Math.round(h.percentile(50) / 1e6),
    'ms',
  );
  process.exit(0);
}
void main2();
