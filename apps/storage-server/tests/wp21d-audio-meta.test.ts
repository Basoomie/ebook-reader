/**
 * WP21d: audiobook stage 5 (metadata decisions). The rules on the live cases of the labeled
 * books; the stage through the service and the routes with the AI stand-in (setup E: both
 * models, record choice for review units, never invent, a blocked answer); restarts asking
 * nothing again; a rules change decided again without asking; a user value kept; the spending
 * limit pausing the stage on the page; labeled-only; On refused; EXPLAIN of every polled query.
 */
import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicProvider, OpenAiProvider } from '../src/cleanup/ai/providers';
import { setUserValue, valuesOf } from '../src/cleanup/ai/values';
import { onAudioStagePaused, getAudioStage } from '../src/cleanup/audio/audio-stages';
import { EvidenceBuilder } from '../src/cleanup/audio/meta-evidence';
import { cleanStoreTitle, metaRules, recordAuthors } from '../src/cleanup/audio/meta-rules';
import { META_SYSTEM, metaUserText } from '../src/cleanup/audio/meta-prompt';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { startAiStandin } from './helpers/ai-standin';
import { liveCases, liveLabels, seedStage4, type SeedUnit } from './helpers/audio-meta-seed';
import { makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';

function freshDb(): Database.Database {
  const s = initCleanupDatabase(makeTempDir('wp21d-meta'));
  if (!s.ok) throw new Error(s.error);
  return s.db;
}

function evidence(db: Database.Database, key: string) {
  const u = EvidenceBuilder.units(db, 's4-test').find((x) => x.unit_key === key)!;
  return new EvidenceBuilder(db).build(u);
}

describe('stage 5 rules on the live cases', () => {
  const db = freshDb();
  seedStage4(db, liveCases());
  const rules = (key: string) => {
    const ev = evidence(db, key);
    return metaRules(ev, ev.record, ev.stage4.class === 'auto' && ev.kind === 'record');
  };

  it('titles: Audible prefixes, imprints, a publisher after a colon and ＜collections＞ out; ＜上＞ kept', () => {
    expect(
      cleanStoreTitle('[4巻] やはり俺の青春ラブコメはまちがっている。４（ガガガ文庫）: （小学館）'),
    ).toBe('やはり俺の青春ラブコメはまちがっている。4');
    expect(cleanStoreTitle('精霊幻想記　3.決別の鎮魂歌 HJ文庫(ホビージャパン)')).toBe(
      '精霊幻想記 3.決別の鎮魂歌',
    );
    expect(cleanStoreTitle('夏に溺れる　ガガガ文庫')).toBe('夏に溺れる');
    expect(cleanStoreTitle('鏡　＜田中芳樹短篇小説＞')).toBe('鏡');
    expect(cleanStoreTitle('[5巻・下] ウィザーズ・ブレインV 賢人の庭＜下＞')).toBe(
      'ウィザーズ・ブレインV 賢人の庭＜下＞',
    );
    expect(cleanStoreTitle('掟上今日子の備忘録（文庫版）')).toBe('掟上今日子の備忘録');
    expect(rules('u:cop').title).toMatchObject({ value: 'コップクラフト5', auto: true });
  });

  it('authors: translators out by the description, foreign + Japanese name open, 原作 kept, companies out', () => {
    expect(rules('u:genji').authors).toEqual({ value: ['紫式部'], auto: true, reason: null });
    expect(rules('u:homo').authors).toMatchObject({
      value: ['ユヴァル・ノア・ハラリ', '柴田裕之'],
      auto: false,
    });
    expect(rules('u:holmes').authors).toEqual({
      value: ['アーサー・コナン・ドイル'],
      auto: true,
      reason: null,
    });
    expect(rules('u:melos').authors).toMatchObject({ value: [], auto: false });
    expect(
      recordAuthors({
        ...evidence(db, 'u:genji').record!,
        authors: ['著/藤咲 あゆな', '原作/堀田 敦子'],
        description: '',
      }).value,
    ).toEqual(['藤咲あゆな', '堀田敦子']);
    expect(
      recordAuthors({
        ...evidence(db, 'u:genji').record!,
        authors: ['ヨースタイン・ゴルデル（著）', '須田 朗（監修）', '池田 香代子（訳）'],
        description: '',
      }),
    ).toEqual({ value: ['ヨースタイン・ゴルデル'], auto: true, reason: null });
    // でじじ is Pan Rolling's store, never an author (T037 日本国憲法; アイヌ神話 keeps 中田千畝).
    const panRolling = {
      ...evidence(db, 'u:genji').record!,
      publisher: 'パンローリング株式会社',
      description: '',
    };
    expect(recordAuthors({ ...panRolling, authors: ['でじじ'] })).toMatchObject({
      value: [],
      auto: false,
    });
    expect(recordAuthors({ ...panRolling, authors: ['中田 千畝', 'でじじ'] })).toEqual({
      value: ['中田千畝'],
      auto: true,
      reason: null,
    });
  });

  it('series: Audible position, odd labels and short names open, drama CDs twice, imprints never', () => {
    expect(rules('u:genji').series).toMatchObject({
      value: [{ name: '源氏物語', position: 8 }],
      auto: true,
    });
    expect(rules('u:sawazaki').series.auto).toBe(false);
    expect(rules('u:hoshi').series).toMatchObject({
      auto: false,
      reason: expect.stringMatching(/short series name/),
    });
    expect(rules('u:honzuki6').series).toMatchObject({
      auto: true,
      value: [
        { name: '本好きの下剋上 ドラマCD', position: 6 },
        { name: '本好きの下剋上', position: null, label: 'drama' },
      ],
    });
    expect(rules('u:cop').series).toEqual({ value: [], auto: true });
    expect(rules('u:honzuki6').drama).toEqual({ value: true, auto: true });
    expect(rules('u:melos').drama.value).toBe(true);
  });

  it('records not confirmed, no record, AI books: open, from the names', () => {
    const r = rules('u:arslan2');
    expect(r.record).toMatchObject({ value: 'kikubon:19', auto: false });
    expect(r.title.auto).toBe(false);
    const ai = rules('u:ai');
    expect(ai.series).toMatchObject({
      value: [{ name: '薬屋のひとりごと', position: 4 }],
      auto: false,
    });
    expect(ai.title).toMatchObject({ value: '薬屋のひとりごと4', auto: false });
    expect(rules('u:naomi').title).toMatchObject({ value: 'ナオミとカナコ', auto: false });
  });

  it('the prompt carries the confirmed rules and the evidence, never a label', () => {
    expect(META_SYSTEM).toContain('ウィリアム・シェークスピア');
    expect(META_SYSTEM).toMatch(/柴田裕之 is the\s+translator/);
    expect(META_SYSTEM).toMatch(/ドラマCD" with its number AND in "X" with\s+position null/);
    expect(META_SYSTEM).not.toMatch(/omnibus|N\.1/);
    const text = metaUserText(evidence(db, 'u:arslan2'));
    expect(text).toContain('## Store records to choose from');
    expect(text).toContain('id: kikubon:19');
    expect(text).toContain('id: kikubon:20');
  });
});

// ---------------------------------------------------------------------------------------------
// the stage through the service and the routes

type Ans = Record<string, unknown> | 'block' | 'bad';
/** Answers per unit name: [Haiku's, Luna's]. */
function answers(): Record<string, [Ans, Ans]> {
  const same = (a: Record<string, unknown>): [Ans, Ans] => [a, a];
  return {
    '源氏物語 第八帖 花宴': same({
      title: '源氏物語 第八帖 花宴',
      authors: ['紫式部'],
      narrators: ['岡崎弥保'],
      series: [{ name: '源氏物語', position: 8, label: '8' }],
      drama: false,
    }),
    'ホモ・デウス 上': same({
      title: 'ホモ・デウス 上',
      authors: ['ユヴァル・ノア・ハラリ'],
      narrators: ['金子由之'],
      series: [],
      drama: false,
    }),
    私が殺した少女: same({
      title: '私が殺した少女',
      authors: ['原りょう'],
      narrators: ['大塚明夫'],
      series: [{ name: '探偵・沢崎シリーズ', position: 2, label: '2' }],
      drama: false,
    }),
    'アルスラーン戦記2 王子二人': same({
      record: 'kikubon:19',
      title: 'アルスラーン戦記2 王子二人',
      authors: ['田中芳樹'],
      narrators: ['下山吉光'],
      series: [{ name: 'アルスラーン戦記', position: 2, label: '2' }],
      drama: false,
    }),
    迷子の録音: [
      { record: 'audible:B0MAYOIA01', title: '迷子の録音 1' },
      { record: 'audible:B0MAYOIA02', title: '迷子の録音 2' },
    ],
    // 奥田英朗 is not in the evidence: never invented.
    ナオミとカナコ: [
      { title: 'ナオミとカナコ', authors: ['奥田英朗'], narrators: ['千衣子', '桜木繭子'] },
      { title: 'ナオミとカナコ', authors: [], narrators: ['千衣子', '桜木繭子'] },
    ],
    薬屋のひとりごと４: same({
      title: '薬屋のひとりごと4',
      authors: ['日向夏'],
      series: [{ name: '薬屋のひとりごと', position: 4, label: '4' }],
    }),
    'ざこラジ 第1回': [{ title: 'ざこラジ 第1回' }, 'block'],
    '走れメロス ドラマCD': same({
      title: '名作文学（笑）シリーズ 走れメロス',
      authors: [],
      drama: true,
    }),
    星を編む: same({
      title: '星を編む',
      authors: ['凪良ゆう'],
      series: [{ name: '星', position: 2, label: '2' }],
    }),
    コップクラフト５: ['bad', { title: 'コップクラフト5', authors: ['賀東招二'] }],
  };
}

let standin: Awaited<ReturnType<typeof startAiStandin>> | null = null;
let env: CleanupEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  await standin?.close();
  standin = null;
});

async function makeStage(units: SeedUnit[] = liveCases()) {
  const table = answers();
  standin = await startAiStandin({
    answer: ({ provider, user }: { provider: string; user: string }) => {
      const name = /^name: (.*)$/m.exec(user)?.[1] ?? '';
      const pair = table[name];
      const a = pair?.[provider === 'anthropic' ? 0 : 1];
      if (!a) return { kind: 'json', json: {} };
      if (a === 'block') return { kind: provider === 'openai' ? 'content_filter' : 'refusal' };
      if (a === 'bad') return { kind: 'text', text: 'Not sure.' };
      return {
        kind: 'json',
        json: {
          record: null,
          title: null,
          authors: null,
          narrators: null,
          series: null,
          drama: null,
          confidence: {},
          ...a,
        },
      };
    },
  });
  const labels = JSON.stringify(liveLabels(units));
  const made = await makeCleanupEnv({
    audio: {
      aiProviders: (p, key) =>
        p === 'anthropic'
          ? new AnthropicProvider(key, standin!.anthropicUrl)
          : new OpenAiProvider(key, standin!.openaiUrl),
      readLabels: () => ({ text: labels, error: null }),
    },
  });
  await made.setup();
  env = made.env;
  const db = env.cleanupDb;
  seedStage4(db, units);
  env.service.secrets.put('anthropicApiKey', 'sk-ant-test-0000', Date.now());
  env.service.secrets.put('openaiApiKey', 'sk-openai-test-0000', Date.now());
  return { env, db, token: env.userToken() };
}

async function untilDone(e: CleanupEnv, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    await e.audio!.tick();
    const p = e.audio!.stage5.progress();
    if (p?.phase === 'done') return p;
    if (Date.now() - t0 > ms) throw new Error(`stage 5 still ${p?.phase}: ${p?.wait}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

const value = (db: Database.Database, key: string, field: string) =>
  valuesOf(db, 'audio5', key).find((v) => v.field === field)!;

describe('stage 5 through the service', () => {
  it('runs as Preview from the routes: setup E per field, the record choice, never invent, the gate', async () => {
    const { env: e, db, token } = await makeStage();
    const api = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    // On is refused; nothing is asked before a spending limit is set.
    const on = await api(request(e.app).put('/api/v1/cleanup/audio/stages/5')).send({ mode: 'on' });
    expect(on.status).toBe(400);
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        modes: {
          'claude-haiku-5-5': 'direct',
          'gpt-6-luna': 'direct',
          'gpt-6.1-sol': 'direct',
          'claude-sonnet-5-5': 'direct',
        },
      },
    });
    expect(
      (await api(request(e.app).put('/api/v1/cleanup/audio/stages/5')).send({ mode: 'analyse' }))
        .status,
    ).toBe(200);
    for (let i = 0; i < 20 && e.audio!.stage5.progress()?.phase !== 'models'; i++) {
      await e.audio!.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    for (let i = 0; i < 5; i++) {
      await e.audio!.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    const waiting = (await api(request(e.app).get('/api/v1/cleanup/audio/status'))).body.stage5;
    expect(waiting.progress.phase).toBe('models');
    expect(waiting.waiting).toBe('Set a spending limit first (Settings > AI)');
    expect(getAudioStage(db, 5).pauseReason).toBe('ai');
    expect(
      standin!.calls.filter((c: { path: string }) => /messages|completions/.test(c.path)).length,
    ).toBe(0);

    updateSettings(db, { ai: { ...getSettings(db).ai, spendLimitUsd: 1 } });
    const p = await untilDone(e);
    expect(p.error).toBeNull();
    expect(getAudioStage(db, 5).pauseReason).toBeNull();
    // Both models read every recording (13 units x 2), each once.
    const asked = standin!.calls.filter(
      (c: { path: string }) => c.path === '/v1/messages' || c.path === '/v1/chat/completions',
    );
    expect(asked.length).toBe(26);
    expect(
      new Set(asked.map((c: { user: string; provider: string }) => c.provider + c.user)).size,
    ).toBe(26);

    // Rules kept where both models agree with them; open fields both agreed on are applied.
    expect(value(db, 'u:genji', 'authors')).toMatchObject({
      value: ['紫式部'],
      source: 'rules',
      flagged: false,
    });
    expect(value(db, 'u:homo', 'authors')).toMatchObject({
      value: ['ユヴァル・ノア・ハラリ'],
      source: 'both_models',
    });
    expect(value(db, 'u:sawazaki', 'series')).toMatchObject({
      value: [{ name: '探偵・沢崎シリーズ', position: 2 }],
      source: 'both_models',
    });
    expect(value(db, 'u:hoshi', 'series')).toMatchObject({ source: 'both_models' });
    // A review unit: both picked kikubon 19, so the record and its fields are applied.
    expect(value(db, 'u:arslan2', 'record')).toMatchObject({
      value: 'kikubon:19',
      source: 'both_models',
      flagged: false,
    });
    expect(value(db, 'u:arslan2', 'series')).toMatchObject({
      value: [{ name: 'アルスラーン戦記', position: 2 }],
      source: 'rules',
    });
    expect(value(db, 'u:arslan2', 'publisher')).toMatchObject({
      value: 'らいおんbooks',
      source: 'rules',
      flagged: false,
    });
    // The models disagree on the record: Luna's pick, unconfirmed; its fields flagged with it.
    expect(value(db, 'u:unsure', 'record')).toMatchObject({
      value: 'audible:B0MAYOIA02',
      source: 'secondary_guess',
      flagged: true,
    });
    expect(value(db, 'u:unsure', 'store_id')).toMatchObject({
      value: 'audible:B0MAYOIA02',
      source: 'rules_guess',
      flagged: true,
    });
    // Never invent: 奥田英朗 is in no evidence, so only Luna's [] answered.
    expect(value(db, 'u:naomi', 'authors')).toMatchObject({
      source: 'secondary_guess',
      flagged: true,
      value: [],
    });
    expect(value(db, 'u:naomi', 'narrators')).toMatchObject({
      value: ['千衣子', '桜木繭子'],
      source: 'both_models',
    });
    expect(value(db, 'u:naomi', 'multi_narr')).toMatchObject({
      value: true,
      source: 'both_models',
    });
    expect(p.invented).toBeGreaterThanOrEqual(2);
    // AI book: the series both models parsed from the names.
    expect(value(db, 'u:ai', 'series')).toMatchObject({
      value: [{ name: '薬屋のひとりごと', position: 4 }],
      source: 'both_models',
    });
    expect(value(db, 'u:ai', 'store_id')).toMatchObject({
      value: null,
      source: 'unknown',
      flagged: false,
    });
    // A blocked answer is final: the radio clip's title is Luna-less, so the rules' guess.
    expect(value(db, 'u:radio', 'title')).toMatchObject({ source: 'rules_guess', flagged: true });
    const blocked = db
      .prepare(`SELECT state FROM ai_requests WHERE item_key = 'u:radio' AND model = 'gpt-6-luna'`)
      .get() as { state: string };
    expect(blocked.state).toBe('blocked');
    // Haiku's bad answer is invalid; the rules' automatic title stays.
    expect(value(db, 'u:cop', 'title')).toMatchObject({
      value: 'コップクラフト5',
      source: 'rules',
    });

    // The gate: every field on the labeled books, automatic values only.
    expect(p.gate!.passed).toBe(true);
    expect(p.gate!.fields.title.auto).toBeGreaterThan(5);
    expect(p.gate!.misses).toEqual([]);
    expect(p.cost!.costUsd).toBeGreaterThan(0);
    expect(p.cost!.items).toBe(13);

    // The lists and the AI status.
    const flagged = await api(request(e.app).get('/api/v1/cleanup/audio/meta?list=flagged'));
    expect(flagged.status).toBe(200);
    expect(flagged.body.items.map((x: { unitKey: string }) => x.unitKey)).toContain('u:unsure');
    const byField = await api(
      request(e.app).get('/api/v1/cleanup/audio/meta?list=field:authors:both_models'),
    );
    expect(byField.body.items.map((x: { unitKey: string }) => x.unitKey).sort()).toEqual([
      'u:homo',
      'u:melos',
    ]);
    expect((await api(request(e.app).get('/api/v1/cleanup/audio/meta?list=nope'))).status).toBe(
      400,
    );
    const ai = await api(request(e.app).get('/api/v1/cleanup/ai/status'));
    expect(ai.body.keys).toEqual({ anthropic: true, openai: true });
    expect(ai.body.spend.limitUsd).toBe(1);
    expect(JSON.stringify(ai.body)).not.toContain('sk-ant-test');
    const check = await api(request(e.app).post('/api/v1/cleanup/ai/models/check'));
    expect(check.status).toBe(200);
    expect(
      check.body.tasks.find((t: { task: string }) => t.task === 'audio5.secondary'),
    ).toMatchObject({ model: 'gpt-6-luna', checked: true });
    const status = (await api(request(e.app).get('/api/v1/cleanup/audio/status'))).body.stage5;
    expect(status.progress.phase).toBe('done');
    expect(status.secondsLeft).toBe(0);
  });

  it('a restart and a re-analysis ask nothing again; a rules change decides again; a user value stays', async () => {
    const { env: e, db } = await makeStage();
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        modes: {
          'claude-haiku-5-5': 'direct',
          'gpt-6-luna': 'direct',
          'gpt-6.1-sol': 'direct',
          'claude-sonnet-5-5': 'direct',
        },
        spendLimitUsd: 1,
      },
    });
    e.audio!.setMode(5, 'analyse');
    await untilDone(e);
    const asked = () =>
      standin!.calls.filter(
        (c: { path: string }) => c.path === '/v1/messages' || c.path === '/v1/chat/completions',
      ).length;
    const n = asked();
    setUserValue(db, 'audio5', 'u:cop', 'title', 'コップクラフト 5 (mine)', Date.now());
    e.audio!.reanalyse(5);
    const p = await untilDone(e);
    expect(asked()).toBe(n);
    expect(value(db, 'u:cop', 'title')).toMatchObject({
      value: 'コップクラフト 5 (mine)',
      source: 'user',
    });
    // A rules setting changes: decided again from the stored answers.
    updateSettings(db, { audiobooks: { ...getSettings(db).audiobooks, multiNarratorMin: 3 } });
    await e.audio!.tick();
    const again = await untilDone(e);
    expect(again.analysisId).toBe(p.analysisId);
    expect(asked()).toBe(n);
    expect(value(db, 'u:hoshi', 'multi_narr').value).toBe(false);
    // Changed models ask again (only the new model).
    updateSettings(db, { models: { 'audio5.secondary': 'gpt-6.1-sol' } });
    await e.audio!.tick();
    await untilDone(e);
    const later = standin!.calls
      .filter((c: { path: string }) => c.path === '/v1/chat/completions')
      .slice(-13);
    expect(asked()).toBe(n + 13);
    expect(later.every((c: { model: string }) => c.model === 'gpt-6.1-sol')).toBe(true);
  });

  it('pauses on the page when the spending limit is reached and goes on when it is raised', async () => {
    const { env: e, db } = await makeStage();
    const paused: string[] = [];
    const off = onAudioStagePaused((stage, reason) => paused.push(`${stage}:${reason}`));
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        modes: {
          'claude-haiku-5-5': 'direct',
          'gpt-6-luna': 'direct',
          'gpt-6.1-sol': 'direct',
          'claude-sonnet-5-5': 'direct',
        },
        spendLimitUsd: 0.002,
      },
    });
    e.audio!.setMode(5, 'analyse');
    for (let i = 0; i < 60 && getAudioStage(db, 5).pauseReason !== 'ai'; i++) {
      await e.audio!.tick();
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(getAudioStage(db, 5).pauseDetail).toMatch(/^Spending limit reached/);
    expect(paused).toContain('5:ai');
    const spent = (db.prepare('SELECT SUM(cost_usd) AS c FROM ai_requests').get() as { c: number })
      .c;
    expect(spent).toBeLessThanOrEqual(0.002);
    updateSettings(db, { ai: { ...getSettings(db).ai, spendLimitUsd: 1 } });
    const p = await untilDone(e);
    expect(p.error).toBeNull();
    expect(getAudioStage(db, 5).pauseReason).toBeNull();
    off();
  });

  it('asks only about the labeled books when labeledOnly is set (the others decided by the rules)', async () => {
    const { env: e, db } = await makeStage();
    updateSettings(db, {
      ai: {
        ...getSettings(db).ai,
        modes: {
          'claude-haiku-5-5': 'direct',
          'gpt-6-luna': 'direct',
          'gpt-6.1-sol': 'direct',
          'claude-sonnet-5-5': 'direct',
        },
        spendLimitUsd: 1,
        labeledOnly: true,
      },
    });
    e.audio!.setMode(5, 'analyse');
    await untilDone(e);
    const users = standin!.calls
      .filter((c: { path: string }) => c.path === '/v1/messages')
      .map((c: { user: string }) => /^name: (.*)$/m.exec(c.user)?.[1]);
    expect(users).not.toContain('迷子の録音');
    expect(users).toContain('私が殺した少女');
    expect(value(db, 'u:unsure', 'record')).toMatchObject({ source: 'rules_guess', flagged: true });
    expect(value(db, 'u:holmes', 'authors')).toMatchObject({ source: 'rules', flagged: false });
  });
});

describe('cleanup.db v13', () => {
  it('every polled and paged query uses an index', () => {
    const db = freshDb();
    const plans: [string, string][] = [
      [
        `SELECT model, COUNT(*) AS n FROM ai_requests WHERE run_id = 'r' AND stage = 'audio5' AND state = 'queued' GROUP BY model`,
        'ai_requests_run',
      ],
      [
        `SELECT id FROM ai_requests WHERE run_id = 'r' AND stage = 'audio5' AND state = 'queued' AND model = 'm' ORDER BY labeled DESC, id LIMIT 5`,
        'ai_requests_run',
      ],
      [
        `SELECT state, COUNT(*) AS n FROM ai_requests WHERE run_id = 'r' AND stage = 'audio5' GROUP BY state`,
        'ai_requests_run',
      ],
      [
        `SELECT state, answer_json FROM ai_requests WHERE stage = 'audio5' AND item_key = 'k' AND model = 'm' AND prompt_version = 'p' AND evidence_hash = 'h'`,
        'sqlite_autoindex_ai_requests_1',
      ],
      [`SELECT id FROM ai_requests WHERE batch_id = 'b' AND state = 'sent'`, 'ai_requests_batch'],
      [
        `SELECT input_tokens FROM ai_requests WHERE model = 'm' AND state IN ('answered', 'invalid', 'blocked') AND input_tokens IS NOT NULL ORDER BY id DESC LIMIT 50`,
        'ai_requests_model',
      ],
      [
        `SELECT id FROM ai_batches WHERE state = 'submitted' AND stage = 'audio5' AND COALESCE(checked_at, submitted_at) <= 1`,
        'ai_batches_state',
      ],
      [
        `SELECT unit_key FROM audio_meta_units WHERE analysis_id = 'a' AND state IN ('evidence', 'asking') ORDER BY labeled DESC, unit_key LIMIT 200`,
        'audio_meta_units_state',
      ],
      [
        `SELECT unit_key FROM audio_meta_units m WHERE m.analysis_id = 'a' AND m.flagged > 0 ORDER BY m.flagged DESC, m.unit_key LIMIT 50`,
        'audio_meta_units_flagged',
      ],
      [
        `SELECT unit_key FROM audio_meta_units m WHERE m.analysis_id = 'a' AND m.kind = 'no_record' ORDER BY m.unit_key LIMIT 50`,
        'audio_meta_units_kind',
      ],
      [
        `SELECT unit_key FROM audio_meta_units m WHERE m.analysis_id = 'a' AND m.labeled = 1 ORDER BY m.unit_key LIMIT 50`,
        'audio_meta_units_labeled',
      ],
      [
        `SELECT * FROM ai_values WHERE stage = 'audio5' AND item_key = 'k' ORDER BY field`,
        'sqlite_autoindex_ai_values_1',
      ],
      [
        `SELECT item_key FROM ai_values WHERE stage = 'audio5' AND field = 'title' AND source = 'rules'`,
        'ai_values_field',
      ],
      [
        `SELECT evidence_hash FROM ai_items WHERE stage = 'audio5' AND item_key = 'k'`,
        'sqlite_autoindex_ai_items_1',
      ],
    ];
    for (const [sql] of plans) {
      const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
      expect(plan, sql).toMatch(/USING (COVERING )?INDEX|PRIMARY KEY/);
      expect(plan, sql).not.toMatch(/SCAN (ai_|audio_meta|m\b)/);
    }
  });
});
