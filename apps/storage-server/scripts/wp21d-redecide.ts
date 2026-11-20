/**
 * WP21d follow-up, stop 1: stage 5 decided again on a working copy of the live cleanup.db, from
 * the answers it already stored. No provider, no key, no request: `redecide()` reads
 * `ai_requests` and `ai_items` only. Reports every value that changes, which of the eight
 * changes it belongs to, the labeled ones, and the gate.
 *
 *   npx vite-node scripts/wp21d-redecide.ts -- --db <copy of the live cleanup.db or its audio
 *     tables> --labels <labels.json> --out <dir> [--work <dir>]
 *
 * The copy of a live file taken while the Calibre cleanup writes is not consistent as a whole;
 * the working database is a fresh one at the same schema, filled from the audio_*, ai_* and
 * settings tables (read-only; the copy is never changed).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { AiRunner } from '../src/cleanup/ai/runner';
import type { SecretStore } from '../src/cleanup/secrets';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { AudioStage5 } from '../src/cleanup/audio/stage5-meta';
import { isImprintSeries, isNotPerson, VOLUME_NO_SERIES } from '../src/cleanup/audio/meta-rules';
import { getAudioStage } from '../src/cleanup/audio/audio-stages';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}

const out = arg('out');
fs.mkdirSync(out, { recursive: true });
const workIdx = process.argv.indexOf('--work');
const dbFile = path.join(workIdx > 0 ? process.argv[workIdx + 1] : out, 'cleanup.db');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) fs.rmSync(f, { force: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
migrateCleanup(db);
{
  const from = new Database(arg('db'), { readonly: true, fileMustExist: true });
  db.pragma('foreign_keys = OFF');
  const want = (t: string) => /^(audio_|ai_)/.test(t) || t === 'settings';
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  )
    .map((r) => r.name)
    .filter(want)
    .filter((t) => t !== 'audio_fetch_waiters');
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
    const flush = db.transaction((rs: unknown[][]) => {
      for (const r of rs) put.run(...r);
    });
    let rows: unknown[][] = [];
    let n = 0;
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
  db.pragma('foreign_keys = ON');
}

interface Snap {
  value: unknown;
  source: string;
  flagged: number;
  reason: string | null;
}
const snapshot = () => {
  const m = new Map<string, Snap>();
  for (const r of db
    .prepare(
      `SELECT item_key, field, value_json, source, flagged, reason FROM ai_values WHERE stage = 'audio5'`,
    )
    .iterate() as Iterable<{
    item_key: string;
    field: string;
    value_json: string;
    source: string;
    flagged: number;
    reason: string | null;
  }>)
    m.set(`${r.item_key}\u0000${r.field}`, {
      value: JSON.parse(r.value_json),
      source: r.source,
      flagged: r.flagged,
      reason: r.reason,
    });
  return m;
};

const before = snapshot();
const askedBefore = (db.prepare('SELECT COUNT(*) AS n FROM ai_requests').get() as { n: number }).n;
const labels = fs.readFileSync(arg('labels'), 'utf8');
const runner = new AiRunner({ db, secrets: {} as SecretStore, log: () => undefined });
const stage = new AudioStage5({
  db,
  runner,
  readLabels: () => ({ text: labels, error: null }),
  log: (m) => console.log(m),
});
const s4 = getAudioStage(db, 4).progress as { analysisId: string };
db.prepare(`UPDATE audio_stages SET mode = 'analyse' WHERE stage = 5`).run();
const p0 = stage.progress()!;
console.log(`stage 5 before: phase ${p0.phase}, ${p0.units} units, rules key ${p0.rulesKey}`);
stage.redecide();
const t0 = Date.now();
let longest = 0;
let last = Date.now();
const lag = setInterval(() => {
  const now = Date.now();
  longest = Math.max(longest, now - last - 10);
  last = now;
}, 10);
for (;;) {
  const r = await stage.step(() => false, s4.analysisId);
  if (r === 'done') break;
}
clearInterval(lag);
const p = stage.progress()!;
console.log(`decided again in ${Date.now() - t0} ms (longest event-loop delay ${longest} ms)`);
const after = snapshot();
const askedAfter = (db.prepare('SELECT COUNT(*) AS n FROM ai_requests').get() as { n: number }).n;

// ---- what changed, and which change it belongs to ---------------------------------------------
const unit = new Map<
  string,
  { name: string; labeled: number; kind: string; record: string | null }
>();
for (const r of db
  .prepare(`SELECT unit_key, name, labeled, kind, record FROM audio_meta_units`)
  .all() as {
  unit_key: string;
  name: string;
  labeled: number;
  kind: string;
  record: string | null;
}[])
  unit.set(r.unit_key, { name: r.name, labeled: r.labeled, kind: r.kind, record: r.record });

interface Diff {
  key: string;
  name: string;
  labeled: boolean;
  field: string;
  change: number[];
  before: Snap | null;
  after: Snap;
}
const diffs: Diff[] = [];
const J = (v: unknown) => JSON.stringify(v);
for (const [k, a] of after) {
  const b = before.get(k) ?? null;
  if (b && J(b.value) === J(a.value) && b.source === a.source && b.flagged === a.flagged) continue;
  const [key, field] = k.split('\u0000');
  const u = unit.get(key);
  const ch: number[] = [];
  if (field === 'series') {
    if (a.reason?.startsWith('Audible gives the same position')) ch.push(1);
    if (a.reason === VOLUME_NO_SERIES) ch.push(7);
    const bs = (b?.value as { name: string }[] | null) ?? [];
    if (bs.some((s) => isImprintSeries(s.name))) ch.push(5);
  }
  if (field === 'title' && a.source === 'rules' && b && b.source !== 'rules') ch.push(2);
  if (field === 'drama' && b?.value === true && a.value === false) ch.push(3);
  if ((field === 'narrators' || field === 'authors' || field === 'multi_narr') && b) {
    const bl = (b.value as string[] | boolean | null) ?? null;
    if (Array.isArray(bl) && bl.some((n) => isNotPerson(n, null))) ch.push(4);
    if (field === 'multi_narr') {
      const nb = before.get(`${key}\u0000narrators`);
      if (nb && Array.isArray(nb.value) && (nb.value as string[]).some((n) => isNotPerson(n, null)))
        ch.push(4);
    }
  }
  if (
    u?.kind === 'no_record' &&
    (field === 'authors' || field === 'narrators' || field === 'multi_narr')
  )
    ch.push(6);
  diffs.push({
    key,
    name: u?.name ?? key,
    labeled: !!u?.labeled,
    field,
    change: ch,
    before: b,
    after: a,
  });
}

const perChange: Record<string, { values: number; recordings: number; labeled: Diff[] }> = {};
for (let c = 1; c <= 8; c++) {
  const d = diffs.filter((x) => x.change.includes(c));
  perChange[c] = {
    values: d.length,
    recordings: new Set(d.map((x) => x.key)).size,
    labeled: d.filter((x) => x.labeled),
  };
}
const unexplained = diffs.filter((x) => !x.change.length);

fs.writeFileSync(
  path.join(out, 'redecide-report.json'),
  JSON.stringify(
    {
      askedBefore,
      askedAfter,
      rulesKey: p.rulesKey,
      gate: p.gate,
      invented: p.invented,
      counts: p.counts,
      perChange: Object.fromEntries(
        Object.entries(perChange).map(([c, v]) => [
          c,
          {
            values: v.values,
            recordings: v.recordings,
            labeled: v.labeled.map((x) => `${x.name} (${x.field})`),
          },
        ]),
      ),
      changedValues: diffs.length,
      changedRecordings: new Set(diffs.map((x) => x.key)).size,
      unexplained: unexplained.length,
      longestDelayMs: longest,
      diffs,
    },
    null,
    1,
  ),
);
console.log(
  JSON.stringify(
    {
      aiRequestsBefore: askedBefore,
      aiRequestsAfter: askedAfter,
      changedValues: diffs.length,
      changedRecordings: new Set(diffs.map((x) => x.key)).size,
      perChange: Object.fromEntries(
        Object.entries(perChange).map(([c, v]) => [
          c,
          `${v.values} values / ${v.recordings} recordings / ${v.labeled.length} labeled`,
        ]),
      ),
      unexplainedByField: unexplained.reduce<Record<string, number>>(
        (m, x) => ((m[x.field] = (m[x.field] ?? 0) + 1), m),
        {},
      ),
      gate: p.gate && {
        passed: p.gate.passed,
        fields: Object.fromEntries(
          Object.entries(p.gate.fields).map(([f, v]) => [
            f,
            `${v.autoRight}/${v.auto} auto, ${v.flaggedRight}/${v.flagged} flagged, ${v.percent.toFixed(1)}%`,
          ]),
        ),
        misses: p.gate.misses.map((m) => `${m.id}.${m.field}`),
      },
    },
    null,
    1,
  ),
);
