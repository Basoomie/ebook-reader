/**
 * WP21d: stage 5's rules (and, given answers, setup E) on the labeled books of a copy of the
 * live cleanup.db, without the server: the gate per field and every miss with its evidence.
 * Read-only on the database. Answers: an optional JSONL of {unitKey, primary, secondary}.
 *
 *   npx ts-node --transpile-only scripts/wp21d-rules.ts --db <cleanup.db> --labels <labels.json>
 *     [--answers <answers.jsonl>] [--out <report.json>]
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'fs';
import { EvidenceBuilder } from '../src/cleanup/audio/meta-evidence';
import { metaEvidenceText } from '../src/cleanup/audio/meta-prompt';
import { decideUnit } from '../src/cleanup/audio/meta-decide';
import { scoreMetaGate, type GateValue, type MetaLabel } from '../src/cleanup/audio/meta-gate';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const db = new Database(arg('db')!, { readonly: true, fileMustExist: true });
const labels = (JSON.parse(readFileSync(arg('labels')!, 'utf8')) as { books: MetaLabel[] }).books;
const answers = new Map<
  string,
  { primary: Record<string, unknown> | null; secondary: Record<string, unknown> | null }
>();
if (arg('answers'))
  for (const line of readFileSync(arg('answers')!, 'utf8').split('\n').filter(Boolean)) {
    const o = JSON.parse(line) as {
      unitKey: string;
      primary: Record<string, unknown> | null;
      secondary: Record<string, unknown> | null;
    };
    answers.set(o.unitKey, o);
  }
const p4 = JSON.parse(
  (
    db.prepare('SELECT progress_json FROM audio_stages WHERE stage = 4').get() as {
      progress_json: string;
    }
  ).progress_json,
) as { analysisId: string };
const units = EvidenceBuilder.units(db, p4.analysisId);
const builder = new EvidenceBuilder(db);
const byPath = new Map<string, (typeof units)[number]>();
for (const u of units) {
  const inputs = JSON.parse(u.inputs_json) as {
    opening: { root: string; rel: string }[];
    paths: string[];
  };
  for (const f of inputs.opening) if (f.root === 'torrents') byPath.set(f.rel, u);
  for (const p of inputs.paths) {
    const rel = p.slice(p.indexOf(':') + 1);
    if (p.startsWith('torrents:') && !byPath.has(rel)) byPath.set(rel, u);
  }
}
const find = (t: string) => {
  const e = byPath.get(t);
  if (e) return e;
  for (const [rel, u] of byPath) if (rel.startsWith(t + '/')) return u;
  return null;
};
const values = new Map<string, Record<string, GateValue>>();
const t0 = Date.now();
for (const b of labels) {
  const u = find(b.torrent);
  if (!u || values.has(u.unit_key)) continue;
  const ev = builder.build(u);
  const a = answers.get(u.unit_key) ?? { primary: null, secondary: null };
  const out = decideUnit(ev, a, metaEvidenceText(ev), { multiNarratorMin: 2 });
  const v: Record<string, GateValue> = {};
  for (const [f, o] of Object.entries(out.fields))
    v[f] = {
      value: o!.decision.value,
      source: o!.decision.source,
      flagged: o!.decision.flagged,
      rules: o!.rules?.value,
      primary: o!.primary,
      secondary: o!.secondary,
    };
  values.set(u.unit_key, v);
}
const gate = scoreMetaGate(
  labels,
  (t) => {
    const u = find(t);
    return u
      ? { unitKey: u.unit_key, name: u.name, record: u.source ? `${u.source}:${u.store_id}` : null }
      : null;
  },
  (k) => values.get(k) ?? {},
  95,
  20,
);
const ms = Date.now() - t0;
for (const [f, s] of Object.entries(gate.fields))
  console.log(
    `${f.padEnd(11)} auto ${String(s.auto).padStart(3)} right ${String(s.autoRight).padStart(3)} ` +
      `(${s.percent === null ? '-' : s.percent.toFixed(1)}%)  flagged ${s.flagged} right ${s.flaggedRight}`,
  );
console.log(`passed ${gate.passed}; not found ${gate.notFound.length}; ${ms} ms`);
for (const m of gate.misses)
  console.log(
    `MISS ${m.id} ${m.field}: label ${JSON.stringify(m.expected)} got ${JSON.stringify(m.got)} (${m.source}) ${m.name}`,
  );
if (process.argv.includes('--flagged'))
  for (const m of gate.flaggedWrong)
    console.log(
      `FLAG ${m.id} ${m.field}: label ${JSON.stringify(m.expected)} guess ${JSON.stringify(m.got)} (${m.source})`,
    );
if (arg('out')) writeFileSync(arg('out')!, JSON.stringify(gate, null, 1));
