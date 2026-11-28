/**
 * The storage server's stalls (2026-11-26), timed the way the live server is driven: the built
 * server runs on copies of the live databases under a CPU profiler, a stand-in fetch container
 * answers the cleanup's fetch queue at the queue's own pace (a store page for every store page
 * asked, "not found" for every other), and the health check is asked every 2 s with a 5 s
 * timeout, as Docker does. Everything stops at the end.
 *
 *   npx ts-node --transpile-only scripts/health-stalls-drive.ts <dist folder> <copies folder> <minutes> <out prefix>
 *
 * The copies folder holds ttsu.db and cleanup.db (copies, never the live files) and cache/.
 * CALIBRE_DIR is unset (the indexer is off) and nothing leaves the PC: the Natively reader is off,
 * and the copies have no AI or notification keys.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';

type Claimed = { id: number; site: string; url?: string; leaseToken: string };
type Timed = { at: number; ms: number; ok: boolean };

(async () => {
  const [dist, copies, minutesArg, outPrefix] = process.argv.slice(2);
  const minutes = Number(minutesArg);
  const PORT = 3971;
  const base = `http://127.0.0.1:${PORT}/api/v1`;
  const fixtures = path.resolve(__dirname, '../tests/fixtures/store-ratings');
  const page = (f: string) => fs.readFileSync(path.join(fixtures, f));
  const PAGES: Record<string, Buffer> = {
    'amazon-dp': page('amazon-rated-1.html'),
    bookwalker: page('bookwalker-rated.html'),
    bookmeter: page('bookmeter-6826860.html'),
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATA_DIR: path.join(copies, 'data'),
    DB_DIR: copies,
    CACHE_DIR: path.join(copies, 'cache'),
    PORT: String(PORT),
    NATIVELY_LEVELS: '0',
    SNAPSHOT_TIME: '23:59',
    TZ: 'America/Phoenix',
  };
  delete env.CALIBRE_DIR;
  fs.mkdirSync(env.DATA_DIR!, { recursive: true });

  // A fetch token on the copy (the server's own CLI).
  const tokenOut = execFileSync(
    process.execPath,
    [path.join(dist, 'cli.js'), 'token', 'fetch', 'stand-in'],
    {
      env,
      encoding: 'utf8',
    },
  );
  const token = tokenOut.trim().split(/\r?\n/).pop().trim();

  // The server, profiled from inside (a wrapper starts the profiler, then the server).
  const wrapper = path.join(copies, 'profiled-server.cjs');
  fs.writeFileSync(
    wrapper,
    `const inspector = require('inspector'); const fs = require('fs');
const s = new inspector.Session(); s.connect();
s.post('Profiler.enable', () => s.post('Profiler.setSamplingInterval', { interval: 1000 }, () => s.post('Profiler.start', () => {
  require(${JSON.stringify(path.join(dist, 'index.js'))});
  setTimeout(() => s.post('Profiler.stop', (e, r) => {
    fs.writeFileSync(${JSON.stringify(`${outPrefix}.cpuprofile`)}, JSON.stringify(r.profile));
    process.exit(0);
  }), ${Math.round(minutes * 60_000 + 30_000)});
})));`,
  );
  const server = spawn(process.execPath, [wrapper], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(`${outPrefix}.server.log`);
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  const exited = new Promise((r) => server.on('exit', r));

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (i > 600) throw new Error('the server did not start');
    await sleep(500);
  }
  const startedAt = Date.now();
  const endAt = startedAt + minutes * 60_000;
  console.log(`server up; driving for ${minutes} min`);

  // ---- the stand-in fetch container
  const auth = { authorization: `Bearer ${token}` };
  const fetcherId = 'stand-in-1';
  let answered = 0;
  let ratingsAnswered = 0;
  const post = (p: string, body: BodyInit, headers: Record<string, string> = {}) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, ...headers }, body });
  async function fetcher() {
    let lastBeat = 0;
    while (Date.now() < endAt) {
      try {
        if (Date.now() - lastBeat > 30_000) {
          await post('/cleanup-fetch/heartbeat', JSON.stringify({ fetcherId, version: '9.9.9' }), {
            'content-type': 'application/json',
          });
          lastBeat = Date.now();
        }
        const r = await (
          await post('/cleanup-fetch/claim', JSON.stringify({ fetcherId }), {
            'content-type': 'application/json',
          })
        ).json();
        for (const c of (r.requests ?? []) as Claimed[]) {
          // A page takes about a second to fetch through the VPN.
          void (async () => {
            await sleep(400 + Math.random() * 1200);
            // A store page (store ratings' requests, and stage 4's of the same pages).
            const ours = /amazon\.co\.jp\/dp\/|bookwalker\.jp\/de|bookmeter\.com\/books\/\d+$/.test(
              String(c.url ?? ''),
            );
            const body = ours
              ? brotliCompressSync(PAGES[c.site] ?? PAGES.bookmeter)
              : Buffer.alloc(0);
            await post(`/cleanup-fetch/answers/${c.id}`, body, {
              'content-type': 'application/octet-stream',
              'x-lease-token': c.leaseToken,
              'x-status': ours ? '200' : '404',
              'x-ms': '900',
              'x-encoding': 'br',
            }).catch(() => {});
            answered++;
            if (ours) ratingsAnswered++;
          })();
        }
        const waitMs = typeof r.waitMs === 'number' ? r.waitMs : 1000;
        await sleep(Math.max(20, Math.min(waitMs, 1000)));
      } catch {
        await sleep(2000);
      }
    }
  }

  // ---- the health check, as Docker asks it
  const health: Timed[] = [];
  async function healthPoll() {
    while (Date.now() < endAt) {
      const t = performance.now();
      let ok = false;
      try {
        ok = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).ok;
      } catch {
        // timed out: counted as failed
      }
      health.push({ at: Date.now() - startedAt, ms: performance.now() - t, ok });
      await sleep(2000);
    }
  }

  // ---- a large request body, as the apply sidecar uploads an EPUB: 20 MB every 30 s to a route
  // that reads the whole body before it answers (the fetch answers route; the lease is wrong, so
  // the answer is refused and nothing is saved).
  const uploads: Timed[] = [];
  const BODY = Buffer.alloc(20 * 1024 * 1024, 7);
  async function uploadPoll() {
    while (Date.now() < endAt) {
      const t = performance.now();
      let ok = false;
      try {
        ok =
          (
            await fetch(`${base}/cleanup-fetch/answers/999999999`, {
              method: 'POST',
              headers: {
                ...auth,
                'content-type': 'application/octet-stream',
                'x-lease-token': 'x',
              },
              body: BODY,
              signal: AbortSignal.timeout(300_000),
            })
          ).status < 500;
      } catch {
        // timed out: counted as failed
      }
      uploads.push({ at: Date.now() - startedAt, ms: performance.now() - t, ok });
      await sleep(30_000);
    }
  }

  await Promise.all([fetcher(), healthPoll(), uploadPoll()]);
  await exited;

  const ms = health.map((h) => h.ms).sort((a, b) => a - b);
  const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  const summary = {
    checks: health.length,
    failed: health.filter((h) => !h.ok).length,
    over1s: health.filter((h) => h.ms > 1000).length,
    median: Math.round(q(0.5)),
    p95: Math.round(q(0.95)),
    max: Math.round(ms[ms.length - 1]),
    answered,
    ratingsAnswered,
    uploads20MB: uploads.map((u) => Math.round(u.ms)),
  };
  fs.writeFileSync(
    `${outPrefix}.health.json`,
    JSON.stringify({ summary, health, uploads }, null, 1),
  );
  console.log(JSON.stringify(summary));
})();
