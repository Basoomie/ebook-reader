/**
 * Book summaries session 1: the shared AI layer (src/ai/). The one-time move out of cleanup.db
 * (rollback copies, totals, keys, a failed check, run twice, already-saved settings), the month
 * in the configured time zone, the one monthly limit across features, a feature that waits in
 * its queue for room (one alert), the providers' batch data deleted once collected, the ledger
 * repaired after a stop between the two writes, Settings > AI without cleanup.db, and no
 * cleanup code inside src/ai/.
 */
import Database from 'better-sqlite3';
import { createCipheriv, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AiCore } from '../src/ai/core';
import { spentTotal } from '../src/ai/ledger';
import { monthOf } from '../src/ai/month';
import { costOf, priceOf } from '../src/ai/spend';
import { AnthropicProvider, OpenAiProvider, type ProviderClient } from '../src/ai/providers';
import { AiRunner } from '../src/ai/runner';
import type { AiStageSpec, Provider } from '../src/ai/types';
import { waitNeedsUser } from '../src/ai/waits';
import { AI_MOVE_MARKER } from '../src/cleanup/ai-move';
import {
  CLEANUP_MIGRATIONS,
  cleanupSchemaVersion,
  initCleanupDatabase,
} from '../src/cleanup/cleanup-db';
import { getSettings } from '../src/cleanup/settings';
import { getOrCreateSecret } from '../src/db/secrets';
import { initDatabase } from '../src/db/database';
import { NotificationService } from '../src/notifications/service';
import { NotificationWatcher } from '../src/notifications/watcher';
import { startAiStandin } from './helpers/ai-standin';
import { cleanupRunner, makeAiCore } from './helpers/ai-env';
import { makeTempDir } from './helpers/spawn-server';
import { makeTestApp } from './helpers/test-app';

type Ev = { title: string };
const SPEC: AiStageSpec<Ev> = {
  stage: 'audio5',
  promptVersion: 'p1',
  tasks: {
    primary: 'audio5.primary',
    secondary: 'audio5.secondary',
    upgradePrimary: 'audio5.upgradePrimary',
    upgradeSecondary: 'audio5.upgradeSecondary',
  },
  system: 'Answer {"title": str}.',
  userText: (e) => `ITEM ${e.title}`,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: { title: { type: 'string' } },
  },
  schemaName: 'layer_test',
  parseAnswer: (j) =>
    j && typeof j === 'object' && typeof (j as { title?: unknown }).title === 'string'
      ? (j as Record<string, unknown>)
      : null,
  evidenceText: (e) => e.title,
};

let standin: Awaited<ReturnType<typeof startAiStandin>> | null = null;
afterEach(async () => {
  await standin?.close();
  standin = null;
});

// ---------------------------------------------------------------------------------------------
// the one-time move

/** A cleanup.db at v20 (before the move) beside a ttsu.db at the latest version. */
function v20Pair() {
  const dir = makeTempDir('ai-move');
  const main = initDatabase(dir, makeTempDir('ai-move-data'));
  if (!main.ok) throw new Error(main.error);
  const c = new Database(path.join(dir, 'cleanup.db'));
  c.pragma('journal_mode = WAL');
  for (const m of CLEANUP_MIGRATIONS) {
    if (m.version > 20) break;
    c.exec(m.sql);
    c.pragma(`user_version = ${m.version}`);
  }
  return { dir, main: main.db, cleanup: c };
}

/** Stores a secret the way cleanup.db did before v21 (the cleanup key in ttsu.db). */
function putOldSecret(c: Database.Database, main: Database.Database, name: string, v: string) {
  const key = getOrCreateSecret(main, 'cleanup_secrets');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const ct = Buffer.concat([cipher.update(v, 'utf8'), cipher.final()]);
  c.prepare(
    `INSERT INTO secrets (name, ciphertext, nonce, tag, hint, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(name, ct, nonce, cipher.getAuthTag(), v.slice(-4), 1);
}

function seedOld(c: Database.Database, main: Database.Database) {
  c.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('ai', ?, 1)`).run(
    JSON.stringify({
      spendLimitUsd: 65,
      modes: { 'gpt-6-luna': 'direct' },
      batchStallMinutes: 30,
      connectAttemptMs: 5000,
      batchTurnaroundMinutes: 3,
      directWorkers: 60,
      batchSize: 500,
      batchPollSeconds: 60,
      maxTokens: 16000,
      requestTimeoutSeconds: 180,
      attempts: 4,
      batchPriceFactor: 0.5,
      prices: { 'claude-haiku-5-5': { inputPerMTok: 0.1, outputPerMTok: 0.5 } },
      structuredOutputs: true,
      labeledOnly: true,
      arrivalsDesign: 'J',
      upgradeIncludeDecided: false,
    }),
  );
  putOldSecret(c, main, 'anthropicApiKey', 'sk-ant-api03-moved-key-AAAA');
  putOldSecret(c, main, 'openaiApiKey', 'sk-proj-moved-key-BBBB');
  putOldSecret(c, main, 'calibrePassword', 'calibre-pw');
  const req = c.prepare(
    `INSERT INTO ai_requests (stage, item_key, role, provider, model, prompt_version, evidence_hash,
       state, run_id, labeled, created_at, answered_at, cost_usd, answer_json)
     VALUES (?, ?, 'primary', ?, ?, 'p', 'h', ?, 'r', 0, 1, ?, ?, ?)`,
  );
  // 2026-11-19 and 2026-11-20 (UTC): Calibre and audiobook questions, one unpaid.
  req.run(
    'calibre4',
    'a',
    'anthropic',
    'claude-haiku-5-5',
    'answered',
    1_795_600_000_000,
    0.25,
    '{"t":1}',
  );
  req.run('calibre5', 'b', 'openai', 'gpt-6-luna', 'answered', 1_795_650_000_000, 0.125, '{"t":2}');
  req.run(
    'audio5',
    'c',
    'anthropic',
    'claude-haiku-5-5',
    'invalid',
    1_795_700_000_000,
    0.0625,
    null,
  );
  req.run('audio5', 'd', 'openai', 'gpt-6-luna', 'failed', null, null, null);
  c.prepare(
    `INSERT INTO ai_batch_tests (provider, model, batch_id, state, submitted_at, ended_at, cost_usd, detail)
     VALUES ('anthropic', 'claude-haiku-5-5', 'msgbatch_t', 'answered', 1, 1_795_600_000_000, 0.001, 'answered in 14 s')`,
  ).run();
  c.prepare(
    `INSERT INTO ai_model_checks (provider, checked_at, models_json, error) VALUES ('openai', 5, '["gpt-6-luna"]', NULL)`,
  ).run();
  c.prepare(
    `INSERT INTO ai_batches (id, provider, model, stage, state, requests, estimate_usd, submitted_at)
     VALUES ('msgbatch_open', 'anthropic', 'claude-haiku-5-5', 'calibre4', 'submitted', 10, 0.5, 9)`,
  ).run();
}

describe('the one-time move out of cleanup.db', () => {
  it('copies both databases first, then moves the keys, settings, checks, tests and spending, checked', () => {
    const { dir, main, cleanup } = v20Pair();
    seedOld(cleanup, main);
    const answersBefore = cleanup.prepare('SELECT * FROM ai_requests ORDER BY id').all();
    const batchesBefore = cleanup.prepare('SELECT * FROM ai_batches ORDER BY id').all();
    cleanup.close();
    const st = initCleanupDatabase(dir, { mainDb: main, log: () => undefined });
    if (!st.ok) throw new Error(st.error);
    expect(cleanupSchemaVersion(st.db)).toBe(21);
    // Rollback copies of both, each a whole database at its pre-move state.
    const copies = fs
      .readdirSync(path.join(dir, 'snapshots'))
      .filter((f) => f.startsWith('pre-ai-layer-'));
    expect(copies.map((f) => f.replace(/-\d{8}-\d{6}Z\.db$/, '')).sort()).toEqual([
      'pre-ai-layer-cleanup',
      'pre-ai-layer-ttsu',
    ]);
    const oldCopy = new Database(
      path.join(dir, 'snapshots', copies.find((f) => f.includes('cleanup'))!),
      { readonly: true },
    );
    expect(oldCopy.pragma('user_version', { simple: true })).toBe(20);
    expect(oldCopy.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 3 });
    oldCopy.close();
    // ttsu.db: the provider settings (no cleanup choice among them), both keys, the history.
    const core = new AiCore({ db: main, dbDir: dir, timeZone: () => 'UTC' });
    expect(core.settings()).toMatchObject({ spendLimitUsd: 65, directWorkers: 60 });
    expect('labeledOnly' in core.settings()).toBe(false);
    expect(core.secrets.read('anthropicApiKey')).toBe('sk-ant-api03-moved-key-AAAA');
    expect(core.secrets.read('openaiApiKey')).toBe('sk-proj-moved-key-BBBB');
    expect(core.secrets.info().anthropicApiKey).toMatchObject({ set: true, hint: 'AAAA' });
    expect(fs.existsSync(path.join(dir, 'ai-secrets.key'))).toBe(true);
    expect(spentTotal(main, 'cleanup')).toEqual({ usd: 0.4375, rows: 3 });
    expect(spentTotal(main, 'ai')).toEqual({ usd: 0.001, rows: 1 });
    const byFeature = main
      .prepare(`SELECT feature, SUM(cost_usd) AS c FROM ai_spend GROUP BY feature ORDER BY feature`)
      .all();
    expect(byFeature).toEqual([
      { feature: 'ai-settings', c: 0.001 },
      { feature: 'audiobook-cleanup', c: 0.0625 },
      { feature: 'calibre-cleanup', c: 0.375 },
    ]);
    expect(core.modelChecks().openai.models).toEqual(['gpt-6-luna']);
    expect(core.batchTests()['claude-haiku-5-5']).toMatchObject({ state: 'answered' });
    expect(main.prepare('SELECT * FROM ai_holds').all()).toMatchObject([
      {
        source: 'cleanup',
        batch_id: 'msgbatch_open',
        feature: 'calibre-cleanup',
        estimate_usd: 0.5,
      },
    ]);
    // cleanup.db: answers and batches unchanged; the moved parts gone; its own choices kept.
    expect(st.db.prepare('SELECT * FROM ai_requests ORDER BY id').all()).toEqual(answersBefore);
    expect(
      (
        st.db.prepare('SELECT * FROM ai_batches ORDER BY id').all() as Record<string, unknown>[]
      ).map(({ files_deleted_at: _f, ...rest }) => rest),
    ).toEqual(batchesBefore);
    expect(st.db.prepare('SELECT name FROM secrets').all()).toEqual([{ name: 'calibrePassword' }]);
    expect(getSettings(st.db).ai).toEqual({
      labeledOnly: true,
      arrivalsDesign: 'J',
      upgradeIncludeDecided: false,
    });
    for (const t of ['ai_model_checks', 'ai_batch_tests'])
      expect(st.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(t)).toBeUndefined();
    // Opening again changes nothing (and makes no more copies).
    st.db.close();
    const again = initCleanupDatabase(dir, { mainDb: main });
    if (!again.ok) throw new Error(again.error);
    expect(spentTotal(main, 'cleanup')).toEqual({ usd: 0.4375, rows: 3 });
    expect(
      fs.readdirSync(path.join(dir, 'snapshots')).filter((f) => f.startsWith('pre-ai-layer-')),
    ).toHaveLength(2);
    again.db.close();
  });

  it('a key that cannot be read stops the move: cleanup.db stays at v20, ttsu.db unchanged', () => {
    const { dir, main, cleanup } = v20Pair();
    seedOld(cleanup, main);
    // Damaged: the tag no longer matches.
    cleanup.prepare(`UPDATE secrets SET tag = ? WHERE name = 'openaiApiKey'`).run(randomBytes(16));
    cleanup.close();
    const st = initCleanupDatabase(dir, { mainDb: main, log: () => undefined });
    expect(st.ok).toBe(false);
    if (!st.ok) expect(st.error).toMatch(/openaiApiKey can't be read; nothing moved/);
    const c = new Database(path.join(dir, 'cleanup.db'));
    expect(cleanupSchemaVersion(c)).toBe(20);
    expect(c.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 3 });
    c.close();
    expect(main.prepare('SELECT COUNT(*) AS n FROM ai_spend').get()).toEqual({ n: 0 });
    expect(main.prepare('SELECT COUNT(*) AS n FROM ai_secrets').get()).toEqual({ n: 0 });
    expect(
      main.prepare('SELECT 1 FROM ai_state WHERE key = ?').get(AI_MOVE_MARKER),
    ).toBeUndefined();
  });

  it('never overwrites what Settings > AI already has, but still carries the spending over', () => {
    const { dir, main, cleanup } = v20Pair();
    seedOld(cleanup, main);
    cleanup.close();
    const core = new AiCore({ db: main, dbDir: dir, timeZone: () => 'UTC' });
    core.updateSettings({ spendLimitUsd: 100 });
    core.secrets.put('anthropicApiKey', 'sk-ant-api03-typed-in-settings');
    const st = initCleanupDatabase(dir, { mainDb: main, log: () => undefined });
    if (!st.ok) throw new Error(st.error);
    expect(core.settings().spendLimitUsd).toBe(100);
    expect(core.secrets.read('anthropicApiKey')).toBe('sk-ant-api03-typed-in-settings');
    expect(core.secrets.read('openaiApiKey')).toBeNull();
    expect(spentTotal(main, 'cleanup').usd).toBe(0.4375);
    st.db.close();
  });

  it('without ttsu.db a cleanup.db that still holds the AI data is refused (nothing dropped unmoved)', () => {
    const { dir, main, cleanup } = v20Pair();
    seedOld(cleanup, main);
    cleanup.close();
    const st = initCleanupDatabase(dir);
    expect(st.ok).toBe(false);
    if (!st.ok) expect(st.error).toMatch(/must move them to ttsu.db first/);
  });

  it('a new cleanup.db has nothing to move: no copies', () => {
    const dir = makeTempDir('ai-move-new');
    const main = initDatabase(dir, makeTempDir('ai-move-new-data'));
    if (!main.ok) throw new Error(main.error);
    const st = initCleanupDatabase(dir, { mainDb: main.db });
    if (!st.ok) throw new Error(st.error);
    expect(cleanupSchemaVersion(st.db)).toBe(21);
    expect(fs.existsSync(path.join(dir, 'snapshots'))).toBe(false);
    st.db.close();
  });
});

// ---------------------------------------------------------------------------------------------
// months and the one limit

describe('the month in the configured time zone', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  it('starts on the 1st at local midnight (Denver, Tokyo, a daylight saving month)', () => {
    // Denver, winter (UTC-7): Dec 1 00:00 local is 07:00 UTC.
    const nov = monthOf(Date.parse('2026-12-01T06:59:59Z'), 'America/Denver');
    expect(nov.key).toBe('2026-11');
    expect(iso(nov.start)).toBe('2026-11-01T06:00:00.000Z'); // still MDT on Nov 1
    expect(iso(nov.end)).toBe('2026-12-01T07:00:00.000Z');
    expect(monthOf(Date.parse('2026-12-01T07:00:00Z'), 'America/Denver').key).toBe('2026-12');
    // Tokyo (UTC+9): Dec 1 00:00 local is Nov 30 15:00 UTC.
    expect(monthOf(Date.parse('2026-11-30T14:59:59Z'), 'Asia/Tokyo').key).toBe('2026-11');
    expect(monthOf(Date.parse('2026-11-30T15:00:00Z'), 'Asia/Tokyo')).toMatchObject({
      key: '2026-12',
      start: Date.parse('2026-11-30T15:00:00Z'),
    });
    // March 2027 in Denver: starts in MST (07:00 UTC), ends in MDT (06:00 UTC).
    const mar = monthOf(Date.parse('2027-03-20T12:00:00Z'), 'America/Denver');
    expect([iso(mar.start), iso(mar.end)]).toEqual([
      '2027-03-01T07:00:00.000Z',
      '2027-04-01T06:00:00.000Z',
    ]);
    // December rolls over to January.
    expect(iso(monthOf(Date.parse('2026-12-15T00:00:00Z'), 'UTC').end)).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('counts only this month, and follows a changed time zone', () => {
    let zone = 'America/Denver';
    const now = Date.parse('2026-12-01T03:00:00Z'); // Nov 30 in Denver, Dec 1 in UTC
    const { core, db } = makeAiCore({ now: () => now, timeZone: () => zone });
    const row = (ref: number, at: string, usd: number) =>
      core.record({
        source: 't',
        ref,
        feature: 'calibre-cleanup',
        stage: 'calibre4',
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        mode: 'batch',
        costUsd: usd,
        at: Date.parse(at),
      });
    row(1, '2026-10-31T12:00:00Z', 50); // October: history only
    row(2, '2026-11-20T12:00:00Z', 2);
    row(3, '2026-12-01T01:00:00Z', 3); // Nov 30 evening in Denver
    expect(core.room()).toMatchObject({ month: '2026-11', spentUsd: 5, resumesOn: 'Dec 1' });
    zone = 'UTC';
    expect(core.room()).toMatchObject({ month: '2026-12', spentUsd: 3, resumesOn: 'Jan 1' });
    zone = 'America/Denver';
    const months = core.spending();
    expect(months.map((m) => [m.month, m.totalUsd])).toEqual([
      ['2026-11', 5],
      ['2026-10', 50],
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_spend').get()).toEqual({ n: 3 });
    // The month's total is kept in memory (the sum took 69 ms at the live size): a row this
    // process records adds to it, a row from last month doesn't, the same row twice counts once.
    expect(core.room().spentUsd).toBe(5);
    row(4, '2026-11-25T12:00:00Z', 1);
    row(4, '2026-11-25T12:00:00Z', 1);
    row(5, '2026-10-02T12:00:00Z', 7);
    expect(core.room().spentUsd).toBe(6);
    // Rows written around it (the ledger repair) are read again once it is told.
    db.prepare(
      `INSERT INTO ai_spend (source, ref, feature, stage, provider, model, mode, cost_usd, at)
       VALUES ('t', 9, 'x', 's', 'openai', 'm', NULL, 2, ?)`,
    ).run(Date.parse('2026-11-26T00:00:00Z'));
    expect(core.room().spentUsd).toBe(6);
    core.invalidateSpend();
    expect(core.room().spentUsd).toBe(8);
  });
});

/** A provider answering every direct call at once, with fixed usage (cost $0.0006 each). */
function quickProvider(log: string[] = []): ProviderClient {
  return {
    provider: 'openai',
    listModels: async () => ['gpt-6-luna', 'claude-haiku-5-5'],
    call: async (input) => {
      const title = input.user.replace(/^ITEM /, '');
      log.push(title);
      return {
        kind: 'answered',
        text: `{"title":"${title}"}`,
        json: { title },
        usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 },
      };
    },
    submitBatch: async () => {
      throw new Error('no batches');
    },
    batchStatus: async () => {
      throw new Error('no batches');
    },
    batchResults: async () => [],
    cancelBatch: async () => {},
  };
}

/** A second feature's queue (its own database with the queue tables) on the same core. */
function otherFeature(core: AiCore, feature: string, onLimit: 'pause' | 'queue' = 'pause') {
  const st = initCleanupDatabase(makeTempDir('ai-other'));
  if (!st.ok) throw new Error(st.error);
  const runner = new AiRunner({
    db: st.db,
    core,
    source: `${feature}-queue`,
    featureOf: () => feature,
    modelFor: () => 'gpt-6-luna',
    sleep: async () => {},
  });
  const spec: AiStageSpec<Ev> = { ...SPEC, stage: `${feature}1`, onLimit };
  return { db: st.db, runner, spec };
}

describe('one monthly limit for every feature together', () => {
  it("one feature's spending leaves less room for the other; the split shows where it went", async () => {
    const { core } = makeAiCore({ keys: { read: () => 'key' }, providers: () => quickProvider() });
    core.updateSettings({ modes: { 'gpt-6-luna': 'direct' }, spendLimitUsd: 0.003 });
    const a = otherFeature(core, 'summaries');
    const b = otherFeature(core, 'calibre-cleanup');
    const items = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        key: `k${i}`,
        evidence: { title: `t${i}` },
        labeled: false,
      }));
    for (const f of [a, b]) {
      f.runner.putItems(f.spec, items(10), 1);
      f.runner.enqueue(
        f.spec,
        'secondary',
        items(10).map((x) => x.key),
        'r',
      );
    }
    // The first feature uses the room ($0.0006 a call; at most 0.003 together).
    for (let i = 0; i < 10; i++) {
      await a.runner.step(a.spec, 'r', () => false);
      await a.runner.settle();
    }
    const r = await b.runner.step(b.spec, 'r', () => false);
    expect(r.wait).toMatchObject({ kind: 'limit_reached', limitUsd: 0.003 });
    expect(r.sent).toBe(0);
    const room = core.room();
    expect(room.spentUsd).toBeGreaterThan(0.002);
    expect(room.spentUsd).toBeLessThanOrEqual(0.003);
    expect(core.spending()[0].byFeature).toEqual({ summaries: room.spentUsd });
  });
});

describe('a feature that waits in its queue for room (onLimit: queue)', () => {
  it('waits without a pause, sends one alert, and goes on with a higher limit or a new month', async () => {
    let now = Date.parse('2026-11-30T12:00:00Z');
    const { core, db } = makeAiCore({
      keys: { read: () => 'key' },
      providers: () => quickProvider(),
      now: () => now,
    });
    core.registerFeature('summaries', 'Book summaries');
    core.updateSettings({ modes: { 'gpt-6-luna': 'direct' }, spendLimitUsd: 0.00001 });
    const f = otherFeature(core, 'summaries', 'queue');
    f.runner.putItems(f.spec, [{ key: 'k0', evidence: { title: 't0' }, labeled: false }], 1);
    f.runner.enqueue(f.spec, 'secondary', ['k0'], 'r');
    const r = await f.runner.step(f.spec, 'r', () => false);
    expect(r.wait?.kind).toBe('limit_reached');
    expect(waitNeedsUser(r.wait!, 'queue')).toBe(false);
    expect(waitNeedsUser(r.wait!)).toBe(true); // the cleanup's stages still pause
    expect(core.waiting()).toMatchObject([{ feature: 'summaries', label: 'Book summaries' }]);
    expect(core.waiting()[0].detail).toMatch(/room again on Dec 1 or with a higher limit/);
    // One alert through the notifications, however often they look.
    const service = new NotificationService({
      db,
      dbDir: makeTempDir('ai-notify'),
      config: {} as never,
    });
    const sent: { event: string; lines: string[] }[] = [];
    (service as unknown as { notify: (m: { event: string; lines: string[] }) => void }).notify = (
      m,
    ) => void sent.push(m);
    const watcher = new NotificationWatcher(service, { db, now: () => now });
    const look = () => watcher.check(service.settings());
    look();
    look();
    expect(sent.filter((m) => m.event === 'ai_limit_waiting')).toHaveLength(1);
    expect(sent.find((m) => m.event === 'ai_limit_waiting')!.lines[0]).toBe(
      'Book summaries waits for the monthly AI spending limit',
    );
    // A new month tells the waiting feature (room listeners), and the next step goes on.
    let told = 0;
    core.onRoom(() => told++);
    core.checkMonth();
    now = Date.parse('2026-12-01T12:00:00Z');
    core.checkMonth();
    expect(told).toBe(1);
    // A higher limit tells it at once too.
    core.updateSettings({ spendLimitUsd: 1 });
    expect(told).toBe(2);
    const go = await f.runner.step(f.spec, 'r', () => false);
    await f.runner.settle();
    expect(go.sent).toBe(1);
    expect(core.waiting()).toEqual([]);
    look();
    expect(sent.filter((m) => m.event === 'ai_limit_waiting')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// the providers' batch data

describe("what the providers keep of a batch is deleted once it's collected", () => {
  async function batchSetup(polls = 1) {
    standin = await startAiStandin({
      batchPolls: polls,
      anthropicKey: 'ak',
      openaiKey: 'ok',
      answer: ({ user }: { user: string }) => ({
        kind: 'json',
        json: { title: /ITEM (.*)/.exec(user)?.[1] ?? '' },
      }),
    });
    let now = 1_800_000_000_000;
    const st = initCleanupDatabase(makeTempDir('ai-delete'));
    if (!st.ok) throw new Error(st.error);
    const { core } = makeAiCore({
      keys: { read: (n) => (n === 'anthropicApiKey' ? 'ak' : 'ok') },
      providers: (p: Provider, key: string) =>
        p === 'anthropic'
          ? new AnthropicProvider(key, standin!.anthropicUrl)
          : new OpenAiProvider(key, standin!.openaiUrl),
      now: () => now,
    });
    core.updateSettings({
      spendLimitUsd: 1,
      modes: { 'claude-haiku-5-5': 'batch', 'gpt-6-luna': 'batch' },
    });
    const runner = cleanupRunner(st.db, core, { now: () => now, sleep: async () => {} });
    return { db: st.db, core, runner, advance: (ms: number) => (now += ms) };
  }

  it("deletes OpenAI's input and output files and Anthropic's batch, never before the answers are in", async () => {
    const { db, runner, advance } = await batchSetup(1);
    const keys = ['k0', 'k1'];
    runner.putItems(
      SPEC,
      keys.map((k) => ({ key: k, evidence: { title: k }, labeled: false })),
      1,
    );
    runner.enqueue(SPEC, 'primary', keys, 'r');
    runner.enqueue(SPEC, 'secondary', keys, 'r');
    await runner.step(SPEC, 'r', () => false);
    const deletes = () =>
      (standin!.calls as { delete?: boolean; path: string }[]).filter((c) => c.delete);
    // At the provider: nothing deleted while it runs.
    advance(61_000);
    await runner.step(SPEC, 'r', () => false);
    expect(deletes()).toEqual([]);
    advance(61_000);
    const r = await runner.step(SPEC, 'r', () => false);
    expect(r.pending).toBe(0);
    expect(runner.answerOf(SPEC, 'secondary', 'k1')?.state).toBe('answered');
    const paths = deletes().map((c) =>
      c.path.replace(/(batch|file)[-_][\w-]+/, '$1-x').replace(/msgbatch_\w+/, 'msgbatch-x'),
    );
    expect(paths.sort()).toEqual(
      ['/v1/files/file-x', '/v1/files/file-x', '/v1/messages/batches/msgbatch-x'].sort(),
    );
    expect(standin!.files.size).toBe(0);
    expect(standin!.batches.size).toBe(1); // OpenAI keeps the batch object (ids only)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ai_batches WHERE files_deleted_at IS NOT NULL`).get(),
    ).toEqual({ n: 2 });
  });

  it('a delete that failed is tried again by the sweep; the batches collected before are swept too', async () => {
    const { db, runner } = await batchSetup();
    // Collected before deleting existed (or a delete failed): files_deleted_at is empty.
    db.prepare(
      `INSERT INTO ai_batches (id, provider, model, stage, state, requests, estimate_usd, submitted_at)
       VALUES ('msgbatch_old', 'anthropic', 'claude-haiku-5-5', 'audio5', 'collected', 1, 0, 1)`,
    ).run();
    expect(await runner.sweepBatchData(20, true)).toBe(1);
    expect(
      (standin!.calls as { delete?: boolean; batch?: string }[]).filter((c) => c.delete),
    ).toMatchObject([{ batch: 'msgbatch_old' }]); // already gone at the provider: counts as done
    expect(await runner.sweepBatchData(20, true)).toBe(0);
    // A batch still at the provider is never touched.
    db.prepare(
      `INSERT INTO ai_batches (id, provider, model, stage, state, requests, estimate_usd, submitted_at)
       VALUES ('msgbatch_open', 'anthropic', 'claude-haiku-5-5', 'audio5', 'submitted', 1, 0, 2)`,
    ).run();
    expect(await runner.sweepBatchData(20, true)).toBe(0);
  });

  it("deletes a Test batch's data once it has ended", async () => {
    const { core, advance } = await batchSetup(0);
    await core.testBatch('gpt-6-luna');
    advance(61_000);
    await core.pollBatchTests();
    expect(core.batchTests()['gpt-6-luna'].state).toBe('answered');
    expect(standin!.files.size).toBe(0);
    expect(
      core.db.prepare(`SELECT files_deleted_at IS NOT NULL AS d FROM ai_batch_tests`).get(),
    ).toEqual({ d: 1 });
    // Its cost is in the ledger, as Settings' own spending.
    expect(core.spending()[0].byFeature['ai-settings']).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// the ledger, the routes, the boundary

describe('the ledger and Settings > AI', () => {
  it('a paid answer the ledger missed (a stop between the two writes) is added at the next start', () => {
    const st = initCleanupDatabase(makeTempDir('ai-repair'));
    if (!st.ok) throw new Error(st.error);
    const { core, db } = makeAiCore();
    cleanupRunner(st.db, core);
    st.db
      .prepare(
        `INSERT INTO ai_requests (stage, item_key, role, provider, model, prompt_version, evidence_hash,
           state, run_id, labeled, created_at, answered_at, cost_usd)
         VALUES ('calibre4', 'x', 'primary', 'openai', 'gpt-6-luna', 'p', 'h', 'answered', 'r', 0, 1, 2, 0.5)`,
      )
      .run();
    expect(spentTotal(db, 'cleanup').rows).toBe(0);
    cleanupRunner(st.db, core);
    expect(spentTotal(db, 'cleanup')).toEqual({ usd: 0.5, rows: 1 });
    expect(db.prepare('SELECT feature, at FROM ai_spend').get()).toEqual({
      feature: 'calibre-cleanup',
      at: 2,
    });
    cleanupRunner(st.db, core);
    expect(spentTotal(db, 'cleanup').rows).toBe(1);
  });

  it('works without cleanup.db: status, settings, write-only keys, Check models', async () => {
    standin = await startAiStandin({
      anthropicKey: 'sk-ant-api03-route-key-1234',
      openaiKey: 'ok',
    });
    const t = makeTestApp();
    if (!t.database.ok) throw new Error('no db');
    const core = new AiCore({
      db: t.database.db,
      dbDir: t.config.dbDir,
      providers: (p, key) =>
        p === 'anthropic'
          ? new AnthropicProvider(key, standin!.anthropicUrl)
          : new OpenAiProvider(key, standin!.openaiUrl),
    });
    const { createApp } = await import('../src/app');
    const app = createApp({ config: t.config, database: t.database, version: 't', ai: core });
    const auth = { Authorization: `Bearer ${t.newUserToken()}` };
    expect((await request(app).get('/api/v1/cleanup/status').set(auth)).body.available).toBe(false);
    const st = await request(app).get('/api/v1/ai/status').set(auth).expect(200);
    expect(st.body.spend).toMatchObject({ spentUsd: 0, limitUsd: null });
    const put = await request(app)
      .put('/api/v1/ai/settings')
      .set(auth)
      .send({ spendLimitUsd: 100 })
      .expect(200);
    expect(put.body.settings.spendLimitUsd).toBe(100);
    await request(app).put('/api/v1/ai/settings').set(auth).send({ labeledOnly: true }).expect(400);
    const key = await request(app)
      .put('/api/v1/ai/secrets/anthropicApiKey')
      .set(auth)
      .send({ value: 'sk-ant-api03-route-key-1234' })
      .expect(200);
    expect(JSON.stringify(key.body)).not.toContain('route-key');
    expect(key.body.keys.anthropicApiKey).toMatchObject({ set: true, hint: '1234' });
    const check = await request(app).post('/api/v1/ai/models/check').set(auth).expect(200);
    expect(check.body.checks.anthropic).toMatchObject({ error: null });
    expect(
      check.body.models.find((m: { model: string }) => m.model === 'claude-haiku-5-5'),
    ).toMatchObject({ offered: true, mode: 'batch' });
    await request(app).delete('/api/v1/ai/secrets/anthropicApiKey').set(auth).expect(200);
    expect(core.secrets.read('anthropicApiKey')).toBeNull();
  });

  it('src/ai/ has no cleanup code: nothing in it imports from src/cleanup/', () => {
    const dir = path.join(__dirname, '../src/ai');
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/from '([^']+)'/g))
        if (/cleanup/.test(m[1])) bad.push(`${f}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
    // And the old place is gone.
    expect(fs.existsSync(path.join(__dirname, '../src/cleanup/ai'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// the built-in prices (asked by the user 2026-11-21: prices are information, not settings)

describe("the providers' list prices, built in", () => {
  const usage = (input: number, output: number, cacheRead = 0) => ({
    input,
    output,
    cacheRead,
    cacheWrite: 0,
  });

  it('counts each model at its own price, the long-prompt tier above its threshold, its own cache price', () => {
    const s = makeAiCore().core.settings();
    const haiku = priceOf(s, 'claude-haiku-5-5')!;
    // 100K prompt tokens or fewer: $0.10 / $0.50; above: $0.50 / $2.50 (the whole request).
    expect(costOf(haiku, usage(100_000, 1000), false, 0.5)).toBeCloseTo(0.0105, 9);
    expect(costOf(haiku, usage(150_000, 1000), false, 0.5)).toBeCloseTo(0.0775, 9);
    // Batches at half.
    expect(costOf(haiku, usage(150_000, 1000), true, 0.5)).toBeCloseTo(0.03875, 9);
    // Sol: cached input $0.10 (5 % of its input price), above 272K input tokens $4 / $15.
    const sol = priceOf(s, 'gpt-6.1-sol')!;
    expect(costOf(sol, usage(1000, 1000, 200_000), false, 0.5)).toBeCloseTo(0.032, 9);
    expect(costOf(sol, usage(300_000, 1000), false, 0.5)).toBeCloseTo(1.215, 9);
    // Opus 5.5 is one of the app's models.
    expect(priceOf(s, 'claude-opus-5-5')).toMatchObject({ inputPerMTok: 4, outputPerMTok: 20 });
  });

  it('a built-in price always wins over a stored one; a stored added model keeps its price', () => {
    const { core } = makeAiCore();
    core.updateSettings({
      prices: {
        'claude-haiku-5-5': { inputPerMTok: 0, outputPerMTok: 0 },
        'claude-opus-5.5': { inputPerMTok: 1, outputPerMTok: 1 },
      },
    });
    const s = core.settings();
    expect(priceOf(s, 'claude-haiku-5-5')).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 0.5 });
    expect(priceOf(s, 'claude-opus-5.5')).toEqual({ inputPerMTok: 1, outputPerMTok: 1 });
  });

  it('Settings > AI: prices read-only, the app’s models kept, an added model deleted unless in use', async () => {
    const t = makeTestApp();
    if (!t.database.ok) throw new Error('no db');
    const core = new AiCore({ db: t.database.db, dbDir: t.config.dbDir });
    // As on the NAS: an entry typed before prices were built in.
    core.updateSettings({ prices: { 'claude-opus-5.5': { inputPerMTok: 1, outputPerMTok: 1 } } });
    let used = '';
    core.registerModelUse((m) => (m === used ? ['library cleanup audio5.primary'] : []));
    const { createApp } = await import('../src/app');
    const app = createApp({ config: t.config, database: t.database, version: 't', ai: core });
    const auth = { Authorization: `Bearer ${t.newUserToken()}` };
    const st = await request(app).get('/api/v1/ai/status').set(auth).expect(200);
    expect(
      st.body.models.map((m: { model: string; builtIn: boolean }) => [m.model, m.builtIn]),
    ).toEqual([
      ['claude-haiku-5-5', true],
      ['claude-sonnet-5-5', true],
      ['claude-opus-5-5', true],
      ['gpt-6-luna', true],
      ['gpt-6.1-sol', true],
      ['claude-opus-5.5', false],
    ]);
    expect(st.body.pricesChecked).toBe('2026-11-21');
    // Prices can't be set.
    await request(app)
      .put('/api/v1/ai/settings')
      .set(auth)
      .send({ prices: { 'claude-haiku-5-5': { inputPerMTok: 0, outputPerMTok: 0 } } })
      .expect(400);
    // The app's own models can't be deleted; an added one in use can't either.
    const own = await request(app).delete('/api/v1/ai/models/claude-haiku-5-5').set(auth);
    expect(own.status).toBe(409);
    used = 'claude-opus-5.5';
    const busy = await request(app).delete('/api/v1/ai/models/claude-opus-5.5').set(auth);
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toMatch(/in use \(library cleanup audio5\.primary\)/);
    used = '';
    const gone = await request(app)
      .delete('/api/v1/ai/models/claude-opus-5.5')
      .set(auth)
      .expect(200);
    expect(gone.body.models.some((m: { model: string }) => m.model === 'claude-opus-5.5')).toBe(
      false,
    );
    expect(core.settings().prices).toEqual({});
    await request(app).delete('/api/v1/ai/models/claude-opus-5.5').set(auth).expect(409);
  });
});
