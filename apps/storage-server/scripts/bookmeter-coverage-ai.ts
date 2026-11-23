/**
 * More Bookmeter coverage, step 1 (measuring only): the AI check for near misses on the labeled
 * books. A near miss is a book whose search had results but no accepted match, where the closest
 * result fails exactly one of the four checks (under today's rule, or under a candidate rule
 * set given with --rules). Haiku and Luna (stage 4's two models) are asked whether that result
 * is the same book; it counts as accepted only when both say yes.
 *
 * Runs through the shared AI layer (src/ai: AiCore + AiRunner), so every paid request is
 * recorded in the ledger and the monthly limit applies. The ledger is a WORKING COPY of ttsu.db
 * (--main, migrated in place; never the live file), the question queue a new small cleanup.db
 * in --work. Keys are read from the copy with the key file in --ai-key-dir and never printed.
 *
 *   npx ts-node --transpile-only scripts/bookmeter-coverage-ai.ts --in books-full.jsonl
 *     --gold gold800.json --main <working copy of ttsu.db> --ai-key-dir <dir with ai-secrets.key>
 *     --work <dir> [--rules '{"full":true,...}'] [--direct] [--dry]
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { AiCore } from '../src/ai/core';
import { AiRunner } from '../src/ai/runner';
import { AiSecretStore } from '../src/ai/secrets';
import type { AiStageSpec } from '../src/ai/types';
import { CLEANUP_AI_SOURCE, cleanupFeatureOf } from '../src/cleanup/ai-features';
import { migrateCleanup } from '../src/cleanup/cleanup-db';
import { getSettings } from '../src/cleanup/settings';
import { migrate } from '../src/db/migrations';
import {
  closestWith,
  judge,
  makeRules,
  acceptWith,
  type BookRow,
  type Check,
  type Gold,
  type Hit,
  type Options,
} from './lib/bookmeter-rules';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Evidence {
  book: {
    title: string;
    fileTitle: string | null;
    calibreTitle: string;
    authors: string[];
    series: string | null;
    number: number | null;
  };
  result: { title: string; authors: string[]; pages: number | null };
  failedCheck: Check;
}

const SYSTEM = `You compare a Japanese e-book in a personal library with one search result from Bookmeter (読書メーター), a Japanese book-cataloguing site, and decide whether the result is the same book: the same work AND the same volume AND the same edition (a different volume, a different book in the same series, a collection or omnibus, a different translation, a manga adaptation of a novel, or a special edition such as 大活字/新装版 that the library book is not, are all "no").
Bookmeter's titles usually end with the publisher's label in brackets, e.g. "(電撃文庫 す 9-5)" or "(GAノベル)"; the letters and numbers inside a label are a catalogue code, not a volume number. Bookmeter may list the illustrator or translator as authors, write a name with a space where the book has ・, or use an older kanji form of a name (國/国).
"failedCheck" says which of the automatic checks the result failed: title (the titles differ after cleaning), author (no author name in common), volume (the numbers in the titles differ) or edition (the result names an edition the book does not).
Answer "yes" only when you are confident it is the same book, "no" when it is not, and "unsure" otherwise. Give a short reason.`;

const spec: AiStageSpec<Evidence, 'primary' | 'secondary'> = {
  stage: 'bookmeter-near',
  promptVersion: 'bm-near-1',
  tasks: { primary: 'stage4.primary', secondary: 'stage4.secondary' },
  system: SYSTEM,
  userText: (e) => JSON.stringify(e),
  schema: {
    type: 'object',
    properties: {
      same_book: { type: 'string', enum: ['yes', 'no', 'unsure'] },
      reason: { type: 'string' },
    },
    required: ['same_book', 'reason'],
    additionalProperties: false,
  },
  schemaName: 'same_book',
  parseAnswer: (raw) => {
    const r = raw as { same_book?: unknown; reason?: unknown } | null;
    if (!r || !['yes', 'no', 'unsure'].includes(String(r.same_book))) return null;
    return { same_book: r.same_book, reason: typeof r.reason === 'string' ? r.reason : '' };
  },
  evidenceText: (e) => JSON.stringify(e),
};

async function main() {
  const books = fs
    .readFileSync(arg('in')!, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as BookRow);
  const gold = JSON.parse(fs.readFileSync(arg('gold')!, 'utf8')) as Record<string, Gold>;
  const o = JSON.parse(arg('rules') ?? '{}') as Options;
  const rules = makeRules(o);
  const truth = arg('truth')
    ? (JSON.parse(fs.readFileSync(arg('truth')!, 'utf8')) as Record<string, 'right' | 'wrong'>)
    : {};

  // The labeled near misses.
  const items: { key: string; b: BookRow; hit: Hit; failed: Check; evidence: Evidence }[] = [];
  let nearAll = 0;
  for (const b of books) {
    if (!b.hits.length || acceptWith(rules, b)) continue;
    const c = closestWith(rules, b, o);
    if (!c || c.failed.length !== 1) continue;
    nearAll++;
    if (!b.gid) continue;
    const hit = c.hit;
    items.push({
      key: String(b.cid),
      b,
      hit,
      failed: c.failed[0],
      evidence: {
        book: {
          title: b.t,
          fileTitle: b.opfTitle,
          calibreTitle: b.calTitle,
          authors: b.au,
          series: b.se,
          number: b.ix,
        },
        result: { title: hit.full ?? hit.title, authors: hit.authors, pages: hit.pages },
        failedCheck: c.failed[0],
      },
    });
  }
  log(`near misses: ${nearAll} library-wide, ${items.length} labeled (asked)`);
  if (process.argv.includes('--dry')) return;

  const work = arg('work')!;
  fs.mkdirSync(work, { recursive: true });
  const db = new Database(path.join(work, 'queue-cleanup.db'));
  db.pragma('journal_mode = WAL');
  migrateCleanup(db, { beforeAiMove: () => undefined });
  const main = new Database(arg('main')!);
  if (path.resolve(arg('main')!).toLowerCase().includes(`${path.sep}ttsu${path.sep}db${path.sep}`))
    throw new Error('--main must be a working copy, not the live ttsu.db');
  const quiet = console.log;
  console.log = () => undefined;
  try {
    migrate(main);
  } finally {
    console.log = quiet;
  }
  const keyDir = arg('ai-key-dir')!;
  const store = new AiSecretStore(main, keyDir);
  const core = new AiCore({ db: main, dbDir: keyDir, keys: store, log });
  log(
    `keys: anthropic ${store.read('anthropicApiKey') ? 'set' : 'MISSING'}, openai ${store.read('openaiApiKey') ? 'set' : 'MISSING'}; limit ${core.settings().spendLimitUsd ?? 'none'}`,
  );
  if (process.argv.includes('--direct')) {
    // Calls one at a time instead of batches (only on this working copy's settings).
    const modes = { ...core.settings().modes };
    for (const m of [
      getSettings(db).models['stage4.primary'],
      getSettings(db).models['stage4.secondary'],
    ])
      if (m) modes[m] = 'direct';
    core.updateSettings({ modes });
  }
  const runner = new AiRunner({
    db,
    core,
    source: CLEANUP_AI_SOURCE,
    featureOf: cleanupFeatureOf,
    modelFor: (task) => getSettings(db).models[task] ?? '',
    log,
  });
  const runId = 'bm-near-' + (arg('run') ?? '1');
  runner.putItems(
    spec,
    items.map((i) => ({ key: i.key, evidence: i.evidence, labeled: true })),
    1,
  );
  const keys = items.map((i) => i.key);
  runner.enqueue(spec, 'primary', keys, runId);
  runner.enqueue(spec, 'secondary', keys, runId);
  for (let round = 0; ; round++) {
    const r = await runner.step(spec, runId, () => false);
    if (r.pending === 0) break;
    if (r.wait && r.sent === 0 && r.answered === 0) {
      log(`waiting: ${JSON.stringify(r.wait).slice(0, 300)}`);
      if (!['provider_busy', 'batch_failing', 'batch_queue_full'].includes(r.wait.kind)) break;
    }
    if (round % 10 === 0) log(`pending ${r.pending}`);
    await sleep(r.sent || r.answered ? 200 : 5000);
  }
  await runner.settle();

  const costOf = db.prepare(
    `SELECT model, SUM(cost_usd) AS c, COUNT(*) AS n FROM ai_requests WHERE stage = ? AND run_id = ? GROUP BY model`,
  );
  const costs = costOf.all(spec.stage, runId) as { model: string; c: number; n: number }[];
  const rows = items.map((i) => {
    const a = runner.answerOf(spec, 'primary', i.key)?.answer?.same_book ?? null;
    const b = runner.answerOf(spec, 'secondary', i.key)?.answer?.same_book ?? null;
    const j = judge(i.hit, gold[i.b.gid!]);
    const t: 'right' | 'wrong' | 'flag' = truth[i.key] ?? (j.ok ? 'right' : 'flag');
    return {
      cid: i.b.cid,
      gid: i.b.gid,
      failed: i.failed,
      book: `${i.b.t} / ${i.b.au.join(', ')}${i.b.se ? ` [${i.b.se} ${i.b.ix ?? ''}]` : ''}`,
      result: `${i.hit.id} ${i.hit.full ?? i.hit.title} / ${i.hit.authors.join(', ')}`,
      label: `${gold[i.b.gid!].t} / ${[gold[i.b.gid!].au].flat().join(', ')} [${gold[i.b.gid!].se ?? ''} ${gold[i.b.gid!].ix ?? ''}]`,
      haiku: a,
      luna: b,
      accepted: a === 'yes' && b === 'yes',
      truth: t,
      why: j.why.join('+'),
      reasons: [
        runner.answerOf(spec, 'primary', i.key)?.answer?.reason ?? null,
        runner.answerOf(spec, 'secondary', i.key)?.answer?.reason ?? null,
      ],
    };
  });
  const sum = (f: (r: { accepted: boolean; truth: string }) => boolean) => rows.filter(f).length;
  const total = costs.reduce((s, c) => s + (c.c ?? 0), 0);
  const report = {
    rules: o,
    nearAll,
    asked: items.length,
    accepted: sum((r) => r.accepted),
    acceptedRight: sum((r) => r.accepted && r.truth === 'right'),
    acceptedWrong: sum((r) => r.accepted && r.truth === 'wrong'),
    acceptedFlag: sum((r) => r.accepted && r.truth === 'flag'),
    rejectedRight: sum((r) => !r.accepted && r.truth === 'right'),
    rejectedWrong: sum((r) => !r.accepted && r.truth === 'wrong'),
    rejectedFlag: sum((r) => !r.accepted && r.truth === 'flag'),
    costs,
    costPerBook: items.length ? total / items.length : 0,
    rows,
  };
  fs.writeFileSync(path.join(work, 'ai-report.json'), JSON.stringify(report, null, 1));
  log(
    `asked ${report.asked}; accepted ${report.accepted} (right ${report.acceptedRight}, wrong ${report.acceptedWrong}, to judge ${report.acceptedFlag}); not accepted: right ${report.rejectedRight}, wrong ${report.rejectedWrong}, to judge ${report.rejectedFlag}; cost $${total.toFixed(4)} = $${report.costPerBook.toFixed(5)} per book`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
