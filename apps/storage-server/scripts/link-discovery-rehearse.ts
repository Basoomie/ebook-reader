/**
 * More direct links: the real pass (stage4/link-discovery.ts) on a WORKING COPY of cleanup.db,
 * every phase of the Preview (record, series, settle, propose, the spot check's draw), timed, with
 * the labeled books judged, the polled queries explained and timed at the run's end size, and the
 * result compared with the measuring's (scripts/link-discovery-measure.ts gains.jsonl). Nothing is
 * fetched and nothing is written to Calibre (the planner is never called). Never point it at a
 * live database: it migrates and writes the copy it is given.
 *
 *   npx ts-node --transpile-only scripts/link-discovery-rehearse.ts --db <working cleanup.db>
 *     --main <working ttsu.db> --metadata <calibre snapshot copy> --gold <gold800.json>
 *     [--measured <gains.jsonl>] [--out <report.json>]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { loadGold, mapLabeledIds } from '../src/cleanup/stage2-gate';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { judge, type Gold } from '../src/cleanup/stage4/bookmeter-rules';
import { LinkDiscovery, linkAnalysisId } from '../src/cleanup/stage4/link-discovery';
import { LINK_KEY, type LinkSite } from '../src/cleanup/stage4/link-rules';
import { migrate } from '../src/db/migrations';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);

function refuseLive(p: string): void {
  const n = path.resolve(p).toLowerCase();
  if (n.includes(`${path.sep}appdata${path.sep}`) || n.startsWith('\\\\') || n.startsWith('//'))
    throw new Error(`${p}: a working copy on this PC only (never the NAS or a live database)`);
}

async function main() {
  for (const k of ['db', 'main']) refuseLive(arg(k)!);
  const db = new Database(arg('db')!);
  db.pragma('journal_mode = WAL');
  const quiet = console.log;
  console.log = () => undefined;
  try {
    migrateCleanup(db, { beforeAiMove: () => undefined });
  } finally {
    console.log = quiet;
  }
  const main = new Database(arg('main')!);
  console.log = () => undefined;
  try {
    migrate(main);
  } finally {
    console.log = quiet;
  }
  const p4 = getStage(db, 4).progress as unknown as Stage4Progress;
  const lib = p4.libraryId;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-rehearse-'));
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${lib}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('metadata')!, snap);
  const analysis = new Stage4Analysis({
    cleanup: db,
    main,
    calibreDir: '',
    cacheDir,
    dbDir: null,
    queue: null as never,
  });
  const pass = new LinkDiscovery({
    db,
    analysis,
    batches: null as never,
    targetLibrary: () => lib,
    stage4Done: () => true,
    writeWait: () => 'rehearsal: nothing is written',
    referenceFile: () => arg('gold') ?? null,
    log,
  });
  // A rehearsal starts from the beginning each time.
  if (pass.state().progress.libraryId) pass.again();
  pass.setMode('analyse');

  // Every phase of the Preview. The event loop's delay shows how long the server would be held
  // (the series phase yields inside a step, so a step's own time says nothing there).
  const loop = monitorEventLoopDelay({ resolution: 5 });
  const perPhase: Record<string, { steps: number; ms: number; longestMs: number; heldMs: number }> =
    {};
  const t0 = performance.now();
  let phase = '';
  for (;;) {
    const s = pass.state().progress;
    if (s.phase !== phase) {
      if (phase) {
        perPhase[phase].heldMs = Math.round(loop.max / 1e6);
        loop.disable();
      }
      phase = s.phase;
      perPhase[phase] ??= { steps: 0, ms: 0, longestMs: 0, heldMs: 0 };
      loop.reset();
      loop.enable();
    }
    const t = performance.now();
    const r = await pass.step();
    const ms = performance.now() - t;
    perPhase[phase].steps++;
    perPhase[phase].ms += ms;
    if (ms > perPhase[phase].longestMs) perPhase[phase].longestMs = ms;
    if (r !== 'more') break;
    await new Promise((res) => setImmediate(res));
  }
  loop.disable();
  const wall = performance.now() - t0;
  const st = pass.state();
  const p = st.progress;
  for (const v of Object.values(perPhase)) {
    v.ms = Math.round(v.ms);
    v.longestMs = Math.round(v.longestMs);
  }

  // The labeled books: every proposed link judged against its label (title and volume).
  const { gold } = loadGold(arg('gold')!);
  const byCid = new Map<number, [string, Gold]>();
  for (const [gid, cid] of mapLabeledIds(db, lib, Object.keys(gold ?? {})))
    byCid.set(cid, [gid, gold![gid] as unknown as Gold]);
  const rows = db
    .prepare(
      `SELECT calibre_uuid, calibre_id, site, store_id, store_title, how FROM link_discovery_picks
       WHERE library_id = ? AND state = 'ok' AND proposed = 1`,
    )
    .all(lib) as {
    calibre_uuid: string;
    calibre_id: number;
    site: LinkSite;
    store_id: string;
    store_title: string;
    how: string;
  }[];
  const labeled = { links: 0, ok: 0, flagged: [] as unknown[] };
  for (const r of rows) {
    const g = byCid.get(r.calibre_id);
    if (!g) continue;
    labeled.links++;
    const why = judge(
      { id: r.store_id, title: r.store_title, authors: [], pages: null, edOk: true },
      g[1],
    ).why.filter((x) => x !== 'author');
    if (!why.length) labeled.ok++;
    else
      labeled.flagged.push({
        gid: g[0],
        site: r.site,
        how: r.how,
        why,
        label: g[1].t,
        store: `${r.store_id} ${r.store_title}`,
      });
  }

  // Against the measuring: the same (book, key, id) set, or what differs.
  let compare: unknown = null;
  if (arg('measured')) {
    const want = new Map<string, string>();
    for (const line of fs.readFileSync(arg('measured')!, 'utf8').split('\n')) {
      if (!line) continue;
      const g = JSON.parse(line) as { uuid: string; g: Record<string, { id: string }> };
      for (const [k, v] of Object.entries(g.g)) want.set(`${g.uuid}|${k}`, v.id);
    }
    const got = new Map<string, string>();
    for (const r of rows) got.set(`${r.calibre_uuid}|${LINK_KEY[r.site]}`, r.store_id);
    const only = (a: Map<string, string>, b: Map<string, string>) =>
      [...a].filter(([k, v]) => b.get(k) !== v).map(([k, v]) => `${k}=${v}`);
    const missing = only(want, got);
    const extra = only(got, want);
    compare = {
      measured: want.size,
      rehearsed: got.size,
      onlyMeasured: missing.length,
      onlyRehearsed: extra.length,
      examples: { onlyMeasured: missing.slice(0, 15), onlyRehearsed: extra.slice(0, 15) },
    };
  }

  // The polled queries at the run's end size: their plans and times.
  const plan = (sql: string, ...a: unknown[]) =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
  const time = (f: () => unknown) => {
    const t = performance.now();
    for (let i = 0; i < 20; i++) f();
    return Math.round(((performance.now() - t) / 20) * 100) / 100;
  };
  const aid = linkAnalysisId(p.run);
  const queries = {
    statusMs: time(() => pass.status(lib)),
    pickCountsMs: time(() => pass.pickCounts(lib)),
    proposalCountsMs: time(() => pass.proposalCounts(lib, p.run)),
    spotListMs: time(() => pass.listSpot(lib, p.run)),
    listPageMs: time(() => pass.listLinks(lib, p.run, { state: 'ok' }, 0, 20)),
    plans: {
      pickCounts: plan(
        `SELECT state, site, how, COUNT(*) AS n FROM link_discovery_picks INDEXED BY link_discovery_picks_counts WHERE library_id = ? GROUP BY state, site, how`,
        lib,
      ),
      proposalCounts: plan(
        `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 4 AND library_id = ? AND state = ? AND field = 'identifiers' AND analysis_id = ?`,
        lib,
        'proposed',
        aid,
      ),
      settle: plan(
        `UPDATE link_discovery_picks SET state = 'clash', updated_at = 0 WHERE library_id = ? AND state = 'ok' AND (site, store_id) IN (SELECT site, store_id FROM link_discovery_picks INDEXED BY link_discovery_picks_id WHERE library_id = ? AND state = 'ok' GROUP BY site, store_id HAVING COUNT(*) > 1)`,
        lib,
        lib,
      ),
      startRunDelete: plan(
        `DELETE FROM proposed_changes WHERE stage = 4 AND field = 'identifiers' AND analysis_id LIKE 'link-discovery:%' AND state = 'proposed' AND batch_id IS NULL`,
      ),
    },
    proposedChangesRows: (
      db.prepare('SELECT COUNT(*) AS n FROM proposed_changes').get() as { n: number }
    ).n,
  };

  const noLinkKeys = [
    'amazon_jp',
    'bookwalker',
    'bookmeter',
    'ranobedb',
    'natively',
    'rakuten',
    'honto',
    'ebookjapan',
    'unext',
  ];
  let noLink = 0;
  let noLinkGain = 0;
  const gaining = new Set(rows.map((r) => r.calibre_uuid));
  for (const r of db
    .prepare(`SELECT calibre_uuid FROM stage4_books WHERE library_id = ? AND state = 'proposed'`)
    .all(lib) as { calibre_uuid: string }[]) {
    const b = analysis.snapshotBook(lib, r.calibre_uuid);
    if (!b || noLinkKeys.some((k) => b.identifiers[k])) continue;
    noLink++;
    if (gaining.has(r.calibre_uuid)) noLinkGain++;
  }

  const report = {
    wallSeconds: Math.round(wall / 100) / 10,
    longestSliceMs: p.longestSliceMs,
    endedIn: p.phase,
    perPhase,
    progress: {
      books: p.books,
      record: p.record,
      series: p.series,
      settle: p.settle,
      propose: p.propose,
      spot: p.spot,
      labeledLine: p.labeled,
    },
    picks: pass.pickCounts(lib),
    proposals: pass.proposalCounts(lib, p.run),
    booksGaining: gaining.size,
    noDirectLink: { books: noLink, gaining: noLinkGain },
    spotBySlot: db
      .prepare(
        'SELECT site, how, COUNT(*) AS n FROM link_discovery_spot GROUP BY site, how ORDER BY site, how',
      )
      .all(),
    labeled,
    compare,
    queries,
  };
  if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  fs.rmSync(cacheDir, { recursive: true, force: true });
}

void main();
