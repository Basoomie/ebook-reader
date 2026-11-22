/**
 * WP21d stop 1: stage 5 on a working copy of the live cleanup.db, with the real code. Reads the
 * API keys from the copy (their encryption key from a copy of ttsu.db; never printed).
 *
 *   --estimate         build the evidence and print the expected cost (nothing is asked)
 *   --smoke N          first N labeled recordings, one call each (checks the model ids and the
 *                      answer format), then stops
 *   --run              the labeled books through the Batch API (labeledOnly), to the end
 *   --limit USD        spending limit written into the copy (default 1)
 *
 *   npx ts-node --transpile-only scripts/wp21d-live.ts --db <copy/cleanup.db> --work <work.db> [--reuse]
 *     --main <copy/ttsu.db> --labels <labels.json> [--estimate | --smoke 5 | --run] [--out report.json]
 */
import Database from 'better-sqlite3';
import fs, { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { AiRunner } from '../src/ai/runner';
import { valueCounts } from '../src/cleanup/ai-decide/values';
import { costOf } from '../src/ai/spend';
import { AudioStage5 } from '../src/cleanup/audio/stage5-meta';
import { META_SPEC } from '../src/cleanup/audio/meta-prompt';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { SecretStore } from '../src/cleanup/secrets';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { getAudioStage } from '../src/cleanup/audio/audio-stages';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toLocaleTimeString();

/** A fresh cleanup.db at this schema, filled from the copy's audio, settings and secrets tables. */
function workingCopy(src: string, out: string): Database.Database {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  for (const x of [out, out + '-wal', out + '-shm']) fs.rmSync(x, { force: true });
  const db = new Database(out);
  db.pragma('journal_mode = WAL');
  migrateCleanup(db);
  const from = new Database(src, { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = OFF');
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
      name: string;
    }[]
  )
    .map((r) => r.name)
    .filter(
      (t) =>
        (/^audio_/.test(t) && t !== 'audio_fetch_waiters') || t === 'settings' || t === 'secrets',
    );
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
    db.prepare(`DELETE FROM "${t}"`).run();
    let rows: unknown[][] = [];
    let n = 0;
    const flush = db.transaction((rs: unknown[][]) => {
      for (const r of rs) put.run(...r);
    });
    for (const r of from.prepare(`SELECT ${list} FROM "${t}"`).raw().iterate() as Iterable<
      unknown[]
    >) {
      rows.push(r);
      n++;
      if (rows.length >= 5000) {
        flush(rows);
        rows = [];
      }
    }
    flush(rows);
    console.log(`  ${t}: ${n} rows`);
  }
  from.close();
  // Stage 5's row (v13) is not in the copy.
  db.prepare('INSERT OR IGNORE INTO audio_stages (stage, updated_at) VALUES (5, 0)').run();
  db.pragma('foreign_keys = ON');
  const orphans = db.pragma('foreign_key_check') as unknown[];
  if (orphans.length) throw new Error(`${orphans.length} rows without their parent`);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db;
}

async function main() {
  const out = arg('work')!;
  const db = has('reuse') ? new Database(out) : workingCopy(arg('db')!, out);
  console.log(
    `working copy v${db.pragma('user_version', { simple: true })}: ${db.pragma('quick_check', { simple: true })}`,
  );
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const secrets = new SecretStore(db, main);
  console.log(
    `keys: anthropic ${secrets.read('anthropicApiKey') ? 'set' : 'MISSING'}, openai ${secrets.read('openaiApiKey') ? 'set' : 'MISSING'}`,
  );
  const labelsText = readFileSync(arg('labels')!, 'utf8');
  const s = getSettings(db);
  updateSettings(db, {
    ai: {
      ...s.ai,
      spendLimitUsd: Number(arg('limit') ?? 1),
      labeledOnly: true,
      modes: has('smoke') ? { anthropic: 'direct', openai: 'direct' } : { 'gpt-6-luna': 'direct' },
      batchStallMinutes: 30,
      batchPollSeconds: 30,
    },
  });
  db.prepare(`UPDATE audio_stages SET mode = 'analyse' WHERE stage = 5`).run();
  const logs: string[] = [];
  const runner = new AiRunner({
    db,
    secrets,
    log: (m) => (logs.push(m), console.log(`${t()} ${m}`)),
  });
  const stage = new AudioStage5({
    db,
    runner,
    readLabels: () => ({ text: labelsText, error: null }),
    log: (m) => console.log(`${t()} ${m}`),
  });
  const s4 = getAudioStage(db, 4).progress as { analysisId: string };

  // The evidence (database only): timed, with the longest synchronous stretch.
  let p = stage.progress();
  if (!p || p.stage4Id !== s4.analysisId) p = stage.restart();
  let longest = 0;
  const probe = setInterval(() => undefined, 1000);
  let last = Date.now();
  const lag = setInterval(() => {
    const now = Date.now();
    longest = Math.max(longest, now - last - 10);
    last = now;
  }, 10);
  const te = Date.now();
  while (stage.progress()!.phase === 'evidence') await stage.step(() => false, s4.analysisId);
  p = stage.progress()!;
  console.log(
    `evidence: ${p.units} units (${p.labeledUnits} labeled) in ${Date.now() - te} ms; longest event-loop delay ${longest} ms`,
  );

  // The estimate from the real prompts of the labeled recordings.
  const labeled = (
    db
      .prepare(`SELECT unit_key FROM audio_meta_units WHERE analysis_id = ? AND labeled = 1`)
      .all(p.analysisId) as { unit_key: string }[]
  ).map((r) => r.unit_key);
  let chars = 0;
  for (const k of labeled)
    chars +=
      META_SPEC.system.length +
      META_SPEC.userText(runner.evidenceOf(META_SPEC, k)!.evidence).length;
  const avg = chars / labeled.length;
  const est = (inTok: number, outTok: number, batch: boolean) =>
    costOf(
      { inputPerMTok: 0.1, outputPerMTok: 0.5 },
      { input: inTok, output: outTok, cacheRead: 0, cacheWrite: 0 },
      batch,
      0.5,
    ) * 2;
  console.log(
    `prompt: ${Math.round(avg)} characters on average (system ${META_SPEC.system.length})`,
  );
  console.log(
    `estimate per recording (both models, ~1 token per character in, 750-1500 out): list $${est(avg, 750, false).toFixed(5)}-$${est(avg, 1500, false).toFixed(5)}, batch $${est(avg, 750, true).toFixed(5)}-$${est(avg, 1500, true).toFixed(5)}`,
  );
  console.log(
    `estimate for the ${labeled.length} labeled: list $${(est(avg, 1500, false) * labeled.length).toFixed(3)} at most, batch $${(est(avg, 1500, true) * labeled.length).toFixed(3)} at most`,
  );
  if (has('estimate')) return;

  if (has('smoke')) {
    const n = Number(arg('smoke'));
    const checks = await runner.checkModels();
    for (const [prov, c] of Object.entries(checks))
      console.log(
        `${prov}: ${c.error ?? `${c.models?.length} models`}; ${['claude-haiku-5-5', 'gpt-6-luna'].filter((m) => c.models?.includes(m)).join(', ') || 'neither configured model listed'}`,
      );
    const keys = labeled.slice(0, n);
    runner.enqueue(META_SPEC, 'primary', keys, 'smoke');
    runner.enqueue(META_SPEC, 'secondary', keys, 'smoke');
    for (let i = 0; i < 20; i++) {
      const r = await runner.step(META_SPEC, 'smoke', () => false);
      if (r.wait) console.log('wait', JSON.stringify(r.wait));
      if (r.pending === 0) break;
    }
    for (const r of db
      .prepare(
        `SELECT item_key, model, state, input_tokens, output_tokens, cost_usd, error, answer_json, raw_text FROM ai_requests WHERE run_id = 'smoke'`,
      )
      .all() as Record<string, unknown>[])
      console.log(JSON.stringify({ ...r, raw_text: String(r.raw_text ?? '').slice(0, 300) }));
    return;
  }

  // The labeled books through the Batch API.
  const t0 = Date.now();
  for (;;) {
    const r = await stage.step(() => false, s4.analysisId);
    p = stage.progress()!;
    if (r === 'done') break;
    if (r === 'wait') {
      const st = getAudioStage(db, 5);
      if (st.pauseReason) console.log(`${t()} paused: ${st.pauseDetail}`);
      console.log(
        `${t()} ${p.phase} ${JSON.stringify(p.ai)} ${JSON.stringify(runner.batches('audio5'))}`,
      );
      await sleep(30_000);
    }
  }
  clearInterval(lag);
  clearInterval(probe);
  const report = {
    minutes: (Date.now() - t0) / 60000,
    gate: p.gate,
    ai: p.ai,
    invented: p.invented,
    cost: p.cost,
    spent: db
      .prepare(
        'SELECT SUM(cost_usd) AS c, SUM(input_tokens) AS i, SUM(output_tokens) AS o, COUNT(*) AS n FROM ai_requests',
      )
      .get(),
    byModel: db
      .prepare(
        'SELECT model, mode, COUNT(*) AS n, SUM(cost_usd) AS c, AVG(input_tokens) AS i, AVG(output_tokens) AS o, MAX(output_tokens) AS omax FROM ai_requests GROUP BY model, mode',
      )
      .all(),
    batches: runner.batches('audio5'),
    batchRows: db
      .prepare(
        'SELECT id, provider, model, requests, estimate_usd, cost_usd, submitted_at, ended_at, provider_status FROM ai_batches',
      )
      .all(),
    countsLabeled: valueCounts(db, 'audio5', labeled),
    countsAll: valueCounts(db, 'audio5'),
    phaseTimes: p.phaseTimes,
    longestDelayMs: longest,
  };
  writeFileSync(arg('out') ?? 'wp21d-live-report.json', JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify(
      {
        gate: { passed: p.gate?.passed, fields: p.gate?.fields, misses: p.gate?.misses.length },
        cost: p.cost,
        minutes: report.minutes,
      },
      null,
      1,
    ),
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
