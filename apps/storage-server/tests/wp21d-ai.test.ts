/**
 * WP21d: the shared AI framework (src/cleanup/ai/): setup E and its upgrades per field, the
 * never-invent check, the runner (batches and direct calls through the real SDKs against a
 * stand-in of both providers, the spending limit, blocked answers final, retries only on busy
 * and server errors, a refused key, answers reused), and the values store (a user's value is
 * never replaced; an upgrade re-checks only what the models decided or guessed).
 */
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  answerOf,
  combineE,
  combineUpgrade,
  evidenceForm,
  inEvidence,
} from '../src/cleanup/ai/combine';
import {
  AnthropicProvider,
  OpenAiProvider,
  firstJson,
  type ProviderClient,
} from '../src/cleanup/ai/providers';
import { AiRunner } from '../src/cleanup/ai/runner';
import { costOf, runSpend, spendNow } from '../src/cleanup/ai/spend';
import { NAME_FORM_RULE, VOLUME_MARKER_RULE, systemPrompt } from '../src/cleanup/ai/prompt-blocks';
import type { AiField, AiStageSpec, Provider } from '../src/cleanup/ai/types';
import { setUserValue, upgradeTargets, valuesOf, writeDecisions } from '../src/cleanup/ai/values';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { updateSettings } from '../src/cleanup/settings';
import { makeTempDir } from './helpers/spawn-server';
import { startAiStandin } from './helpers/ai-standin';

function freshDb(): Database.Database {
  const s = initCleanupDatabase(makeTempDir('wp21d-ai'));
  if (!s.ok) throw new Error(s.error);
  return s.db;
}

const T: AiField<string> = {
  name: 'title',
  fromAnswer: (a) => (typeof a.title === 'string' ? a.title : undefined),
  same: (a, b) => a.replace(/\s/g, '') === b.replace(/\s/g, ''),
  strings: (v) => [v],
};

describe('setup E per field', () => {
  const auto = { value: 'A', auto: true };
  const open = { value: 'A', auto: false, reason: 'unsure' };
  it('keeps an automatic rules value unless both models agree against it', () => {
    expect(combineE(T, auto, 'A', 'A')).toMatchObject({
      value: 'A',
      source: 'rules',
      flagged: false,
    });
    expect(combineE(T, auto, 'B', 'C')).toMatchObject({
      value: 'A',
      source: 'rules',
      flagged: false,
    });
    expect(combineE(T, auto, undefined, undefined)).toMatchObject({
      source: 'rules',
      flagged: false,
    });
    expect(combineE(T, auto, 'B', 'B')).toMatchObject({
      value: 'B',
      source: 'secondary_guess',
      flagged: true,
      reason: 'Both models disagree with the rules',
    });
    // A final rules value (the store's own data) stands even against both models.
    const final = { value: 'A', auto: true, final: true };
    expect(combineE(T, final, 'B', 'B')).toEqual({
      value: 'A',
      source: 'rules',
      flagged: false,
      reason: null,
    });
    expect(combineE(T, final, 'B', 'C')).toMatchObject({ value: 'A', flagged: false });
  });
  it('applies an open field when both models agree, otherwise the best guess (Luna, rules, unknown)', () => {
    expect(combineE(T, open, 'B', 'B ')).toMatchObject({
      value: 'B',
      source: 'both_models',
      flagged: false,
    });
    expect(combineE(T, open, 'B', 'C')).toMatchObject({
      value: 'C',
      source: 'secondary_guess',
      flagged: true,
    });
    expect(combineE(T, open, 'B', undefined)).toMatchObject({
      value: 'A',
      source: 'rules_guess',
      flagged: true,
    });
    expect(combineE(T, { value: null, auto: false }, undefined, undefined)).toMatchObject({
      value: null,
      source: 'unknown',
      flagged: true,
      reason: 'Neither model answered',
    });
    // An automatic field with no rules value is open.
    expect(combineE(T, { value: null, auto: true }, 'X', 'X')).toMatchObject({
      source: 'both_models',
    });
  });
  it('upgrades: F re-checks only flagged fields, J also open fields E agreed on', () => {
    const cheapAgainst = { primary: 'B', secondary: 'B' };
    // F: the strong pair back to the rules -> rules.
    expect(
      combineUpgrade('F', T, auto, cheapAgainst, { primary: 'A', secondary: 'A' }),
    ).toMatchObject({
      source: 'rules',
      flagged: false,
    });
    // F: all four against the rules -> still flagged (J applies it).
    expect(
      combineUpgrade('F', T, auto, cheapAgainst, { primary: 'B', secondary: 'B' }).flagged,
    ).toBe(true);
    expect(
      combineUpgrade('J', T, auto, cheapAgainst, { primary: 'B', secondary: 'B' }),
    ).toMatchObject({
      value: 'B',
      source: 'upgrade_models',
      flagged: false,
    });
    // An open field E's pair agreed on: F keeps it, J lets the strong pair decide.
    expect(
      combineUpgrade(
        'F',
        T,
        open,
        { primary: 'B', secondary: 'B' },
        { primary: 'C', secondary: 'D' },
      ),
    ).toMatchObject({
      source: 'both_models',
      value: 'B',
    });
    expect(
      combineUpgrade(
        'J',
        T,
        open,
        { primary: 'B', secondary: 'B' },
        { primary: 'C', secondary: 'D' },
      ),
    ).toMatchObject({
      source: 'secondary_guess',
      value: 'D',
      flagged: true,
    });
    expect(
      combineUpgrade(
        'F',
        T,
        open,
        { primary: 'B', secondary: 'C' },
        { primary: 'C', secondary: 'C' },
      ),
    ).toMatchObject({
      source: 'upgrade_models',
      value: 'C',
    });
  });
});

describe('never invent', () => {
  const ev = evidenceForm(
    'title: [17巻] 盾の勇者の成り上がり 17 / subtitle: 結界の魔術師 / authors: ウィリアム シェークスピア, 福 沙奈恵',
  );
  it('takes strings only from the evidence (spaces, ・ and widths ignored; joined parts allowed)', () => {
    expect(inEvidence(['盾の勇者の成り上がり１７'], ev)).toBe(true);
    expect(inEvidence(['ウィリアム・シェークスピア', '福沙奈恵'], ev)).toBe(true);
    expect(inEvidence(['盾の勇者の成り上がり 17 結界の魔術師'], ev)).toBe(true);
    expect(inEvidence(['鎧の勇者'], ev)).toBe(false);
    expect(inEvidence(['盾の勇者 新作'], ev)).toBe(false);
  });
  it('drops an invented answer and counts it', () => {
    expect(answerOf(T, { title: '盾の勇者の成り上がり17' }, ev)).toEqual({
      value: '盾の勇者の成り上がり17',
      invented: false,
    });
    expect(answerOf(T, { title: '剣の勇者' }, ev)).toEqual({ value: undefined, invented: true });
    expect(answerOf(T, { title: null }, ev)).toEqual({ value: undefined, invented: false });
  });
});

describe('prompt blocks', () => {
  it('joins katakana names with ・ and keeps (上)/(下) out of long series', () => {
    expect(NAME_FORM_RULE).toContain('ウィリアム・シェークスピア');
    expect(VOLUME_MARKER_RULE).toMatch(
      /only when the work itself is published in two or three parts/,
    );
    expect(VOLUME_MARKER_RULE).toContain('終物語(中) is not volume 2');
    const s = systemPrompt({ intro: 'Intro.', rules: ['- own rule'], answerFormat: 'JSON.' });
    expect(s.indexOf(NAME_FORM_RULE)).toBeLessThan(s.indexOf('- own rule'));
    // The Calibre-only rules are not shared.
    expect(s).not.toMatch(/omnibus|bonus/i);
  });
  it('reads the first JSON object of a text', () => {
    expect(firstJson('Sure: {"a": "}{", "b": [1, {"c": 2}]} and more {"x":1}')).toEqual({
      a: '}{',
      b: [1, { c: 2 }],
    });
    expect(firstJson('no json')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// the runner

interface Ev {
  title: string;
}
const SPEC: AiStageSpec<Ev> = {
  stage: 'test5',
  promptVersion: 't1',
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
  schemaName: 'test',
  parseAnswer: (raw) =>
    raw && typeof raw === 'object' && typeof (raw as { title?: unknown }).title === 'string'
      ? (raw as Record<string, unknown>)
      : null,
  evidenceText: (e) => evidenceForm(e.title),
};

type Behaviour = 'answer' | 'refusal' | 'content_filter' | 'bad' | 'busy' | 'bad_request';
let standin: Awaited<ReturnType<typeof startAiStandin>> | null = null;
afterEach(async () => {
  await standin?.close();
  standin = null;
});

async function setup(
  opts: {
    behaviour?: (title: string, provider: string) => Behaviour;
    batchPolls?: number;
    stallModels?: string[];
  } = {},
) {
  const tries = new Map<string, number>();
  standin = await startAiStandin({
    batchPolls: opts.batchPolls ?? 0,
    stallModels: opts.stallModels ?? [],
    anthropicKey: 'ak',
    openaiKey: 'ok',
    answer: ({ provider, user }: { provider: string; user: string }) => {
      const title = /ITEM (.*)/.exec(user)?.[1] ?? '';
      const b = opts.behaviour?.(title, provider) ?? 'answer';
      const k = `${provider}:${title}`;
      tries.set(k, (tries.get(k) ?? 0) + 1);
      if (b === 'refusal') return { kind: 'refusal' };
      if (b === 'content_filter')
        return { kind: provider === 'openai' ? 'content_filter' : 'refusal' };
      if (b === 'bad') return { kind: 'text', text: 'I think the title is unclear.' };
      if (b === 'busy')
        return tries.get(k)! <= 1
          ? { kind: 'error', status: 529 }
          : { kind: 'json', json: { title } };
      if (b === 'bad_request') return { kind: 'error', status: 400, code: 'invalid_request_error' };
      return { kind: 'json', json: { title: `${title}${provider === 'openai' ? '' : ''}` } };
    },
  });
  const db = freshDb();
  const keys: Record<string, string | null> = { anthropicApiKey: 'ak', openaiApiKey: 'ok' };
  let now = 1_800_000_000_000;
  const runner = new AiRunner({
    db,
    secrets: { read: (n) => keys[n] ?? null },
    providers: (p: Provider, key: string): ProviderClient =>
      p === 'anthropic'
        ? new AnthropicProvider(key, standin!.anthropicUrl)
        : new OpenAiProvider(key, standin!.openaiUrl),
    now: () => now,
    sleep: async () => {},
  });
  return {
    db,
    runner,
    keys,
    advance: (ms: number) => {
      now += ms;
    },
    tries,
  };
}

function items(n: number, labeled = 0) {
  return Array.from({ length: n }, (_, i) => ({
    key: `k${i}`,
    evidence: { title: `title${i}` },
    labeled: i < labeled,
  }));
}

async function runToEnd(runner: AiRunner, runId: string, advance: (ms: number) => void, max = 20) {
  let last = null;
  for (let i = 0; i < max; i++) {
    last = await runner.step(SPEC, runId, () => false);
    if (last.pending === 0) break;
    advance(61_000);
  }
  return last!;
}

describe('AI runner', () => {
  it('asks nothing until a spending limit is set', async () => {
    const { runner } = await setup();
    runner.putItems(SPEC, items(3), 1);
    runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2'], 'run1');
    const r = await runner.step(SPEC, 'run1', () => false);
    expect(r.wait).toEqual({ kind: 'no_limit' });
    expect(r.sent).toBe(0);
    expect(standin!.calls.length).toBe(0);
  });

  it('sends batches to both providers through the SDKs, collects them and counts the cost (half price)', async () => {
    const { db, runner, advance } = await setup({ batchPolls: 1 });
    updateSettings(db, {
      ai: {
        ...(await import('../src/cleanup/settings')).getSettings(db).ai,
        spendLimitUsd: 1,
        modes: {
          'claude-haiku-5-5': 'batch',
          'gpt-6-luna': 'batch',
          'gpt-6.1-sol': 'batch',
          'claude-sonnet-5-5': 'batch',
        },
      },
    });
    runner.putItems(SPEC, items(5, 2), 1);
    const keys = ['k0', 'k1', 'k2', 'k3', 'k4'];
    expect(runner.enqueue(SPEC, 'primary', keys, 'run1')).toBe(5);
    expect(runner.enqueue(SPEC, 'secondary', keys, 'run1')).toBe(5);
    const first = await runner.step(SPEC, 'run1', () => false);
    expect(first.sent).toBe(10);
    // Before the poll interval nothing is asked of the providers again.
    const again = await runner.step(SPEC, 'run1', () => false);
    expect(again.sent).toBe(0);
    expect(standin!.calls.filter((c: { poll?: boolean }) => c.poll).length).toBe(0);
    const end = await runToEnd(runner, 'run1', advance);
    expect(end.pending).toBe(0);
    expect(runner.counts('test5', 'run1')).toMatchObject({ answered: 10, queued: 0, sent: 0 });
    expect(runner.answerOf(SPEC, 'primary', 'k3')).toMatchObject({
      model: 'claude-haiku-5-5',
      state: 'answered',
      answer: { title: 'title3' },
    });
    expect(runner.answerOf(SPEC, 'secondary', 'k3')).toMatchObject({
      model: 'gpt-6-luna',
      state: 'answered',
    });
    // 4,000 in + 500 out at $0.10/$0.50 per MTok, batch half price: $0.000325 each.
    const one = costOf(
      { inputPerMTok: 0.1, outputPerMTok: 0.5 },
      { input: 4000, output: 500, cacheRead: 0, cacheWrite: 0 },
      true,
      0.5,
    );
    expect(one).toBeCloseTo(0.000325, 9);
    expect(spendNow(db).spentUsd).toBeCloseTo(one * 10, 9);
    expect(spendNow(db).reservedUsd).toBe(0);
    expect(runSpend(db, 'test5', 'run1')).toMatchObject({ items: 5 });
    expect(runner.batches('test5')).toMatchObject({ open: 0, collected: 2, failed: 0 });
    // The labeled items went first, in the structured-output format, without temperature.
    const anth = standin!.calls.find(
      (c: { path: string; provider: string }) => c.path === '/v1/messages/batches',
    );
    expect(anth.body.requests[0].params.messages[0].content).toBe('ITEM title0');
    expect(anth.body.requests[0].params.output_config.format.type).toBe('json_schema');
    expect(anth.body.requests[0].params.max_tokens).toBe(16000);
    expect('temperature' in anth.body.requests[0].params).toBe(false);
  });

  it('never asks the same evidence twice; failed questions again only in a later run; blocked never', async () => {
    const { db, runner, advance } = await setup({
      behaviour: (t) => (t === 'title0' ? 'refusal' : t === 'title1' ? 'bad_request' : 'answer'),
    });
    const { getSettings } = await import('../src/cleanup/settings');
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        spendLimitUsd: 1,
        modes: {
          'claude-haiku-5-5': 'direct',
          'gpt-6-luna': 'direct',
          'gpt-6.1-sol': 'direct',
          'claude-sonnet-5-5': 'direct',
        },
      },
    });
    runner.putItems(SPEC, items(3), 1);
    runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2'], 'run1');
    await runToEnd(runner, 'run1', advance);
    expect(runner.answerOf(SPEC, 'primary', 'k0')?.state).toBe('blocked');
    expect(runner.answerOf(SPEC, 'primary', 'k1')?.state).toBe('failed');
    const calls = standin!.calls.length;
    // Same run, same evidence: nothing new.
    expect(runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2'], 'run1')).toBe(0);
    await runToEnd(runner, 'run1', advance);
    expect(standin!.calls.length).toBe(calls);
    // A later run asks the failed one again, never the blocked one.
    runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2'], 'run2');
    await runToEnd(runner, 'run2', advance);
    const asked = standin!.calls
      .slice(calls)
      .filter((c: { path: string }) => c.path === '/v1/messages');
    expect(asked.map((c: { user: string }) => c.user)).toEqual(['ITEM title1']);
    // Changed evidence is a new question.
    runner.putItems(SPEC, [{ key: 'k2', evidence: { title: 'title2b' }, labeled: false }], 1);
    expect(runner.enqueue(SPEC, 'primary', ['k2'], 'run2')).toBe(1);
  });

  it('retries busy and server errors only, and records content blocks and bad answers as final', async () => {
    const { db, runner, advance, tries } = await setup({
      behaviour: (t) =>
        t === 'title0'
          ? 'busy'
          : t === 'title1'
            ? 'content_filter'
            : t === 'title2'
              ? 'bad'
              : 'answer',
    });
    const { getSettings } = await import('../src/cleanup/settings');
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        spendLimitUsd: 1,
        modes: {
          'claude-haiku-5-5': 'direct',
          'gpt-6-luna': 'direct',
          'gpt-6.1-sol': 'direct',
          'claude-sonnet-5-5': 'direct',
        },
      },
    });
    runner.putItems(SPEC, items(3), 1);
    runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2'], 'r');
    runner.enqueue(SPEC, 'secondary', ['k0', 'k1', 'k2'], 'r');
    await runToEnd(runner, 'r', advance);
    expect(tries.get('anthropic:title0')).toBe(2);
    expect(runner.answerOf(SPEC, 'primary', 'k0')?.state).toBe('answered');
    expect(runner.answerOf(SPEC, 'primary', 'k1')?.state).toBe('blocked');
    expect(runner.answerOf(SPEC, 'secondary', 'k1')?.state).toBe('blocked');
    expect(tries.get('openai:title1')).toBe(1);
    expect(runner.answerOf(SPEC, 'primary', 'k2')?.state).toBe('invalid');
  });

  it('stops before the spending limit and goes on when it is raised', async () => {
    const { db, runner, advance } = await setup();
    const { getSettings } = await import('../src/cleanup/settings');
    // 6 questions at about $0.0005 each (estimated from the prompt length): room for 2.
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        spendLimitUsd: 0.001,
        modes: {
          'claude-haiku-5-5': 'batch',
          'gpt-6-luna': 'batch',
          'gpt-6.1-sol': 'batch',
          'claude-sonnet-5-5': 'batch',
        },
      },
    });
    runner.putItems(SPEC, items(6), 1);
    runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2', 'k3', 'k4', 'k5'], 'r');
    const r = await runner.step(SPEC, 'r', () => false);
    expect(r.wait?.kind).toBe('limit_reached');
    expect(r.sent).toBeGreaterThan(0);
    expect(r.sent).toBeLessThan(6);
    advance(61_000);
    await runner.step(SPEC, 'r', () => false);
    const spent = spendNow(db).spentUsd;
    expect(spent).toBeLessThanOrEqual(0.001);
    const stuck = await runner.step(SPEC, 'r', () => false);
    expect(stuck.wait?.kind).toBe('limit_reached');
    updateSettings(db, { ai: { ...getSettings(db).ai, spendLimitUsd: 1 } });
    const end = await runToEnd(runner, 'r', advance);
    expect(end.pending).toBe(0);
    expect(runner.counts('test5', 'r').answered).toBe(6);
  });

  it('waits for a missing key, a refused key, an unknown model id and a model without a price', async () => {
    const { db, runner, keys } = await setup();
    const { getSettings } = await import('../src/cleanup/settings');
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        spendLimitUsd: 1,
        modes: {
          'claude-haiku-5-5': 'direct',
          'gpt-6-luna': 'direct',
          'gpt-6.1-sol': 'direct',
          'claude-sonnet-5-5': 'direct',
        },
      },
    });
    runner.putItems(SPEC, items(1), 1);
    keys.anthropicApiKey = null;
    runner.enqueue(SPEC, 'primary', ['k0'], 'r');
    expect((await runner.step(SPEC, 'r', () => false)).wait).toEqual({
      kind: 'no_key',
      provider: 'anthropic',
    });
    keys.anthropicApiKey = 'wrong';
    const refused = (await runner.step(SPEC, 'r', () => false)).wait;
    expect(refused?.kind).toBe('auth_failed');
    keys.anthropicApiKey = 'ak';
    updateSettings(db, { models: { 'audio5.primary': 'claude-haiku-9-9' } });
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        prices: {
          ...getSettings(db).ai.prices,
          'claude-haiku-9-9': { inputPerMTok: 1, outputPerMTok: 1 },
        },
      },
    });
    runner.enqueue(SPEC, 'primary', ['k0'], 'r');
    const missing = await runner.step(SPEC, 'r', () => false);
    expect(missing.wait).toMatchObject({ kind: 'model_missing', model: 'claude-haiku-9-9' });
    updateSettings(db, { models: { 'audio5.primary': 'claude-sonnet-5-5' } });
    const { prices } = getSettings(db).ai;
    const { 'claude-sonnet-5-5': _drop, ...rest } = prices;
    updateSettings(db, { ai: { ...getSettings(db).ai, prices: rest } });
    // (the question to the unknown model would be reported first)
    db.prepare(`DELETE FROM ai_requests WHERE model = 'claude-haiku-9-9'`).run();
    runner.enqueue(SPEC, 'primary', ['k0'], 'r');
    expect((await runner.step(SPEC, 'r', () => false)).wait).toEqual({
      kind: 'no_price',
      model: 'claude-sonnet-5-5',
    });
    // Model lists are read with the key and stored (Settings: Check models).
    const checked = await runner.checkModels();
    expect(checked.anthropic.models).toContain('claude-haiku-5-5');
    expect(checked.openai.models).toContain('gpt-6-luna');
  });

  it('asks each provider in its own mode: by default Anthropic by batch, OpenAI directly', async () => {
    const { db, runner } = await setup();
    const { getSettings } = await import('../src/cleanup/settings');
    expect(getSettings(db).ai.modes).toEqual({ 'gpt-6-luna': 'direct' });
    updateSettings(db, { ai: { ...getSettings(db).ai, spendLimitUsd: 1 } });
    runner.putItems(SPEC, items(3), 1);
    runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2'], 'r');
    runner.enqueue(SPEC, 'secondary', ['k0', 'k1', 'k2'], 'r');
    await runner.step(SPEC, 'r', () => false);
    const paths = standin!.calls.map((c: { path: string }) => c.path);
    expect(paths.filter((x: string) => x === '/v1/messages/batches').length).toBe(1);
    expect(paths.filter((x: string) => x === '/v1/chat/completions').length).toBe(3);
    expect(paths).not.toContain('/v1/batches');
    expect(runner.answerOf(SPEC, 'secondary', 'k2')).toMatchObject({ state: 'answered' });
  });

  for (const stuck of ['gpt-6-luna', 'claude-haiku-5-5']) {
    it(`cancels a batch nothing in it answered in batchStallMinutes and asks its questions directly (${stuck})`, async () => {
      const { db, runner, advance } = await setup({ stallModels: [stuck] });
      const { getSettings } = await import('../src/cleanup/settings');
      updateSettings(db, {
        ai: {
          ...getSettings(db).ai,
          spendLimitUsd: 1,
          modes: {
            'claude-haiku-5-5': 'batch',
            'gpt-6-luna': 'batch',
            'gpt-6.1-sol': 'batch',
            'claude-sonnet-5-5': 'batch',
          },
          batchStallMinutes: 2,
        },
      });
      runner.putItems(SPEC, items(3), 1);
      runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2'], 'r');
      runner.enqueue(SPEC, 'secondary', ['k0', 'k1', 'k2'], 'r');
      expect((await runner.step(SPEC, 'r', () => false)).sent).toBe(6);
      // One minute: the other provider's batch is in; the stuck one isn't cancelled yet.
      advance(61_000);
      await runner.step(SPEC, 'r', () => false);
      expect(standin!.calls.some((c: { cancel?: boolean }) => c.cancel)).toBe(false);
      // Two minutes with nothing answered: cancelled.
      advance(61_000);
      await runner.step(SPEC, 'r', () => false);
      expect(standin!.calls.filter((c: { cancel?: boolean }) => c.cancel).length).toBe(1);
      expect(runner.batches('test5').stalled).toBe(1);
      // Next check: cancelled at the provider; its questions are asked directly at once.
      advance(61_000);
      const r = await runner.step(SPEC, 'r', () => false);
      expect(r.pending).toBe(0);
      const role = stuck === 'gpt-6-luna' ? 'secondary' : 'primary';
      for (const k of ['k0', 'k1', 'k2'])
        expect(runner.answerOf(SPEC, role, k)?.state).toBe('answered');
      const direct = standin!.calls.filter(
        (c: { path: string }) => c.path === '/v1/chat/completions' || c.path === '/v1/messages',
      );
      expect(direct.length).toBe(3);
      const modes = db
        .prepare(`SELECT DISTINCT mode FROM ai_requests WHERE model = ?`)
        .all(stuck) as { mode: string }[];
      expect(modes.map((m) => m.mode)).toEqual(['direct']);
      // The stalled batch is kept out of the measured turnaround.
      expect(runner.batches('test5')).toMatchObject({ collected: 1, stalled: 1, open: 0 });
    });
  }

  it('"Test batch" shows whether and how fast a provider runs batches for a model', async () => {
    const { db, runner, advance } = await setup({ stallModels: ['gpt-6-luna'] });
    const { getSettings } = await import('../src/cleanup/settings');
    await expect(runner.testBatch('claude-haiku-5-5')).rejects.toThrow(/spending limit/);
    updateSettings(db, { ai: { ...getSettings(db).ai, spendLimitUsd: 1, batchStallMinutes: 2 } });
    await runner.testBatch('claude-haiku-5-5');
    await runner.testBatch('gpt-6-luna');
    await expect(runner.testBatch('gpt-6-luna')).rejects.toThrow(/already running/);
    expect(runner.batchTests()['gpt-6-luna'].state).toBe('open');
    advance(61_000);
    await runner.pollBatchTests();
    expect(runner.batchTests()['claude-haiku-5-5']).toMatchObject({
      state: 'answered',
      detail: 'answered in 61 s',
    });
    expect(runner.batchTests()['gpt-6-luna'].state).toBe('open');
    advance(61_000);
    await runner.pollBatchTests();
    expect(runner.batchTests()['gpt-6-luna']).toMatchObject({ state: 'nothing' });
    expect(runner.batchTests()['gpt-6-luna'].detail).toMatch(/^nothing answered in 2 min/);
    expect(standin!.calls.filter((c: { cancel?: boolean }) => c.cancel).length).toBe(1);
    // The test's cost counts against the limit.
    expect(spendNow(db).spentUsd).toBeGreaterThan(0);
  });

  it('only labeled items are asked when labeledOnly is set', async () => {
    const { db, runner, advance } = await setup();
    const { getSettings } = await import('../src/cleanup/settings');
    updateSettings(db, { ai: { ...getSettings(db).ai, spendLimitUsd: 1, labeledOnly: true } });
    runner.putItems(SPEC, items(4, 1), 1);
    runner.enqueue(SPEC, 'primary', ['k0', 'k1', 'k2', 'k3'], 'r');
    await runner.step(SPEC, 'r', () => false);
    advance(61_000);
    await runner.step(SPEC, 'r', () => false);
    expect(runner.answerOf(SPEC, 'primary', 'k0')?.state).toBe('answered');
    expect(runner.answerOf(SPEC, 'primary', 'k1')).toBeNull();
    // Unlabeled questions queued earlier never hold the stage (live stop 1, 2026-11-19).
    const r = await runner.step(SPEC, 'r', () => false);
    expect(r.pending).toBe(0);
    expect(runner.counts(SPEC.stage, 'r')).toMatchObject({ queued: 0, answered: 1 });
    updateSettings(db, { ai: { ...getSettings(db).ai, labeledOnly: false } });
    expect(runner.pending(SPEC.stage, 'r')).toBe(3);
  });
});

describe('values: sources, user values, upgrades', () => {
  it('never replaces a user value and re-checks only what the models decided or guessed', () => {
    const db = freshDb();
    const d = (value: unknown, source: string, flagged = false) => ({
      decision: { value, source: source as never, flagged, reason: null },
      rules: { value: 'r', auto: source === 'rules' },
      primary: 'p',
      secondary: 's',
      evidenceHash: 'h',
    });
    writeDecisions(
      db,
      'x',
      [
        { itemKey: 'a', field: 'title', ...d('T', 'rules') },
        { itemKey: 'a', field: 'authors', ...d(['A'], 'both_models') },
        { itemKey: 'a', field: 'series', ...d([], 'secondary_guess', true) },
        { itemKey: 'b', field: 'title', ...d('U', 'rules_guess', true) },
      ],
      'E',
      1,
    );
    setUserValue(db, 'x', 'b', 'title', 'Mine', 2);
    writeDecisions(
      db,
      'x',
      [{ itemKey: 'b', field: 'title', ...d('Later', 'both_models') }],
      'E',
      3,
    );
    const b = valuesOf(db, 'x', 'b')[0];
    expect(b).toMatchObject({ value: 'Mine', source: 'user', flagged: false, userAt: 2 });
    expect(b.primary).toBe('p');
    expect(upgradeTargets(db, 'x', 'F')).toEqual([{ itemKey: 'a', field: 'series' }]);
    expect(upgradeTargets(db, 'x', 'J')).toEqual([
      { itemKey: 'a', field: 'authors' },
      { itemKey: 'a', field: 'series' },
    ]);
  });
});
