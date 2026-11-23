/**
 * WP20g stop 1: the AI measurements on a working copy of the live cleanup.db, with the real code
 * and the real models (direct calls, list price).
 *
 *   J   the new arrivals' stage-4 J gate (ArrivalStage4Ai.jGate, the code the run uses): Sonnet
 *       5.5 + Sol answer the labeled books where E left a field open or flagged, every labeled
 *       book is decided with J in memory and scored against the bars, beside E's own score of
 *       the same books from the stored answers.
 *   S5  stage 5 (genres and tags) with the stronger pair: Sonnet 5.5 + Sol answer the genre
 *       test's blind-labeled books (the evidence stored for stage 5, the stage-5 prompt
 *       unchanged, under a stage key of their own so Haiku's and Luna's answers stay), scored as
 *       the gate scores (gate.ts): Haiku AND Luna (today), Sonnet AND Sol, either pair, and three
 *       of the four models, each with RanobeDB's and the store's terms as stage 5 adds them.
 *
 * Reads the API keys from the copies (never printed). Writes only the working copy.
 *
 *   npx ts-node --transpile-only scripts/wp20g-measure.ts --db <copy/cleanup.db> --work <work.db>
 *     [--reuse] --main <copy/ttsu.db> --ai-key-dir <dir> --metadata <copy/metadata.db>
 *     --gold <gold800.json> --genre-labels <genre-labels.json> [--limit 10] [--only j|s5]
 *     [--out report.json]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { AiRunner } from '../src/ai/runner';
import { runSpend } from '../src/ai/spend';
import { waitText } from '../src/ai/waits';
import { SNAPSHOT_DIRNAME } from '../src/calibre/indexer';
import { CLEANUP_AI_SOURCE, cleanupFeatureOf } from '../src/cleanup/ai-features';
import { ArrivalStage4Ai } from '../src/cleanup/arrivals/stage4-ai';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { mapLabeledIds } from '../src/cleanup/stage2-gate';
import { getStage } from '../src/cleanup/stages';
import { outcomeValues, stage4NeedsUpgrade } from '../src/cleanup/stage4/ai-decide';
import { scoreAiGate, type AiGate } from '../src/cleanup/stage4/ai-gate';
import { Stage4Analysis, type Stage4Progress } from '../src/cleanup/stage4/analysis';
import { FetchQueue } from '../src/cleanup/stage4/queue';
import { FIELD_NAMES, SCORED_FIELDS } from '../src/cleanup/stage4/score';
import { adaptationText, type Stage5Item } from '../src/cleanup/stage5/evidence';
import { ownTerms, seriesUnion, type OwnTerms } from '../src/cleanup/stage5/decide';
import { belowBars, loadGenreLabels, scoreSet, type SetScore } from '../src/cleanup/stage5/gate';
import { STAGE5_SPEC, type Stage5Answer } from '../src/cleanup/stage5/prompt';
import { GENRE_IDS, SUBJECT_IDS, TAG_IDS } from '../src/cleanup/stage5/vocab';
import { cleanupAi, migrateWorkingCopy, readAiSeed } from './lib/cleanup-ai';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SONNET = 'claude-sonnet-5-5';
const SOL = 'gpt-6.1-sol';

async function copyIn(src: string, out: string): Promise<void> {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  for (const x of [out, out + '-wal', out + '-shm']) fs.rmSync(x, { force: true });
  // A consistent copy with its WAL (the source may hold one): SQLite's own backup, read-only.
  const s = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await s.backup(out);
  } finally {
    s.close();
  }
}

function fieldTable(g: AiGate): Record<string, { autoPercent: number | null; auto: number }> {
  const out: Record<string, { autoPercent: number | null; auto: number }> = {};
  for (const f of SCORED_FIELDS)
    out[FIELD_NAMES[f]] = { autoPercent: g.all.fields[f].autoPercent, auto: g.all.fields[f].auto };
  return out;
}

async function measureJ(
  db: Database.Database,
  ai: ArrivalStage4Ai,
  analysis: Stage4Analysis,
  p4: Stage4Progress,
  limit: number,
) {
  const labeled = analysis.labeledBooks(p4);
  // E from the stored answers (the library's own decision, what an E arrival gets).
  const cheapOf = (uuid: string) =>
    (
      ai as unknown as {
        cheapOutcome(p: Stage4Progress, u: string): { out: never; asked: boolean } | null;
      }
    ).cheapOutcome(p4, uuid);
  let need = 0;
  const eBooks = labeled.map((b) => {
    const c = cheapOf(b.uuid);
    if (c && stage4NeedsUpgrade(c.out, 'J')) need++;
    return { gid: b.gid, gold: b.gold, ai: c ? outcomeValues(c.out, c.asked) : null };
  });
  const gE = scoreAiGate(eBooks);
  log(`J: ${labeled.length} labeled books, ${need} need the stronger pair`);
  const t0 = Date.now();
  let lastWait = '';
  for (;;) {
    const r = await ai.jGate(p4, 'J', () => false);
    if (r.gate) {
      const cost = runSpend(db, 'calibre4', 'arrivals-gate-J');
      return {
        labeled: labeled.length,
        needUpgrade: need,
        seconds: Math.round((Date.now() - t0) / 1000),
        costUsd: cost.costUsd,
        costPerUpgradedBook: need ? cost.costUsd / need : 0,
        E: { books: gE.books, allRight: gE.all.everyFieldPercent, fields: fieldTable(gE) },
        J: r.gate,
      };
    }
    if (r.wait && r.wait !== lastWait) log(`J: ${r.wait}`);
    lastWait = r.wait ?? '';
    if (runSpend(db, 'calibre4', 'arrivals-gate-J').costUsd >= limit) {
      log('J: the spending cap reached; stopped');
      return { stopped: 'cap', needUpgrade: need };
    }
    await sleep(3000);
  }
}

/** The ids two answers agree on (stage 5's models rule, ownTerms' first part). */
function agreed(
  answers: (Stage5Answer | null)[],
  min: number,
  text: string,
): { ids: Set<string>; asked: boolean } {
  const got = answers.filter((a): a is Stage5Answer => !!a);
  if (got.length < Math.min(min, answers.length) || got.length < 2)
    return { ids: new Set(), asked: false };
  const count = new Map<string, number>();
  for (const a of got)
    for (const id of new Set([...a.genres, ...a.subjects, ...a.tags]))
      count.set(id, (count.get(id) ?? 0) + 1);
  const ids = new Set([...count].filter(([, n]) => n >= min).map(([id]) => id));
  const anime = got.filter((a) => a.anime).length >= min && /アニメ/.test(text);
  const manga =
    got.filter((a) => a.manga).length >= min && /コミカライズ|漫画化|マンガ化/.test(text);
  if (anime) ids.add('anime');
  if (manga) ids.add('manga');
  return { ids, asked: true };
}

async function measureS5(
  db: Database.Database,
  runner: AiRunner,
  core: ReturnType<typeof cleanupAi>['core'],
  analysis: Stage4Analysis,
  p4: Stage4Progress,
  labelsFile: string,
  limit: number,
) {
  const L = loadGenreLabels(labelsFile);
  if (!L) throw new Error(`no genre labels in ${labelsFile}`);
  const gidList = [...new Set([...Object.keys(L.genres), ...Object.keys(L.tags)])];
  const gids = mapLabeledIds(db, p4.libraryId, gidList);
  const snap = analysis.loadSnapshot(p4.libraryId);
  const keyOf = new Map<string, string>();
  for (const [gid, id] of gids) {
    const u = snap.books.get(id)?.uuid;
    if (u) keyOf.set(gid, `${p4.libraryId}:${u}`);
  }
  const keys = [...new Set(keyOf.values())];
  log(`S5: ${gidList.length} labeled books, ${keys.length} in the library`);
  // The stronger pair under a stage key of its own: stage 5's stored evidence, its prompt.
  const SPEC = {
    ...STAGE5_SPEC,
    stage: 'calibre5-j',
    tasks: {
      primary: 'measure.sonnet',
      secondary: 'measure.sol',
      upgradePrimary: 'measure.sonnet',
      upgradeSecondary: 'measure.sol',
    },
  } as typeof STAGE5_SPEC;
  const copy = db.prepare(
    `INSERT OR REPLACE INTO ai_items (stage, item_key, evidence, evidence_version, evidence_hash, labeled, updated_at)
     SELECT ?, item_key, evidence, evidence_version, evidence_hash, labeled, updated_at
     FROM ai_items WHERE stage = 'calibre5' AND item_key = ?`,
  );
  db.transaction(() => {
    for (const k of keys) copy.run(SPEC.stage, k);
  })();
  const strong = new AiRunner({
    db,
    core,
    source: CLEANUP_AI_SOURCE,
    featureOf: cleanupFeatureOf,
    modelFor: (t) =>
      t === 'measure.sonnet'
        ? SONNET
        : t === 'measure.sol'
          ? SOL
          : (getSettings(db).models[t as never] ?? ''),
    onlyLabeled: () => false,
    log,
  });
  const RUN = 'wp20g-measure';
  strong.enqueue(SPEC, 'primary', keys, RUN);
  strong.enqueue(SPEC, 'secondary', keys, RUN);
  const t0 = Date.now();
  let lastWait = '';
  for (;;) {
    const r = await strong.step(SPEC, RUN, () => false);
    if (r.pending === 0) break;
    const w = r.wait ? waitText(r.wait) : '';
    if (w && w !== lastWait) log(`S5: ${w}`);
    lastWait = w;
    if (runSpend(db, SPEC.stage, RUN).costUsd >= limit) {
      log('S5: the spending cap reached; stopped');
      break;
    }
    await sleep(2000);
  }
  const cost = runSpend(db, SPEC.stage, RUN);
  const ans = (r: AiRunner, spec: typeof STAGE5_SPEC, role: 'primary' | 'secondary', k: string) => {
    const x = r.answerOf(spec, role, k);
    return x?.state === 'answered' ? (x.answer as Stage5Answer) : null;
  };
  const combos = {
    'Haiku AND Luna (today)': (h: Ans) => agreed([h.H, h.L], 2, h.text),
    'Sonnet AND Sol': (h: Ans) => agreed([h.S, h.O], 2, h.text),
    'either pair': (h: Ans) => {
      const a = agreed([h.H, h.L], 2, h.text);
      const b = agreed([h.S, h.O], 2, h.text);
      return { ids: new Set([...a.ids, ...b.ids]), asked: a.asked || b.asked };
    },
    'both pairs': (h: Ans) => {
      const a = agreed([h.H, h.L], 2, h.text);
      const b = agreed([h.S, h.O], 2, h.text);
      return { ids: new Set([...a.ids].filter((x) => b.ids.has(x))), asked: a.asked && b.asked };
    },
    '3 of the 4': (h: Ans) => agreed([h.H, h.L, h.S, h.O], 3, h.text),
  };
  type Ans = {
    H: Stage5Answer | null;
    L: Stage5Answer | null;
    S: Stage5Answer | null;
    O: Stage5Answer | null;
    text: string;
    rules: OwnTerms;
  };
  const per = new Map<string, Ans>();
  for (const [gid, k] of keyOf) {
    const ev = runner.evidenceOf<Stage5Item>(STAGE5_SPEC, k);
    if (!ev) continue;
    const text = adaptationText(ev.evidence);
    per.set(gid, {
      H: ans(runner, STAGE5_SPEC, 'primary', k),
      L: ans(runner, STAGE5_SPEC, 'secondary', k),
      S: ans(strong, SPEC, 'primary', k),
      O: ans(strong, SPEC, 'secondary', k),
      text,
      // RanobeDB's and the store's terms, as stage 5 adds them to the models' (no answers).
      rules: ownTerms({
        primary: null,
        secondary: null,
        ranobedbTags: ev.evidence.ranobedb_tags,
        storeCategories: ev.evidence.amazon_categories,
        adaptationText: text,
      }),
    });
  }
  const settings = getSettings(db);
  const result: Record<
    string,
    { genres: SetScore; tags: SetScore; below: string[]; notAsked: number }
  > = {};
  for (const [name, f] of Object.entries(combos)) {
    let notAsked = 0;
    const terms = new Map<string, Set<string>>();
    for (const [gid, a] of per) {
      const m = f(a);
      if (!m.asked) notAsked++;
      const own: OwnTerms = {
        terms: { ...a.rules.terms },
        asked: m.asked,
        oneModel: 0,
      };
      for (const id of m.ids) own.terms[id] = [...(own.terms[id] ?? []), 'models'];
      // Per book (stage 5's rule since 2026-11-21): the union with series null.
      const u = seriesUnion([{ calibreId: 1, series: null, own }]).get(1) ?? {};
      terms.set(gid, new Set(Object.keys(u)));
    }
    const pick = (gid: string) => terms.get(gid) ?? null;
    const g = {
      genres: scoreSet(L.genres, pick, (x) => GENRE_IDS.has(x) || SUBJECT_IDS.has(x)),
      tags: scoreSet(L.tags, pick, (x) => TAG_IDS.has(x)),
    };
    result[name] = { ...g, below: belowBars(g, settings.gate.stage5), notAsked };
  }
  return {
    books: per.size,
    answered: {
      sonnet: [...per.values()].filter((a) => a.S).length,
      sol: [...per.values()].filter((a) => a.O).length,
    },
    seconds: Math.round((Date.now() - t0) / 1000),
    costUsd: cost.costUsd,
    costPerBook: per.size ? cost.costUsd / per.size : 0,
    combos: result,
  };
}

async function main() {
  const out = arg('work')!;
  if (!has('reuse')) {
    log('copying the working copy');
    await copyIn(arg('db')!, out);
  }
  const db = new Database(out);
  db.pragma('journal_mode = WAL');
  const main = new Database(arg('main')!, { readonly: true, fileMustExist: true });
  const seed = readAiSeed(db, main, arg('ai-key-dir') ?? null);
  migrateWorkingCopy(db);
  log(`working copy v${db.pragma('user_version', { simple: true })}`);
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
  const s = getSettings(db);
  updateSettings(db, { gate: { ...s.gate, labeledBooksFile: arg('gold')! } });
  const { core, runner } = cleanupAi(db, { seed, log });
  const limit = Number(arg('limit') ?? 10);
  // The shared monthly limit counts this month's real spend (copied in): the cap is on top of it.
  // Sonnet through the Batch API (half price); Sol one call each.
  core.updateSettings({
    spendLimitUsd: Math.round((core.room().spentUsd + limit) * 100) / 100,
    modes: { [SONNET]: 'batch', [SOL]: 'direct' },
    directWorkers: 8,
  });
  const report: Record<string, unknown> = { at: new Date().toISOString(), limitUsd: limit };
  const only = arg('only');
  if (!only || only === 'j') {
    const ai = new ArrivalStage4Ai({ db, runner, analysis, log });
    report.j = await measureJ(db, ai, analysis, p4, limit);
    log(`J done: ${JSON.stringify(report.j).slice(0, 400)}`);
  }
  if (!only || only === 's5') {
    report.s5 = await measureS5(db, runner, core, analysis, p4, arg('genre-labels')!, limit);
    log(`S5 done: $${(report.s5 as { costUsd: number }).costUsd.toFixed(4)}`);
  }
  if (arg('out')) fs.writeFileSync(arg('out')!, JSON.stringify(report, null, 1));
  db.close();
  main.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
