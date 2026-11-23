/**
 * WP21g stop 1: EXPLAIN every query stage 8 runs, at the live size. A working copy of a full
 * rehearsal's cleanup.db (every stage-8 table filled from the live copies) runs a whole pass from
 * a changed snapshot (read, pair, values, gate; covers left out: no Calibre files here) and every
 * call the page polls or pages (status, progress, each list at its first and last page, the CSV,
 * the overlay stage 7 reads). Every SQL text is recorded on the way; each is then EXPLAINed, and
 * a full scan of a table is printed with the call that ran it and the time it took.
 *
 *   npx vite-node scripts/wp21g-explain.ts -- --cleanup <rehearsed cleanup.db> --calibre <snapshot copy>
 *     --labels <ebook-pairs.json> --out <dir>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DiskLock } from '../src/cleanup/disk-lock';
import { AudioStage8 } from '../src/cleanup/audio/stage8-ebooks';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}
const out = arg('out');
fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'cleanup.db');
fs.rmSync(file, { force: true });
const src = new Database(arg('cleanup'), { readonly: true });
await src.backup(file);
src.close();
const db = new Database(file);

// Every SQL text, with the call that prepared it first.
let call = 'setup';
const seen = new Map<string, { call: string; n: number }>();
const prepare = db.prepare.bind(db);
(db as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
  const s = seen.get(sql);
  if (s) s.n++;
  else seen.set(sql, { call, n: 1 });
  return prepare(sql);
};
const times: { call: string; ms: number }[] = [];
async function timed<T>(name: string, f: () => T | Promise<T>): Promise<T> {
  call = name;
  const t = performance.now();
  const r = await f();
  times.push({ call: name, ms: Math.round((performance.now() - t) * 10) / 10 });
  return r;
}

const labelsText = fs.readFileSync(arg('labels'), 'utf8');
const stage8 = new AudioStage8({
  db,
  lock: new DiskLock(5),
  calibre: () => ({
    libraryId: 'japanese',
    snapshotFile: arg('calibre'),
    libraryDir: path.join(out, 'calibre'),
  }),
  readLabels: () => ({ text: labelsText, error: null }),
});
// A changed snapshot: the whole read and every ebook's fingerprint compared again.
db.prepare('DELETE FROM audio_ebook_state').run();
// --fresh: a first run (no ebook known yet, nothing paired): every write at its largest.
if (process.argv.includes('--fresh'))
  for (const t of [
    'audio_ebook_known',
    'audio_ebook_pairs',
    'audio_ebook_values',
    'audio_ebook_books',
    'audio_ebook_series',
  ])
    db.prepare(`DELETE FROM ${t}`).run();
db.prepare('UPDATE audio_ebook_books SET cover_json = ?').run('{"path":null,"missing":true}');
const noPreview = async () => ({
  changes: 0,
  metadata: 0,
  moves: 0,
  held: 0,
  reviews: 0,
  at: Date.now(),
});
stage8.begin(1);
let slowestStep = { phase: '', ms: 0 };
for (let i = 0; i < 100_000; i++) {
  const phase = stage8.progress()!.phase;
  const t = performance.now();
  const r = await timed(`step ${phase}`, () => stage8.step(() => false, noPreview as never));
  const ms = performance.now() - t;
  if (ms > slowestStep.ms) slowestStep = { phase, ms: Math.round(ms) };
  if (typeof r === 'object') throw new Error(r.stop);
  if (r === 'done') break;
}
await timed('status', () => stage8.status());
await timed('progress', () => stage8.progress());
await timed('overlay', () => stage8.overlay());
await timed('values', () => stage8.values());
await timed('evaluateGate', () => stage8.evaluateGate());
const kinds = [
  'auto',
  'review',
  'none',
  'excluded',
  'series-fill',
  'series-review',
  'series-disagree',
  'terms',
  'preview',
];
for (const k of kinds) {
  const first = await timed(`list ${k}`, () => stage8.list(k, { limit: 50, offset: 0 }));
  const last = Math.max(0, first.total - 50);
  await timed(`list ${k} last page`, () => stage8.list(k, { limit: 50, offset: last }));
}
await timed('csv', () => stage8.csv());

// EXPLAIN each text (parameters bound as null: the plan does not depend on their values).
const scans: string[] = [];
const lines: string[] = [];
for (const [sql, s] of seen) {
  if (!/^\s*(SELECT|UPDATE|DELETE|WITH)/i.test(sql)) continue;
  const n = (sql.replace(/'[^']*'/g, '').match(/\?/g) ?? []).length;
  let plan: { detail: string }[];
  try {
    plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(n).fill(null)) as { detail: string }[];
  } catch (err) {
    lines.push(`?? ${s.call}: ${(err as Error).message}\n   ${sql.replace(/\s+/g, ' ')}`);
    continue;
  }
  const detail = plan.map((p) => p.detail).join(' | ');
  lines.push(`[${s.call} ×${s.n}] ${sql.replace(/\s+/g, ' ').slice(0, 160)}\n   ${detail}`);
  for (const p of plan)
    if (/^SCAN /.test(p.detail) && !/USING (COVERING )?INDEX/.test(p.detail))
      scans.push(`${s.call} ×${s.n}: ${p.detail} — ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
}
fs.writeFileSync(path.join(out, 'explain.txt'), lines.join('\n') + '\n');
const rows = (t: string) => (prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
console.log(
  'table sizes',
  Object.fromEntries(
    [
      'audio_ebook_pairs',
      'audio_ebook_books',
      'audio_ebook_values',
      'audio_ebook_known',
      'audio_ebook_series',
      'audio_ebook_preview',
      'audio_meta_units',
      'ai_values',
      'ai_items',
    ].map((t) => [t, rows(t)]),
  ),
);
console.log(`${seen.size} SQL texts; full table scans: ${scans.length}`);
for (const s of scans) console.log('  SCAN', s);
const byCall = new Map<string, { n: number; ms: number; max: number }>();
for (const t of times) {
  const c = byCall.get(t.call) ?? { n: 0, ms: 0, max: 0 };
  c.n++;
  c.ms += t.ms;
  c.max = Math.max(c.max, t.ms);
  byCall.set(t.call, c);
}
for (const [c, v] of byCall)
  console.log(
    `  ${c.padEnd(28)} ×${String(v.n).padStart(4)}  total ${v.ms.toFixed(1)} ms  longest ${v.max} ms`,
  );
console.log(`longest single step: ${slowestStep.phase} ${slowestStep.ms} ms`);
console.log(`wrote ${path.join(out, 'explain.txt')}`);
