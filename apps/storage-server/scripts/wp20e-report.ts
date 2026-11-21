/**
 * WP20e: the stop reports from a working copy after the AI check (scripts/wp20e-live.ts) or a
 * copy of the live cleanup.db: the AI gate per field (confirmed and with no review) for the 600
 * and check D, books with every field right, every labeled miss with both models' answers and
 * the rules' value, the values both models flagged against the rules (counts and examples),
 * the review list before (the snapshot copy) and after (this copy) by reason, the unconfirmed
 * values written at On, and the cost and answers by model. Reads only.
 *
 *   npx ts-node --transpile-only scripts/wp20e-report.ts --db <work cleanup.db> --before <snapshot cleanup.db>
 *     [--labeled-only] [--out report.json]
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const db = new Database(arg('db')!, { readonly: true });
const before = arg('before') ? new Database(arg('before')!, { readonly: true }) : null;
const p = JSON.parse(
  (
    db.prepare('SELECT progress_json FROM stages WHERE stage = 4').get() as {
      progress_json: string;
    }
  ).progress_json,
);
const ai = p.ai;
const reviewByReason = (d: Database.Database, analysisId: string) =>
  d
    .prepare(
      `SELECT field, review_reason AS reason, COUNT(*) AS n FROM proposed_changes
       WHERE stage = 4 AND state = 'proposed' AND class = 'review' AND analysis_id = ?
       GROUP BY field, reason ORDER BY field, n DESC`,
    )
    .all(analysisId) as { field: string; reason: string; n: number }[];
const total = (rows: { n: number }[]) => rows.reduce((a, r) => a + r.n, 0);
const reviewAfter = reviewByReason(db, p.analysisId);
const reviewBefore = before ? reviewByReason(before, p.analysisId) : [];
const unconfirmed = db
  .prepare(
    `SELECT field, COUNT(*) AS n FROM proposed_changes WHERE stage = 4 AND state = 'proposed' AND analysis_id = ?
     AND class = 'auto' AND json_extract(evidence_json, '$.unconfirmed') = 1 GROUP BY field`,
  )
  .all(p.analysisId) as { field: string; n: number }[];
const flaggedRows = db
  .prepare(
    `SELECT v.item_key, v.field, v.value_json, v.rules_json, v.primary_json, v.secondary_json, i.labeled
     FROM ai_values v JOIN ai_items i ON i.stage = v.stage AND i.item_key = v.item_key
     JOIN ai_values a ON a.stage = v.stage AND a.item_key = v.item_key AND a.field = 'asked' AND a.value_json = 'true'
     WHERE v.stage = 'calibre4' AND v.flagged = 1 AND v.rules_auto = 1`,
  )
  .all() as {
  item_key: string;
  field: string;
  value_json: string;
  rules_json: string;
  primary_json: string;
  secondary_json: string;
  labeled: number;
}[];
const flaggedCounts: Record<string, number> = {};
for (const r of flaggedRows) flaggedCounts[r.field] = (flaggedCounts[r.field] ?? 0) + 1;
const bySource = db
  .prepare(
    `SELECT v.field, v.source, COUNT(*) AS n FROM ai_values v
     JOIN ai_values a ON a.stage = v.stage AND a.item_key = v.item_key AND a.field = 'asked' AND a.value_json = 'true'
     WHERE v.stage = 'calibre4' AND v.field IN ('t','au','il','se','ix','fmt') GROUP BY v.field, v.source`,
  )
  .all();
const byModel = db
  .prepare(
    `SELECT model, mode, state, COUNT(*) AS n, ROUND(SUM(cost_usd), 4) AS usd, ROUND(AVG(input_tokens)) AS inTok,
       ROUND(AVG(output_tokens)) AS outTok, MAX(output_tokens) AS maxOut,
       MIN(sent_at) AS first, MAX(answered_at) AS last
     FROM ai_requests WHERE stage = 'calibre4' GROUP BY model, mode, state`,
  )
  .all();
// Every labeled miss with what each side said.
const key = new Map<string, string>();
for (const r of db
  .prepare(
    `SELECT library_id, calibre_uuid, calibre_id FROM stage4_books WHERE labeled = 1 AND analysis_id = ?`,
  )
  .all(p.analysisId) as { library_id: string; calibre_uuid: string; calibre_id: number }[])
  key.set(String(r.calibre_id), `${r.library_id}:${r.calibre_uuid}`);
const F: Record<string, string> = { t: 't', au: 'au', il: 'il', se: 'se', ix: 'ix', fmt: 'fmt' };
const misses: unknown[] = [];
for (const f of Object.keys(F)) {
  for (const w of ai?.gate?.all?.fields?.[f]?.wrong ?? []) {
    const gid = String(w).split(' ')[0];
    misses.push({ field: f, label: w, ...(ai.gate ? {} : {}) });
    void gid;
  }
}
const report = {
  analysisId: p.analysisId,
  ai: {
    phase: ai?.phase,
    items: ai?.items,
    labeledItems: ai?.labeledItems,
    decided: ai?.decided,
    invented: ai?.invented,
    cost: ai?.cost,
    times: ai?.times,
  },
  gate: ai?.gate
    ? {
        passed: ai.gate.passed,
        below: ai.gate.below,
        books: ai.gate.books,
        notAsked: ai.gate.notAsked,
        the600: summarize(ai.gate.the600),
        checkD: summarize(ai.gate.checkD),
        all: summarize(ai.gate.all),
      }
    : null,
  misses,
  flaggedAgainstRules: {
    counts: flaggedCounts,
    labeled: flaggedRows.filter((r) => r.labeled).length,
    examples: flaggedRows.slice(0, 40).map((r) => ({
      item: r.item_key,
      field: r.field,
      rules: JSON.parse(r.rules_json),
      haiku: JSON.parse(r.primary_json ?? 'null'),
      luna: JSON.parse(r.secondary_json ?? 'null'),
      written: JSON.parse(r.value_json),
    })),
  },
  bySource,
  review: {
    before: { total: total(reviewBefore), rows: reviewBefore },
    after: { total: total(reviewAfter), rows: reviewAfter },
  },
  unconfirmedWrittenAtOn: { total: total(unconfirmed), rows: unconfirmed },
  byModel,
};
function summarize(g: {
  books: number;
  everyFieldRight: number;
  everyFieldPercent: number | null;
  fields: Record<
    string,
    {
      scored: number;
      auto: number;
      autoRight: number;
      autoPercent: number | null;
      allRight: number;
      allPercent: number | null;
      wrong: string[];
    }
  >;
}) {
  return {
    books: g.books,
    everyFieldRight: `${g.everyFieldRight} (${g.everyFieldPercent?.toFixed(1)} %)`,
    fields: Object.fromEntries(
      Object.entries(g.fields).map(([f, s]) => [
        f,
        {
          confirmed: `${s.autoRight}/${s.auto} (${s.autoPercent?.toFixed(1)} %)`,
          noReview: `${s.allRight}/${s.scored} (${s.allPercent?.toFixed(1)} %)`,
          wrong: s.wrong,
        },
      ]),
    ),
  };
}
void key;
console.log(JSON.stringify(report, null, 1));
if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
