/**
 * WP20g stop 1, "scoped = whole": books treated as added by hand go through the new arrivals'
 * own run (BookArrivals, the real CleanupService wiring) in Preview, on a working copy of the
 * live cleanup.db and ttsu.db, and their results are compared with what the whole-library code
 * gives the same books:
 *
 *   stage 1  the run's identical-copy proposals vs stage 1's own analysis of the library
 *   stage 2  the run's proposals vs stage 2's own whole-library analysis run on the same copy
 *   stage 3  every candidate pair the run's compare finds and classifies vs the pairs stage 3's
 *            own analysis stored (both books still in the library)
 *   stage 4  the values the run decides (E, stored answers) vs the library's decided values
 *   stage 5  the terms the run decides per book vs the library's
 *
 * Reads the EPUBs from the library share (files only; every database is a local copy). Nothing is
 * paid: the AI limit is set to this month's spend, so a question that would have to be asked
 * again shows as a wait (and is reported).
 *
 *   npx ts-node --transpile-only scripts/wp20g-scoped.ts --db <copy/cleanup.db> --work <dir>
 *     --main <copy/ttsu.db> --ai-key-dir <dir> --metadata <copy/metadata.db> --calibre <dir>
 *     --gold <gold800.json> --genre-labels <genre-labels.json> [--n 30] [--reuse]
 *     [--no-whole2] [--minutes 90] [--stage3-cache <stage3.db>] [--unchanged4] [--skip3]
 *     [--out report.json]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { getLibrary } from '../src/calibre/libraries';
import { judgePair } from '../src/cleanup/arrivals/compare';
import { CleanupService } from '../src/cleanup/cleanup-service';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { mapLabeledIds } from '../src/cleanup/stage2-gate';
import { getStage, setStageMode } from '../src/cleanup/stages';
import { InProcessReader } from '../src/counts/book-text-worker';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import type { BookTextModule } from '../src/cleanup/stage3-work';
import { migrateWorkingCopy } from './lib/cleanup-ai';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bundle = require(COUNTER_BUNDLE) as BookTextModule;
const IMPORT = { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true };

/** A seeded shuffle (the same books on every run of the script). */
function pick<T>(xs: T[], n: number, seed: number): T[] {
  const a = [...xs];
  let x = seed;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function backupInto(src: string, out: string): Promise<void> {
  for (const x of [out, out + '-wal', out + '-shm']) fs.rmSync(x, { force: true });
  const s = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await s.backup(out);
  } finally {
    s.close();
  }
}

type Row = Record<string, unknown>;

async function main() {
  const work = arg('work')!;
  fs.mkdirSync(path.join(work, 'cleanup', 'reference-sample'), { recursive: true });
  const cdb = path.join(work, 'cleanup.db');
  const mdb = path.join(work, 'ttsu.db');
  if (!has('reuse')) {
    log('copying the working copies');
    await backupInto(arg('db')!, cdb);
    await backupInto(arg('main')!, mdb);
  }
  fs.copyFileSync(
    path.join(arg('ai-key-dir')!, 'ai-secrets.key'),
    path.join(work, 'ai-secrets.key'),
  );
  fs.copyFileSync(arg('gold')!, path.join(work, 'cleanup', 'reference-sample', 'gold800.json'));
  fs.copyFileSync(
    arg('genre-labels')!,
    path.join(work, 'cleanup', 'reference-sample', 'genre-labels.json'),
  );
  const cleanup = new Database(cdb);
  cleanup.pragma('journal_mode = WAL');
  const main = new Database(mdb);
  main.pragma('journal_mode = WAL');
  migrateWorkingCopy(cleanup);
  log(`working copy v${cleanup.pragma('user_version', { simple: true })}`);
  const libraryId = (getStage(cleanup, 4).progress as { libraryId: string }).libraryId;
  const cacheDir = path.join(work, 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${libraryId}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  if (!fs.existsSync(snap)) fs.copyFileSync(arg('metadata')!, snap);
  // --fetch-pages: the stored answers' pages (plain files copied from the server's cache folder,
  // <dir>/fetch/<site>/…): stage 4 reads a page from its file.
  if (arg('fetch-pages'))
    fs.cpSync(arg('fetch-pages')!, path.join(cacheDir, 'cleanup'), { recursive: true });
  // Stage 3's sketch store (the server's cache, a local copy): the candidate index reads it.
  if (arg('stage3-cache')) {
    const dst = path.join(cacheDir, 'cleanup', 'stage3.db');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    for (const x of ['', '-wal'])
      if (fs.existsSync(arg('stage3-cache')! + x))
        fs.copyFileSync(arg('stage3-cache')! + x, dst + x);
  }
  const s0 = getSettings(cleanup);
  updateSettings(cleanup, {
    gate: { ...s0.gate, labeledBooksFile: '', genreLabelsFile: '' },
    arrivals: { ...s0.arrivals, settleMinutes: 0, handCheckMinutes: 0 },
    ai: { ...s0.ai, booksArrivalsDesign: 'E' },
  });
  const logs: string[] = [];
  const service = new CleanupService({
    cleanup,
    main,
    calibreDir: arg('calibre')!,
    cacheDir,
    dbDir: work,
    indexerEnabled: () => true,
    stage3Reader: new InProcessReader(bundle, IMPORT),
    log: (m) => {
      logs.push(m);
      log(m);
    },
    logError: (m, e) => log(`ERROR ${m} ${(e as Error)?.message ?? ''}`),
  });
  // Nothing is paid: the limit is this month's spend.
  // --ai-cap: room for the questions of books whose evidence changed (the left-out ones); every
  // compared book asked again is listed in the report.
  service.aiCore.updateSettings({
    spendLimitUsd:
      Math.round((service.aiCore.room().spentUsd + Number(arg('ai-cap') ?? 0)) * 100) / 100,
  });
  const lib = getLibrary(main, libraryId)!;
  const libDir = path.join(arg('calibre')!, lib.folder);
  const arrivals = service.arrivals;
  const a = arrivals as unknown as {
    recordNewBooks(l: string, now: number): void;
    snapshotBooks(
      l: string,
    ): Map<number, { calibreId: number; uuid: string; filePath: string | null; title: string }>;
    compareDeps(l: string, d: string, b?: unknown): unknown;
  };
  const books = a.snapshotBooks(libraryId);
  log(`library: ${books.size} books`);

  // The books: 30 labeled, 30 not, each with an EPUB.
  const n = Number(arg('n') ?? 30);
  const gold = JSON.parse(fs.readFileSync(arg('gold')!, 'utf8')) as Record<string, unknown>;
  const labeled = [...mapLabeledIds(cleanup, libraryId, Object.keys(gold)).values()].filter(
    (id) => books.get(id)?.filePath,
  );
  const lset = new Set(labeled);
  const others = [...books.values()]
    .filter((b) => b.filePath && !lset.has(b.calibreId))
    .map((b) => b.calibreId);
  // --unchanged4: only books stage 4 changed nothing in (their online searches are the ones
  // stage 4 made, so the stored answers answer them; nothing is fetched here).
  const changed4 = new Set(
    has('unchanged4')
      ? (
          cleanup
            .prepare(
              `SELECT DISTINCT calibre_uuid FROM proposed_changes WHERE stage = 4 AND state = 'applied'`,
            )
            .all() as { calibre_uuid: string }[]
        ).map((r) => r.calibre_uuid)
      : [],
  );
  const ok4 = (id: number) => !changed4.has(books.get(id)!.uuid);
  const chosen = [
    ...pick(labeled.filter(ok4), n, 20261122),
    ...pick(others.filter(ok4), n, 20261123),
  ];
  log(`chosen: ${chosen.length} books (${n} labeled, ${n} not)`);

  // Before: the library's decided values for these books (the run decides them again).
  const keyOf = (id: number) => `${libraryId}:${books.get(id)!.uuid}`;
  const valuesOf = (stage: string) => {
    const out = new Map<string, Row>();
    const q = cleanup.prepare(
      `SELECT field, value_json, source, flagged, decided_at FROM ai_values WHERE stage = ? AND item_key = ?`,
    );
    for (const id of chosen)
      for (const r of q.all(stage, keyOf(id)) as Row[])
        out.set(`${id}|${r.field}`, {
          value: r.value_json,
          source: r.source,
          flagged: r.flagged,
          decidedAt: r.decided_at,
        });
    return out;
  };
  const before4 = valuesOf('calibre4');
  const before5 = valuesOf('calibre5');

  // As added by hand: the baseline recorded, the chosen books marked new.
  a.recordNewBooks(libraryId, Date.now());
  const mark = cleanup.prepare(
    `UPDATE calibre_known_books SET origin = 'hand', run_id = NULL, added_at = 0, settled_at = NULL
     WHERE library_id = ? AND calibre_id = ?`,
  );
  cleanup.transaction(() => {
    for (const id of chosen) mark.run(libraryId, id);
  })();
  for (const st of [1, 2, 3, 4, 5])
    if (getStage(cleanup, st).mode === 'off') setStageMode(cleanup, st, 'analyse');
  arrivals.setMode('analyse');
  const started = Date.now();
  const gaveUp = new Set<string>();
  arrivals.requestRun();

  // The run, until it is done (or the time is up).
  const until = Date.now() + Number(arg('minutes') ?? 90) * 60_000;
  let phase = '';
  let wait = '';
  let waitSince = Date.now();
  for (;;) {
    const r = await arrivals.step();
    const run = arrivals.currentRun();
    if (run && run.p.phase !== phase) {
      phase = run.p.phase;
      log(`run ${run.id}: ${phase}`);
    }
    if (run?.p.waiting && run.p.waiting !== wait) {
      wait = run.p.waiting;
      waitSince = Date.now();
      log(`  waiting: ${wait}`);
    }
    // --give-up-new-lookups: nothing fetches here. Lookups the library's own run never made are
    // given up after a minute (as for a switched-off site) and their books left out of stage 4's
    // and 5's comparison; the rest decide from the stored answers.
    if (
      has('give-up-new-lookups') &&
      run?.p.waiting?.startsWith('Looking the new books up online') &&
      Date.now() - waitSince > 60_000
    ) {
      const q = cleanup
        .prepare(`SELECT id FROM fetch_requests WHERE state = 'queued' AND created_at >= ?`)
        .all(started) as { id: number }[];
      if (q.length) {
        const w = cleanup.prepare('SELECT calibre_uuid FROM fetch_waiters WHERE request_id = ?');
        const now = Date.now();
        cleanup.transaction(() => {
          for (const { id } of q) {
            for (const r of w.all(id) as { calibre_uuid: string }[]) gaveUp.add(r.calibre_uuid);
            cleanup
              .prepare(
                `UPDATE fetch_requests SET state = 'failed', error = 'Not fetched in the proof', finished_at = ?, updated_at = ? WHERE id = ?`,
              )
              .run(now, now, id);
            cleanup.prepare('UPDATE fetch_waiters SET ready = 1 WHERE request_id = ?').run(id);
          }
        })();
        log(
          `  gave up ${q.length} lookups the library never made (${gaveUp.size} books left out of stages 4-5)`,
        );
        waitSince = Date.now();
      }
    }
    // The same wait for 10 minutes (a lookup nobody answers here, a question not paid): stop.
    if (run?.p.waiting && Date.now() - waitSince > 10 * 60_000) {
      log(`the run waits on "${wait}" for 10 minutes: it stops here`);
      break;
    }
    if (r === 'idle' && !arrivals.currentRun()) break;
    if (Date.now() > until) {
      log('time is up: the run stops here');
      break;
    }
    if (r === 'wait') await sleep(1000);
  }
  const run = arrivals.currentRun() ?? null;
  const runId = (
    cleanup.prepare('SELECT MAX(id) AS id FROM calibre_arrival_runs').get() as { id: number }
  ).id;
  const runRow = cleanup
    .prepare('SELECT phase, state, error, progress_json FROM calibre_arrival_runs WHERE id = ?')
    .get(runId) as Row;
  const aid = `arrivals:${runId}`;
  const props = (stage: number) =>
    cleanup
      .prepare(
        `SELECT calibre_id, field, new_json, class FROM proposed_changes WHERE stage = ? AND analysis_id = ? ORDER BY calibre_id, field`,
      )
      .all(stage, aid) as { calibre_id: number; field: string; new_json: string; class: string }[];
  const report: Record<string, unknown> = {
    chosen,
    run: {
      id: runId,
      phase: runRow.phase,
      state: runRow.state,
      error: runRow.error,
      stoppedAt: run?.p.phase ?? null,
      waiting: run?.p.waiting ?? null,
    },
  };
  const scopeSet = new Set(chosen);

  // ---- stage 1: the run's proposals vs stage 1's own analysis (proposals still open for these).
  const a1 = (getStage(cleanup, 1).progress as { analysisId?: string }).analysisId ?? '';
  const whole1 = cleanup
    .prepare(
      `SELECT calibre_id FROM proposed_changes WHERE stage = 1 AND analysis_id = ? AND state = 'proposed'`,
    )
    .all(a1)
    .map((r) => (r as { calibre_id: number }).calibre_id)
    .filter((id) => scopeSet.has(id));
  const scoped1 = props(1).map((r) => r.calibre_id);
  report.stage1 = {
    scoped: scoped1,
    whole: whole1,
    same: JSON.stringify(scoped1.sort()) === JSON.stringify(whole1.sort()),
  };
  log(`stage 1: scoped ${scoped1.length}, whole ${whole1.length}`);

  if (!has('skip3')) {
    // ---- stage 3: every candidate pair of the chosen books, classified by the run's compare.
    const a3 = (getStage(cleanup, 3).progress as { analysisId?: string }).analysisId ?? '';
    const stored3 = cleanup
      .prepare(`SELECT a_id, b_id, class FROM content_pairs WHERE analysis_id = ?`)
      .all(a3) as { a_id: number; b_id: number; class: string }[];
    const wholePairs = new Map<string, string>();
    for (const p of stored3)
      if ((scopeSet.has(p.a_id) || scopeSet.has(p.b_id)) && books.has(p.a_id) && books.has(p.b_id))
        wholePairs.set(`${Math.min(p.a_id, p.b_id)}-${Math.max(p.a_id, p.b_id)}`, p.class);
    const cmp = await import('../src/cleanup/arrivals/compare');
    const cd = a.compareDeps(libraryId, libDir, books) as Parameters<typeof cmp.readNewText>[0];
    const news = new Map<number, Awaited<ReturnType<typeof cmp.readNewText>>>();
    const pacer = new (await import('../src/cleanup/arrivals/sources-fs')).SourcePacer(0);
    for (const id of chosen) {
      const b = books.get(id)!;
      const file = path.join(libDir, b.filePath!);
      news.set(id, await cmp.readNewText(cd, id, file, [b.title], pacer));
    }
    const pairs = await cmp.candidatePairsOf(cd, [...news.values()]);
    const measured = await cmp.measurePairs(cd, news, pairs);
    const scopedPairs = new Map<string, string>();
    for (const m of measured) {
      if (!m.m) continue;
      const k = news.has(m.pair.a) ? m.pair.a : m.pair.b;
      const other = k === m.pair.a ? m.pair.b : m.pair.a;
      const v = await judgePair(cd, k, other, m.m, news, (x: number) =>
        cmp.libraryQuality(cd, x, pacer),
      );
      scopedPairs.set(`${Math.min(k, other)}-${Math.max(k, other)}`, v.cls);
    }
    const diff3: Row[] = [];
    for (const [k, c] of wholePairs)
      if (scopedPairs.get(k) !== c)
        diff3.push({ pair: k, whole: c, scoped: scopedPairs.get(k) ?? 'not found' });
    for (const [k, c] of scopedPairs)
      if (!wholePairs.has(k)) diff3.push({ pair: k, whole: 'not stored', scoped: c });
    report.stage3 = { whole: wholePairs.size, scoped: scopedPairs.size, differences: diff3 };
    log(
      `stage 3: whole ${wholePairs.size} pairs, scoped ${scopedPairs.size}, differences ${diff3.length}`,
    );
  }
  // ---- stage 4 and 5: the values the run decided vs the library's (before the run).
  const leftOut = new Set(chosen.filter((id) => gaveUp.has(books.get(id)!.uuid)).map(String));
  report.leftOutOf45 = [...leftOut];
  const cmpValues = (before: Map<string, Row>, stage: string) => {
    const after = valuesOf(stage);
    const diffs: Row[] = [];
    let same = 0;
    // Values the run decided again (else "same" says nothing).
    let decidedAgain = 0;
    for (const [k, v] of before) {
      if (leftOut.has(k.split('|')[0])) continue;
      const w = after.get(k);
      if (w && Number(w.decidedAt) >= started) decidedAgain++;
      if (w && w.value === v.value && w.flagged === v.flagged) same++;
      else diffs.push({ key: k, whole: v, scoped: w ?? null });
    }
    return {
      values: before.size - [...before.keys()].filter((k) => leftOut.has(k.split('|')[0])).length,
      decidedAgain,
      same,
      differences: diffs,
    };
  };
  // The compared books the run asked a model about again (their evidence changed).
  const askedAgain = (
    cleanup
      .prepare(`SELECT DISTINCT stage, item_key FROM ai_requests WHERE created_at >= ?`)
      .all(started) as { stage: string; item_key: string }[]
  ).filter((r) => {
    const id = chosen.find((c) => keyOf(c) === r.item_key);
    return id !== undefined && !leftOut.has(String(id));
  });
  report.askedAgain = askedAgain;
  report.aiCost = service.aiCore.room().spentUsd;
  report.stage4 = cmpValues(before4, 'calibre4');
  report.stage5 = cmpValues(before5, 'calibre5');
  log(
    `stage 4: ${JSON.stringify({ ...(report.stage4 as Row), differences: (report.stage4 as { differences: Row[] }).differences.length })}`,
  );
  log(
    `stage 5: ${JSON.stringify({ ...(report.stage5 as Row), differences: (report.stage5 as { differences: Row[] }).differences.length })}`,
  );

  // ---- stage 2: stage 2's own whole-library analysis on the same copy, vs the run's.
  const scoped2 = props(2).map((r) => `${r.calibre_id}|${r.field}|${r.new_json}|${r.class}`);
  if (!has('no-whole2')) {
    log('stage 2: the whole-library analysis (a stat per book on the share)');
    const a2 = (
      service as unknown as {
        analysis2: {
          restart(l: string): { analysisId: string };
          step(s: () => boolean): Promise<boolean>;
        };
      }
    ).analysis2;
    const p2 = a2.restart(libraryId);
    let steps = 0;
    while (!(await a2.step(() => false)))
      if (++steps % 50 === 0)
        log(`  stage 2 whole: ${JSON.stringify(getStage(cleanup, 2).progress).slice(0, 160)}`);
    const whole2 = (
      cleanup
        .prepare(
          `SELECT calibre_id, field, new_json, class FROM proposed_changes WHERE stage = 2 AND analysis_id = ?`,
        )
        .all(p2.analysisId) as {
        calibre_id: number;
        field: string;
        new_json: string;
        class: string;
      }[]
    )
      .filter((r) => scopeSet.has(r.calibre_id))
      .map((r) => `${r.calibre_id}|${r.field}|${r.new_json}|${r.class}`);
    const ws = new Set(whole2);
    const ss = new Set(scoped2);
    report.stage2 = {
      scoped: scoped2.length,
      whole: whole2.length,
      onlyScoped: scoped2.filter((x) => !ws.has(x)),
      onlyWhole: whole2.filter((x) => !ss.has(x)),
    };
    log(`stage 2: scoped ${scoped2.length}, whole ${whole2.length}`);
  } else report.stage2 = { scoped: scoped2.length, whole: null };
  report.logs = logs.slice(-200);
  if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  await service.stop();
  cleanup.close();
  main.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
