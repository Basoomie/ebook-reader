/**
 * Series-order follow-up, stop 1: the AI step's decide, spelling, series and gate phases with
 * the new rules (STAGE4_RULES_VERSION 3), on a working copy of the live cleanup.db, from the
 * stored answers only (as wp20e-respell.ts). No key is read, so nothing can be asked. The fixed
 * picker's one-time pass needs the fetcher: on the copy it is marked done (its effect is measured
 * from the stored search results by series-repick-measure.ts). Writes nothing but the working
 * copy, the report and each book's series number for the scoring (--numbers).
 *
 *   npx ts-node --transpile-only scripts/series-order-live.ts --db <copy/cleanup.db>
 *     --main <copy/ttsu.db> --metadata <snapshot copy of metadata.db> --calibre <books folder>
 *     --dbdir <DB_DIR with cleanup/reference-sample> --out <report.json> --numbers <numbers.json>
 */
import Database from 'better-sqlite3';
import fs, { writeFileSync } from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getStage, updateStage } from '../src/cleanup/stages';
import { Stage4Ai } from '../src/cleanup/stage4/ai-step';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { cleanupAi, migrateWorkingCopy } from './lib/cleanup-ai';
import { getSettings } from '../src/cleanup/settings';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

type Row = {
  calibre_uuid: string;
  calibre_id: number;
  field: string;
  class: string;
  new_json: string;
  old_json: string;
  source: string;
  review_reason: string | null;
  unconfirmed: number | null;
};
function rows(db: Database.Database): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const r of db
    .prepare(
      `SELECT calibre_uuid, calibre_id, field, class, new_json, old_json, source, review_reason,
         json_extract(evidence_json, '$.unconfirmed') AS unconfirmed
       FROM proposed_changes WHERE stage = 4 AND state = 'proposed'`,
    )
    .all() as Row[])
    out.set(`${r.calibre_uuid}|${r.field}`, r);
  return out;
}

async function main() {
  const file = arg('db')!;
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrateWorkingCopy(db);
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const p0 = getStage(db, 4).progress as unknown as Stage4Progress;
  if (p0.repick?.phase !== 'done') {
    p0.repick = { phase: 'done', cursor: '', amazon: 0, ranobedb: 0, bookwalker: 0, reopened: 0 };
    updateStage(db, 4, { progress: p0 as unknown as Record<string, unknown> });
    log("the fixed picker's pass marked done on the copy (it needs the fetcher)");
  }
  const cacheDir = path.join(path.dirname(file), 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${p0.libraryId}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  if (!fs.existsSync(snap)) fs.copyFileSync(arg('metadata')!, snap);
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
    // Only read: the labeled books' file (cleanup/reference-sample) for the gate.
    dbDir: arg('dbdir') ?? null,
    queue,
    log,
  });
  // No secrets: a question could never be sent.
  const { runner } = cleanupAi(db, { log });
  const ai = new Stage4Ai({ db, runner, analysis, log });

  const before = rows(db);
  const gateBefore = (p0 as unknown as { ai?: { gate?: unknown } }).ai?.gate;
  log(`before: ${before.size} proposals; needs work ${ai.needsWork()}`);
  if (!ai.needsWork()) throw new Error('The AI step has nothing to do: is this the new code?');

  let longest = 0;
  let last = Date.now();
  const lag = setInterval(() => {
    const now = Date.now();
    longest = Math.max(longest, now - last - 10);
    last = now;
  }, 10);
  const t0 = Date.now();
  const delays: Record<string, number> = {};
  for (;;) {
    const phase = ai.progress()?.phase ?? 'none';
    longest = 0;
    const r = await ai.step(() => false);
    delays[phase] = Math.max(delays[phase] ?? 0, longest);
    const a = ai.progress()!;
    if (a.phase !== phase) log(`phase ${phase} -> ${a.phase}`);
    if (a.phase === 'decide' && a.decided % 5000 < 50) log(`decide: ${a.decided}`);
    if (r === 'wait') throw new Error(`waits: ${a.wait}`);
    if (r === 'done' && a.phase === 'done') break;
  }
  clearInterval(lag);
  const a = ai.progress()!;
  const after = rows(db);

  // What changed, per field.
  const changes: Record<string, { added: number; removed: number; value: number; klass: number }> =
    {};
  const samples: Record<string, unknown[]> = {};
  const bump = (f: string, k: 'added' | 'removed' | 'value' | 'klass', x: unknown) => {
    const c = (changes[f] ??= { added: 0, removed: 0, value: 0, klass: 0 });
    c[k]++;
    const s = (samples[`${f}:${k}`] ??= []);
    if (s.length < 400) s.push(x);
  };
  for (const [k, r] of after) {
    const b = before.get(k);
    if (!b)
      bump(r.field, 'added', {
        id: r.calibre_id,
        old: r.old_json,
        new: r.new_json,
        src: r.source,
        cls: r.class,
      });
    else if (b.new_json !== r.new_json)
      bump(r.field, 'value', {
        id: r.calibre_id,
        before: b.new_json,
        after: r.new_json,
        src: r.source,
        cls: r.class,
      });
    else if (b.class !== r.class || (b.unconfirmed ?? 0) !== (r.unconfirmed ?? 0))
      bump(r.field, 'klass', {
        id: r.calibre_id,
        before: `${b.class}/${b.unconfirmed}`,
        after: `${r.class}/${r.unconfirmed}`,
        reason: r.review_reason,
      });
  }
  for (const [k, b] of before)
    if (!after.has(k))
      bump(b.field, 'removed', {
        id: b.calibre_id,
        old: b.old_json,
        new: b.new_json,
        src: b.source,
      });

  const report = {
    minutes: (Date.now() - t0) / 60000,
    times: a.times,
    longestDelayMs: delays,
    spelling: a.spelling,
    seriesOrder: a.seriesOrder,
    gateBefore,
    gate: a.gate,
    proposals: { before: before.size, after: after.size },
    changes,
    samples,
  };
  writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  // Every book's number after On as the series step left it (for the test-half scoring).
  const numbers: Record<string, unknown> = {};
  for (const r of db
    .prepare(
      `SELECT calibre_id, series, idx, src, guess, reason, title, title_src, review FROM stage4_series_order`,
    )
    .all() as { calibre_id: number; src: string; idx: number | null }[])
    numbers[String(r.calibre_id)] = r;
  if (arg('numbers')) writeFileSync(arg('numbers')!, JSON.stringify(numbers));
  log(
    JSON.stringify({
      minutes: report.minutes,
      spelling: a.spelling,
      seriesOrder: { ...a.seriesOrder, checks: { ...a.seriesOrder?.checks, examples: undefined } },
      changes,
      gatePassed: a.gate?.passed,
    }),
  );
}

void main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
