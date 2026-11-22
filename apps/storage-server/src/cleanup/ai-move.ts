/**
 * The one-time move of what every AI feature shares from cleanup.db into ttsu.db (book
 * summaries session 1), run when cleanup.db is about to go from v20 to v21:
 *
 *   1. rollback copies of both databases (verified), in DB_DIR/snapshots;
 *   2. in one ttsu.db transaction: the provider settings, both API keys (decrypted with the
 *      cleanup key, encrypted with the AI key), the model checks, the batch tests, one ledger
 *      row per paid question and per paid batch test, the holds of batches still at a provider,
 *      and the marker; checked inside the transaction (totals, counts, both keys read back the
 *      same), so a failed check leaves ttsu.db as it was;
 *   3. then v21 removes them from cleanup.db (its own migration).
 *
 * A stop after 2 skips to 3 on the next start (the marker). Settings or keys already saved in
 * Settings > AI are never overwritten (the spending history is still carried over).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { recordSpendMany, resetHolds, spentTotal } from '../ai/ledger';
import { AiSecretStore, AI_SECRET_NAMES, type AiSecretName } from '../ai/secrets';
import {
  AI_SETTING_KEYS,
  aiSettingsSaved,
  DEFAULT_AI_SETTINGS,
  listBeforeModels,
  updateAiSettings,
  validateAiSettings,
} from '../ai/settings';
import { SETTINGS_FEATURE, SETTINGS_SOURCE } from '../ai/core';
import { snapshotDir } from '../snapshot';
import { CLEANUP_AI_SOURCE, cleanupFeatureOf } from './ai-features';
import { readCleanupSecret } from './secrets';

export const AI_MOVE_MARKER = 'movedFromCleanup';

export interface AiMoveResult {
  moved: boolean;
  copies: string[];
  settings: boolean;
  keys: AiSecretName[];
  spendRows: number;
  spentUsd: number;
}

/** A verified single-file copy (VACUUM INTO, then quick_check); never over an existing file. */
export function copyDatabase(db: Database.Database, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`${file} exists already`);
  db.prepare('VACUUM INTO ?').run(file);
  const copy = new Database(file, { fileMustExist: true, readonly: true });
  try {
    const r = copy.pragma('quick_check', { simple: true });
    if (r !== 'ok') throw new Error(`the copy ${file} failed quick_check: ${String(r)}`);
  } finally {
    copy.close();
  }
}

const stamp = (d: Date) =>
  d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*$/, '') + 'Z';

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a));

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** True when cleanup.db holds anything the move carries over (a new cleanup.db holds nothing). */
export function hasAiData(cleanupDb: Database.Database): boolean {
  const has = (sql: string) => !!cleanupDb.prepare(sql).get();
  return (
    has(`SELECT 1 FROM settings WHERE key = 'ai'`) ||
    has(`SELECT 1 FROM secrets WHERE name IN ('anthropicApiKey', 'openaiApiKey')`) ||
    (tableExists(cleanupDb, 'ai_requests') &&
      has(`SELECT 1 FROM ai_requests WHERE cost_usd IS NOT NULL LIMIT 1`)) ||
    (tableExists(cleanupDb, 'ai_batch_tests') && has(`SELECT 1 FROM ai_batch_tests LIMIT 1`)) ||
    (tableExists(cleanupDb, 'ai_model_checks') && has(`SELECT 1 FROM ai_model_checks LIMIT 1`))
  );
}

export function moveAiToShared(
  cleanupDb: Database.Database,
  mainDb: Database.Database,
  dbDir: string,
  opts: { now?: () => number; log?: (m: string) => void } = {},
): AiMoveResult {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m: string) => console.log(m));
  const out: AiMoveResult = {
    moved: false,
    copies: [],
    settings: false,
    keys: [],
    spendRows: 0,
    spentUsd: 0,
  };
  if (mainDb.prepare('SELECT 1 FROM ai_state WHERE key = ?').get(AI_MOVE_MARKER)) return out;
  if (!hasAiData(cleanupDb)) return out;

  // 1. Rollback copies of both databases, before anything changes.
  const dir = snapshotDir(dbDir);
  const when = stamp(new Date(now()));
  for (const [db, name] of [
    [mainDb, 'ttsu'],
    [cleanupDb, 'cleanup'],
  ] as const) {
    const file = path.join(dir, `pre-ai-layer-${name}-${when}.db`);
    copyDatabase(db, file);
    out.copies.push(file);
  }
  log(`AI move: rollback copies written: ${out.copies.join(', ')}`);

  // What cleanup.db has.
  const rawAi = cleanupDb.prepare(`SELECT value_json FROM settings WHERE key = 'ai'`).get() as
    | { value_json: string }
    | undefined;
  const oldKeys = Object.fromEntries(
    AI_SECRET_NAMES.map((n) => [n, readCleanupSecret(cleanupDb, mainDb, n)]),
  ) as Record<(typeof AI_SECRET_NAMES)[number], string | null>;
  const storedKeys = AI_SECRET_NAMES.filter(
    (n) => !!cleanupDb.prepare('SELECT 1 FROM secrets WHERE name = ?').get(n),
  );
  const unreadable = storedKeys.filter((n) => oldKeys[n] === null);
  if (unreadable.length)
    throw new Error(`AI move: the stored ${unreadable.join(', ')} can't be read; nothing moved`);
  const requests = cleanupDb
    .prepare(
      `SELECT id, stage, provider, model, mode, cost_usd, answered_at, created_at FROM ai_requests
       WHERE cost_usd IS NOT NULL`,
    )
    .all() as {
    id: number;
    stage: string;
    provider: string;
    model: string;
    mode: string | null;
    cost_usd: number;
    answered_at: number | null;
    created_at: number;
  }[];
  const oldSpent = cleanupDb
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n FROM ai_requests WHERE cost_usd IS NOT NULL`,
    )
    .get() as { c: number; n: number };
  const tests = tableExists(cleanupDb, 'ai_batch_tests')
    ? (cleanupDb.prepare('SELECT * FROM ai_batch_tests ORDER BY id').all() as {
        id: number;
        provider: string;
        model: string;
        batch_id: string;
        state: string;
        submitted_at: number;
        checked_at: number | null;
        ended_at: number | null;
        cost_usd: number | null;
        detail: string | null;
      }[])
    : [];
  const checks = tableExists(cleanupDb, 'ai_model_checks')
    ? (cleanupDb.prepare('SELECT * FROM ai_model_checks').all() as {
        provider: string;
        checked_at: number;
        models_json: string | null;
        error: string | null;
      }[])
    : [];
  const open = cleanupDb
    .prepare(
      `SELECT id, stage, estimate_usd, submitted_at FROM ai_batches WHERE state = 'submitted'`,
    )
    .all() as { id: string; stage: string; estimate_usd: number; submitted_at: number }[];

  const secrets = new AiSecretStore(mainDb, dbDir);
  const keepSettings = aiSettingsSaved(mainDb);
  const keepKeys = secrets.any();

  // 2. Into ttsu.db, checked before it commits.
  mainDb.transaction(() => {
    if (rawAi && !keepSettings) {
      const old = JSON.parse(rawAi.value_json) as Record<string, unknown>;
      const provider: Record<string, unknown> = {};
      for (const k of AI_SETTING_KEYS) if (k in old) provider[k] = old[k];
      provider.models = listBeforeModels(old.prices);
      try {
        validateAiSettings(provider, structuredClone(DEFAULT_AI_SETTINGS));
        updateAiSettings(mainDb, provider, now());
        out.settings = true;
      } catch (err) {
        // As cleanup.db's own reading did: a stored group that no longer fits is the defaults.
        log(
          `AI move: the stored provider settings don't fit (${(err as Error).message}); defaults kept`,
        );
      }
    } else if (rawAi)
      log('AI move: Settings > AI already has settings; the cleanup.db ones are not used');
    if (!keepKeys) {
      for (const n of AI_SECRET_NAMES) {
        const v = oldKeys[n];
        if (v === null) continue;
        secrets.put(n, v, now());
        out.keys.push(n);
      }
    } else if (storedKeys.length)
      log('AI move: Settings > AI already has keys; the cleanup.db ones are not used');
    const putCheck = mainDb.prepare(
      `INSERT INTO ai_model_checks (provider, checked_at, models_json, error) VALUES (?, ?, ?, ?)
       ON CONFLICT(provider) DO NOTHING`,
    );
    for (const c of checks) putCheck.run(c.provider, c.checked_at, c.models_json, c.error);
    const testIds = new Map<number, number>();
    const putTest = mainDb.prepare(
      `INSERT INTO ai_batch_tests (provider, model, batch_id, state, submitted_at, checked_at,
         ended_at, cost_usd, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of tests)
      testIds.set(
        t.id,
        Number(
          putTest.run(
            t.provider,
            t.model,
            t.batch_id,
            t.state,
            t.submitted_at,
            t.checked_at,
            t.ended_at,
            t.cost_usd,
            t.detail,
          ).lastInsertRowid,
        ),
      );
    const before = spentTotal(mainDb, CLEANUP_AI_SOURCE);
    const beforeTests = spentTotal(mainDb, SETTINGS_SOURCE);
    const added = recordSpendMany(
      mainDb,
      requests.map((r) => ({
        source: CLEANUP_AI_SOURCE,
        ref: r.id,
        feature: cleanupFeatureOf(r.stage),
        stage: r.stage,
        provider: r.provider,
        model: r.model,
        mode: r.mode,
        costUsd: r.cost_usd,
        at: r.answered_at ?? r.created_at,
      })),
    );
    const paidTests = tests.filter((t) => t.cost_usd !== null);
    const addedTests = recordSpendMany(
      mainDb,
      paidTests.map((t) => ({
        source: SETTINGS_SOURCE,
        ref: testIds.get(t.id)!,
        feature: SETTINGS_FEATURE,
        stage: 'batch-test',
        provider: t.provider,
        model: t.model,
        mode: 'batch',
        costUsd: t.cost_usd!,
        at: t.ended_at ?? t.submitted_at,
      })),
    );
    resetHolds(
      mainDb,
      CLEANUP_AI_SOURCE,
      open.map((b) => ({
        batchId: b.id,
        feature: cleanupFeatureOf(b.stage),
        estimateUsd: b.estimate_usd,
        since: b.submitted_at,
      })),
    );

    // The checks: nothing lost, nothing counted twice, the keys the same.
    const cleanupLedger = spentTotal(mainDb, CLEANUP_AI_SOURCE);
    if (
      added !== oldSpent.n ||
      cleanupLedger.rows !== before.rows + oldSpent.n ||
      !close(cleanupLedger.usd - before.usd, oldSpent.c)
    )
      throw new Error(
        `AI move: the ledger got ${added} rows, $${cleanupLedger.usd - before.usd} for the cleanup; cleanup.db has ${oldSpent.n}, $${oldSpent.c}`,
      );
    const testsUsd = paidTests.reduce((a, t) => a + t.cost_usd!, 0);
    const testsLedger = spentTotal(mainDb, SETTINGS_SOURCE);
    if (addedTests !== paidTests.length || !close(testsLedger.usd - beforeTests.usd, testsUsd))
      throw new Error(
        `AI move: batch tests $${testsLedger.usd - beforeTests.usd} in the ledger, $${testsUsd} before`,
      );
    for (const n of out.keys)
      if (secrets.read(n) !== oldKeys[n])
        throw new Error(`AI move: ${n} does not read back the same`);
    out.spendRows = cleanupLedger.rows + testsLedger.rows;
    out.spentUsd = cleanupLedger.usd + testsLedger.usd;
    mainDb.prepare(`INSERT INTO ai_state (key, value_json, updated_at) VALUES (?, ?, ?)`).run(
      AI_MOVE_MARKER,
      JSON.stringify({
        at: now(),
        copies: out.copies,
        settings: out.settings,
        keys: out.keys,
        spendRows: out.spendRows,
        spentUsd: out.spentUsd,
        cleanupSpentUsd: oldSpent.c,
        cleanupPaidRequests: oldSpent.n,
      }),
      now(),
    );
  })();
  out.moved = true;
  log(
    `AI move: done (settings ${out.settings ? 'moved' : 'not moved'}, keys ${out.keys.length}, ${out.spendRows} paid requests, $${out.spentUsd.toFixed(4)})`,
  );
  return out;
}
