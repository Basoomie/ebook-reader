/**
 * WP20f stop 1: stage 5 (genres and tags) on a working copy of the live cleanup.db, with the
 * real code: the marks, the evidence of every book, the real models on the labeled books and
 * every volume of their series (labeledOnly), every book decided (the rest by RanobeDB and the
 * store rules alone), the gate, and every Calibre book proposed. Then the checks of lessons
 * 1-4: the Google run's marks keep isProcessed for every book once the tags are gone, the
 * EXPLAIN plans and times of the polled and hot queries at the run's end size (stand-in
 * questions for every book), the event-loop holds per phase. Reads the API keys from the copy
 * (their encryption key from a copy of ttsu.db; never printed). Writes only the working copy.
 *
 *   npx ts-node --transpile-only scripts/wp20f-live.ts --db <copy/cleanup.db> --work <work.db>
 *     [--reuse] --main <copy/ttsu.db> --metadata <copy/metadata.db> --labels <genre-labels.json>
 *     [--limit 5] [--no-models] [--out report.json]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { AiRunner } from '../src/ai/runner';
import { runSpend } from '../src/ai/spend';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { attachMarks } from '../src/cleanup/marks';
import { SecretStore } from '../src/cleanup/secrets';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { isProcessed } from '../src/cleanup/stage2-rules';
import { readStage2Snapshot } from '../src/cleanup/stage2-snapshot';
import { setStageMode } from '../src/cleanup/stages';
import { Stage4Ai } from '../src/cleanup/stage4/ai-step';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { getStage } from '../src/cleanup/stages';
import { applyTagChange } from '../src/cleanup/stage5/decide';
import { Stage5 } from '../src/cleanup/stage5/step';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const t = () => new Date().toLocaleTimeString();
const log = (m: string) => console.log(`${t()} ${m}`);

async function main() {
  const out = arg('work')!;
  if (!has('reuse')) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    for (const x of [out, out + '-wal', out + '-shm']) fs.rmSync(x, { force: true });
    fs.copyFileSync(arg('db')!, out);
  }
  const db = new Database(out);
  db.pragma('journal_mode = WAL');
  const t0m = Date.now();
  migrateCleanup(db);
  log(
    `working copy v${db.pragma('user_version', { simple: true })} (migration ${Date.now() - t0m} ms)`,
  );
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const secrets = new SecretStore(db, main);
  const p4 = getStage(db, 4).progress as unknown as Stage4Progress;
  const cacheDir = path.join(path.dirname(out), 'cache');
  const snap = path.join(cacheDir, SNAPSHOT_DIRNAME, `${p4.libraryId}.db`);
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
    calibreDir: path.dirname(out),
    cacheDir,
    dbDir: null,
    queue,
    log,
  });
  const runner = new AiRunner({ db, secrets, log });
  const real4 = new Stage4Ai({ db, runner, analysis, log });
  // labeledOnly is part of stage 4's key: as it was on the server (a rerun of this script set it).
  updateSettings(db, { ai: { ...getSettings(db).ai, labeledOnly: false } });
  // Stage 4's state before any setting changes here (labeledOnly is shared and part of its key).
  const done4 = real4.isDone();
  const undone4 = real4.undoneBooks();
  log(`stage 4 done: ${done4}; books with every change undone: ${undone4.length}`);
  const stage4Ai = { isDone: () => done4, progress: () => real4.progress() } as unknown as Stage4Ai;

  const s = getSettings(db);
  updateSettings(db, {
    ai: {
      ...s.ai,
      spendLimitUsd: Number(arg('limit') ?? 5),
      labeledOnly: true,
      modes: { 'claude-haiku-5-5': 'direct', 'gpt-6-luna': 'direct' },
      directWorkers: 8,
    },
    gate: { ...s.gate, genreLabelsFile: arg('labels')! },
  });
  if (has('no-models')) {
    updateSettings(db, { ai: { ...getSettings(db).ai, spendLimitUsd: null } });
  }
  setStageMode(db, 5, 'analyse');
  if (has('fresh')) {
    // A clean stage 5 on the copy: its progress, proposals and decisions go; the evidence and
    // the answers stay (nothing is asked again where the evidence is the same).
    db.prepare(
      `UPDATE stages SET progress_json = '{}', pause_reason = NULL, pause_detail = NULL WHERE stage = 5`,
    ).run();
    db.prepare(`DELETE FROM proposed_changes WHERE stage = 5`).run();
    db.prepare(`DELETE FROM ai_values WHERE stage = 'calibre5'`).run();
    db.prepare(`DELETE FROM stage_field_pauses WHERE stage = 5`).run();
    log('stage 5 cleared on the copy (answers kept)');
  }
  const s5 = new Stage5({ db, runner, analysis, stage4Ai, log });

  let longest = 0;
  let last = Date.now();
  const lag = setInterval(() => {
    const now = Date.now();
    longest = Math.max(longest, now - last - 10);
    last = now;
  }, 10);
  const times: Record<string, number> = {};
  const holds: Record<string, number> = {};
  const spentBefore = runSpend(db, 'calibre5', 'x');
  void spentBefore;
  let phase = '';
  for (let i = 0; i < 1_000_000; i++) {
    const p = s5.progress();
    if (p && p.phase === 'done' && !s5.needsWork(p4.libraryId)) break;
    const ph = p?.phase ?? 'start';
    if (ph !== phase) {
      log(`phase ${ph}`);
      phase = ph;
    }
    const a = Date.now();
    longest = 0;
    const r = await s5.step(p4.libraryId, () => false);
    // Let the lag timer run first: a synchronous stretch shows only at its next tick.
    await new Promise((res) => setTimeout(res, 25));
    holds[ph] = Math.max(holds[ph] ?? 0, longest);
    times[ph] = (times[ph] ?? 0) + (Date.now() - a);
    if (r === 'wait') {
      const w = s5.progress()?.wait;
      if (w && has('no-models') && ph === 'models') {
        // Nothing is asked: the models phase ends with no answers (rules only).
        log(`models: ${w}; going on without answers`);
        db.prepare(
          `UPDATE ai_requests SET state = 'failed' WHERE stage = 'calibre5' AND state = 'queued'`,
        ).run();
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    if (i % 200 === 0 && ph === 'models') {
      const b = s5.bar();
      if (b) log(`models: ${b.done} of ${b.total} answers`);
    }
  }
  clearInterval(lag);
  const p = s5.progress()!;
  const cost = runSpend(db, 'calibre5', p.analysisId);
  log(
    `done: ${JSON.stringify({ items: p.items, labeledItems: p.labeledItems, asked: p.asked, oneModel: p.oneModel, droppedTerms: p.droppedTerms, marks: p.marks, cost })}`,
  );

  // ---------------------------------------------------------------- the marks keep isProcessed
  const snapshot = readStage2Snapshot(snap);
  attachMarks(db, p4.libraryId, snapshot.books.values());
  const custom = getSettings(db).customTags;
  const changes = new Map(
    (
      db
        .prepare(
          `SELECT calibre_uuid, new_json FROM proposed_changes WHERE stage = 5 AND state = 'proposed'`,
        )
        .all() as { calibre_uuid: string; new_json: string }[]
    ).map((r) => [r.calibre_uuid, JSON.parse(r.new_json) as { add: string[]; remove: string[] }]),
  );
  let processedBefore = 0;
  let processedAfter = 0;
  let differ = 0;
  for (const b of snapshot.books.values()) {
    const before = isProcessed(b.tags);
    const ch = changes.get(b.uuid);
    const after = ch ? applyTagChange(b.tags, ch, custom) : b.tags;
    const now = isProcessed(after, b.marks ?? []);
    if (before) processedBefore++;
    if (now) processedAfter++;
    if (before !== now) differ++;
  }
  log(
    `marks: metadata-processed before ${processedBefore}, after removal with the record ${processedAfter}, books that differ ${differ}`,
  );

  // ---------------------------------------------------------------- forms of the series union
  // On the same stored decisions: which terms a labeled book would get under narrower unions.
  const own = new Map(
    (
      db
        .prepare(
          `SELECT item_key, value_json FROM ai_values WHERE stage = 'calibre5' AND field = 'own'`,
        )
        .all() as { item_key: string; value_json: string }[]
    ).map((r) => [
      r.item_key.slice(r.item_key.indexOf(':') + 1),
      JSON.parse(r.value_json) as { terms: Record<string, string[]> },
    ]),
  );
  const extras = analysis.extrasAll(p4);
  const bySeries = new Map<string, { uuid: string; id: number }[]>();
  for (const b of snapshot.books.values()) {
    const se = extras.get(b.calibreId)?.series;
    if (!se || !own.has(b.uuid)) continue;
    const l = bySeries.get(se) ?? [];
    l.push({ uuid: b.uuid, id: b.calibreId });
    bySeries.set(se, l);
  }
  const labelsFile = JSON.parse(fs.readFileSync(arg('labels')!, 'utf8')) as {
    genres: Record<string, [string[], string[]]>;
    tags: Record<string, [string[], string[]]>;
  };
  const { scoreSet } = await import('../src/cleanup/stage5/gate');
  const { GENRE_IDS, SUBJECT_IDS, TAG_IDS } = await import('../src/cleanup/stage5/vocab');
  const { mapLabeledIds } = await import('../src/cleanup/stage2-gate');
  const gids = mapLabeledIds(db, p4.libraryId, [
    ...new Set([...Object.keys(labelsFile.genres), ...Object.keys(labelsFile.tags)]),
  ]);
  const termsOf = (
    uuid: string,
    form: (id: string, srcs: string[], share: number, n: number) => boolean,
  ) => {
    const b = [...snapshot.books.values()].find((x) => x.uuid === uuid)!;
    const se = extras.get(b.calibreId)?.series;
    const vols = se ? (bySeries.get(se) ?? []) : [{ uuid, id: b.calibreId }];
    const count = new Map<string, { n: number; srcs: Set<string> }>();
    for (const v of vols)
      for (const [id, srcs] of Object.entries(own.get(v.uuid)?.terms ?? {})) {
        const c = count.get(id) ?? { n: 0, srcs: new Set<string>() };
        c.n++;
        for (const x of srcs) c.srcs.add(x);
        count.set(id, c);
      }
    const mine = own.get(uuid)?.terms ?? {};
    return new Set(
      [...count]
        .filter(([id, c]) => id in mine || form(id, [...c.srcs], c.n / vols.length, c.n))
        .map(([id]) => id),
    );
  };
  const forms: Record<string, (id: string, srcs: string[], share: number, n: number) => boolean> = {
    'own book only (no union)': () => false,
    'union: RanobeDB only (series-level source)': (_i, srcs) => srcs.includes('ranobedb'),
    'union: in a quarter of the volumes or more': (_i, _s, share) => share >= 0.25,
    'union: in half of the volumes or more': (_i, _s, share) => share >= 0.5,
    'union: in 2 volumes or more': (_i, _s, _sh, n) => n >= 2,
    'union: everything (as decided)': () => true,
  };
  const formScores: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(forms)) {
    const pick = (gid: string) => {
      const id = gids.get(gid);
      const b = id === undefined ? undefined : snapshot.books.get(id);
      return b && own.has(b.uuid) ? termsOf(b.uuid, f) : null;
    };
    const g = scoreSet(labelsFile.genres, pick, (x) => GENRE_IDS.has(x) || SUBJECT_IDS.has(x));
    const tg = scoreSet(labelsFile.tags, pick, (x) => TAG_IDS.has(x));
    formScores[name] = {
      genres: { found: g.foundPercent, right: g.rightPercent, full: g.full, books: g.books },
      tags: { found: tg.foundPercent, right: tg.rightPercent, full: tg.full, books: tg.books },
    };
    log(
      `form "${name}": genres ${g.foundPercent} found / ${g.rightPercent} right / ${g.full} of ${g.books}; tags ${tg.foundPercent} / ${tg.rightPercent} / ${tg.full} of ${tg.books}`,
    );
  }

  // ---------------------------------------------------------------- the 10 books stage 4 left out
  const undone = undone4.map((u) => {
    const b = [...snapshot.books.values()].find((x) => x.uuid === u);
    return { calibreId: b?.calibreId, title: b?.title };
  });

  // ---------------------------------------------------------------- EXPLAIN at the end size
  // Stand-in questions for every book (both models), as the run will end with.
  const have = (
    db.prepare(`SELECT COUNT(*) AS n FROM ai_requests WHERE stage = 'calibre5'`).get() as {
      n: number;
    }
  ).n;
  const items = db
    .prepare(`SELECT item_key, evidence_hash FROM ai_items WHERE stage = 'calibre5'`)
    .all() as { item_key: string; evidence_hash: string }[];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO ai_requests (stage, item_key, role, provider, model, prompt_version, evidence_hash, state, run_id, labeled, created_at, cost_usd, answered_at)
     VALUES ('calibre5', ?, ?, ?, ?, 'calibre5-v1', ?, 'answered', ?, 0, 1, 0.0002, 2)`,
  );
  db.transaction(() => {
    for (const it of items) {
      ins.run(
        it.item_key,
        'primary',
        'anthropic',
        'claude-haiku-5-5',
        it.evidence_hash,
        p.analysisId,
      );
      ins.run(it.item_key, 'secondary', 'openai', 'gpt-6-luna', it.evidence_hash, p.analysisId);
    }
  })();
  const now = (
    db.prepare(`SELECT COUNT(*) AS n FROM ai_requests WHERE stage = 'calibre5'`).get() as {
      n: number;
    }
  ).n;
  log(`ai_requests calibre5: ${have} real, ${now} with the stand-ins (end size)`);
  const lib = p4.libraryId;
  const queries: [string, string, unknown[]][] = [
    [
      'byModel (bar)',
      `SELECT model, state, COUNT(*) AS n FROM ai_requests WHERE run_id = ? AND stage = 'calibre5' GROUP BY model, state`,
      [p.analysisId],
    ],
    [
      'remaining5',
      `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 5 AND library_id = ? AND state = 'proposed' AND field = 'tags' AND class = 'auto' AND analysis_id = ?`,
      [lib, p.analysisId],
    ],
    [
      'write5 count',
      `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 5 AND library_id = ? AND state = ? AND field = 'tags' AND analysis_id = ?`,
      [lib, 'applied', p.analysisId],
    ],
    [
      'list total',
      `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 5 AND library_id = ? AND state = ? AND field = 'tags' AND analysis_id = ?`,
      [lib, 'proposed', p.analysisId],
    ],
    [
      'list page',
      `SELECT id FROM proposed_changes INDEXED BY proposed_changes_stage WHERE stage = 5 AND library_id = ? AND state = ? AND field = 'tags' AND analysis_id = ? ORDER BY id LIMIT 50 OFFSET 25000`,
      [lib, 'proposed', p.analysisId],
    ],
    [
      'plan',
      `SELECT id, calibre_id, calibre_uuid, field, old_json, new_json, evidence_json FROM proposed_changes WHERE stage = 5 AND library_id = ? AND state = 'proposed' AND class = 'auto' AND (analysis_id = ? OR decided_by IS NOT NULL) AND field = 'tags' ORDER BY calibre_id, id`,
      [lib, p.analysisId],
    ],
    [
      'formats',
      `SELECT calibre_uuid, new_json FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 4 AND library_id = ? AND state = 'proposed' AND field = 'format' AND analysis_id = ?`,
      [lib, p4.analysisId],
    ],
    [
      'undone4',
      `SELECT DISTINCT calibre_uuid FROM proposed_changes INDEXED BY proposed_changes_counts WHERE stage = 4 AND library_id = ? AND state = 'undone' AND analysis_id = ?`,
      [lib, p4.analysisId],
    ],
    [
      'own terms',
      `SELECT item_key, value_json FROM ai_values WHERE stage = 'calibre5' AND field = ?`,
      ['own'],
    ],
    [
      'propose: delete per book',
      `SELECT id FROM proposed_changes INDEXED BY proposed_changes_book WHERE library_id = ? AND calibre_uuid = ? AND field = 'tags' AND stage = 5 AND state IN ('proposed', 'skipped')`,
      [lib, 'x'],
    ],
  ];
  const explain: Record<string, { plan: string[]; ms: number }> = {};
  for (const [name, sql, params] of queries) {
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
    ).map((r) => r.detail);
    const a = performance.now();
    db.prepare(sql).all(...params);
    explain[name] = { plan, ms: Math.round((performance.now() - a) * 10) / 10 };
    log(`EXPLAIN ${name}: ${plan.join(' | ')} (${explain[name].ms} ms)`);
  }
  // The stand-ins go again (the report counts the real ones).
  db.prepare(
    `DELETE FROM ai_requests WHERE stage = 'calibre5' AND cost_usd = 0.0002 AND answered_at = 2`,
  ).run();

  const report = {
    at: new Date().toISOString(),
    progress: { ...p, times: p.times },
    cost,
    times,
    holds,
    marks: { processedBefore, processedAfter, differ },
    forms: formScores,
    undone4: undone,
    explain,
  };
  if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  log(`times ${JSON.stringify(times)}; longest event-loop hold per phase ${JSON.stringify(holds)}`);
  db.close();
  main.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
