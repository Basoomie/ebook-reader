/**
 * WP20e stop 1: Calibre stage 4's AI check on a working copy of the live cleanup.db, with the
 * real code (Bookmeter's edition pass, then the AI step's evidence, models, decide and gate).
 * Reads the API keys from the copy (their encryption key from a copy of ttsu.db; never
 * printed). Covers are read from the library share (read-only). Nothing is written anywhere
 * but the working copy.
 *
 *   --estimate         build the evidence and print the expected cost (nothing is asked)
 *   --smoke N          the first N labeled books, one call each, then stops
 *   --run              the labeled books (labeledOnly), to the end, then decide and gate
 *   --limit USD        the spending limit written into the copy (all cleanup AI; default 10)
 *
 *   npx ts-node --transpile-only scripts/wp20e-live.ts --db <copy/cleanup.db> --work <work.db>
 *     [--reuse] --main <copy/ttsu.db> --metadata <copy/metadata.db> --calibre <books folder>
 *     --labels <gold800.json> [--estimate | --smoke 5 | --run] [--out report.json]
 */
import Database from 'better-sqlite3';
import fs, { writeFileSync } from 'fs';
import path from 'path';
import { AiRunner } from '../src/cleanup/ai/runner';
import { costOf } from '../src/cleanup/ai/spend';
import { valueCounts } from '../src/cleanup/ai/values';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { SecretStore } from '../src/cleanup/secrets';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { STAGE4_SPEC } from '../src/cleanup/stage4/ai-prompt';
import { Stage4Ai } from '../src/cleanup/stage4/ai-step';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = () => new Date().toLocaleTimeString();
const log = (m: string) => console.log(`${t()} ${m}`);

async function main() {
  const out = arg('work')!;
  if (!has('reuse')) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    for (const x of [out, out + '-wal', out + '-shm']) fs.rmSync(x, { force: true });
    fs.copyFileSync(arg('db')!, out);
  }
  const db = new Database(out);
  db.pragma('journal_mode = WAL');
  migrateCleanup(db);
  log(`working copy v${db.pragma('user_version', { simple: true })}`);
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const secrets = new SecretStore(db, main);
  log(
    `keys: anthropic ${secrets.read('anthropicApiKey') ? 'set' : 'MISSING'}, openai ${secrets.read('openaiApiKey') ? 'set' : 'MISSING'}`,
  );
  const p0 = getStage(db, 4).progress as unknown as Stage4Progress;
  // The analysis reads the reader's snapshot of metadata.db: the copy given stands in for it.
  const cacheDir = path.join(path.dirname(out), 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${p0.libraryId}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  if (!fs.existsSync(snap)) fs.copyFileSync(arg('metadata')!, snap);
  const s = getSettings(db);
  updateSettings(db, {
    ai: {
      ...s.ai,
      spendLimitUsd: Number(arg('limit') ?? 10),
      labeledOnly: true,
      // Modes are per model id (not per provider).
      modes: has('smoke')
        ? { 'claude-haiku-5-5': 'direct', 'gpt-6-luna': 'direct' }
        : { 'gpt-6-luna': 'direct' },
      // The smoke test cancels a stalled batch (OpenAI runs no Luna batch here) at once.
      batchStallMinutes: has('smoke') ? 1 : 30,
      batchPollSeconds: 30,
    },
    gate: { ...s.gate, labeledBooksFile: arg('labels')! },
  });
  const queue = new FetchQueue(
    db,
    path.join(cacheDir, 'cleanup'),
    () => getSettings(db).fetch,
    log,
  );
  const analysis = new Stage4Analysis({
    cleanup: db,
    main,
    calibreDir: arg('calibre')!,
    cacheDir,
    dbDir: null,
    queue,
    log,
  });
  const runner = new AiRunner({ db, secrets, log });
  const ai = new Stage4Ai({ db, runner, analysis, log });

  let longest = 0;
  let last = Date.now();
  /** Every stretch over 200 ms that held the event loop, with the phase it happened in. */
  const stalls: { at: string; phase: string; ms: number }[] = [];
  let phaseNow = 'start';
  const lag = setInterval(() => {
    const now = Date.now();
    const d = now - last - 10;
    longest = Math.max(longest, d);
    if (d > 200) stalls.push({ at: new Date(now).toLocaleTimeString(), phase: phaseNow, ms: d });
    last = now;
  }, 10);
  const times: Record<string, number> = {};
  /** The longest event-loop delay per phase (lessons 3: no step may block the server). */
  const delays: Record<string, number> = {};
  const timeIt = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    const before = longest;
    longest = 0;
    phaseNow = name;
    await fn();
    delays[name] = Math.max(delays[name] ?? 0, longest);
    longest = Math.max(before, longest);
    times[name] = (times[name] ?? 0) + (Date.now() - t0);
  };

  // Bookmeter's edition pass (a finished analysis from before it).
  await timeIt('bookmeter editions', async () => {
    while (!(await analysis.step(() => false))) {
      /* the pass runs in slices */
    }
  });
  const pb = analysis.progress()!;
  log(`bookmeter editions: ${JSON.stringify(pb.bookmeterEditions)}; phase ${pb.phase}`);

  // The evidence of every proposed book.
  await timeIt('evidence', async () => {
    while ((ai.progress()?.phase ?? 'evidence') === 'evidence') {
      await ai.step(() => false);
      const a = ai.progress();
      if (a && a.items % 5000 < 50) log(`evidence: ${a.items} books`);
    }
  });
  const a1 = ai.progress()!;
  log(
    `evidence: ${a1.items} books (${a1.labeledItems} labeled) in ${times.evidence} ms; longest event-loop delay ${delays.evidence} ms (Bookmeter pass with the snapshot load: ${delays['bookmeter editions']} ms)`,
  );

  // The estimate from the real prompts of the labeled books.
  const labeled = (
    db.prepare(`SELECT item_key FROM ai_items WHERE stage = 'calibre4' AND labeled = 1`).all() as {
      item_key: string;
    }[]
  ).map((r) => r.item_key);
  // Tokens: about 1 per Japanese character, about 1 per 4 other characters (the system
  // prompt is English). The smoke test measures the real numbers.
  const tokens = (s: string) => {
    let wide = 0;
    for (const ch of s) if (ch.codePointAt(0)! > 0x2e7f) wide++;
    return wide + (s.length - wide) / 4;
  };
  let tok = 0;
  let chars = 0;
  for (const k of labeled) {
    const text =
      STAGE4_SPEC.system + STAGE4_SPEC.userText(runner.evidenceOf(STAGE4_SPEC, k)!.evidence);
    tok += tokens(text);
    chars += text.length;
  }
  const avg = chars / labeled.length;
  const avgTok = tok / labeled.length;
  const est = (outTok: number, batch: boolean) =>
    costOf(
      { inputPerMTok: 0.1, outputPerMTok: 0.5 },
      { input: avgTok, output: outTok, cacheRead: 0, cacheWrite: 0 },
      batch,
      0.5,
    );
  log(
    `prompt: ${Math.round(avg)} characters, about ${Math.round(avgTok)} tokens (system ${STAGE4_SPEC.system.length} characters, about ${Math.round(tokens(STAGE4_SPEC.system))} tokens)`,
  );
  log(
    `estimate per book and model (750 tokens out, the bake-off's): list $${est(750, false).toFixed(5)}, batch $${est(750, true).toFixed(5)}`,
  );
  log(
    `estimate for the library (${a1.items} books, Haiku by batch + Luna one call each): $${((est(750, true) + est(750, false)) * a1.items).toFixed(2)}; labeled ${labeled.length}: $${((est(750, true) + est(750, false)) * labeled.length).toFixed(3)}`,
  );
  if (has('estimate')) return;

  if (has('smoke')) {
    const n = Number(arg('smoke'));
    const checks = await runner.checkModels();
    for (const [prov, c] of Object.entries(checks))
      log(`${prov}: ${c.error ?? `${c.models?.length} models`}`);
    const keys = labeled.slice(0, n);
    runner.enqueue(STAGE4_SPEC, 'primary', keys, 'smoke');
    runner.enqueue(STAGE4_SPEC, 'secondary', keys, 'smoke');
    for (let i = 0; i < 60; i++) {
      const r = await runner.step(STAGE4_SPEC, 'smoke', () => false);
      if (r.wait) log(`wait ${JSON.stringify(r.wait)}`);
      if (r.pending === 0) break;
      log(`smoke: ${r.pending} pending ${JSON.stringify(runner.batches('calibre4'))}`);
      await sleep(20_000);
    }
    for (const r of db
      .prepare(
        `SELECT item_key, model, state, input_tokens, output_tokens, cost_usd, error, answer_json, raw_text FROM ai_requests WHERE run_id = 'smoke'`,
      )
      .all() as Record<string, unknown>[])
      console.log(JSON.stringify({ ...r, raw_text: String(r.raw_text ?? '').slice(0, 300) }));
    return;
  }

  // --redecide: decide again from the stored answers (nothing is asked), to time it.
  if (has('redecide')) {
    const st = getStage(db, 4).progress as unknown as Stage4Progress & {
      ai?: { rulesKey: string | null };
    };
    if (st.ai) st.ai.rulesKey = 'redecide';
    db.prepare('UPDATE stages SET progress_json = ? WHERE stage = 4').run(JSON.stringify(st));
  }
  // The labeled books: models, then decide (every book) and the gate.
  const t0 = Date.now();
  for (;;) {
    const before = ai.progress()?.phase;
    let r: Awaited<ReturnType<typeof ai.step>> = 'more';
    await timeIt(before ?? 'none', async () => {
      r = await ai.step(() => false);
    });
    const a = ai.progress()!;
    if (before !== a.phase) log(`phase ${before} -> ${a.phase}`);
    if (r === 'done' && a.phase === 'done') break;
    if (a.phase === 'decide' && a.decided % 2000 < 50) log(`decide: ${a.decided}`);
    if (r === 'wait') {
      const st = getStage(db, 4);
      if (st.pauseReason) log(`paused: ${st.pauseDetail}`);
      log(`${a.phase} ${JSON.stringify(a.ai)} ${JSON.stringify(runner.batches('calibre4'))}`);
      await sleep(30_000);
    }
  }
  clearInterval(lag);
  const a = ai.progress()!;
  const proposals = db
    .prepare(
      `SELECT field, class, json_extract(evidence_json, '$.unconfirmed') AS unconfirmed, review_reason AS reason, COUNT(*) AS n
       FROM proposed_changes WHERE stage = 4 AND state = 'proposed' GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 5 DESC`,
    )
    .all();
  const report = {
    minutes: (Date.now() - t0) / 60000,
    times: { ...times, ...a.times },
    longestDelayMs: delays,
    stalls,
    bookmeterEditions: pb.bookmeterEditions,
    gate: a.gate,
    ai: a.ai,
    invented: a.invented,
    cost: a.cost,
    flaggedAgainstRules: a.flaggedAgainstRules,
    byModel: db
      .prepare(
        `SELECT model, mode, state, COUNT(*) AS n, SUM(cost_usd) AS c, AVG(input_tokens) AS i, AVG(output_tokens) AS o,
           MAX(output_tokens) AS omax FROM ai_requests WHERE stage = 'calibre4' GROUP BY model, mode, state`,
      )
      .all(),
    batches: runner.batches('calibre4'),
    countsLabeled: valueCounts(db, 'calibre4', labeled),
    proposals,
  };
  writeFileSync(arg('out') ?? 'wp20e-live-report.json', JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify({ gate: a.gate?.all, cost: a.cost, minutes: report.minutes }, null, 1),
  );
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
