/**
 * More Bookmeter coverage, step 2: the real pass (stage4/bookmeter-more.ts) on a WORKING COPY of
 * a one-step cleanup.db copy, to reproduce step 1's numbers with the new code. Runs the match
 * phase (and with --ai the AI check on the labeled near misses, real models, spending through a
 * working copy of ttsu.db); nothing is fetched (the second search and the store lists stop the
 * run). Never point it at a live database: it migrates and writes the copy it is given.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-more-rehearse.ts --db <working cleanup.db>
 *     --main <working ttsu.db> --metadata <calibre snapshot copy> --cache <folder with fetch/>
 *     --gold <gold800.json> --judged <judged.json> [--ai --ai-key-dir <dir> [--direct]]
 *     [--out <report.json>]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AiCore } from '../src/ai/core';
import { AiRunner } from '../src/ai/runner';
import { AiSecretStore } from '../src/ai/secrets';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { CLEANUP_AI_SOURCE, cleanupFeatureOf } from '../src/cleanup/ai-features';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { getSettings } from '../src/cleanup/settings';
import { loadGold, mapLabeledIds } from '../src/cleanup/stage2-gate';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { judge, type Gold } from '../src/cleanup/stage4/bookmeter-rules';
import {
  BookmeterMore,
  NEAR_SPEC,
  bookmeterAnalysisId,
  type BmHit,
} from '../src/cleanup/stage4/bookmeter-more';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { migrate } from '../src/db/migrations';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

function refuseLive(p: string): void {
  const n = path.resolve(p).toLowerCase();
  if (n.includes(`${path.sep}appdata${path.sep}`) || n.startsWith('\\\\') || n.startsWith('//'))
    throw new Error(`${p}: a working copy on this PC only (never the NAS or a live database)`);
}

async function main() {
  for (const k of ['db', 'main']) refuseLive(arg(k)!);
  const db = new Database(arg('db')!);
  db.pragma('journal_mode = WAL');
  const quiet = console.log;
  console.log = () => undefined;
  try {
    migrateCleanup(db, { beforeAiMove: () => undefined });
  } finally {
    console.log = quiet;
  }
  const main = new Database(arg('main')!);
  console.log = () => undefined;
  try {
    migrate(main);
  } finally {
    console.log = quiet;
  }
  const p4 = getStage(db, 4).progress as unknown as Stage4Progress;
  const lib = p4.libraryId;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-rehearse-'));
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${lib}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('metadata')!, snap);
  const queue = new FetchQueue(db, arg('cache')!, () => getSettings(db).fetch, log);
  const analysis = new Stage4Analysis({
    cleanup: db,
    main,
    calibreDir: '',
    cacheDir,
    dbDir: null,
    queue,
  });
  let runner: AiRunner;
  if (has('ai')) {
    const keyDir = arg('ai-key-dir')!;
    const store = new AiSecretStore(main, keyDir);
    const core = new AiCore({ db: main, dbDir: keyDir, keys: store, log });
    log(
      `keys: anthropic ${store.read('anthropicApiKey') ? 'set' : 'MISSING'}, openai ${store.read('openaiApiKey') ? 'set' : 'MISSING'}; limit ${core.settings().spendLimitUsd ?? 'none'}`,
    );
    if (has('direct')) {
      const modes = { ...core.settings().modes };
      for (const m of [
        getSettings(db).models['stage4.primary'],
        getSettings(db).models['stage4.secondary'],
      ])
        if (m) modes[m] = 'direct';
      core.updateSettings({ modes });
    }
    runner = new AiRunner({
      db,
      core,
      source: CLEANUP_AI_SOURCE,
      featureOf: cleanupFeatureOf,
      modelFor: (task) => getSettings(db).models[task] ?? '',
      onlyLabeled: () => true,
      log,
    });
  } else runner = null as never;
  const pass = new BookmeterMore({
    db,
    analysis,
    queue,
    runner,
    batches: null as never,
    targetLibrary: () => lib,
    stage4Done: () => true,
    writeWait: () => 'rehearsal: nothing is written',
    referenceFile: () => arg('gold') ?? null,
    log,
  });
  db.prepare(`UPDATE bookmeter_more_state SET mode = 'analyse' WHERE id = 1`).run();

  // The match phase, timed per step (the longest step is the longest the server is held).
  const until = has('ai') ? 'second' : 'ai';
  let steps = 0;
  let longest = 0;
  const top: { step: number; ms: number }[] = [];
  const t0 = performance.now();
  for (;;) {
    const s = pass.state().progress;
    // --reask: a finished AI check (version 1) asked again once (NEAR_VERSION 2), then stop.
    if (has('reask')) {
      if ((s.nearVersion ?? 1) >= 2 && s.phase === 'second') break;
    } else {
      if (s.phase === until || s.phase === 'done') break;
      if (s.phase !== 'match' && !has('ai')) break;
    }
    const t = performance.now();
    const r = await pass.step();
    const ms = performance.now() - t;
    if (pass.state().progress.phase === 'match') {
      longest = Math.max(longest, ms);
      top.push({ step: steps, ms });
      top.sort((a, b) => b.ms - a.ms);
      top.length = Math.min(top.length, 8);
    }
    steps++;
    if (steps % 2000 === 0) log(`${pass.state().progress.counts.looked} books looked at`);
    if (r === 'wait') await new Promise((res) => setTimeout(res, has('ai') ? 2000 : 10));
    if (r === 'idle') break;
  }
  const p = pass.state().progress;
  const wall = performance.now() - t0;
  log(
    `match: ${p.counts.looked} books in ${(p.times.match / 1000).toFixed(1)} s of work (${steps} steps, longest match step ${longest.toFixed(1)} ms, wall ${(wall / 1000).toFixed(1)} s)`,
  );
  log(`counts ${JSON.stringify(p.counts)}`);
  log(`longest steps: ${top.map((x) => `#${x.step} ${x.ms.toFixed(0)} ms`).join(', ')}`);

  // The labeled books: the new matches judged like step 1 (judged.json: step 1's look by eye).
  const { gold } = loadGold(arg('gold')!);
  const byCid = new Map<number, Gold>();
  for (const [gid, cid] of mapLabeledIds(db, lib, Object.keys(gold ?? {})))
    byCid.set(cid, (gold as Record<string, unknown>)[gid] as Gold);
  const judged = arg('judged')
    ? (JSON.parse(fs.readFileSync(arg('judged')!, 'utf8')) as {
        wrong: number[];
        unsure: number[];
        artifact: number[];
      })
    : { wrong: [], unsure: [], artifact: [] };
  const rows = db
    .prepare(
      `SELECT calibre_id, state, source, hit_json FROM bookmeter_more_books
       WHERE library_id = ? AND labeled = 1 AND state = 'matched'`,
    )
    .all(lib) as { calibre_id: number; state: string; source: string; hit_json: string }[];
  const flagged: { cid: number; source: string; why: string[]; title: string; result: string }[] =
    [];
  let labeled = 0;
  for (const r of rows) {
    const g = byCid.get(r.calibre_id);
    if (!g) continue;
    labeled++;
    const h = JSON.parse(r.hit_json) as BmHit;
    const j = judge(
      {
        ...h,
        title: h.listTitle ?? h.title,
        full: h.listTitle !== undefined ? h.title : null,
        edOk: true,
      },
      g,
    );
    if (!j.ok)
      flagged.push({
        cid: r.calibre_id,
        source: r.source,
        why: j.why,
        title: g.t,
        result: h.title,
      });
  }
  const bySource = (s: string) => rows.filter((r) => r.source === s && byCid.has(r.calibre_id));
  const wrong = flagged.filter(
    (f) => judged.wrong.includes(f.cid) || judged.unsure.includes(f.cid),
  );
  const artifacts = flagged.filter((f) => judged.artifact.includes(f.cid));
  log(
    `labeled: ${labeled} new matches (rules ${bySource('rules').length}, AI ${bySource('ai').length}); checker flags ${flagged.length}: ${artifacts.length} label artifacts, ${wrong.length} judged wrong or unsure in step 1`,
  );
  for (const f of flagged)
    log(`  flagged ${f.cid} [${f.source}] ${f.why.join('+')}: ${f.title}  →  ${f.result}`);

  // The AI check's labeled answers.
  let ai: unknown = null;
  if (has('ai')) {
    const asked = db
      .prepare(`SELECT COUNT(*) AS n FROM ai_items WHERE stage = ? AND labeled = 1`)
      .get(NEAR_SPEC.stage) as { n: number };
    const cost = db
      .prepare(
        `SELECT model, SUM(cost_usd) AS c, COUNT(*) AS n FROM ai_requests WHERE stage = ? AND run_id = ? GROUP BY model`,
      )
      .all(NEAR_SPEC.stage, bookmeterAnalysisId(p.run));
    ai = { askedLabeled: asked.n, accepted: p.ai.accepted, cost };
    log(`AI: ${JSON.stringify(ai)}`);
  }
  // The second search's books (asked at the deploy; counted here).
  const second = db
    .prepare(
      `SELECT COUNT(*) AS n FROM bookmeter_more_books WHERE library_id = ? AND state = 'second'`,
    )
    .get(lib) as { n: number };
  const report = {
    counts: p.counts,
    times: p.times,
    longestStepMs: longest,
    steps,
    labeled: { matches: labeled, flagged, wrong, artifacts },
    ai,
    secondSearchBooks: second.n,
    storeListsToAsk: p.counts.rules + (p.ai.accepted ?? 0),
  };
  if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  if (runner) await runner.settle();
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
