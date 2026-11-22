/**
 * Book summaries session 2: puts the AI keys and provider settings into the PC test copy's own
 * ttsu.db, read from copies of the NAS snapshots (never the live files): the ttsu.db snapshot
 * and the cleanup.db snapshot taken just before the keys moved (the keys were still in
 * cleanup.db then, encrypted with the key in that ttsu.db). Sets the test's models to direct
 * calls (round 1) or batches, and the budget as the copy's monthly limit.
 *
 *   npx ts-node --transpile-only scripts/summaries-test-seed.ts <cleanup-snap> <ttsu-snap> <test DB_DIR> [direct|batch]
 */
import Database from 'better-sqlite3';
import path from 'path';
import { AiCore } from '../src/ai/core';
import { AI_SECRET_NAMES, AiSecretStore } from '../src/ai/secrets';
import { initDatabase } from '../src/db/database';
import { MODELS } from '../src/summaries/specs';
import { readAiSeed } from './lib/cleanup-ai';

const [cleanupSnap, ttsuSnap, dbDir, mode] = process.argv.slice(2);
if (!cleanupSnap || !ttsuSnap || !dbDir)
  throw new Error('usage: <cleanup-snap> <ttsu-snap> <DB_DIR> [direct|batch]');
// "fake fake": stand-in keys for the e2e copy (its AI addresses point at the stand-in).
const seed =
  cleanupSnap === 'fake'
    ? {
        keys: Object.fromEntries(AI_SECRET_NAMES.map((n) => [n, 'stand-in-key'])) as Record<
          (typeof AI_SECRET_NAMES)[number],
          string | null
        >,
        settings: null,
      }
    : readAiSeed(
        new Database(cleanupSnap, { readonly: true }),
        new Database(ttsuSnap, { readonly: true }),
        null,
      );
const got = AI_SECRET_NAMES.filter((n) => seed.keys[n]);
console.log(`keys found: ${got.join(', ') || 'none'}`);
if (!got.length) throw new Error('no keys in the snapshots');
const main = initDatabase(dbDir, path.join(dbDir, '..', 'data'));
if (!main.ok) throw new Error(main.error);
const store = new AiSecretStore(main.db, dbDir);
for (const n of got) store.put(n, seed.keys[n]!);
const core = new AiCore({ db: main.db, dbDir });
const s = core.updateSettings({
  ...(seed.settings ?? {}),
  spendLimitUsd: Number(process.env.SUMMARIES_TEST_BUDGET_USD ?? 30),
  modes: {
    ...(seed.settings?.modes ?? {}),
    ...Object.fromEntries(
      Object.values(MODELS).map((id) => [id, mode === 'batch' ? 'batch' : 'direct']),
    ),
  },
});
console.log(
  `limit $${s.spendLimitUsd}, modes ${JSON.stringify(Object.fromEntries(Object.values(MODELS).map((id) => [id, s.modes[id]])))}`,
);
for (const n of got) console.log(`${n}: stored`);
