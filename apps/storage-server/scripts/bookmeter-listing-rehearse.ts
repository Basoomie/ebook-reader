/**
 * Bookmeter links: the real pass (stage4/bookmeter-listing.ts) on WORKING COPIES of cleanup.db
 * and ttsu.db, every phase of the Preview (search, pick, propose, the spot check's draw), timed,
 * with the labeled books judged, every proposal checked to change only the bookmeter id, the
 * polled queries explained and timed at the run's end size, and the result compared with step 1's
 * measuring (bookmeter-listing-extract.ts: changes.jsonl from the stored answers, the blind
 * sample's live searches). The searches the pass asks are answered by a stand-in fetcher: the
 * sample's saved live pages, else "not fetched" (the book is decided from its stored answers).
 * The fetch cache is read from --cache (read only; new answers go to a temporary folder). Nothing
 * is written to Calibre and the planner is never called. Never point it at a live database: it
 * migrates and writes the copies it is given.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-listing-rehearse.ts --db <working cleanup.db>
 *     --main <working ttsu.db> --metadata <calibre snapshot copy> --cache <fetch cache folder>
 *     --live <sample's live pages> --gold <gold800.json> [--changes <changes.jsonl>]
 *     [--sample <sample-live.jsonl>] [--out <report.json>]
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay, performance } from 'perf_hooks';
import { brotliCompressSync, brotliDecompressSync } from 'zlib';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { loadGold, mapLabeledIds } from '../src/cleanup/stage2-gate';
import { getStage } from '../src/cleanup/stages';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import {
  BookmeterListings,
  listingAnalysisId,
  type BlDecision,
} from '../src/cleanup/stage4/bookmeter-listing';
import { judge, type Gold } from '../src/cleanup/stage4/bookmeter-rules';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { BOOKMETER_AUTHOR_SEARCH_KEY } from '../src/cleanup/stage4/store-links';
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

const quietly = <T>(f: () => T): T => {
  const keep = console.log;
  console.log = () => undefined;
  try {
    return f();
  } finally {
    console.log = keep;
  }
};

async function main() {
  for (const k of ['db', 'main']) refuseLive(arg(k)!);
  const db = new Database(arg('db')!);
  db.pragma('journal_mode = WAL');
  quietly(() => migrateCleanup(db, { beforeAiMove: () => undefined }));
  const main = new Database(arg('main')!);
  quietly(() => migrate(main));
  const p4 = getStage(db, 4).progress as unknown as Stage4Progress;
  const lib = p4.libraryId!;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-rehearse-'));
  const snap = path.join(tmp, SNAPSHOT_DIRNAME, `${lib}.db`);
  fs.mkdirSync(path.dirname(snap), { recursive: true });
  fs.copyFileSync(arg('metadata')!, snap);
  // The queue writes new answers under tmp; stored answers are read from the cache (read only).
  const nasCache = arg('cache')!;
  const s = getSettings(db).fetch;
  updateSettings(db, {
    fetch: {
      ...s,
      sites: { ...s.sites, bookmeter: { ...s.sites.bookmeter, enabled: true } },
    },
  });
  const queue = new FetchQueue(db, tmp, () => getSettings(db).fetch);
  const cacheOf = db.prepare('SELECT cache_file FROM fetch_requests WHERE id = ?');
  queue.readAnswer = (id: number) => {
    const r = cacheOf.get(id) as { cache_file: string | null } | undefined;
    if (!r?.cache_file) return null;
    for (const dir of [tmp, nasCache]) {
      try {
        return brotliDecompressSync(fs.readFileSync(path.join(dir, r.cache_file)));
      } catch {
        /* the other folder */
      }
    }
    return null;
  };
  const analysis = new Stage4Analysis({
    cleanup: db,
    main,
    calibreDir: '',
    cacheDir: tmp,
    dbDir: null,
    queue,
  });
  const pass = new BookmeterListings({
    db,
    analysis,
    queue,
    batches: null as never,
    targetLibrary: () => lib,
    stage4Done: () => true,
    writeWait: () => 'rehearsal: nothing is written',
    referenceFile: () => arg('gold') ?? null,
    log,
  });
  if (pass.state().progress.libraryId) pass.again();
  pass.setMode('analyse');

  /** The stand-in fetcher: the sample's live page for the search, else "not fetched". */
  const liveDir = arg('live');
  let livePages = 0;
  let notFetched = 0;
  const answerOpen = () => {
    const open = db
      .prepare(
        `SELECT DISTINCT r.id, r.key FROM fetch_requests r JOIN bookmeter_listing_waiters w ON w.request_id = r.id
         WHERE r.state IN ('queued', 'leased')`,
      )
      .all() as { id: number; key: string }[];
    const now = Date.now();
    db.transaction(() => {
      for (const r of open) {
        let body: Buffer | null = null;
        if (liveDir && r.key.startsWith(BOOKMETER_AUTHOR_SEARCH_KEY)) {
          const rest = r.key.slice(BOOKMETER_AUTHOR_SEARCH_KEY.length);
          const f = path.join(liveDir, createHash('sha1').update(rest).digest('hex') + '.html');
          if (fs.existsSync(f)) body = fs.readFileSync(f);
        }
        if (body) {
          const cf = queue.cacheFile('bookmeter', r.key);
          fs.mkdirSync(path.dirname(path.join(tmp, cf)), { recursive: true });
          fs.writeFileSync(path.join(tmp, cf), brotliCompressSync(body));
          db.prepare(
            `UPDATE fetch_requests SET state = 'done', status = 200, cache_file = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
          ).run(cf, now, now, r.id);
          livePages++;
        } else {
          // Not fetched in a rehearsal: an empty result page, so the book is decided from its
          // stored searches (the live pass asks a refused search again until it is answered).
          const cf = queue.cacheFile('bookmeter', r.key);
          fs.mkdirSync(path.dirname(path.join(tmp, cf)), { recursive: true });
          fs.writeFileSync(path.join(tmp, cf), brotliCompressSync(Buffer.from('<ul></ul>')));
          db.prepare(
            `UPDATE fetch_requests SET state = 'done', status = 200, cache_file = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
          ).run(cf, now, now, r.id);
          notFetched++;
        }
        db.prepare('UPDATE bookmeter_listing_waiters SET ready = 1 WHERE request_id = ?').run(r.id);
      }
    })();
    return open.length;
  };

  const loop = monitorEventLoopDelay({ resolution: 5 });
  const perPhase: Record<string, { steps: number; ms: number; longestMs: number; heldMs: number }> =
    {};
  const t0 = performance.now();
  let phase = '';
  for (let guard = 0; guard < 10_000_000; guard++) {
    const st = pass.state().progress;
    if (st.phase !== phase) {
      if (phase) {
        perPhase[phase].heldMs = Math.round(loop.max / 1e6);
        loop.disable();
      }
      phase = st.phase;
      perPhase[phase] ??= { steps: 0, ms: 0, longestMs: 0, heldMs: 0 };
      loop.reset();
      loop.enable();
      log(`phase ${phase}`);
    }
    const t = performance.now();
    const r = await pass.step();
    const ms = performance.now() - t;
    perPhase[phase].steps++;
    perPhase[phase].ms += ms;
    if (ms > perPhase[phase].longestMs) perPhase[phase].longestMs = ms;
    if (perPhase[phase].steps % 2000 === 0)
      log(
        `${phase}: ${perPhase[phase].steps} steps, ${JSON.stringify(pass.state().progress.search)}`,
      );
    if (r === 'wait' && phase === 'search') {
      if (answerOpen() === 0) await new Promise((res) => setTimeout(res, 50));
      continue;
    }
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

  // Every proposal: the same identifiers but the bookmeter id, from the saved id to the pick.
  const props = db
    .prepare(
      `SELECT calibre_uuid, old_json, new_json, evidence_json FROM proposed_changes
       WHERE analysis_id = ? AND field = 'identifiers'`,
    )
    .all(listingAnalysisId(p.run)) as {
    calibre_uuid: string;
    old_json: string;
    new_json: string;
    evidence_json: string;
  }[];
  const savedOf = db.prepare(
    'SELECT saved_id, state FROM bookmeter_listing_books WHERE library_id = ? AND calibre_uuid = ?',
  );
  const bad: string[] = [];
  for (const r of props) {
    const o = JSON.parse(r.old_json) as Record<string, string>;
    const n = JSON.parse(r.new_json) as Record<string, string>;
    const keys = new Set([...Object.keys(o), ...Object.keys(n)]);
    const other = [...keys].filter((k) => k !== 'bookmeter' && o[k] !== n[k]);
    const row = savedOf.get(lib, r.calibre_uuid) as { saved_id: string; state: string };
    if (
      other.length ||
      o.bookmeter !== row.saved_id ||
      n.bookmeter === o.bookmeter ||
      row.state !== 'change'
    )
      bad.push(`${r.calibre_uuid}: ${other.join(',')} ${o.bookmeter}->${n.bookmeter} ${row.state}`);
  }
  const aiProposed = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM bookmeter_listing_books b JOIN proposed_changes c
           ON c.library_id = b.library_id AND c.calibre_uuid = b.calibre_uuid AND c.analysis_id = ?
         WHERE b.state IN ('ai', 'yours', 'keep', 'adaptation', 'unseen', 'nofacts')`,
      )
      .get(listingAnalysisId(p.run)) as { n: number }
  ).n;

  // The labeled books: the saved and the new listing judged against the label.
  const { gold } = loadGold(arg('gold')!);
  const byCid = new Map<number, [string, Gold]>();
  for (const [gid, cid] of mapLabeledIds(db, lib, Object.keys(gold ?? {})))
    byCid.set(cid, [gid, gold![gid] as unknown as Gold]);
  const decided = db
    .prepare(
      `SELECT calibre_uuid, calibre_id, state, saved_id, decision_json FROM bookmeter_listing_books
       WHERE library_id = ? AND decision_json IS NOT NULL`,
    )
    .all(lib) as {
    calibre_uuid: string;
    calibre_id: number;
    state: string;
    saved_id: string;
    decision_json: string;
  }[];
  const labeled = {
    withSavedId: 0,
    changes: 0,
    newOk: 0,
    savedOkNewFlagged: [] as unknown[],
    flagged: [] as unknown[],
  };
  for (const r of decided) {
    const g = byCid.get(r.calibre_id);
    if (!g) continue;
    labeled.withSavedId++;
    if (r.state !== 'change') continue;
    labeled.changes++;
    const d = JSON.parse(r.decision_json) as BlDecision;
    const jn = judge({ ...d.pick!, pages: null, edOk: true }, g[1]).why;
    const js = d.saved ? judge({ ...d.saved, pages: null, edOk: true }, g[1]).why : ['unseen'];
    const line = {
      gid: g[0],
      label: g[1].t,
      saved: `${d.saved?.id} (${d.saved?.registrations}) ${d.saved?.title} [${d.saved?.authors}] ${js}`,
      pick: `${d.pick!.id} (${d.pick!.registrations}) ${d.pick!.title} [${d.pick!.authors}] ${jn}`,
    };
    if (!jn.length) labeled.newOk++;
    else {
      labeled.flagged.push(line);
      if (!js.length) labeled.savedOkNewFlagged.push(line);
    }
  }

  // Against step 1: the stored answers' changes, and the blind sample with its live searches.
  type Step1 = {
    uuid: string;
    saved: string;
    facts: boolean;
    searches: { q: string; hits: { id: string; reg: number | null; pass: boolean }[] }[];
  };
  const step1Best = (r: Step1, withLive: boolean) => {
    const all = new Map<string, { id: string; reg: number | null; pass: boolean }>();
    for (const s of r.searches)
      if (withLive || s.q !== 'live') for (const h of s.hits) if (!all.has(h.id)) all.set(h.id, h);
    const sv = all.get(r.saved);
    const best = [...all.values()]
      .filter((h) => h.pass)
      .reduce<{
        id: string;
        reg: number | null;
      } | null>((b, h) => ((h.reg ?? -1) > (b?.reg ?? -2) ? h : b), null);
    return sv && best && best.id !== r.saved && (best.reg ?? -1) > (sv.reg ?? -1) ? best.id : null;
  };
  const now = new Map(decided.map((r) => [r.calibre_uuid, r]));
  const pickOf = (u: string) => {
    const r = now.get(u);
    return r?.state === 'change' ? (JSON.parse(r.decision_json) as BlDecision).pick!.id : null;
  };
  const compareWith = (file: string | undefined, withLive: boolean) => {
    if (!file) return null;
    const rows = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Step1)
      .filter((r) => r.facts);
    let same = 0;
    const onlyStep1: string[] = [];
    const differ: string[] = [];
    const onlyNow: string[] = [];
    for (const r of rows) {
      const want = step1Best(r, withLive);
      const got = pickOf(r.uuid);
      if (want && got === want) same++;
      else if (want && !got)
        onlyStep1.push(`${r.uuid} ${r.saved}->${want} now ${now.get(r.uuid)?.state}`);
      else if (want && got) differ.push(`${r.uuid} ${r.saved}->${want} now ${got}`);
      else if (!want && got) onlyNow.push(`${r.uuid} ${r.saved}->${got}`);
    }
    return {
      books: rows.length,
      same,
      onlyStep1: onlyStep1.length,
      differ: differ.length,
      onlyNow: onlyNow.length,
      examples: {
        onlyStep1: onlyStep1.slice(0, 20),
        differ: differ.slice(0, 20),
        onlyNow: onlyNow.slice(0, 20),
      },
    };
  };

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
  const queries = {
    statusMs: time(() => pass.status(lib)),
    spotListMs: time(() => pass.listSpot(lib, p.run)),
    listPageMs: time(() => pass.listBooks(lib, p.run, 'change', 0, 20)),
    plans: {
      bookCounts: plan(
        `SELECT state, COUNT(*) AS n FROM bookmeter_listing_books INDEXED BY bookmeter_listing_books_state WHERE library_id = ? GROUP BY state`,
        lib,
      ),
      proposalCounts: plan(
        `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 4 AND library_id = ? AND state = ? AND field = 'identifiers' AND analysis_id = ?`,
        lib,
        'proposed',
        listingAnalysisId(p.run),
      ),
      openSearches: plan(`SELECT COUNT(*) AS n FROM bookmeter_listing_waiters WHERE ready = 0`),
      readyWaiters: plan(
        `SELECT w.request_id, w.calibre_uuid, r.state AS rstate FROM bookmeter_listing_waiters w JOIN fetch_requests r ON r.id = w.request_id WHERE w.ready = 1 AND w.library_id = ? LIMIT 100`,
        lib,
      ),
      listPage: plan(
        `SELECT * FROM bookmeter_listing_books INDEXED BY bookmeter_listing_books_state WHERE library_id = ? AND state = ? ORDER BY calibre_uuid LIMIT 20 OFFSET 0`,
        lib,
        'change',
      ),
      aiChose: plan(
        `SELECT source, json_extract(hit_json, '$.id') AS id FROM bookmeter_more_books WHERE library_id = ? AND calibre_uuid = ?`,
        lib,
        'x',
      ),
    },
  };

  const report = {
    copy: { db: arg('db'), main: arg('main') },
    wallSeconds: Math.round(wall / 100) / 10,
    longestStepMs: p.longestStepMs,
    endedIn: p.phase,
    perPhase,
    fetcher: { livePages, notFetched },
    progress: {
      books: p.books,
      search: p.search,
      propose: p.propose,
      spot: p.spot,
      labeledLine: p.labeled,
    },
    books: pass.bookCounts(lib),
    proposals: pass.proposalCounts(lib, p.run),
    proposalChecks: {
      proposals: props.length,
      bad: bad.length,
      examples: bad.slice(0, 10),
      aiProposed,
    },
    labeled,
    step1Stored: compareWith(arg('changes'), false),
    step1Sample: compareWith(arg('sample'), true),
    queries,
  };
  if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  console.log(
    JSON.stringify(
      { ...report, labeled: { ...labeled, flagged: labeled.flagged.length } },
      null,
      1,
    ),
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

void main();
