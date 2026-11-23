/**
 * The whole run a stage-4 deploy causes, on a working copy of the live cleanup.db, before the
 * deploy (the user, 2026-11-22: "Why are you not finding these issues before deploying and
 * running the live preview?"): the one-time passes, the lookups (answered from the fetch cache;
 * a request it can't answer is counted), the final pass, then the AI step with the real models
 * (the copy's keys; asked only where the evidence changed, within --limit dollars), decide,
 * spelling, series and gate. Reports the book states, the open proposals by field, class and rules
 * version, the gate and the cost. Writes only the working copy.
 *
 *   npx ts-node --transpile-only scripts/stage4-rehearse.ts --db <live cleanup.db copy>
 *     --work <work dir> --main <ttsu.db snapshot> --ai-key-dir <dir with ai-secrets.key>
 *     --metadata <metadata.db snapshot> --calibre <books folder> --fetchcache <dir with fetch/>
 *     --dbdir <DB_DIR with cleanup/reference-sample> [--limit 6] --out <report.json>
 */
import Database from 'better-sqlite3';
import fs, { writeFileSync } from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { Stage4Ai } from '../src/cleanup/stage4/ai-step';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { cleanupAi, migrateWorkingCopy, readAiSeed } from './lib/cleanup-ai';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function states(db: Database.Database) {
  return db
    .prepare('SELECT state, error, COUNT(*) AS n FROM stage4_books GROUP BY state, error')
    .all();
}
function proposals(db: Database.Database) {
  return db
    .prepare(
      `SELECT field, class, json_extract(evidence_json, '$.rules') AS rules, COUNT(*) AS n
       FROM proposed_changes WHERE stage = 4 AND state = 'proposed' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
    )
    .all();
}

async function main() {
  const work = arg('work')!;
  fs.mkdirSync(work, { recursive: true });
  const file = path.join(work, 'cleanup.db');
  const reuse = process.argv.includes('--reuse');
  if (!reuse) {
    for (const x of [file, file + '-wal', file + '-shm']) fs.rmSync(x, { force: true });
    fs.copyFileSync(arg('db')!, file);
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const seed = readAiSeed(db, main, arg('ai-key-dir') ?? null);
  migrateWorkingCopy(db);
  log(
    `keys: anthropic ${seed.keys.anthropicApiKey ? 'set' : 'MISSING'}, openai ${seed.keys.openaiApiKey ? 'set' : 'MISSING'}`,
  );
  const { core, runner } = cleanupAi(db, { seed, log });
  core.updateSettings({ spendLimitUsd: Number(arg('limit') ?? 6) });
  const p0 = getStage(db, 4).progress as unknown as Stage4Progress;
  const cacheDir = path.join(work, 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${p0.libraryId}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  if (!reuse || !fs.existsSync(snap)) fs.copyFileSync(arg('metadata')!, snap);
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
  const ai = new Stage4Ai({ db, runner, analysis, log });
  const before = { states: states(db), proposals: proposals(db) };
  const t0 = Date.now();

  // The analysis: one-time passes, lookups (cache only), final pass.
  let lastWaiting = -1;
  let still = 0;
  let uncached = false;
  const givenUp: string[] = [];
  for (;;) {
    const done = await analysis.step(() => false);
    if (done) break;
    const p = analysis.progress()!;
    const waiting = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM stage4_books WHERE library_id = ? AND state IN ('waiting', 'read', 'ready')`,
        )
        .get(p.libraryId) as { n: number }
    ).n;
    if (p.phase === 'lookups') {
      if (waiting === lastWaiting) still++;
      else still = 0;
      if (still > 200) {
        // Requests the cache can't answer (no fetcher runs here): taken as given up by the site,
        // counted, and the run goes on (an author reading or two; a book page would be listed).
        const queued = db
          .prepare(`SELECT id, site, key FROM fetch_requests WHERE state IN ('queued', 'leased')`)
          .all() as { id: number; site: string; key: string }[];
        if (!queued.length) {
          uncached = true;
          log(`lookups: nothing moves and nothing is queued: stopping`);
          break;
        }
        givenUp.push(...queued.map((q) => `${q.site} ${q.key}`));
        log(`lookups: ${queued.length} requests the cache can't answer taken as given up`);
        const now = Date.now();
        for (const q of queued)
          db.prepare(
            `UPDATE fetch_requests SET state = 'gone', status = 404, outcome = 'rehearsal: not in the cache', finished_at = ?, updated_at = ? WHERE id = ?`,
          ).run(now, now, q.id);
        db.prepare(
          `UPDATE fetch_waiters SET ready = 1 WHERE request_id IN (${queued.map((q) => q.id).join(',')})`,
        ).run();
        still = 0;
      }
      // Author readings asked in a request the cache couldn't answer: none found (on the NAS the
      // request is answered).
      if (still > 150) {
        const stuck = db
          .prepare(
            `UPDATE author_readings SET state = 'none', updated_at = ? WHERE state = 'asked'
             AND request_id IN (SELECT id FROM fetch_requests WHERE state = 'gone')`,
          )
          .run(Date.now()).changes;
        if (stuck) {
          givenUp.push(`author readings taken as none: ${stuck}`);
          log(
            `lookups: ${stuck} author readings whose request the cache couldn't answer taken as none`,
          );
          still = 0;
        }
      }
    }
    lastWaiting = waiting;
  }
  const afterAnalysis = states(db);
  log(`analysis: ${JSON.stringify(afterAnalysis)}`);
  if (uncached) {
    writeFileSync(
      arg('out')!,
      JSON.stringify(
        {
          stoppedAt: 'lookups',
          before,
          afterAnalysis,
          uncached: db
            .prepare(
              `SELECT site, COUNT(*) AS n FROM fetch_requests WHERE state = 'queued' GROUP BY site`,
            )
            .all(),
        },
        null,
        1,
      ),
    );
    return;
  }

  // The AI step: evidence, models (real), decide, spelling, series, gate.
  for (;;) {
    const phase = ai.progress()?.phase ?? 'none';
    const r = await ai.step(() => false);
    const a = ai.progress()!;
    if (a.phase !== phase) log(`AI: ${phase} -> ${a.phase}`);
    if (r === 'done' && a.phase === 'done') break;
    if (r === 'wait') {
      const st = getStage(db, 4);
      if (st.pauseReason) {
        log(`paused: ${st.pauseReason} ${st.pauseDetail ?? ''}`);
        break;
      }
      log(`${a.phase} ${JSON.stringify(a.ai)}`);
      await sleep(30_000);
    }
  }
  const a = ai.progress()!;
  const report = {
    minutes: (Date.now() - t0) / 60000,
    before,
    after: { states: states(db), proposals: proposals(db) },
    gate: a.gate,
    ai: a.ai,
    cost: a.cost,
    seriesOrder: { ...a.seriesOrder, checks: { ...a.seriesOrder?.checks, examples: undefined } },
    repick: (getStage(db, 4).progress as unknown as Stage4Progress).repick,
    givenUp,
  };
  writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  log(
    JSON.stringify({
      minutes: report.minutes,
      gatePassed: a.gate?.passed,
      cost: a.cost?.costUsd,
      states: report.after.states,
    }),
  );
}

void main();
