/**
 * Book summaries session 1: the one-time move of the shared AI data, proven on copies of the
 * live databases (never the live files). On fresh working copies of a cleanup.db and a ttsu.db:
 *
 *   - before and after the move: the total spent (cleanup.db's sum against the ledger), a hash
 *     of every table the move must not touch (every stored answer, evidence record, value,
 *     design, batch, stage and the rest of cleanup.db), the provider settings and both keys;
 *   - the runner on the shared layer reads the same stored answer for every item and role of
 *     every AI stage as the old lookup (model from the cleanup's choice, prompt version and
 *     evidence hash);
 *   - audiobook stage 5 decided again from the stored answers (no provider) gives the same
 *     values;
 *   - with --check-models, both moved keys read each provider's model list (a free call; the
 *     keys are never printed);
 *   - the move's time, and the time and query plans of the queries every step now runs.
 *
 *   npx vite-node scripts/ai-layer-move-check.ts -- --cleanup <copy> --ttsu <copy> --work <dir>
 *     [--labels <audio labels.json>] [--check-models]
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { AiCore } from '../src/ai/core';
import { spentTotal } from '../src/ai/ledger';
import { AI_SECRET_NAMES } from '../src/ai/secrets';
import { AI_SETTING_KEYS } from '../src/ai/settings';
import { AiRunner } from '../src/ai/runner';
import { CLEANUP_AI_SOURCE, cleanupFeatureOf } from '../src/cleanup/ai-features';
import { META_SPEC } from '../src/cleanup/audio/meta-prompt';
import { AudioStage5 } from '../src/cleanup/audio/stage5-meta';
import { getAudioStage } from '../src/cleanup/audio/audio-stages';
import { CLEANUP_MIGRATIONS, initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { readCleanupSecret } from '../src/cleanup/secrets';
import { getSettings } from '../src/cleanup/settings';
import { STAGE4_SPEC } from '../src/cleanup/stage4/ai-prompt';
import { STAGE5_SPEC } from '../src/cleanup/stage5/prompt';
import { migrate } from '../src/db/migrations';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const out: Record<string, unknown> = {};
const say = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const sha = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

const work = arg('work')!;
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
say('copying the inputs into the working folder (the copies given stay as they are)');
fs.copyFileSync(arg('cleanup')!, path.join(work, 'cleanup.db'));
fs.copyFileSync(arg('ttsu')!, path.join(work, 'ttsu.db'));

const MOVED = new Set(['settings', 'secrets', 'ai_model_checks', 'ai_batch_tests']);

/** A hash of each table's rows in rowid order (or primary key order). */
function tableHashes(
  db: Database.Database,
  skip: Set<string>,
): Record<string, { rows: number; hash: string }> {
  const res: Record<string, { rows: number; hash: string }> = {};
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  for (const t of tables) {
    if (skip.has(t)) continue;
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[])
      .filter((c) => !(t === 'ai_batches' && c.name === 'files_deleted_at'))
      .map((c) => c.name);
    const withoutRowid = !!db
      .prepare(`SELECT 1 FROM sqlite_master WHERE name = ? AND sql LIKE '%WITHOUT ROWID%'`)
      .get(t);
    const order = withoutRowid ? cols.map((_, i) => i + 1).join(', ') : 'rowid';
    const h = createHash('sha256');
    let n = 0;
    for (const r of db
      .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${t} ORDER BY ${order}`)
      .raw()
      .iterate() as Iterable<unknown[]>) {
      h.update(
        JSON.stringify(r, (_k, v) =>
          Buffer.isBuffer(v) ? v.toString('base64') : typeof v === 'bigint' ? String(v) : v,
        ),
      );
      h.update('\n');
      n++;
    }
    res[t] = { rows: n, hash: h.digest('hex').slice(0, 16) };
  }
  return res;
}

const SPECS = [STAGE4_SPEC, STAGE5_SPEC, META_SPEC];

/** Every item's stored answer per role, as the old runner looked it up (straight from SQL). */
function oldAnswers(db: Database.Database): string {
  const models = getSettings(db).models;
  const h = createHash('sha256');
  let n = 0;
  for (const spec of SPECS)
    for (const role of ['primary', 'secondary', 'upgradePrimary', 'upgradeSecondary'] as const) {
      const model = models[spec.tasks[role]] ?? '';
      for (const r of db
        .prepare(
          `SELECT i.item_key, r.state, r.answer_json FROM ai_items i
           LEFT JOIN ai_requests r ON r.stage = i.stage AND r.item_key = i.item_key AND r.model = ?
             AND r.prompt_version = ? AND r.evidence_hash = i.evidence_hash
           WHERE i.stage = ? ORDER BY i.item_key`,
        )
        .all(model, spec.promptVersion, spec.stage) as {
        item_key: string;
        state: string | null;
        answer_json: string | null;
      }[]) {
        const a =
          !r.state || r.state === 'queued' || r.state === 'sent'
            ? null
            : [model, r.state, r.answer_json];
        h.update(JSON.stringify([spec.stage, role, r.item_key, a]) + '\n');
        n++;
      }
    }
  out.answerLookups = n;
  return h.digest('hex').slice(0, 16);
}

/** The same through the runner on the shared layer. */
function runnerAnswers(runner: AiRunner, db: Database.Database): string {
  const h = createHash('sha256');
  for (const spec of SPECS)
    for (const role of ['primary', 'secondary', 'upgradePrimary', 'upgradeSecondary'] as const)
      for (const { item_key } of db
        .prepare(`SELECT item_key FROM ai_items WHERE stage = ? ORDER BY item_key`)
        .all(spec.stage) as { item_key: string }[]) {
        const a = runner.answerOf(spec, role, item_key);
        h.update(
          JSON.stringify([
            spec.stage,
            role,
            item_key,
            a ? [a.model, a.state, a.answer ? JSON.stringify(a.answer) : null] : null,
          ]) + '\n',
        );
      }
  return h.digest('hex').slice(0, 16);
}

// ---- before ---------------------------------------------------------------------------------
const main = new Database(path.join(work, 'ttsu.db'));
say(`ttsu.db v${main.pragma('user_version', { simple: true })} -> migrate`);
migrate(main);
const pre = new Database(path.join(work, 'cleanup.db'));
pre.pragma('journal_mode = WAL');
// The live cleanup.db is at v20: an older copy is brought there first, so "before" is the state
// the move starts from (v20's own changes are not the move's).
for (const m of CLEANUP_MIGRATIONS) {
  if (m.version <= (pre.pragma('user_version', { simple: true }) as number) || m.version >= 21)
    continue;
  pre.transaction(() => {
    pre.exec(m.sql);
    pre.pragma(`user_version = ${m.version}`);
  })();
  say(`copy brought to v${m.version} (${m.name})`);
}
const preVersion = pre.pragma('user_version', { simple: true }) as number;
const before = {
  version: preVersion,
  spent: pre
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM ai_requests WHERE cost_usd IS NOT NULL`,
    )
    .get() as { c: number; n: number },
  testsSpent: pre
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM ai_batch_tests WHERE cost_usd IS NOT NULL`,
    )
    .get() as { c: number; n: number },
  keys: Object.fromEntries(AI_SECRET_NAMES.map((n) => [n, sha(readCleanupSecret(pre, main, n))])),
  keySet: Object.fromEntries(
    AI_SECRET_NAMES.map((n) => [n, readCleanupSecret(pre, main, n) !== null]),
  ),
  provider: (() => {
    const raw = pre.prepare(`SELECT value_json FROM settings WHERE key = 'ai'`).get() as
      | { value_json: string }
      | undefined;
    const old = raw ? (JSON.parse(raw.value_json) as Record<string, unknown>) : {};
    return Object.fromEntries(AI_SETTING_KEYS.filter((k) => k in old).map((k) => [k, old[k]]));
  })(),
  cleanupAi: (() => {
    const raw = pre.prepare(`SELECT value_json FROM settings WHERE key = 'ai'`).get() as
      | { value_json: string }
      | undefined;
    const old = raw ? (JSON.parse(raw.value_json) as Record<string, unknown>) : {};
    return {
      labeledOnly: old.labeledOnly,
      arrivalsDesign: old.arrivalsDesign,
      upgradeIncludeDecided: old.upgradeIncludeDecided,
    };
  })(),
  otherSettings: sha(
    pre.prepare(`SELECT key, value_json FROM settings WHERE key <> 'ai' ORDER BY key`).all(),
  ),
  otherSecrets: sha(
    pre
      .prepare(
        `SELECT * FROM secrets WHERE name NOT IN ('anthropicApiKey', 'openaiApiKey') ORDER BY name`,
      )
      .all(),
  ),
  tables: tableHashes(pre, MOVED),
  answers: '',
};
pre.close();
say(
  `cleanup.db v${preVersion}: ${before.spent.n} paid questions, $${before.spent.c.toFixed(4)}; batch tests $${before.testsSpent.c.toFixed(4)}`,
);

// ---- the move, as the server runs it ----------------------------------------------------------
const t0 = Date.now();
const st = initCleanupDatabase(work, { mainDb: main, log: say });
const moveMs = Date.now() - t0;
if (!st.ok) throw new Error(st.error);
const db = st.db;
say(`opened and moved in ${moveMs} ms; cleanup.db v${db.pragma('user_version', { simple: true })}`);
before.answers = oldAnswers(db); // the lookup reads only tables the move leaves alone

// ---- after ----------------------------------------------------------------------------------
const core = new AiCore({ db: main, dbDir: work, log: say });
const runner = new AiRunner({
  db,
  core,
  source: CLEANUP_AI_SOURCE,
  featureOf: cleanupFeatureOf,
  modelFor: (task) => getSettings(db).models[task] ?? '',
  onlyLabeled: () => getSettings(db).ai.labeledOnly,
  log: say,
});
const ledger = spentTotal(main, CLEANUP_AI_SOURCE);
const testsLedger = spentTotal(main, 'ai');
const after = {
  tables: tableHashes(db, MOVED),
  keys: Object.fromEntries(AI_SECRET_NAMES.map((n) => [n, sha(core.secrets.read(n))])),
  provider: Object.fromEntries(
    Object.keys(before.provider).map((k) => [
      k,
      (core.settings() as unknown as Record<string, unknown>)[k],
    ]),
  ),
  cleanupAi: getSettings(db).ai,
  otherSettings: sha(
    db.prepare(`SELECT key, value_json FROM settings WHERE key <> 'ai' ORDER BY key`).all(),
  ),
  otherSecrets: sha(db.prepare(`SELECT * FROM secrets ORDER BY name`).all()),
  answers: runnerAnswers(runner, db),
};
const diffTables = Object.keys({ ...before.tables, ...after.tables }).filter(
  (t) => JSON.stringify(before.tables[t]) !== JSON.stringify(after.tables[t]),
);
const checks: Record<string, boolean> = {
  'total spent equals the ledger (cleanup questions)':
    ledger.rows === before.spent.n && Math.abs(ledger.usd - before.spent.c) < 1e-9,
  'batch tests equal the ledger':
    testsLedger.rows === before.testsSpent.n &&
    Math.abs(testsLedger.usd - before.testsSpent.c) < 1e-9,
  'every table the move must not touch is unchanged': diffTables.length === 0,
  'both keys read back the same': JSON.stringify(before.keys) === JSON.stringify(after.keys),
  'the provider settings are the same':
    JSON.stringify(before.provider) === JSON.stringify(after.provider),
  "the cleanup's own AI choices are the same":
    JSON.stringify(before.cleanupAi) === JSON.stringify(after.cleanupAi),
  'the other cleanup settings and secrets are the same':
    before.otherSettings === after.otherSettings && before.otherSecrets === after.otherSecrets,
  'the runner reads the same stored answer for every item and role':
    before.answers === after.answers,
};
out.before = { ...before, keys: before.keySet };
out.after = {
  tables: after.tables,
  ledger,
  testsLedger,
  provider: after.provider,
  cleanupAi: after.cleanupAi,
};
out.diffTables = diffTables;
out.moveMs = moveMs;
out.copies = fs
  .readdirSync(path.join(work, 'snapshots'))
  .map((f) => [f, fs.statSync(path.join(work, 'snapshots', f)).size]);
out.months = core.spending();

// ---- the queries every step now runs: time and plans at this size ----------------------------
const timeIt = (fn: () => unknown, n = 50) => {
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  return Number(process.hrtime.bigint() - t) / 1e6 / n;
};
const m = core.month();
out.queryMs = {
  room: timeIt(() => core.room()),
  spending12: timeIt(() => core.spending(), 5),
  repairCount: timeIt(
    () => db.prepare(`SELECT COUNT(*) AS n FROM ai_requests WHERE cost_usd IS NOT NULL`).get(),
    20,
  ),
};
out.plans = Object.fromEntries(
  [
    [
      `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_spend WHERE at >= ${m.start} AND at < ${m.end}`,
      main,
    ],
    [`SELECT COUNT(*) AS n FROM ai_spend WHERE source = 'cleanup'`, main],
    [`SELECT COALESCE(SUM(estimate_usd), 0) AS c FROM ai_holds`, main],
    [`SELECT COUNT(*) AS n FROM ai_requests WHERE cost_usd IS NOT NULL`, db],
    [
      `SELECT id, provider FROM ai_batches WHERE state <> 'submitted' AND files_deleted_at IS NULL ORDER BY submitted_at LIMIT 20`,
      db,
    ],
  ].map(([q, d]) => [
    q as string,
    ((d as Database.Database).prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join(' | '),
  ]),
);

async function finish() {
  // Audiobook stage 5 decided again from the stored answers, no provider (as wp21d-redecide).
  const labelsFile = arg('labels');
  if (labelsFile) {
    const valuesBefore = sha(
      db.prepare(`SELECT * FROM ai_values WHERE stage = 'audio5' ORDER BY item_key, field`).all(),
    );
    const mem = new Database(':memory:');
    migrate(mem);
    const noKeys = new AiCore({ db: mem, dbDir: work, keys: { read: () => null } });
    const offline = new AiRunner({
      db,
      core: noKeys,
      source: CLEANUP_AI_SOURCE,
      featureOf: cleanupFeatureOf,
      modelFor: (task) => getSettings(db).models[task] ?? '',
      onlyLabeled: () => getSettings(db).ai.labeledOnly,
    });
    const labels = fs.readFileSync(labelsFile, 'utf8');
    const stage = new AudioStage5({
      db,
      runner: offline,
      readLabels: () => ({ text: labels, error: null }),
      log: () => undefined,
    });
    const s4 = getAudioStage(db, 4).progress as { analysisId: string };
    const mode = getAudioStage(db, 5).mode;
    db.prepare(`UPDATE audio_stages SET mode = 'analyse' WHERE stage = 5`).run();
    stage.redecide();
    const t = Date.now();
    for (let i = 0; i < 100000; i++)
      if ((await stage.step(() => false, s4.analysisId)) === 'done') break;
    db.prepare(`UPDATE audio_stages SET mode = ? WHERE stage = 5`).run(mode);
    const valuesAfter = sha(
      db.prepare(`SELECT * FROM ai_values WHERE stage = 'audio5' ORDER BY item_key, field`).all(),
    );
    const asked = db.prepare(`SELECT COUNT(*) AS n FROM ai_requests WHERE sent_at > ?`).get(t) as {
      n: number;
    };
    // decided_at changes with every decision: compare the values without it.
    const strip = () =>
      sha(
        db
          .prepare(
            `SELECT stage, item_key, field, value_json, source, flagged, reason, rules_json, rules_auto, primary_json, secondary_json, design, evidence_hash, user_at FROM ai_values WHERE stage = 'audio5' ORDER BY item_key, field`,
          )
          .all(),
      );
    out.audio5Redecide = { ms: Date.now() - t, valuesBefore, valuesAfter, asked: asked.n };
    checks['audiobook stage 5 decided again from the stored answers: the same values'] =
      before.tables.ai_values?.hash === after.tables.ai_values?.hash &&
      strip() === stripBefore &&
      asked.n === 0;
  }
  if (has('check-models')) {
    const r = await core.checkModels();
    const ok = (p: 'anthropic' | 'openai') => !!r[p].models?.length && !r[p].error;
    out.checkModels = {
      anthropic: { models: r.anthropic.models?.length ?? 0, error: r.anthropic.error },
      openai: { models: r.openai.models?.length ?? 0, error: r.openai.error },
    };
    checks['both moved keys pass Check models'] = ok('anthropic') && ok('openai');
  }
  out.checks = checks;
  fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  console.log(
    JSON.stringify({ moveMs, ledger, testsLedger, queryMs: out.queryMs, diffTables }, null, 2),
  );
  process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
}
const stripBefore = sha(
  db
    .prepare(
      `SELECT stage, item_key, field, value_json, source, flagged, reason, rules_json, rules_auto, primary_json, secondary_json, design, evidence_hash, user_at FROM ai_values WHERE stage = 'audio5' ORDER BY item_key, field`,
    )
    .all(),
);
void finish();
