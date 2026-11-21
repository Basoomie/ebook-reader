/**
 * WP20e: Calibre stage 4's AI check and the two fixes from the WP20d run, as pure functions:
 * the check "changed in Calibre after the cleanup wrote it" per field, Bookmeter's edition
 * check, setup E per field against the stage-4 rules (the series' "no series" a real answer,
 * never invent), and the proposals built from the decided values (an unconfirmed guess is
 * written but marked; the guards still send a value to review; a user value wins).
 */
import { describe, expect, it } from 'vitest';
import { evidenceForm } from '../src/cleanup/ai/combine';
import { decideStage4Ai, decisionRows, storedAiValues } from '../src/cleanup/stage4/ai-decide';
import { scoreAiGate } from '../src/cleanup/stage4/ai-gate';
import {
  STAGE4_SCHEMA,
  STAGE4_SYSTEM,
  parseStage4Answer,
  stage4Evidence,
  stage4UserText,
} from '../src/cleanup/stage4/ai-prompt';
import { proposeStage4, stillAsWritten } from '../src/cleanup/stage4/proposals';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import type { Stage4Decision } from '../src/cleanup/stage4/stage4-rules';
import { acceptBookmeter, editionNotes } from '../src/cleanup/stage4/store-links';
import { writeDecisions, setUserValue } from '../src/cleanup/ai/values';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import type { Stage2Book } from '../src/cleanup/stage2-snapshot';
import { makeTempDir } from './helpers/spawn-server';

describe('changed in Calibre after the cleanup wrote it', () => {
  const cover = (o: Record<string, unknown>) => ({
    hasCover: true,
    now: { sha256: 'aa', dhash: '0000000000000000' },
    fileDhash: '0000000000000000',
    sameDistance: 5,
    lastModified: '2026-11-15 21:00:51.854895+00:00',
    writtenLastModified: '2026-11-15T21:00:51.854895+00:00',
    ...o,
  });
  it('compares identifiers whatever the key order (3,578 store-link items were sent to review)', () => {
    expect(
      stillAsWritten(
        'identifiers',
        { isbn: '1', google: 'g', amazon_jp: 'B0' },
        { amazon_jp: 'B0', google: 'g', isbn: '1' },
      ),
    ).toBe(true);
    expect(stillAsWritten('identifiers', { isbn: '1' }, { isbn: '2' })).toBe(false);
    expect(stillAsWritten('identifiers', { isbn: '1' }, { isbn: '1', bookmeter: '9' })).toBe(false);
  });
  it('compares names ignoring case, as the write path does', () => {
    expect(stillAsWritten('authors', ['Abc'], ['abc'])).toBe(true);
    expect(stillAsWritten('authors', ['A', 'B'], ['B', 'A'])).toBe(false);
    expect(stillAsWritten('title', 'X', 'X')).toBe(true);
  });
  it("compares the cover by Calibre's cover.jpg, not the has_cover flag (1,081 covers)", () => {
    const jpeg = { sha256: 'aa', mediaType: 'image/jpeg' };
    // The old check compared this object with `true`: every cover looked changed.
    expect(stillAsWritten('cover', jpeg, true, cover({}))).toBe(true);
    expect(stillAsWritten('cover', jpeg, true, cover({ now: { sha256: 'bb', dhash: null } }))).toBe(
      false,
    );
    expect(stillAsWritten('cover', jpeg, true, cover({ hasCover: false }))).toBe(false);
    expect(stillAsWritten('cover', jpeg, true, cover({ now: null }))).toBe(false);
    // Calibre converts other types to JPEG: the same picture, or nothing written since.
    const gif = { sha256: 'aa', mediaType: 'image/gif' };
    const converted = { sha256: 'cc', dhash: 'ffffffffffffffff' };
    expect(
      stillAsWritten(
        'cover',
        gif,
        true,
        cover({ now: { sha256: 'cc', dhash: '0000000000000001' } }),
      ),
    ).toBe(true);
    expect(stillAsWritten('cover', gif, true, cover({ now: converted }))).toBe(true);
    expect(
      stillAsWritten(
        'cover',
        gif,
        true,
        cover({ now: converted, lastModified: '2026-11-16 10:00:00+00:00' }),
      ),
    ).toBe(false);
  });
});

describe("Bookmeter's edition check", () => {
  const hit = (id: string, title: string) => ({ id, title, authors: ['多湖輝'], pages: 100 });
  it('finds edition notes, not volume numbers or store bonuses', () => {
    expect(editionNotes('【大活字シリーズ】悪の説得術')).toEqual(['大活字シリーズ']);
    expect(editionNotes('魔女の旅々【3】')).toEqual([]);
    expect(editionNotes('聖なる魔女と悪魔の騎士１【イラスト特典付き】')).toEqual([]);
    expect(editionNotes('危ない恋【新装版・イラスト三枚入り】')).toEqual([
      '新装版・イラスト三枚入り',
    ]);
  });
  it("rejects another edition, keeps the book's own edition and takes the next hit", () => {
    const hits = [hit('1', '【新装版】悪の説得術'), hit('2', '悪の説得術')];
    expect(
      acceptBookmeter(hits, { title: '悪の説得術', authors: ['多湖輝'], own: ['悪の説得術'] }).hit
        ?.id,
    ).toBe('2');
    // The labeled 悪の説得術 is the large-print edition's own e-book: its colophon prints it.
    const lp = [hit('11568100', '【大活字シリーズ】悪の説得術')];
    expect(
      acceptBookmeter(lp, {
        title: '【大活字シリーズ】悪の説得術',
        authors: ['多湖輝'],
        own: [
          '【大活字シリーズ】悪の説得術',
          null,
          '…発行所 ゴマブックス 【大活字シリーズ】悪の説得術',
        ],
      }).hit?.id,
    ).toBe('11568100');
    expect(
      acceptBookmeter([hit('1', '【新装版】悪の説得術')], {
        title: '悪の説得術',
        authors: ['多湖輝'],
        own: ['悪の説得術'],
      }),
    ).toEqual({
      hit: null,
      reason: 'only another edition (a 【…】 edition note the book itself does not have)',
    });
  });
});

const decision = (o: Partial<Stage4Decision> = {}): Stage4Decision =>
  ({
    values: {
      t: 'タイトル 3',
      au: ['作者'],
      il: ['絵描き'],
      se: 'シリーズ',
      ix: 3,
      fmt: 'light novel',
      kind: 'full',
    },
    auto: { t: true, au: true, il: false, se: true, ix: true, fmt: false, kind: true },
    numberGuess: null,
    amazonRejected: null,
    kindMarker: null,
    trace: {
      amazonIdentified: true,
      amazonByAsin: true,
      ranobedbIdentified: false,
      lnHint: false,
      amazon: { se: 'シリーズ' },
      ranobedb: null,
      cleaned: { file: '', amazon: null, ranobedb: null, bookwalker: null },
      colophonIllustrators: [],
      numbered: true,
      titleNumber: 3,
      position: 3,
      side: false,
      imprints: [],
      keywords: '',
    },
    ...o,
  }) as unknown as Stage4Decision;

const evidence = evidenceForm('タイトル 3 作者 絵描き 別の人 シリーズ 別シリーズ');
const answer = (o: Record<string, unknown>) =>
  parseStage4Answer({
    title: 'タイトル 3',
    authors: ['作者'],
    illustrators: ['絵描き'],
    series: 'シリーズ',
    series_index: 3,
    format: 'light novel',
    edition_kind: 'full',
    amazon_is_this_book: true,
    ranobedb_is_this_book: null,
    confidence: {},
    ...o,
  });

describe('setup E against the stage-4 rules', () => {
  it('keeps automatic rules values, flags them only when both models agree against them', () => {
    const o = decideStage4Ai(decision(), { primary: answer({}), secondary: answer({}) }, evidence);
    expect(o.t.decision).toMatchObject({ source: 'rules', flagged: false });
    const against = decideStage4Ai(
      decision(),
      { primary: answer({ authors: ['別の人'] }), secondary: answer({ authors: ['別の人'] }) },
      evidence,
    );
    expect(against.au.decision).toMatchObject({
      value: ['別の人'],
      source: 'secondary_guess',
      flagged: true,
    });
  });
  it('applies an open field both models agree on, else Luna, else the rules', () => {
    const o = decideStage4Ai(decision(), { primary: answer({}), secondary: answer({}) }, evidence);
    expect(o.il.decision).toMatchObject({
      value: ['絵描き'],
      source: 'both_models',
      flagged: false,
    });
    expect(o.fmt.decision).toMatchObject({ value: 'light novel', source: 'both_models' });
    const split = decideStage4Ai(
      decision(),
      { primary: answer({ format: 'novel' }), secondary: answer({ format: 'nonfiction' }) },
      evidence,
    );
    expect(split.fmt.decision).toMatchObject({
      value: 'nonfiction',
      source: 'secondary_guess',
      flagged: true,
    });
    const none = decideStage4Ai(decision(), { primary: null, secondary: null }, evidence);
    expect(none.fmt.decision).toMatchObject({
      value: 'light novel',
      source: 'rules_guess',
      flagged: true,
    });
  });
  it('counts "no series" as an answer both models can agree on', () => {
    const open = decision({ auto: { ...decision().auto, se: false } as Stage4Decision['auto'] });
    const o = decideStage4Ai(
      open,
      { primary: answer({ series: null }), secondary: answer({ series: null }) },
      evidence,
    );
    expect(o.se.decision).toMatchObject({
      value: { name: null },
      source: 'both_models',
      flagged: false,
    });
  });
  it('drops a model value that is not in the evidence (never invent)', () => {
    const open = decision({ auto: { ...decision().auto, il: false } as Stage4Decision['auto'] });
    const o = decideStage4Ai(
      open,
      {
        primary: answer({ illustrators: ['架空の人'] }),
        secondary: answer({ illustrators: ['架空の人'] }),
      },
      evidence,
    );
    expect(o.invented).toBe(2);
    expect(o.il.decision.source).not.toBe('both_models');
  });
  it('tells when both models say Amazon is this book (the description case)', () => {
    expect(
      decideStage4Ai(decision(), { primary: answer({}), secondary: answer({}) }, evidence)
        .amazonIsBook,
    ).toBe(true);
    expect(
      decideStage4Ai(
        decision(),
        { primary: answer({}), secondary: answer({ amazon_is_this_book: false }) },
        evidence,
      ).amazonIsBook,
    ).toBe(false);
  });
});

describe('the prompt', () => {
  it('has the shared blocks and the bonus N.1 and omnibus rules, and a closed schema', () => {
    expect(STAGE4_SYSTEM).toContain('・');
    expect(STAGE4_SYSTEM).toContain('終物語(中) is not volume 2');
    expect(STAGE4_SYSTEM).toContain('a bonus for volume 3 is 3.1');
    expect(STAGE4_SYSTEM).toContain('(volumes 1-5 -> 5.9)');
    expect(STAGE4_SCHEMA.additionalProperties).toBe(false);
    expect(STAGE4_SCHEMA.required).toContain('amazon_is_this_book');
  });
  it("writes the evidence as the bake-off's evidence() did", () => {
    const r = {
      calibre: { cal_title: 'C', cal_authors: 'A&B' },
      file: {
        opf_title: 'F',
        creators: [{ name: 'A', role: 'aut' }],
        publisher: ['P'],
        asin: null,
        chars: 10,
        images: 1,
        front_text: ' front ',
        colophon_text: 'end',
      },
      amazon: { product: null },
      ranobedb: {},
      bookwalker: {},
    } as unknown as RefRecord;
    expect(stage4UserText(stage4Evidence(r)).split('\n')).toEqual([
      '## Calibre record (unreliable)',
      'title: C',
      'authors: A&B',
      '## EPUB file metadata',
      'title: F',
      'creators: A (aut)',
      'publisher: P',
      'asin in file: None',
      'text characters: 10, images: 1',
      '## First pages (excerpt)',
      'front',
      '## Last pages / colophon (excerpt)',
      'end',
      '## Amazon.co.jp ',
      'no result',
      '## RanobeDB',
      'no result',
      '## BookWalker',
      'no result',
    ]);
  });
});

describe('proposals from the decided values', () => {
  const book: Stage2Book = {
    calibreId: 1,
    uuid: 'u1',
    title: '古いタイトル',
    titleSort: null,
    authors: ['作者'],
    authorSort: null,
    tags: [],
    hasCover: true,
    path: 'a/b (1)',
    filePath: 'a/b (1)/b.epub',
    lastModified: null,
    identifiers: {},
    publisher: null,
    languages: [],
    illustrators: [],
  };
  const record = {
    calibre: { cal_title: book.title },
    file: { opf_title: 'タイトル 3' },
    amazon: { product: { title: '別の題', description: 'あらすじ。' }, picked_from_search: true },
    ranobedb: {},
    bookwalker: {},
  } as unknown as RefRecord;
  const input = (ai: Parameters<typeof proposeStage4>[0]['ai'], d = decision()) => ({
    book,
    extras: { series: null, seriesIndex: null, comments: null } as never,
    record,
    decision: d,
    bookmeter: null,
    natively: null,
    readings: new Map(),
    cover: null,
    applied: new Map(),
    sameDistance: 5,
    smallCoverPx: 800,
    ai,
  });
  const v = (value: unknown, source: string, flagged = false) => ({
    value,
    source,
    flagged,
    reason: flagged ? 'The models disagree' : null,
  });

  it('writes an unconfirmed guess as automatic, marked unconfirmed', () => {
    const ps = proposeStage4(
      input({
        asked: true,
        il: v(['別の人'], 'secondary_guess', true),
        fmt: v('novel', 'both_models'),
      }),
    );
    const il = ps.find((p) => p.field === 'illustrator')!;
    expect(il).toMatchObject({ class: 'auto', new: ['別の人'], source: 'ai:secondary_guess' });
    expect(il.evidence).toMatchObject({ unconfirmed: true });
    expect(il.reason).toMatch(/^Unconfirmed/);
    expect(ps.find((p) => p.field === 'format')).toMatchObject({
      class: 'auto',
      new: 'novel',
      source: 'ai:both_models',
    });
  });
  it('keeps the rules alone when the models were not both asked', () => {
    const ps = proposeStage4(input({ asked: false, il: v(['別の人'], 'secondary_guess', true) }));
    expect(ps.find((p) => p.field === 'illustrator')).toMatchObject({
      class: 'review',
      new: ['絵描き'],
    });
  });
  it('sends a garbled value to review whatever its source (a file read in the wrong encoding)', () => {
    // Mojibake of UTF-8 Japanese read as Shift_JIS, as stage 2's check knows it.
    const bad = '縺匃縺輔繧譚繧〃繝・';
    const ps = proposeStage4(input({ asked: true, au: v([bad], 'rules_guess', true) }));
    expect(ps.find((p) => p.field === 'authors')).toMatchObject({
      class: 'review',
      reason: 'The value is garbled (wrong text encoding)',
    });
  });
  it('still sends a name with "&" to review', () => {
    const ps = proposeStage4(input({ asked: true, au: v(['A&B'], 'both_models') }));
    expect(ps.find((p) => p.field === 'authors')).toMatchObject({ class: 'review' });
  });
  it("uses Amazon's description when both models say it is this book, not when the rules set it aside", () => {
    const d = decision({
      trace: {
        ...decision().trace,
        amazonIdentified: false,
        amazonByAsin: false,
      } as Stage4Decision['trace'],
    });
    const yes = proposeStage4(input({ asked: true, amazonIsBook: true }, d)).find(
      (p) => p.field === 'description',
    );
    expect(yes).toMatchObject({ new: 'あらすじ。', source: 'amazon(models)' });
    const rejected = {
      ...d,
      amazonRejected: 'Amazon lists it as manga, but the file has text',
    } as Stage4Decision;
    expect(
      proposeStage4(input({ asked: true, amazonIsBook: true }, rejected)).find(
        (p) => p.field === 'description',
      ),
    ).toBeUndefined();
  });
  it('reads back a value the user set instead of the decision', () => {
    const s = initCleanupDatabase(makeTempDir('wp20e-ai'));
    if (!s.ok) throw new Error(s.error);
    const o = decideStage4Ai(decision(), { primary: answer({}), secondary: answer({}) }, evidence);
    writeDecisions(s.db, 'calibre4', decisionRows('lib:u1', o, 'h', true), 'E', 1);
    setUserValue(s.db, 'calibre4', 'lib:u1', 'il', ['自分の値'], 2);
    writeDecisions(s.db, 'calibre4', decisionRows('lib:u1', o, 'h', true), 'E', 3);
    const stored = storedAiValues(s.db, 'lib:u1')!;
    expect(stored.asked).toBe(true);
    expect(stored.amazonIsBook).toBe(true);
    expect(stored.il).toMatchObject({ value: ['自分の値'], source: 'user' });
    expect(proposeStage4(input(stored)).find((p) => p.field === 'illustrator')).toMatchObject({
      class: 'auto',
      new: ['自分の値'],
    });
  });
});

describe('the AI gate', () => {
  it('scores confirmed values and every value, and books with every field right', () => {
    const gold = {
      t: 'タイトル 3',
      au: ['作者'],
      il: ['絵描き'],
      se: 'シリーズ',
      ix: 3,
      fmt: 'light novel',
      sample: 'D',
    };
    const ok = (value: unknown, source = 'rules', flagged = false) => ({
      value,
      source,
      flagged,
      reason: null,
    });
    const g = scoreAiGate([
      {
        gid: '1',
        gold: gold as never,
        ai: {
          asked: true,
          t: ok('タイトル 3'),
          au: ok(['作者']),
          il: ok(['別の人'], 'secondary_guess', true),
          se: ok({ name: 'シリーズ' }),
          ix: ok({ n: 3 }),
          fmt: ok('light novel', 'both_models'),
        },
      },
      { gid: '2', gold: gold as never, ai: null },
    ]);
    expect(g.books).toBe(1);
    expect(g.notAsked).toBe(1);
    expect(g.checkD.fields.il).toMatchObject({ scored: 1, auto: 0, allRight: 0 });
    expect(g.checkD.fields.fmt).toMatchObject({ auto: 1, autoRight: 1 });
    expect(g.checkD.everyFieldRight).toBe(0);
    expect(g.the600.books).toBe(0);
  });
});

describe("the AI check's progress bar (WP20e follow-up)", () => {
  it('measures each model from when the asking started; the slowest model decides the time left', async () => {
    const { Stage4Ai } = await import('../src/cleanup/stage4/ai-step');
    const s = initCleanupDatabase(makeTempDir('wp20e-bar'));
    if (!s.ok) throw new Error(s.error);
    const db = s.db;
    const put = db.prepare(
      `INSERT INTO ai_requests (stage, item_key, role, provider, model, prompt_version, evidence_hash, state, run_id, created_at)
       VALUES ('calibre4', ?, ?, ?, ?, 'v', 'h', ?, 'run1', 1)`,
    );
    // Claude Haiku (by batch): 600 in, 400 left; Luna (one call each): 200 in, 800 left.
    for (let i = 0; i < 1000; i++) {
      put.run(`k${i}`, 'primary', 'anthropic', 'claude-haiku-5-5', i < 600 ? 'answered' : 'queued');
      put.run(
        `k${i}`,
        'secondary',
        'openai',
        'gpt-6-luna',
        i < 200 ? 'answered' : i < 208 ? 'sent' : 'queued',
      );
    }
    const t0 = 1_000_000;
    // The asking started 10 minutes ago with 100 and 0 answers in.
    const ai = {
      analysisId: 'run1',
      rulesFinishedAt: 5,
      phase: 'models',
      items: 1000,
      decided: 0,
      modelsStart: { at: t0, done: { 'claude-haiku-5-5': 100, 'gpt-6-luna': 0 } },
    };
    const progress = { analysisId: 'run1', phase: 'done', finishedAt: 5, ai };
    const step = new Stage4Ai({
      db,
      runner: {} as never,
      analysis: { progress: () => progress } as never,
    });
    const b = step.bar(t0 + 600_000)!;
    expect(b).toMatchObject({ phase: 'models', done: 800, total: 2000 });
    // Haiku: 500 in 10 min, 400 left = 8 min; Luna: 200 in 10 min, 800 left = 40 min.
    expect(b.secondsLeft).toBe(2400);
    // Before any model has answered since the start: no estimate.
    ai.modelsStart = { at: t0, done: { 'claude-haiku-5-5': 600, 'gpt-6-luna': 200 } };
    expect(step.bar(t0 + 600_000)!.secondsLeft).toBeNull();
    // Deciding: books per minute since the phase started.
    Object.assign(ai, { phase: 'decide', decided: 250, phaseStartedAt: t0, phaseStartDone: 0 });
    expect(step.bar(t0 + 60_000)).toMatchObject({
      phase: 'decide',
      done: 250,
      total: 1000,
      secondsLeft: 180,
    });
  });
});
