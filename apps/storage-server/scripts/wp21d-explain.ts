/**
 * WP21d stop 1: EXPLAIN QUERY PLAN and timing of every query stage 5 and the AI framework run
 * while polled (the page every 5 s, the stage's steps), on a working copy of the live database
 * after a stage-5 run. Read-only.
 *
 *   npx ts-node --transpile-only scripts/wp21d-explain.ts --db <work/cleanup.db>
 */
import Database from 'better-sqlite3';

const i = process.argv.indexOf('--db');
const db = new Database(process.argv[i + 1], { readonly: true, fileMustExist: true });
const p5 = JSON.parse(
  (
    db.prepare('SELECT progress_json FROM audio_stages WHERE stage = 5').get() as {
      progress_json: string;
    }
  ).progress_json,
) as { analysisId: string };
const a = p5.analysisId;
const anyKey = (db.prepare('SELECT item_key FROM ai_values LIMIT 1').get() as { item_key: string })
  .item_key;
const anyModel =
  (db.prepare('SELECT model FROM ai_requests LIMIT 1').get() as { model: string } | undefined)
    ?.model ?? 'm';
const queries: [string, string, unknown[]][] = [
  [
    'queued per model (each step)',
    `SELECT model, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'audio5' AND state = 'queued' GROUP BY model`,
    [a],
  ],
  [
    'next questions to send',
    `SELECT id FROM ai_requests WHERE run_id = ? AND stage = 'audio5' AND state = 'queued' AND model = ? ORDER BY labeled DESC, id LIMIT 500`,
    [a, anyModel],
  ],
  [
    'counts per state (status)',
    `SELECT state, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'audio5' GROUP BY state`,
    [a],
  ],
  [
    'open questions (status)',
    `SELECT COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'audio5' AND state IN ('queued', 'sent')`,
    [a],
  ],
  [
    'counts per state, labeled only (status)',
    `SELECT state, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'audio5' AND (labeled = 1 OR state <> 'queued') GROUP BY state`,
    [a],
  ],
  [
    'open questions, labeled only (step)',
    `SELECT COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'audio5' AND (state = 'sent' OR (state = 'queued' AND labeled = 1))`,
    [a],
  ],
  [
    "an item's answer (decide)",
    `SELECT state, answer_json FROM ai_requests WHERE stage = 'audio5' AND item_key = ? AND model = ? AND prompt_version = 'audio5-v1' AND evidence_hash = 'h'`,
    [anyKey, anyModel],
  ],
  [
    'batches due (each step)',
    `SELECT id FROM ai_batches WHERE state = 'submitted' AND stage = 'audio5' AND COALESCE(checked_at, submitted_at) <= ?`,
    [Date.now()],
  ],
  [
    'spent (status)',
    `SELECT COALESCE(SUM(cost_usd), 0) AS c FROM ai_requests WHERE cost_usd IS NOT NULL`,
    [],
  ],
  [
    'held for batches (status)',
    `SELECT COALESCE(SUM(estimate_usd), 0) AS c FROM ai_batches WHERE state = 'submitted'`,
    [],
  ],
  [
    'expected cost (each send)',
    `SELECT input_tokens FROM ai_requests WHERE model = ? AND state IN ('answered', 'invalid', 'blocked') AND input_tokens IS NOT NULL ORDER BY id DESC LIMIT 50`,
    [anyModel],
  ],
  [
    'run cost (status)',
    `SELECT model, COALESCE(SUM(cost_usd), 0) AS c, COUNT(DISTINCT item_key) AS n FROM ai_requests WHERE stage = 'audio5' AND run_id = ? AND cost_usd IS NOT NULL GROUP BY model`,
    [a],
  ],
  [
    'units to decide (decide)',
    `SELECT unit_key FROM audio_meta_units WHERE analysis_id = ? AND state IN ('evidence', 'asking') ORDER BY labeled DESC, unit_key LIMIT 50`,
    [a],
  ],
  [
    'list: flagged (page)',
    `SELECT unit_key FROM audio_meta_units m WHERE m.analysis_id = ? AND m.flagged > 0 ORDER BY m.flagged DESC, m.unit_key LIMIT 50`,
    [a],
  ],
  [
    'list: flagged total (page)',
    `SELECT COUNT(*) AS n FROM audio_meta_units m WHERE m.analysis_id = ? AND m.flagged > 0`,
    [a],
  ],
  [
    'list: no record (page)',
    `SELECT unit_key FROM audio_meta_units m WHERE m.analysis_id = ? AND m.kind = 'no_record' ORDER BY m.unit_key LIMIT 50`,
    [a],
  ],
  [
    'list: labeled (page)',
    `SELECT unit_key FROM audio_meta_units m WHERE m.analysis_id = ? AND m.labeled = 1 ORDER BY m.unit_key LIMIT 50`,
    [a],
  ],
  [
    'list: field and source (page)',
    `SELECT unit_key FROM audio_meta_units m WHERE m.analysis_id = ? AND m.unit_key IN (SELECT item_key FROM ai_values WHERE stage = 'audio5' AND field = 'authors' AND source = 'both_models') ORDER BY m.unit_key LIMIT 50`,
    [a],
  ],
  [
    "an item's values (page)",
    `SELECT * FROM ai_values WHERE stage = 'audio5' AND item_key = ? ORDER BY field`,
    [anyKey],
  ],
  [
    'value counts (finish)',
    `SELECT item_key, field, source, flagged FROM ai_values WHERE stage = 'audio5'`,
    [],
  ],
];
for (const [name, sql, args] of queries) {
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
    .map((r) => r.detail)
    .join(' | ');
  const st = db.prepare(sql);
  const t0 = process.hrtime.bigint();
  const n = 20;
  for (let k = 0; k < n; k++) st.all(...args);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  console.log(`${name}: ${ms.toFixed(2)} ms -- ${plan}`);
}
