/**
 * WP21c follow-up (2), stop 1: audiobook stage 4 decided again on a copy of the live cleanup.db
 * with a copy of the live fetch cache (the audio sites' stored answers). Runs the real stage-4
 * code and the real fetch queue; nothing is fetched: a request the cache lacks stays queued and
 * is counted (the new requests the live run will ask once deployed).
 *
 *   npx vite-node scripts/wp21c-redecide.ts -- --db <cleanup.db copy> --cache <dir holding fetch/>
 *     --labels <labels.json> --out <dir>
 *
 * The stage starts over the way the server does after the deploy (`stage4StartsOver`: the units
 * were built by older code), builds the units, and advances every unit from the stored answers
 * until only units waiting on new requests are left. Reports: counts before and after, every unit
 * whose class or record changes, the new requests by site and kind, the units waiting on them,
 * the gate, and the longest synchronous stretch.
 *
 * WP21c follow-up (3): the records phase (one store record per recording) reads no audio here
 * (Calibre counts as busy, so a pair stage 3 never compared waits): the pairs it still has to
 * compare go to `pairs-to-compare.json`; `--pair-checks <file>` gives their verdicts, measured
 * elsewhere (`scripts/wp21c3-compare.ts`), and the run then goes on to the end.
 * `--answers <json>` ({url: file}) answers new requests with pages fetched by hand (a store
 * record checked in the browser), so a walk can finish here.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { getSettings, AUDIO_FETCH_SITES } from '../src/cleanup/settings';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { scoreOnlineGate, type LabeledBook } from '../src/cleanup/audio/online-gate';
import {
  AudioStage4,
  stage4Counts,
  stage4StartsOver,
  type AudioStage4Progress,
  type UnitInputs,
} from '../src/cleanup/audio/stage4-online';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}

const src = arg('db');
const cacheDir = arg('cache');
const labelsFile = arg('labels');
const out = arg('out');
fs.mkdirSync(out, { recursive: true });
const dbFile = path.join(out, 'cleanup.db');
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });

// A copy of the live file and its WAL taken while Calibre's stage 4 writes is not consistent as
// a whole (decisions.md WP21c: quick_check fails), but its audiobook, fetch and settings tables
// read fine through the WAL. The working database is a fresh one at the same schema, filled from
// those tables (read-only; the copy itself is never changed).
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
migrateCleanup(db);
{
  const t0 = Date.now();
  const from = new Database(src, { readonly: true, fileMustExist: true });
  // Tables are filled in name order, children before parents: the keys are checked at the end.
  db.pragma('foreign_keys = OFF');
  const want = (t: string) => /^(audio_|fetch_)/.test(t) || t === 'settings';
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter(want);
  for (const t of tables) {
    const cols = (from.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    const mine = new Set(
      (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name),
    );
    const use = cols.filter((c) => mine.has(c));
    if (!use.length) continue;
    const list = use.map((c) => `"${c}"`).join(', ');
    const put = db.prepare(
      `INSERT OR REPLACE INTO "${t}" (${list}) VALUES (${use.map(() => '?').join(', ')})`,
    );
    let n = 0;
    try {
      db.prepare(`DELETE FROM "${t}"`).run();
      let batch: unknown[][] = [];
      const flush = db.transaction((rows: unknown[][]) => {
        for (const r of rows) put.run(...r);
      });
      for (const r of from.prepare(`SELECT ${list} FROM "${t}"`).raw().iterate() as Iterable<
        unknown[]
      >) {
        batch.push(r);
        n++;
        if (batch.length >= 5000) {
          flush(batch);
          batch = [];
        }
      }
      flush(batch);
      console.log(`  ${t}: ${n} rows`);
    } catch (e) {
      console.log(`  ${t}: NOT COPIED after ${n} rows (${(e as Error).message})`);
    }
  }
  from.close();
  db.pragma('foreign_keys = ON');
  const orphans = db.pragma('foreign_key_check') as unknown[];
  if (orphans.length)
    throw new Error(`the working copy has ${orphans.length} rows without their parent`);
  db.pragma('wal_checkpoint(TRUNCATE)');
  console.log(
    `working copy of ${src} built in ${Date.now() - t0} ms (cleanup.db v${db.pragma('user_version', { simple: true })})`,
  );
  const qc = db.pragma('quick_check', { simple: true });
  if (qc !== 'ok') throw new Error(`the working copy fails quick_check: ${qc}`);
}

const sites = AUDIO_FETCH_SITES as readonly string[];
const marks = sites.map(() => '?').join(', ');
const lock = new DiskLock();
const readLabels = () => ({ text: fs.readFileSync(labelsFile, 'utf8'), error: null });
// No audio is read: openings and samples come from the stored fingerprints, or the unit waits.
const roots = { torrents: path.join(out, 'no-torrents'), library: path.join(out, 'no-library') };
const tools = {
  ffprobePath: 'ffprobe',
  ffmpegPath: 'ffmpeg',
  fpcalcPath: 'fpcalc',
  faadPath: 'faad',
};
const queue = new FetchQueue(db, cacheDir, () => getSettings(db).fetch);
const stage3 = new AudioStage3({ db, roots, tools, lock, readLabels });
// No audio is read here: a pair stage 3 never compared waits as if Calibre had the disk.
const stage4 = new AudioStage4({
  db,
  roots,
  tools,
  lock,
  queue,
  stage3,
  readLabels,
  calibreBusy: () => true,
});
{
  const i = process.argv.indexOf('--pair-checks');
  if (i >= 0) {
    const checks = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')) as {
      key: string;
      a: string;
      b: string;
      verdict: string;
      scores: unknown;
    }[];
    const put = db.prepare(
      `INSERT OR REPLACE INTO audio_online_pair_checks (pair_key, a_name, b_name, verdict, scores_json, made_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const c of checks)
      put.run(c.key, c.a, c.b, c.verdict, JSON.stringify(c.scores), Date.now());
    console.log(`pair checks given: ${checks.length}`);
  }
}

// Pages fetched by hand for new requests (--answers): given as the fetcher would.
const known: Record<string, string> = (() => {
  const i = process.argv.indexOf('--answers');
  return i >= 0
    ? (JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')) as Record<string, string>)
    : {};
})();
function answerKnown(): number {
  let n = 0;
  for (const r of db.prepare(`SELECT id, url FROM fetch_requests WHERE state = 'queued'`).all() as {
    id: number;
    url: string;
  }[]) {
    const file = known[r.url];
    if (!file) continue;
    const token = `by-hand-${r.id}`;
    db.prepare(
      `UPDATE fetch_requests SET state = 'leased', lease_token = ?, lease_until = ? WHERE id = ?`,
    ).run(token, Date.now() + 60_000, r.id);
    queue.report(r.id, token, {
      status: 200,
      ms: 1,
      error: null,
      body: fs.readFileSync(file),
      encoding: 'identity',
    });
    console.log(`      answered by hand: ${r.url}`);
    n++;
  }
  return n;
}

interface UnitRow {
  unit_key: string;
  name: string;
  labeled: number;
  kind: string;
  class: string | null;
  source: string | null;
  store_id: string | null;
  review_reason: string | null;
  detail: string | null;
  state: string;
  inputs_json: string;
}
const unitsOf = (analysisId: string) =>
  db
    .prepare(
      `SELECT unit_key, name, labeled, kind, class, source, store_id, review_reason, detail, state, inputs_json
       FROM audio_online_units WHERE analysis_id = ?`,
    )
    .all(analysisId) as UnitRow[];

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

async function run(): Promise<void> {
  const before = stage4.progress() as AudioStage4Progress;
  const s3 = stage3.progress() as { analysisId: string };
  const beforeUnits = new Map(unitsOf(before.analysisId).map((u) => [u.unit_key, u]));
  const beforeCounts = stage4Counts(db, before.analysisId);
  const maxIdBefore = (
    db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM fetch_requests').get() as { m: number }
  ).m;
  const queuedBefore = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM fetch_requests WHERE site IN (${marks}) AND state = 'queued'`,
      )
      .get(...sites) as { n: number }
  ).n;
  console.log(
    `before: analysis ${before.analysisId} (${before.phase}), units v${before.unitsVersion ?? 1}, counts ${JSON.stringify(beforeCounts)}; audio requests already queued: ${queuedBefore}`,
  );
  if (!stage4StartsOver(before, s3.analysisId)) throw new Error('expected the stage to start over');

  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const t0 = Date.now();
  stage4.restart();
  console.log('[1/3] units: building (about 3 s on the live run)…');
  const tc = performance.now();
  stage3.loadCopies(s3.analysisId);
  console.log(`      stage 3 copies loaded in ${Math.round(performance.now() - tc)} ms`);
  lag.reset();
  await stage4.step(() => false);
  let p = stage4.progress()!;
  const unitsLag = lag.max / 1e6;
  console.log(
    `      ${p.units} units (lookup ${p.lookupUnits}, none expected ${p.noRecordUnits}, labeled ${p.labeledUnits}) in ${fmt(Date.now() - t0)}; longest delay ${Math.round(unitsLag)} ms`,
  );

  console.log('[2/3] lookups from the stored answers…');
  const tl = Date.now();
  let stepLag = 0;
  let last = -1;
  let still = 0;
  for (let i = 0; i < 5000; i++) {
    await new Promise((r) => setTimeout(r, 5));
    if (answerKnown()) still = 0;
    lag.reset();
    const done = await stage4.step(() => false);
    stepLag = Math.max(stepLag, lag.max / 1e6);
    if (done) break;
    p = stage4.progress()!;
    const open = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM audio_online_units WHERE analysis_id = ? AND kind = 'lookup' AND state IN ('planned', 'ready', 'audio')`,
        )
        .get(p.analysisId) as { n: number }
    ).n;
    const decided = p.decided - p.noRecordUnits;
    if (i % 10 === 0) {
      const rate = decided / Math.max(1, Date.now() - tl);
      const left = rate > 0 ? open / rate : 0;
      console.log(
        `      ${decided}/${p.lookupUnits} decided, ${open} to advance; ${fmt(Date.now() - tl)} so far, about ${fmt(left)} left`,
      );
    }
    // Only units waiting on requests the cache lacks, or pairs waiting to be compared, are left:
    // nothing more can happen here.
    if (open === 0 && (p.phase === 'lookups' || p.phase === 'records')) {
      if (decided === last) still++;
      else still = 0;
      last = decided;
      if (still >= 3) break;
    }
  }
  p = stage4.progress()!;
  console.log(
    `      lookups: ${fmt(Date.now() - tl)}; phase ${p.phase}; longest delay inside a step ${Math.round(stepLag)} ms`,
  );

  console.log('[3/3] report…');
  const after = unitsOf(p.analysisId);
  const afterCounts = stage4Counts(db, p.analysisId);
  const changes: Record<string, unknown>[] = [];
  const rec = (u: UnitRow | undefined) =>
    !u
      ? 'missing'
      : u.state !== 'decided'
        ? `waiting (${u.state})`
        : `${u.class}${u.review_reason ? ` (${u.review_reason})` : ''}${u.source ? ` ${u.source}:${u.store_id}` : ''}`;
  for (const u of after) {
    const b = beforeUnits.get(u.unit_key);
    if (rec(b) !== rec(u))
      changes.push({
        name: u.name,
        labeled: !!u.labeled,
        before: rec(b),
        after: rec(u),
        detail: u.detail,
        path: (JSON.parse(u.inputs_json) as UnitInputs).paths[0],
      });
  }
  for (const k of beforeUnits.keys())
    if (!after.some((u) => u.unit_key === k))
      changes.push({ name: beforeUnits.get(k)!.name, gone: true });
  const fresh = db
    .prepare(
      `SELECT id, site, url, state FROM fetch_requests WHERE id > ? AND site IN (${marks}) ORDER BY id`,
    )
    .all(maxIdBefore, ...sites) as { id: number; site: string; url: string; state: string }[];
  const kindOf = (site: string, url: string) => {
    const u = new URL(url);
    if (site === 'audible')
      return u.searchParams.has('keywords')
        ? 'keyword search'
        : u.searchParams.has('title')
          ? 'title search'
          : u.searchParams.get('response_groups') === 'sample'
            ? 'sample info'
            : 'product';
    if (site === 'kikubon') return u.pathname.includes('search') ? 'search' : 'product';
    if (site === 'audiobookjp') return u.pathname.includes('search') ? 'search' : 'product';
    return 'sample audio';
  };
  const bySite: Record<string, Record<string, number>> = {};
  for (const r of fresh) {
    const k = kindOf(r.site, r.url);
    (bySite[r.site] ??= {})[k] = (bySite[r.site][k] ?? 0) + 1;
  }
  const waitingUnits = after
    .filter((u) => u.kind === 'lookup' && u.state !== 'decided')
    .map((u) => ({
      name: u.name,
      state: u.state,
      waits: (
        db
          .prepare(
            `SELECT r.site, r.url FROM audio_fetch_waiters w JOIN fetch_requests r ON r.id = w.request_id WHERE w.unit_key = ?`,
          )
          .all(u.unit_key) as { site: string; url: string }[]
      ).map((w) => `${w.site} ${decodeURIComponent(w.url.replace(/\+/g, ' '))}`),
    }));
  const toCompare = stage4.pairsToCompare();
  {
    const a = getSettings(db).audiobooks;
    fs.writeFileSync(
      path.join(out, 'pairs-to-compare.json'),
      JSON.stringify(
        {
          windows: {
            windowSeconds: a.dupWindowSeconds,
            shiftSeconds: a.dupShiftSeconds,
            middleSearchMinutes: a.dupMiddleSearchMinutes,
          },
          same: a.dupSameScore,
          pairs: toCompare,
        },
        null,
        1,
      ),
    );
  }
  console.log(`pairs still to compare (no audio read here): ${toCompare.length}`);
  for (const t of toCompare) console.log(`   ${t.a.name}  <>  ${t.b.name}`);
  console.log(`records phase: ${JSON.stringify(p.records ?? null)}`);
  const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8')) as { books: LabeledBook[] };
  const gate = scoreOnlineGate(labels.books, stage4.unitFinder(p));

  // --assume-empty: the follow-up requests if every new request finds nothing (an empty search,
  // a product that isn't sold), wave by wave until every unit is decided. A bound for planning:
  // a search that finds something also reads up to 2 Audible records / 3 store pages per hit list.
  const waves: number[] = [];
  if (process.argv.includes('--assume-empty')) {
    const empty = (site: string) =>
      Buffer.from(site === 'audible' ? '{"products":[]}' : '<html><body></body></html>');
    for (let w = 0; w < 20; w++) {
      const q = db
        .prepare(
          `SELECT id, site FROM fetch_requests WHERE site IN (${marks}) AND state = 'queued'`,
        )
        .all(...sites) as { id: number; site: string }[];
      if (!q.length) break;
      waves.push(q.length);
      for (const r of q) {
        const token = `assume-empty-${r.id}`;
        db.prepare(
          `UPDATE fetch_requests SET state = 'leased', lease_token = ?, lease_until = ? WHERE id = ?`,
        ).run(token, Date.now() + 60_000, r.id);
        queue.report(r.id, token, {
          status: 200,
          ms: 1,
          error: null,
          body: empty(r.site),
          encoding: 'identity',
        });
      }
      for (let i = 0; i < 200; i++) if (await stage4.step(() => false)) break;
    }
    const pe = stage4.progress()!;
    console.log(
      `assume-empty: requests per wave ${JSON.stringify(waves)} (total ${waves.reduce((a, b) => a + b, 0)}); phase ${pe.phase}; counts ${JSON.stringify(stage4Counts(db, pe.analysisId))}`,
    );
  }
  const report = {
    source: src,
    before: {
      analysisId: before.analysisId,
      unitsVersion: before.unitsVersion ?? 1,
      counts: beforeCounts,
    },
    after: { analysisId: p.analysisId, phase: p.phase, counts: afterCounts, records: p.records },
    pairsToCompare: toCompare.map((t) => [t.a.name, t.b.name]),
    timing: {
      unitsMs: p.phaseTimes.units?.ms ?? null,
      lookupsWallMs: Date.now() - tl,
      longestDelayUnitsMs: Math.round(unitsLag),
      longestDelayLookupsMs: Math.round(stepLag),
    },
    newRequests: {
      total: fresh.length,
      bySite,
      list: fresh.map((r) => `${r.site} ${decodeURIComponent(r.url.replace(/\+/g, ' '))}`),
    },
    waitingUnits,
    changes,
    assumeEmptyWaves: waves,
    gate: {
      passed: gate.passed,
      checked: gate.checked,
      misses: gate.misses,
      bySource: gate.bySource,
    },
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 1));
  console.log('counts before:', JSON.stringify(beforeCounts));
  console.log('counts after: ', JSON.stringify(afterCounts));
  console.log(`new requests: ${fresh.length}`, JSON.stringify(bySite));
  console.log(`units waiting on them: ${waitingUnits.length}`);
  console.log(`units whose class or record changes: ${changes.length}`);
  for (const c of changes) console.log('  ', JSON.stringify(c));
  console.log(
    `GATE passed=${gate.passed} checked=${gate.checked} misses=${gate.misses.length}`,
    JSON.stringify(gate.bySource),
  );
  for (const m of gate.misses) console.log('  MISS', JSON.stringify(m));
  console.log(`report: ${path.join(out, 'report.json')}`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.close());
