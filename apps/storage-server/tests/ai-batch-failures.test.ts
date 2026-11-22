/**
 * Batches a provider refuses as a whole (2026-11-22: OpenAI failed 926 gpt-6-luna batches in 31
 * minutes; the runner sent a new one within seconds of each, and kept only "failed"). Through
 * the real SDKs against the stand-in: the provider's reason is kept, one unconfirmed batch per
 * model, a growing wait, a pause with one alert, tries given back for capacity failures and
 * counted for content ones, the queue cap, a restart, the one-call-each fallback, Anthropic's
 * refusal when a batch is created.
 */
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  OpenAiProvider,
  isCapacityFailure,
  type ProviderClient,
} from '../src/ai/providers';
import type { AiRunner } from '../src/ai/runner';
import type { AiStageSpec, Provider } from '../src/ai/types';
import { waitNeedsUser, waitText } from '../src/ai/waits';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { NotificationService } from '../src/notifications/service';
import { NotificationWatcher } from '../src/notifications/watcher';
import { cleanupRunner, makeAiCore } from './helpers/ai-env';
import { startAiStandin } from './helpers/ai-standin';
import { makeTempDir } from './helpers/spawn-server';

const LIMIT_MSG =
  'Enqueued token limit reached for gpt-6-luna in organization org-test. Limit: 20,000,000 enqueued tokens. Please try again once some in_progress batches have been completed.';

interface Ev {
  title: string;
}
const SPEC: AiStageSpec<Ev> = {
  stage: 'test5',
  promptVersion: 't1',
  tasks: {
    primary: 'audio5.primary', // claude-haiku-5-5
    secondary: 'audio5.secondary', // gpt-6-luna
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
  schemaName: 'test',
  parseAnswer: (raw) =>
    raw && typeof raw === 'object' && typeof (raw as { title?: unknown }).title === 'string'
      ? (raw as Record<string, unknown>)
      : null,
  evidenceText: (e) => e.title,
};

let standin: Awaited<ReturnType<typeof startAiStandin>> | null = null;
afterEach(async () => {
  await standin?.close();
  standin = null;
});

type Fail = { code: string; message: string; errorFile?: boolean } | null;

async function setup(o: { batchPolls?: number } = {}) {
  const opts: {
    batchPolls: number;
    fail: Fail;
    refuse: { status: number; type?: string; message: string } | null;
  } = { batchPolls: o.batchPolls ?? 0, fail: null, refuse: null };
  standin = await startAiStandin({
    get batchPolls() {
      return opts.batchPolls;
    },
    failBatch: () => opts.fail,
    refuseBatch: () => opts.refuse,
    answer: ({ user }: { user: string }) => ({
      kind: 'json',
      json: { title: /ITEM (.*)/.exec(user)?.[1] ?? '' },
    }),
  });
  const s = initCleanupDatabase(makeTempDir('ai-batch-fail'));
  if (!s.ok) throw new Error(s.error);
  const db: Database.Database = s.db;
  let now = Date.parse('2026-11-22T15:20:00Z');
  const logs: string[] = [];
  const providers = (p: Provider, key: string): ProviderClient =>
    p === 'anthropic'
      ? new AnthropicProvider(key, standin!.anthropicUrl)
      : new OpenAiProvider(key, standin!.openaiUrl);
  const made = makeAiCore({
    keys: { read: () => 'key' },
    providers,
    now: () => now,
    timeZone: () => 'America/Denver',
    log: (m) => void logs.push(m),
  });
  const runner = cleanupRunner(db, made.core, { now: () => now, sleep: async () => {} });
  made.core.updateSettings({ spendLimitUsd: 5, modes: { 'gpt-6-luna': 'batch' } });
  return {
    opts,
    db,
    ttsuDb: made.db,
    dir: made.dir,
    core: made.core,
    runner,
    logs,
    providers,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function put(runner: AiRunner, n: number, role: 'primary' | 'secondary' = 'secondary') {
  const items = Array.from({ length: n }, (_, i) => ({
    key: `k${i}`,
    evidence: { title: `title${i}` },
    labeled: false,
  }));
  runner.putItems(SPEC, items, 1);
  runner.enqueue(
    SPEC,
    role,
    items.map((x) => x.key),
    'run1',
  );
}

const created = (provider = 'openai') =>
  (standin!.calls as { path: string; provider: string; poll?: boolean }[]).filter(
    (c) =>
      c.provider === provider &&
      (c.path === '/v1/batches' || c.path === '/v1/messages/batches') &&
      !c.poll,
  ).length;

const step = (runner: AiRunner) => runner.step(SPEC, 'run1', () => false);

describe('a batch the provider refuses as a whole', () => {
  it('keeps the reason, sends no new batch for the wait (growing), and gives capacity failures their tries back', async () => {
    const { opts, db, core, runner, advance, now } = await setup();
    opts.fail = { code: 'token_limit_exceeded', message: LIMIT_MSG };
    put(runner, 20);
    expect((await step(runner)).sent).toBe(20);
    // The next step checks the unconfirmed batch at once: failed, with OpenAI's reason.
    const r = await step(runner);
    expect(r.sent).toBe(0);
    expect(r.wait).toMatchObject({ kind: 'batch_failing', failures: 1, paused: false });
    expect(waitNeedsUser(r.wait!)).toBe(false);
    expect(waitText(r.wait!)).toBe(
      `OpenAI refused a gpt-6-luna batch (token_limit_exceeded: ${LIMIT_MSG}); next batch at 8:25 AM`,
    );
    const b = db.prepare(`SELECT state, error FROM ai_batches`).get() as {
      state: string;
      error: string;
    };
    expect(b.state).toBe('failed');
    expect(b.error).toBe(`failed: token_limit_exceeded: ${LIMIT_MSG}`.slice(0, 300));
    // Capacity: the questions are queued with no try used.
    expect(
      db.prepare(`SELECT DISTINCT state, attempts FROM ai_requests`).all() as unknown[],
    ).toEqual([{ state: 'queued', attempts: 0 }]);
    // No storm: 40 steps two seconds apart send nothing (the old code sent a batch per step).
    for (let i = 0; i < 40; i++) {
      advance(2_000);
      expect((await step(runner)).sent).toBe(0);
    }
    expect(created()).toBe(1);
    // After 5 minutes one batch; it fails too: the next wait is 10 minutes.
    advance(5 * 60_000 - 80_000);
    expect((await step(runner)).sent).toBe(20);
    const r2 = await step(runner);
    expect(r2.wait).toMatchObject({ kind: 'batch_failing', failures: 2 });
    expect(core.batchHealth()['gpt-6-luna'].nextAt - now()).toBe(10 * 60_000);
    advance(9 * 60_000);
    expect((await step(runner)).sent).toBe(0);
    expect(created()).toBe(2);
    expect(db.prepare(`SELECT MAX(attempts) AS a FROM ai_requests`).get()).toEqual({ a: 0 });
  });

  it('pauses after failures in a row with one alert, and goes on (Resolved) once a batch is accepted', async () => {
    const { opts, core, runner, advance, ttsuDb, now } = await setup();
    opts.fail = { code: 'token_limit_exceeded', message: LIMIT_MSG };
    put(runner, 5);
    const service = new NotificationService({
      db: ttsuDb,
      dbDir: makeTempDir('ai-batch-notify'),
      config: {} as never,
    });
    const sent: { event: string; lines: string[] }[] = [];
    (service as unknown as { notify: (m: { event: string; lines: string[] }) => void }).notify = (
      m,
    ) => void sent.push(m);
    const watcher = new NotificationWatcher(service, { db: ttsuDb, now });
    const look = () => watcher.check(service.settings());
    let last = null;
    for (const wait of [0, 5, 10]) {
      advance(wait * 60_000);
      expect((await step(runner)).sent).toBe(5);
      last = await step(runner);
      look();
    }
    expect(last!.wait).toMatchObject({ kind: 'batch_failing', failures: 3, paused: true });
    // Paused: one try a batchFailMaxWaitMinutes (60).
    expect(core.batchHealth()['gpt-6-luna'].nextAt - now()).toBe(60 * 60_000);
    expect(waitText(last!.wait!)).toMatch(
      /^OpenAI refused 3 gpt-6-luna batches in a row \(token_limit_exceeded: .*\); batches paused, next try at 9:35 AM$/,
    );
    look();
    const alerts = sent.filter((m) => m.event === 'ai_batches_failing');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].lines[0]).toBe(
      'OpenAI refused 3 gpt-6-luna batches in a row: its batches are paused',
    );
    expect(alerts[0].lines[1]).toMatch(/^token_limit_exceeded: Enqueued token limit/);
    // The queue has room again: the hourly try is accepted and answered.
    opts.fail = null;
    advance(60 * 60_000);
    expect((await step(runner)).sent).toBe(5);
    const go = await step(runner);
    expect(go.wait).toBeNull();
    expect(go.pending).toBe(0);
    expect(core.batchHealth()).toEqual({});
    look();
    expect(sent.filter((m) => m.event === 'ai_batches_failing')).toHaveLength(1);
    // The problem is resolved (the digest's "Resolved" line).
    const problem = ttsuDb
      .prepare(`SELECT resolved_at FROM notification_problems WHERE key = ?`)
      .get('ai_batches_failing:gpt-6-luna') as { resolved_at: number | null };
    expect(problem.resolved_at).not.toBeNull();
  });

  it('counts a try when the batch was refused for what was sent, and gives a question up after its tries', async () => {
    const { opts, db, core, runner, advance } = await setup();
    core.updateSettings({ attempts: 2, batchFailWaitMinutes: 1 });
    opts.fail = { code: 'invalid_request', message: 'The input file is not valid JSONL.' };
    put(runner, 3);
    expect((await step(runner)).sent).toBe(3);
    await step(runner);
    expect(
      db.prepare(`SELECT DISTINCT state, attempts, error FROM ai_requests`).all() as unknown[],
    ).toEqual([
      {
        state: 'queued',
        attempts: 1,
        error: 'batch failed: invalid_request: The input file is not valid JSONL.',
      },
    ]);
    expect(core.batchHealth()['gpt-6-luna'].capacity).toBe(false);
    advance(60_000);
    expect((await step(runner)).sent).toBe(3);
    const r = await step(runner);
    expect(r.pending).toBe(0);
    expect(runner.counts('test5', 'run1')).toMatchObject({ failed: 3, queued: 0 });
    // Nothing more is sent for them.
    advance(10 * 60_000);
    expect((await step(runner)).sent).toBe(0);
    expect(created()).toBe(2);
  });

  it('reads the reason from the error file when the batch has no error list', async () => {
    const { opts, db, runner } = await setup();
    opts.fail = { code: 'token_limit_exceeded', message: LIMIT_MSG, errorFile: true };
    put(runner, 2);
    await step(runner);
    await step(runner);
    expect((db.prepare(`SELECT error FROM ai_batches`).get() as { error: string }).error).toMatch(
      /^failed: token_limit_exceeded: Enqueued token limit reached/,
    );
  });

  it('keeps the wait over a restart (a new core and runner on the same databases)', async () => {
    const { opts, db, ttsuDb, dir, runner, providers, now } = await setup();
    opts.fail = { code: 'token_limit_exceeded', message: LIMIT_MSG };
    put(runner, 4);
    await step(runner);
    await step(runner);
    const again = makeAiCore({ db: ttsuDb, dir, keys: { read: () => 'key' }, providers, now });
    const r2 = cleanupRunner(db, again.core, { now, sleep: async () => {} });
    const r = await r2.step(SPEC, 'run1', () => false);
    expect(r.wait).toMatchObject({ kind: 'batch_failing', failures: 1 });
    expect(r.sent).toBe(0);
    expect(created()).toBe(1);
  });

  it('with the fallback, a paused model is asked one call each for the rest of the run (its mode unchanged)', async () => {
    const { opts, core, runner } = await setup();
    core.updateSettings({ batchFailPauseAfter: 1, batchFailFallback: 'direct' });
    opts.fail = { code: 'token_limit_exceeded', message: LIMIT_MSG };
    put(runner, 3);
    await step(runner);
    // The step that finds the failure pauses the model and asks its questions one call each.
    const r = await step(runner);
    await runner.settle();
    expect(r.sent).toBe(3);
    expect(waitText(r.wait!)).toMatch(
      /its questions are asked one call each for the rest of this run \(full price\)$/,
    );
    const direct = (standin!.calls as { path: string }[]).filter(
      (c) => c.path === '/v1/chat/completions',
    );
    expect(direct).toHaveLength(3);
    expect(runner.pending('test5', 'run1')).toBe(0);
    expect(core.settings().modes['gpt-6-luna']).toBe('batch');
    expect(created()).toBe(1);
  });

  it("Anthropic's refusal when a batch is created waits as a failed batch (one try, not every step)", async () => {
    const { opts, core, runner, advance } = await setup();
    core.updateSettings({ modes: { 'claude-haiku-5-5': 'batch' } });
    opts.refuse = {
      status: 429,
      type: 'rate_limit_error',
      message: 'Number of batch requests in queue exceeds the limit',
    };
    put(runner, 3, 'primary');
    const r = await step(runner);
    expect(r.sent).toBe(0);
    expect(r.wait).toMatchObject({ kind: 'batch_failing', provider: 'anthropic', failures: 1 });
    expect(core.batchHealth()['claude-haiku-5-5']).toMatchObject({ capacity: true });
    for (let i = 0; i < 10; i++) {
      advance(5_000);
      await step(runner);
    }
    const refused = (standin!.calls as { refused?: boolean }[]).filter((c) => c.refused);
    expect(refused).toHaveLength(1);
    // Accepted after the wait.
    opts.refuse = null;
    advance(5 * 60_000);
    expect((await step(runner)).sent).toBe(3);
    await step(runner);
    expect(core.batchHealth()).toEqual({});
  });
});

describe('the batch queue cap', () => {
  it('never has more than the cap at the provider; more goes as its batches end', async () => {
    const { opts, core, runner, advance } = await setup({ batchPolls: 1000 });
    // About 48 estimated tokens a question before any is measured: 10 fit under 500.
    core.updateSettings({ batchSize: 10, batchQueueTokens: { 'gpt-6-luna': 500 } });
    put(runner, 30);
    expect((await step(runner)).sent).toBe(10);
    advance(61_000);
    const full = await step(runner);
    expect(full.sent).toBe(0);
    expect(full.wait).toMatchObject({ kind: 'batch_queue_full', model: 'gpt-6-luna', limit: 500 });
    expect(waitNeedsUser(full.wait!)).toBe(false);
    expect(created()).toBe(1);
    // The batch ends: the next one goes.
    opts.batchPolls = 0;
    advance(61_000);
    const next = await step(runner);
    expect(next.answered).toBe(10);
    expect(next.sent).toBeGreaterThan(0);
  });

  it('without a cap typed for the model, the default applies; 0 = no cap', async () => {
    const { core, runner } = await setup({ batchPolls: 1000 });
    core.updateSettings({ batchSize: 5, batchQueueTokensDefault: 0 });
    put(runner, 10);
    expect((await step(runner)).sent).toBe(5);
    // The next step confirms the first batch, then sends the second.
    expect((await step(runner)).sent).toBe(5);
  });
});

describe('what counts as the provider capacity', () => {
  it('limits and rate limits do; a spent quota, billing or a bad file does not', () => {
    expect(isCapacityFailure('token_limit_exceeded', LIMIT_MSG)).toBe(true);
    expect(isCapacityFailure('request_limit_exceeded', '')).toBe(true);
    expect(isCapacityFailure('rate_limit_error', 'Number of batch requests')).toBe(true);
    expect(isCapacityFailure('insufficient_quota', 'You exceeded your current quota')).toBe(false);
    expect(isCapacityFailure('billing_hard_limit_reached', 'billing')).toBe(false);
    expect(isCapacityFailure('invalid_json_line', 'Line 3 is not valid JSON')).toBe(false);
    expect(isCapacityFailure(null, null)).toBe(false);
  });
});
