/**
 * The AI runner's calls one at a time (follow-up to WP20e's stop 2): a pool per model as wide
 * as ai.directWorkers, where a call that ends gives its slot to the next question at once
 * (before, each group of calls waited for its slowest one), calls in flight hold their expected
 * cost under the spending limit, and a stop is seen within a second.
 */
import { describe, expect, it } from 'vitest';
import { AiRunner } from '../src/cleanup/ai/runner';
import type { CallInput, CallResult, ProviderClient } from '../src/cleanup/ai/providers';
import { expectedListCost } from '../src/cleanup/ai/spend';
import type { AiStageSpec, Provider } from '../src/cleanup/ai/types';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { makeTempDir } from './helpers/spawn-server';

type Ev = { title: string };

const SPEC: AiStageSpec<Ev> = {
  stage: 'pool5',
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
  schemaName: 'pool_test',
  parseAnswer: (j) =>
    j && typeof j === 'object' && typeof (j as { title?: unknown }).title === 'string'
      ? (j as Record<string, unknown>)
      : null,
  fields: [],
} as unknown as AiStageSpec<Ev>;

/** A provider whose calls end only when the test says so (by item title). */
function heldProvider() {
  const open = new Map<string, (r: CallResult) => void>();
  const started: string[] = [];
  const client: ProviderClient = {
    provider: 'openai',
    listModels: async () => ['gpt-6-luna', 'claude-haiku-5-5'],
    call: (input: CallInput) =>
      new Promise<CallResult>((res) => {
        const title = input.user.replace(/^ITEM /, '');
        started.push(title);
        open.set(title, res);
      }),
    submitBatch: async () => {
      throw new Error('no batches here');
    },
    batchStatus: async () => {
      throw new Error('no batches here');
    },
    batchResults: async () => [],
    cancelBatch: async () => {},
  };
  const end = (title: string) => {
    const r = open.get(title);
    if (!r) throw new Error(`${title} is not in flight`);
    open.delete(title);
    r({
      kind: 'answered',
      text: `{"title":"${title}"}`,
      json: { title },
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    } as CallResult);
  };
  return { client, started, open, end };
}

function setup(directWorkers: number, n: number) {
  const s0 = initCleanupDatabase(makeTempDir('ai-pool'));
  if (!s0.ok) throw new Error(s0.error);
  const db = s0.db;
  const p = heldProvider();
  const runner = new AiRunner({
    db,
    secrets: { read: () => 'key' },
    providers: (_p: Provider) => p.client,
    sleep: async () => {},
  });
  const s = getSettings(db);
  updateSettings(db, {
    ai: {
      ...s.ai,
      spendLimitUsd: 5,
      directWorkers,
      modes: Object.fromEntries(Object.values(s.models).map((m) => [m, 'direct' as const])),
    },
  });
  const keys = Array.from({ length: n }, (_, i) => `k${i}`);
  runner.putItems(
    SPEC,
    keys.map((k) => ({ key: k, evidence: { title: k }, labeled: false })),
    1,
  );
  runner.enqueue(SPEC, 'secondary', keys, 'r');
  return { db, runner, ...p };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('AI calls one at a time: the pool', () => {
  it('a call that ends gives its slot to the next question while a slow one runs on', async () => {
    const { runner, started, end, open } = setup(2, 4);
    // Two slots: k0 and k1 go out; the step waits for one of them to end.
    const step1 = runner.step(SPEC, 'r', () => false);
    await tick();
    expect(started).toEqual(['k0', 'k1']);
    end('k1');
    const r1 = await step1;
    expect(r1).toMatchObject({ sent: 2, answered: 1 });
    // k0 is still in flight (the slow call): the next step fills the free slot at once.
    const step2 = runner.step(SPEC, 'r', () => false);
    await tick();
    expect(started).toEqual(['k0', 'k1', 'k2']);
    expect(open.has('k0')).toBe(true);
    end('k2');
    expect(await step2).toMatchObject({ sent: 1, answered: 1 });
    const step3 = runner.step(SPEC, 'r', () => false);
    await tick();
    expect(started).toEqual(['k0', 'k1', 'k2', 'k3']);
    end('k3');
    end('k0');
    await step3;
    await runner.settle();
    expect(runner.pending(SPEC.stage, 'r')).toBe(0);
    for (const k of ['k0', 'k1', 'k2', 'k3'])
      expect(runner.answerOf(SPEC, 'secondary', k)?.state).toBe('answered');
  });

  it('never has more calls in flight than directWorkers', async () => {
    const { runner, started, end } = setup(3, 10);
    const step1 = runner.step(SPEC, 'r', () => false);
    await tick();
    expect(started.length).toBe(3);
    end('k0');
    await step1;
    // A second step while two are still in flight sends one, not three.
    const step2 = runner.step(SPEC, 'r', () => false);
    await tick();
    expect(started.length).toBe(4);
    for (const k of ['k1', 'k2', 'k3']) end(k);
    await step2;
    // The rest, step by step.
    for (let i = 0; i < 20 && runner.pending(SPEC.stage, 'r') > 0; i++) {
      const st = runner.step(SPEC, 'r', () => false);
      await tick();
      for (const k of started) if (!runner.answerOf(SPEC, 'secondary', k)) end(k);
      await st;
    }
    await runner.settle();
    expect(runner.counts(SPEC.stage, 'r')).toMatchObject({ answered: 10, queued: 0, sent: 0 });
  });

  it('calls in flight hold their cost under the limit (no pause while they do)', async () => {
    const { db, runner, started, end } = setup(5, 4);
    const s = getSettings(db).ai;
    const one = expectedListCost(db, s, 'gpt-6-luna', SPEC.system.length + 'ITEM k0'.length);
    // Room for two calls at the expected cost.
    updateSettings(db, { ai: { ...s, spendLimitUsd: one * 2.5 } });
    const step1 = runner.step(SPEC, 'r', () => false);
    await tick();
    expect(started).toEqual(['k0', 'k1']);
    // While both are in flight a step sends nothing and does not report the limit.
    end('k0');
    const r1 = await step1;
    expect(r1.wait).toBeNull();
    // k0 was recorded at its real (lower) cost: the room it held comes back.
    const step2 = runner.step(SPEC, 'r', () => false);
    await tick();
    expect(started.length).toBeGreaterThanOrEqual(3);
    for (const k of started) if (!runner.answerOf(SPEC, 'secondary', k)) end(k);
    await step2;
    await runner.settle();
  });

  it('every query a step runs on the questions reads an index, never every row or a sort (v16)', async () => {
    const s0 = initCleanupDatabase(makeTempDir('ai-pool-plan'));
    if (!s0.ok) throw new Error(s0.error);
    const db = s0.db;
    const seen = new Set<string>();
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      seen.add(sql);
      return prepare(sql);
    };
    const p = heldProvider();
    const runner = new AiRunner({
      db,
      secrets: { read: () => 'key' },
      providers: () => p.client,
      sleep: async () => {},
    });
    const s = getSettings(db);
    // Haiku by batch (its "returned" and batchable queries), Luna one call each.
    updateSettings(db, { ai: { ...s.ai, spendLimitUsd: 5, directWorkers: 2 } });
    runner.putItems(SPEC, [{ key: 'k0', evidence: { title: 'k0' }, labeled: false }], 1);
    runner.enqueue(SPEC, 'primary', ['k0'], 'r');
    runner.enqueue(SPEC, 'secondary', ['k0'], 'r');
    const st = runner.step(SPEC, 'r', () => false);
    await tick();
    p.end('k0');
    await st;
    runner.counts(SPEC.stage, 'r');
    const { runSpend, spendNow } = await import('../src/cleanup/ai/spend');
    runSpend(db, SPEC.stage, 'r');
    spendNow(db);
    const selects = [...seen].filter((q) => /^\s*SELECT[\s\S]*FROM ai_requests/i.test(q));
    expect(selects.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const q of selects) {
      const n = (q.match(/\?/g) ?? []).length;
      const plan = (
        prepare(`EXPLAIN QUERY PLAN ${q}`).all(...Array(n).fill(null)) as {
          detail: string;
        }[]
      )
        .map((r) => r.detail)
        .join(' | ');
      // The expected-cost lookup's sort is over its LIMIT 50 (0.1 ms with 57,018 answers).
      const sortOk = /ORDER BY id DESC LIMIT 50/.test(q);
      if (
        /SCAN ai_requests\b/.test(plan) ||
        (!sortOk && /TEMP B-TREE FOR (ORDER|GROUP) BY/.test(plan))
      )
        bad.push(`${q.replace(/\s+/g, ' ').slice(0, 120)} => ${plan}`);
    }
    expect(bad).toEqual([]);
    await runner.settle();
  });

  it('a stop is seen within a second although calls are still in flight', async () => {
    const { runner, started, end } = setup(2, 4);
    let stop = false;
    const t0 = Date.now();
    const step1 = runner.step(SPEC, 'r', () => stop);
    await tick();
    stop = true;
    await step1;
    expect(Date.now() - t0).toBeLessThan(2000);
    // Nothing new goes out after the stop; the calls in flight end and are recorded.
    await runner.step(SPEC, 'r', () => stop);
    expect(started).toEqual(['k0', 'k1']);
    end('k0');
    end('k1');
    await runner.settle();
    expect(runner.counts(SPEC.stage, 'r')).toMatchObject({ answered: 2, queued: 2 });
  });
});
