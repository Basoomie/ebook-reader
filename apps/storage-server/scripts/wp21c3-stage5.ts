/**
 * WP21c follow-up (3), stop 1: what audiobook stage 5 asks again after stage 4 decided again
 * (one record per recording). On a copy of a merged working database (stage 4's rows from
 * wp21c-redecide.ts, the AI tables and stage 5's state from the live copy), stage 5 starts over
 * on the new stage-4 analysis exactly as the server does: evidence for every recording, then
 * every recording's questions queued; the runner sends only those with no answer for their
 * evidence. No key is given, so nothing is sent: the questions left queued are the ones the live
 * run asks, priced from the stage's own answered requests (average cost per model).
 *
 *   npx vite-node scripts/wp21c3-stage5.ts -- --db <merged cleanup.db> --labels <labels.json> --out <dir>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { AiRunner } from '../src/ai/runner';
import type { SecretStore } from '../src/cleanup/secrets';
import { AudioStage5 } from '../src/cleanup/audio/stage5-meta';
import { getAudioStage } from '../src/cleanup/audio/audio-stages';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}
const out = arg('out');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'cleanup.db');
for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
{
  const src = new Database(arg('db'), { readonly: true });
  await src.backup(file);
  src.close();
}
const db = new Database(file);
const labels = fs.readFileSync(arg('labels'), 'utf8');
const maxBefore = (
  db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ai_requests').get() as { m: number }
).m;
// No key: nothing can be sent (the runner waits for one).
const runner = new AiRunner({
  db,
  secrets: { read: () => null } as unknown as SecretStore,
  log: () => undefined,
});
const stage = new AudioStage5({
  db,
  runner,
  readLabels: () => ({ text: labels, error: null }),
  log: (m) => console.log(m),
});
const s4 = getAudioStage(db, 4).progress as { analysisId: string };
db.prepare(`UPDATE audio_stages SET mode = 'analyse' WHERE stage = 5`).run();
const before = new Map(
  (
    db.prepare(`SELECT item_key, evidence_hash FROM ai_items WHERE stage = 'audio5'`).all() as {
      item_key: string;
      evidence_hash: string;
    }[]
  ).map((r) => [r.item_key, r.evidence_hash]),
);
const p0 = stage.progress();
console.log(
  `stage 5 before: phase ${p0?.phase}, stage 4 ${p0?.stage4Id}; stage 4 now ${s4.analysisId}`,
);
stage.restart();
let last = '';
for (let i = 0; i < 400; i++) {
  const r = await stage.step(() => false, s4.analysisId);
  const p = stage.progress()!;
  if (p.phase !== last) console.log(`  step ${i}: ${p.phase} (${r})`);
  last = p.phase;
  if (r === 'done') break;
  if (r === 'wait' && p.phase === 'models') break;
}
const p = stage.progress()!;
const changed = (
  db.prepare(`SELECT item_key, evidence_hash FROM ai_items WHERE stage = 'audio5'`).all() as {
    item_key: string;
    evidence_hash: string;
  }[]
).filter((r) => before.get(r.item_key) !== r.evidence_hash);
const fresh = db
  .prepare(
    `SELECT r.item_key, r.role, r.model, r.state, u.name FROM ai_requests r
     LEFT JOIN audio_meta_units u ON u.unit_key = r.item_key AND u.analysis_id = ?
     WHERE r.id > ? AND r.stage = 'audio5' AND r.state IN ('queued', 'sent')`,
  )
  .all(p.analysisId, maxBefore) as {
  item_key: string;
  role: string;
  model: string;
  state: string;
  name: string;
}[];
const price = new Map(
  (
    db
      .prepare(
        `SELECT model, AVG(cost_usd) AS c, COUNT(*) AS n FROM ai_requests
         WHERE stage = 'audio5' AND state = 'answered' AND cost_usd IS NOT NULL GROUP BY model`,
      )
      .all() as { model: string; c: number; n: number }[]
  ).map((r) => [r.model, r]),
);
let cost = 0;
for (const f of fresh) cost += price.get(f.model)?.c ?? 0;
const report = {
  phase: p.phase,
  wait: p.wait ?? null,
  evidenceChanged: changed.map((c) => c.item_key),
  questions: fresh.map((f) => ({ name: f.name, role: f.role, model: f.model })),
  byModel: Object.fromEntries(
    [...new Set(fresh.map((f) => f.model))].map((m) => [
      m,
      { questions: fresh.filter((f) => f.model === m).length, avgCost: price.get(m)?.c ?? null },
    ]),
  ),
  estimatedCostUsd: Math.round(cost * 10000) / 10000,
};
fs.writeFileSync(path.join(out, 'stage5-report.json'), JSON.stringify(report, null, 1));
console.log(`evidence changed: ${changed.length} recordings`);
for (const c of changed) {
  const n = (
    db
      .prepare('SELECT name FROM audio_meta_units WHERE unit_key = ? AND analysis_id = ?')
      .get(c.item_key, p.analysisId) as { name: string } | undefined
  )?.name;
  console.log(`   ${n ?? c.item_key}`);
}
console.log(`questions the live run asks: ${fresh.length}`, JSON.stringify(report.byModel));
console.log(`estimated cost: $${report.estimatedCostUsd}`);

// The gate on the labeled books: the questions above count as not answered (their recordings'
// fields come out unknown or flagged here; none of them is labeled), so stage 5 finishes from
// the stored answers and scores the gate as the live run will.
db.prepare(
  `UPDATE ai_requests SET state = 'failed', error = 'not sent (stop-1 simulation)'
   WHERE id > ? AND stage = 'audio5' AND state IN ('queued', 'sent')`,
).run(maxBefore);
for (let i = 0; i < 400; i++) {
  const r = await stage.step(() => false, s4.analysisId);
  if (r === 'done') break;
}
const g = stage.progress()!.gate;
const labeledChanged = (
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM audio_meta_units WHERE analysis_id = ? AND labeled = 1 AND unit_key IN (${changed.map(() => '?').join(', ') || "''"})`,
    )
    .get(stage.progress()!.analysisId, ...changed.map((c) => c.item_key)) as { n: number }
).n;
console.log(`labeled recordings among them: ${labeledChanged}`);
console.log(
  `GATE passed=${g?.passed} books=${g?.books} misses=${JSON.stringify(g?.misses)}`,
  JSON.stringify(
    Object.fromEntries(
      Object.entries(g?.fields ?? {}).map(([f, v]) => [
        f,
        `${v.autoRight}/${v.auto} auto, ${v.flaggedRight}/${v.flagged} flagged`,
      ]),
    ),
  ),
);
db.close();
