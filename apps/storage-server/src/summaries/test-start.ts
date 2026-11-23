/**
 * Book summaries session 2: starts the accuracy test on the PC's test copy (SUMMARIES_TEST=1).
 * summaries.db beside ttsu.db, a runner of the shared AI layer for the feature "summaries", and
 * the local model when SUMMARIES_LOCAL_URL names a running llama-server.
 */
import type Database from 'better-sqlite3';
import type { AiCore } from '../ai/core';
import { spentTotal } from '../ai/ledger';
import { AiRunner } from '../ai/runner';
import type { TtsJobService } from '../audio/tts-jobs';
import { LlamaServerEngine } from './local-llm';
import { MODELS, modelForTask } from './specs';
import { openSummariesDb, summariesDbPath } from './summaries-db';
import { SummaryTestService } from './test-service';

export function startSummaryTest(o: {
  db: Database.Database;
  dbDir: string;
  core: AiCore;
  tts: TtsJobService;
}): SummaryTestService | null {
  try {
    const db = openSummariesDb(summariesDbPath(o.dbDir));
    o.core.registerFeature('summaries', 'Book summaries');
    o.core.registerModelUse((model) =>
      Object.values(MODELS).includes(model as never) ? ['Book summaries (the accuracy test)'] : [],
    );
    const runner = new AiRunner({
      db,
      core: o.core,
      source: 'summaries',
      featureOf: () => 'summaries',
      modelFor: modelForTask,
      log: (m) => console.log(`Summaries: ${m}`),
    });
    const owner = (
      o.db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get() as
        | { id: string }
        | undefined
    )?.id;
    const localUrl = process.env.SUMMARIES_LOCAL_URL;
    const local = localUrl
      ? new LlamaServerEngine(db, localUrl, {
          contextTokens: Number(process.env.SUMMARIES_LOCAL_CONTEXT ?? 16384),
        })
      : null;
    const svc = new SummaryTestService({
      db,
      runner,
      local,
      findBook: (title) => {
        const r = o.db
          .prepare(
            `SELECT b.id, b.char_count, s.file_path FROM books b JOIN book_sources s ON s.book_id = b.id
             WHERE b.title = ? AND s.missing_at IS NULL LIMIT 1`,
          )
          .get(title) as { id: string; char_count: number | null; file_path: string } | undefined;
        return r ? { id: r.id, characters: r.char_count ?? 0, file: r.file_path } : null;
      },
      scriptOf: (readerId) => {
        if (!owner) throw new Error('no user');
        return o.tts.bookScript(owner, readerId);
      },
      log: (m) => console.log(m),
    });
    // The test's budget is a total, not a monthly limit: the test copy's monthly limit is kept at
    // the budget minus what earlier months of the test spent (nothing else spends in this copy).
    const budget = Number(process.env.SUMMARIES_TEST_BUDGET_USD ?? 30);
    const keepCap = () => {
      const total = spentTotal(o.db).usd;
      const thisMonth = o.core.room().spentUsd;
      const cap = Math.max(0, Math.round((budget - (total - thisMonth)) * 10000) / 10000);
      if (o.core.settings().spendLimitUsd !== cap) o.core.updateSettings({ spendLimitUsd: cap });
    };
    keepCap();
    setInterval(keepCap, 60_000).unref();
    console.log(
      `Summaries test: on (summaries.db, budget $${budget}${local ? `, local model at ${localUrl}` : ''})`,
    );
    return svc;
  } catch (err) {
    console.error('Error: the summaries test is off:', err);
    return null;
  }
}
