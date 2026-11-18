/** WP20d: the SQL a cleanup round spends its time on (copies of the live databases). */
import Database from 'better-sqlite3';
import path from 'path';
import { performance } from 'perf_hooks';

const stats = new Map<string, { n: number; ms: number }>();
const proto = (Database as unknown as { prototype: { prepare: (sql: string) => unknown } })
  .prototype;
const origPrepare = proto.prepare;
proto.prepare = function (this: unknown, sql: string) {
  const st = origPrepare.call(this, sql) as Record<string, (...a: unknown[]) => unknown>;
  for (const m of ['get', 'all', 'run', 'iterate']) {
    const f = st[m];
    if (typeof f !== 'function') continue;
    st[m] = (...a: unknown[]) => {
      const t = performance.now();
      try {
        return f.apply(st, a);
      } finally {
        const k = sql.replace(/\s+/g, ' ').slice(0, 160);
        const s = stats.get(k) ?? { n: 0, ms: 0 };
        s.n++;
        s.ms += performance.now() - t;
        stats.set(k, s);
      }
    };
  }
  return st;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CleanupService } = require('../src/cleanup/cleanup-service');
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
(async () => {
  await service.tick();
  stats.clear();
  for (let i = 0; i < 3; i++) await service.tick();
  const top = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10);
  for (const [k, s] of top) console.log(`${(s.ms / 3).toFixed(1)} ms/round  x${s.n / 3}  ${k}`);
  process.exit(0);
})();
