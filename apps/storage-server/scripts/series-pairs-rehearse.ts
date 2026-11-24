/**
 * Series under two names (tier 4, Part 3), stop 3's rehearsal on working copies of the live
 * state: cleanup.db brought to the current schema, the reader's Calibre snapshot. Runs the real
 * pass (Preview) with stage 4's real analysis, times every step, then plays the write (the
 * stand-in batches mark the merge proposals applied and the merges are applied to the snapshot
 * copy, as Calibre would hold them), lets the open stage-4 proposals follow, and asks stage 4's
 * own proposals (proposalsFor) again for every book of the merged pairs: none may move a book
 * back to the other name. Writes only the working copies and the report.
 *
 *   npx ts-node --transpile-only scripts/series-pairs-rehearse.ts --db <copy/cleanup.db>
 *     --metadata <copy of the snapshot> --work <empty folder> --out <report.json>
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { openCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings } from '../src/cleanup/settings';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { seriesKey } from '../src/cleanup/stage4/series-spelling';
import { SeriesPairs, seriesPairsAnalysisId } from '../src/cleanup/series-pairs/pass';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

async function main() {
  const work = arg('work')!;
  fs.mkdirSync(work, { recursive: true });
  const dbFile = path.join(work, 'cleanup.db');
  fs.copyFileSync(arg('db')!, dbFile);
  const t0 = performance.now();
  const db = openCleanupDatabase(dbFile);
  log(
    `migrated to v${db.pragma('user_version', { simple: true })} in ${Math.round(performance.now() - t0)} ms`,
  );
  const p4 = getStage(db, 4).progress as unknown as Stage4Progress;
  const lib = p4.libraryId;
  const cacheDir = path.join(work, 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${lib}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('metadata')!, snap);
  const analysis = new Stage4Analysis({
    cleanup: db,
    main: null as never,
    calibreDir: '',
    cacheDir,
    dbDir: null,
    queue: null as never,
  });
  analysis.loadSnapshot(lib);
  const planned: string[] = [];
  let mode: 'preview' | 'write' = 'preview';
  const pass = new SeriesPairs({
    db,
    source: {
      books: (l) => analysis.seriesPairBooks(l),
      facts: (l, uuid) => analysis.seriesPairFacts(l, uuid),
    },
    batches: {
      plan: async (_l: string, o: { analysisId?: string }) => {
        if (mode !== 'write') return { batch: null, reason: 'Nothing left to write' };
        const n = db
          .prepare(
            `UPDATE proposed_changes SET state = 'applied' WHERE source = 'series-pairs' AND analysis_id = ? AND state = 'proposed' AND class = 'auto'`,
          )
          .run(o.analysisId).changes;
        if (!n) return { batch: null, reason: 'Nothing left to write' };
        planned.push(String(o.analysisId));
        return { batch: { id: `rehearsal-${planned.length}` } as never, reason: null };
      },
    },
    targetLibrary: () => lib,
    writeWait: () => null,
    log,
  });

  // ---- Preview, every step timed
  pass.setMode('analyse');
  const steps: Record<string, { n: number; maxMs: number; totalMs: number }> = {};
  const runSteps = async () => {
    for (let i = 0; i < 100_000; i++) {
      const phase = pass.state().progress.phase;
      const t = performance.now();
      const r = await pass.step();
      const ms = performance.now() - t;
      const s = (steps[phase] ??= { n: 0, maxMs: 0, totalMs: 0 });
      s.n++;
      s.maxMs = Math.max(s.maxMs, ms);
      s.totalMs += ms;
      if (r === 'idle' || r === 'wait') return;
    }
  };
  await runSteps();
  const pv = pass.state().progress;
  log(
    `Preview: ${JSON.stringify(pv.counts)}, ${pv.propose.books} books proposed in ${pv.propose.pairs} pairs`,
  );
  const groups = db
    .prepare(`SELECT grp, answer, COUNT(*) AS n FROM series_pairs GROUP BY grp, answer`)
    .all();
  const held = db
    .prepare(`SELECT held, COUNT(*) AS n FROM series_pairs WHERE held IS NOT NULL GROUP BY held`)
    .all();

  // ---- the page's and the card's queries: their plans on this copy
  const plans: Record<string, string[]> = {};
  const explain = (name: string, sql: string, ...args: unknown[]) => {
    plans[name] = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]
    ).map((r) => r.detail);
  };
  const aid = seriesPairsAnalysisId(pv.run);
  explain(
    'pair merge counts',
    `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ?
       AND json_extract(evidence_json, '$.seriesPair.short') = ? AND json_extract(evidence_json, '$.seriesPair.long') = ? GROUP BY state`,
    lib,
    aid,
    'a',
    'b',
  );
  explain(
    'run counts',
    `SELECT state, COUNT(*) AS n FROM proposed_changes WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ? GROUP BY state`,
    lib,
    aid,
  );
  explain(
    'merges written',
    `SELECT id FROM proposed_changes WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ? AND state = 'applied'
       AND stage = 4 AND field = 'series' AND json_extract(evidence_json, '$.followed') IS NULL`,
    lib,
    aid,
  );
  explain(
    'list',
    `SELECT * FROM series_pairs WHERE library_id = ? AND answer = 'review' ORDER BY short_books + long_books DESC, id LIMIT 20 OFFSET 0`,
    lib,
  );
  const tList = performance.now();
  for (const v of ['review', 'merge', 'separate', 'decided'] as const) pass.list(lib, v, 0, 20);
  const listMs = Math.round(performance.now() - tList);

  // ---- the write, played: the merges as Calibre would hold them
  const open4Before = db
    .prepare(
      `SELECT COUNT(*) AS n FROM proposed_changes WHERE stage = 4 AND field = 'series' AND state = 'proposed' AND source <> 'series-pairs'`,
    )
    .get() as { n: number };
  mode = 'write';
  pass.setMode('on');
  await runSteps();
  await runSteps();
  const pw = pass.state().progress;
  log(
    `Write played: ${planned.length} batches; stage-4 proposals closed ${pw.write.closed}, moved ${pw.write.repointed}`,
  );
  const meta = new Database(snap);
  const merges = db
    .prepare(
      `SELECT calibre_id, json_extract(new_json, '$.name') AS name FROM proposed_changes WHERE source = 'series-pairs' AND state = 'applied'`,
    )
    .all() as { calibre_id: number; name: string }[];
  meta.transaction(() => {
    for (const m of merges) {
      let s = meta.prepare('SELECT id FROM series WHERE name = ?').get(m.name) as
        | { id: number }
        | undefined;
      if (!s)
        s = {
          id: Number(
            meta.prepare('INSERT INTO series (name, sort) VALUES (?, ?)').run(m.name, m.name)
              .lastInsertRowid,
          ),
        };
      meta.prepare('DELETE FROM books_series_link WHERE book = ?').run(m.calibre_id);
      meta
        .prepare('INSERT INTO books_series_link (book, series) VALUES (?, ?)')
        .run(m.calibre_id, s.id);
    }
  })();
  meta.close();
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(snap, later, later);
  analysis.loadSnapshot(lib);

  // ---- stage 4 asked again for every book of the merged pairs: with the merges recorded, and
  // (the counter-check) with the records dropped for a moment
  const settings = getSettings(db);
  const mergedPairs = db
    .prepare(
      `SELECT short_name, long_name, kept_name, books_json FROM series_pairs WHERE answer = 'merge'`,
    )
    .all() as { short_name: string; long_name: string; kept_name: string; books_json: string }[];
  const ask = () => {
    const out = {
      asked: 0,
      movedBack: 0,
      elsewhere: 0,
      numberOnly: 0,
      unchanged: 0,
      backExamples: [] as string[],
      elsewhereExamples: [] as string[],
    };
    for (const r of mergedPairs) {
      const bs = JSON.parse(r.books_json) as {
        short: { uuid: string; title: string }[];
        long: { uuid: string; title: string }[];
      };
      const keptKey = seriesKey(r.kept_name);
      const otherKeys = new Set([seriesKey(r.short_name), seriesKey(r.long_name)]);
      otherKeys.delete(keptKey);
      for (const b of [...bs.short, ...bs.long]) {
        const res = analysis.proposalsFor(p4, b.uuid, settings);
        if (!res) continue;
        out.asked++;
        const s = res.proposals.find((x) => x.field === 'series');
        if (!s) {
          out.unchanged++;
          continue;
        }
        const n = (s.new as { name?: string | null } | null)?.name ?? null;
        if (n !== null && otherKeys.has(seriesKey(n))) {
          out.movedBack++;
          if (out.backExamples.length < 15)
            out.backExamples.push(`${b.title} -> ${n} (kept ${r.kept_name})`);
        } else if (n === null || seriesKey(n) !== keptKey) {
          out.elsewhere++;
          if (out.elsewhereExamples.length < 15)
            out.elsewhereExamples.push(`${b.title} -> ${n} (kept ${r.kept_name})`);
        } else out.numberOnly++;
      }
    }
    return out;
  };
  const withMerges = ask();
  db.exec('SAVEPOINT counter');
  db.prepare(`DELETE FROM series_pair_decisions WHERE decision = 'merged'`).run();
  const withoutMerges = ask();
  db.exec('ROLLBACK TO counter; RELEASE counter');
  log(
    `Stage 4 asked again: ${JSON.stringify({ ...withMerges, backExamples: undefined, elsewhereExamples: undefined })}; without the merge records: ${withoutMerges.movedBack} would move back`,
  );
  const report = {
    preview: { counts: pv.counts, propose: pv.propose, groups, held },
    steps: Object.fromEntries(
      Object.entries(steps).map(([k, v]) => [
        k,
        { n: v.n, maxMs: Math.round(v.maxMs), totalMs: Math.round(v.totalMs) },
      ]),
    ),
    listMs,
    plans,
    write: {
      batches: planned.length,
      merges: merges.length,
      ...pw.write,
      open4Before: open4Before.n,
    },
    stage4Again: withMerges,
    stage4AgainWithoutMergeRecords: { ...withoutMerges, elsewhereExamples: undefined },
  };
  fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
