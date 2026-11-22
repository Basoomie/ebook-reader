/**
 * WP20f: stage 5, genres and tags. The pure rules (the vocabulary and answers as ids or labels,
 * Haiku AND Luna per id, RanobeDB's mapping, the store rules, adaptation never guessed, the union
 * per series, the tag change with its removals, never a custom tag, never re-adding a tag the
 * user removed), the gate's scoring, the Google run's marks kept for stage 2/4's rules, the
 * phase machine against the AI stand-in, and the write through the real sidecar with the
 * stand-in calibredb (a tag added in Calibre since the proposal stays; Undo exactly).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Calibredb } from '../../cleanup-apply/src/calibredb';
import type { SidecarConfig } from '../../cleanup-apply/src/config';
import { Worker } from '../../cleanup-apply/src/worker';
import { AnthropicProvider, OpenAiProvider, type ProviderClient } from '../src/ai/providers';
import { cleanupRunner, makeAiCore } from './helpers/ai-env';
import type { Provider } from '../src/ai/types';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { attachMarks, recordMarks } from '../src/cleanup/marks';
import { getSettings, updateSettings } from '../src/cleanup/settings';
import { isProcessed } from '../src/cleanup/stage2-rules';
import type { Stage2Book } from '../src/cleanup/stage2-snapshot';
import { getStage, setStageMode, updateStage } from '../src/cleanup/stages';
import type { Stage4Ai } from '../src/cleanup/stage4/ai-step';
import type { Stage4Analysis } from '../src/cleanup/stage4/analysis';
import {
  applyTagChange,
  ownTerms,
  sameTags,
  seriesUnion,
  tagChange,
  undoTagChange,
} from '../src/cleanup/stage5/decide';
import { plainText, stage5Evidence } from '../src/cleanup/stage5/evidence';
import { belowBars, scoreSet } from '../src/cleanup/stage5/gate';
import {
  STAGE5_SCHEMA,
  STAGE5_SYSTEM,
  parseStage5Answer,
  stage5UserText,
} from '../src/cleanup/stage5/prompt';
import { Stage5 } from '../src/cleanup/stage5/step';
import {
  GOOGLE_CATEGORIES,
  TAGS,
  WORKFLOW_TAGS,
  fromRanobedb,
  fromStoreCategories,
  isRemovedTag,
  termId,
  GENRE_IDS,
  SUBJECT_IDS,
  TAG_IDS,
} from '../src/cleanup/stage5/vocab';
import { startAiStandin } from './helpers/ai-standin';
import { addStage2Tables } from './helpers/stage2-fixture';
import { type CleanupEnv, makeCleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';

const CUSTOM = ['PeepoHappyBooks', 'alpindale', 'TMW-collection-*'];
const answer = (o: Partial<Record<string, unknown>> = {}) =>
  parseStage5Answer({
    genres: [],
    nonfiction_subjects: [],
    tags: [],
    anime_adaptation: false,
    manga_adaptation: false,
    confidence: 'high',
    basis: 'description',
    ...o,
  })!;

describe('the vocabulary and the answers', () => {
  it('has the 22 genres, 14 subjects, 43 tags, the approved removals', () => {
    expect(GENRE_IDS.size).toBe(22);
    expect(TAGS).toHaveLength(43);
    expect(GOOGLE_CATEGORIES).toHaveLength(274);
    expect(new Set(GOOGLE_CATEGORIES).size).toBe(274);
    expect(WORKFLOW_TAGS).toHaveLength(7);
    expect(isRemovedTag('young adult fiction')).toBe(true);
    expect(isRemovedTag('metadata-processed')).toBe(true);
    // Kept: the user's tags, the files' own keyword tags, non-category English tags.
    for (const t of ['PeepoHappyBooks', 'TMW-collection-13', '恋愛', 'Kakuyomu', 'read', '11Atop'])
      expect(isRemovedTag(t)).toBe(false);
  });

  it('takes ids or labels (with or without the hint), drops unknown terms and counts them', () => {
    const a = parseStage5Answer({
      genres: [
        'ファンタジー',
        'isekai',
        '異世界 (transported to or reborn in another world)',
        'nf_essay',
      ],
      nonfiction_subjects: ['歴史', 'romance'],
      tags: ['男性主人公', 'magic', 'tsundere'],
      anime_adaptation: true,
      manga_adaptation: false,
    })!;
    expect(a.genres).toEqual(['fantasy', 'isekai', 'romance']);
    expect(a.subjects).toEqual(['nf_essay', 'nf_history']);
    expect(a.tags).toEqual(['magic', 'male_lead']);
    expect(a.dropped).toBe(1);
    expect(a.anime).toBe(true);
    expect(termId('スポーツ', GENRE_IDS)).toBe('sports');
    expect(parseStage5Answer('nope')).toBeNull();
  });

  it('is the genre test prompt with スポーツ, and a closed schema', () => {
    expect(STAGE5_SYSTEM).toContain('  isekai: 異世界 (transported to or reborn in another world)');
    expect(STAGE5_SYSTEM).toContain('  sports: スポーツ');
    expect(STAGE5_SYSTEM).toContain('  game_world: ゲーム要素 (game systems, levels, RPG)');
    expect((STAGE5_SCHEMA as { additionalProperties: boolean }).additionalProperties).toBe(false);
    const e = stage5Evidence({
      book: { title: 'T', authors: ['A'] },
      base: { calibre: { cal_title: 'T' }, file: { front_text: '本文の冒頭' } },
      record: { calibre: { cal_title: 'T' }, file: {} },
      decision: {
        trace: {
          amazonIdentified: false,
          ranobedbIdentified: false,
          cleaned: { bookwalker: null },
        },
        amazonRejected: null,
      } as never,
      comments: null,
      format: 'novel',
      modelsSayAmazon: false,
    });
    // No description: the opening text, as in the test.
    expect(JSON.parse(stage5UserText(e))).toEqual({
      title: 'T',
      authors: ['A'],
      format: 'novel',
      opening_text: '本文の冒頭',
    });
    expect(plainText('<p>一行目</p><p>二&amp;行目</p>')).toBe('一行目\n二&行目');
  });
});

describe('the decisions', () => {
  it('applies a term only when both models give it, adaptation only when stated', () => {
    const own = ownTerms({
      primary: answer({ genres: ['fantasy', 'comedy'], tags: ['magic'], anime_adaptation: true }),
      secondary: answer({
        genres: ['ファンタジー'],
        tags: ['magic', 'harem'],
        anime_adaptation: true,
      }),
      ranobedbTags: null,
      storeCategories: [],
      adaptationText: 'ただのあらすじ',
    });
    expect(Object.keys(own.terms).sort()).toEqual(['fantasy', 'magic']);
    expect(own.oneModel).toBe(2);
    // Both models say anime, and the text states it.
    const stated = ownTerms({
      primary: answer({ anime_adaptation: true, manga_adaptation: true }),
      secondary: answer({ anime_adaptation: true, manga_adaptation: true }),
      ranobedbTags: null,
      storeCategories: [],
      adaptationText: 'TVアニメ放送中！',
    });
    expect(Object.keys(stated.terms)).toEqual(['anime']);
    // One model alone never.
    const one = ownTerms({
      primary: answer({ genres: ['fantasy'] }),
      secondary: null,
      ranobedbTags: null,
      storeCategories: [],
      adaptationText: '',
    });
    expect(one.asked).toBe(false);
    expect(one.terms).toEqual({});
  });

  it("maps RanobeDB's series tags and the store categories", () => {
    expect(
      fromRanobedb([
        { name: 'romance', type: 'genre' },
        { name: 'comedy', type: 'genre' },
        { name: 'male protagonist', type: 'tag' },
        { name: 'anime tie-in', type: 'tag' },
        { name: 'multiple pov', type: 'tag' },
      ]),
    ).toEqual(['anime', 'comedy', 'male_lead', 'romance', 'romcom']);
    expect(fromRanobedb([{ name: 'reincarnation', type: 'tag' }])).toEqual([
      'isekai',
      'reincarnation',
    ]);
    expect(
      fromStoreCategories([
        'コミック・ラノベ・BL',
        'ボーイズラブノベルス (Kindleストア)',
        'ティーンズラブ (Kindleストア)',
        '美少女文庫',
        'アダルト下着',
      ]),
    ).toEqual(['adult', 'bl', 'tl']);
  });

  it('gives every book of a series what any volume has; a standalone keeps its own', () => {
    const t = (ids: string[], s: 'models' | 'ranobedb' = 'models') => ({
      terms: Object.fromEntries(ids.map((i) => [i, [s]])),
      asked: true,
      oneModel: 0,
    });
    const u = seriesUnion([
      { calibreId: 1, series: 'S', own: t(['fantasy']) },
      { calibreId: 2, series: 'S', own: t(['isekai', 'anime'], 'ranobedb') },
      { calibreId: 3, series: null, own: t(['mystery']) },
    ]);
    expect(Object.keys(u.get(1)!).sort()).toEqual(['anime', 'fantasy', 'isekai']);
    expect(Object.keys(u.get(2)!).sort()).toEqual(['anime', 'fantasy', 'isekai']);
    expect(Object.keys(u.get(3)!)).toEqual(['mystery']);
    expect(u.get(1)!.fantasy).toMatchObject({ sources: ['models'], count: 1, books: [1] });
  });

  it('the change: labels and the format tag added, removals, never a custom tag, never re-added', () => {
    const ch = tagChange(
      ['fantasy', 'magic'],
      'light novel',
      ['PeepoHappyBooks', 'Young Adult Fiction', 'metadata-processed', '魔法', 'ln'],
      CUSTOM,
      ['ファンタジー'],
    );
    // 魔法 is already there; ファンタジー was added before and is gone: removed by the user.
    expect(ch.add).toEqual(['ライトノベル']);
    expect(ch.remove).toEqual(['Young Adult Fiction', 'metadata-processed', 'ln']);
    // A book stage 4 never read: removals only.
    expect(tagChange(null, null, ['General', 'alpindale'], CUSTOM)).toEqual({
      add: [],
      remove: ['General'],
    });
    // Applied to what Calibre holds at the write: a tag added since stays; a custom tag stays
    // even if a change named it.
    const final = applyTagChange(
      ['PeepoHappyBooks', 'Young Adult Fiction', 'new-by-user'],
      { add: ['ファンタジー'], remove: ['Young Adult Fiction', 'PeepoHappyBooks'] },
      CUSTOM,
    );
    expect(final).toEqual(['PeepoHappyBooks', 'new-by-user', 'ファンタジー']);
    expect(
      undoTagChange(['PeepoHappyBooks', 'ファンタジー', 'later'], {
        added: ['ファンタジー'],
        removed: ['Young Adult Fiction'],
      }),
    ).toEqual(['PeepoHappyBooks', 'later', 'Young Adult Fiction']);
    expect(sameTags(['A', 'b'], ['B', 'a'])).toBe(true);
  });
});

describe('the gate', () => {
  it('scores found share, right share and fully right books as the genre test did', () => {
    const labels: Record<string, [string[], string[]]> = {
      a: [['fantasy'], ['comedy']],
      b: [['romance', 'drama'], []],
      c: [[], ['horror']],
    };
    const applied: Record<string, string[]> = {
      a: ['fantasy', 'comedy'],
      b: ['romance', 'mystery'],
      c: [],
    };
    const s = scoreSet(
      labels,
      (g) => new Set(applied[g] ?? []),
      () => true,
    );
    expect(s).toMatchObject({ books: 3, core: 3, found: 2, applied: 4, right: 3, full: 2 });
    expect(s.foundPercent).toBe(66.7);
    expect(s.rightPercent).toBe(75);
    expect(s.wrong).toEqual([{ gid: 'b', id: 'mystery' }]);
    expect(
      belowBars(
        { genres: s, tags: s },
        { genresRight: 95, tagsRight: 95, genresFound: 60, tagsFound: 70 },
      ),
    ).toEqual([
      'genres: 75 % right (bar 95 %)',
      'tags: 75 % right (bar 95 %)',
      'tags: 66.7 % found (bar 70 %)',
    ]);
  });

  // Opt-in: the genre test's stored answers and blind labels (GENRE_TEST_DIR = the test folder,
  // GENRE_LABELS = genre-labels.json): the production parsing and scoring give the test's numbers.
  const dir = process.env.GENRE_TEST_DIR;
  const labelsFile = process.env.GENRE_LABELS;
  it.skipIf(!dir || !labelsFile)(
    'reproduces the genre test: 91.3 / 99.3 / 70 and 77.1 / 99.0 / 42',
    () => {
      const load = (m: string) => {
        const out = new Map<string, ReturnType<typeof parseStage5Answer>>();
        for (const l of fs.readFileSync(path.join(dir!, 'out', `${m}.jsonl`), 'utf8').split('\n')) {
          if (!l.trim()) continue;
          const o = JSON.parse(l) as { id: unknown; ok: boolean; answer: unknown };
          if (o.ok) out.set(String(o.id), parseStage5Answer(o.answer));
        }
        return out;
      };
      const h = load('claude-haiku-5-5');
      const l = load('gpt-6-luna');
      const L = JSON.parse(fs.readFileSync(labelsFile!, 'utf8')) as {
        genres: Record<string, [string[], string[]]>;
        tags: Record<string, [string[], string[]]>;
      };
      const both = (g: string) => {
        const o = ownTerms({
          primary: h.get(g) ?? null,
          secondary: l.get(g) ?? null,
          ranobedbTags: null,
          storeCategories: [],
          adaptationText: '',
        });
        return new Set(Object.keys(o.terms));
      };
      const gs = scoreSet(L.genres, both, (x) => GENRE_IDS.has(x) || SUBJECT_IDS.has(x));
      const ts = scoreSet(L.tags, both, (x) => TAG_IDS.has(x));
      expect([gs.foundPercent, gs.rightPercent, gs.full]).toEqual([91.3, 99.3, 70]);
      expect([ts.foundPercent, ts.rightPercent, ts.full]).toEqual([77.1, 99, 42]);
    },
  );
});

describe("the Google run's marks", () => {
  it('are recorded once and keep isProcessed after the tag is gone', () => {
    const s = initCleanupDatabase(makeTempDir('wp20f-marks'));
    if (!s.ok) throw new Error(s.error);
    const book = (uuid: string, tags: string[]) =>
      ({ uuid, tags, calibreId: 1 }) as unknown as Stage2Book;
    expect(
      recordMarks(s.db, 'L', [book('u1', ['Metadata-Processed', 'x']), book('u2', ['y'])]),
    ).toBe(1);
    expect(recordMarks(s.db, 'L', [book('u1', ['metadata-processed'])])).toBe(0);
    const gone = [book('u1', ['x']), book('u2', ['y'])];
    attachMarks(s.db, 'L', gone);
    expect(gone[0].marks).toEqual(['metadata-processed']);
    expect(isProcessed(gone[0].tags, gone[0].marks)).toBe(true);
    expect(isProcessed(gone[1].tags, gone[1].marks)).toBe(false);
    s.db.close();
  });
});

// -----------------------------------------------------------------------------------------------
// The phase machine against the AI stand-in, with a stage-4 stand-in (cleanup.db rows + a fake
// analysis giving the books' sources).

describe('stage 5 from evidence to proposals', () => {
  let standin: Awaited<ReturnType<typeof startAiStandin>> | null = null;
  afterEach(async () => {
    await standin?.close();
    standin = null;
  });

  it('asks both models, decides per id and per book, gates and proposes one change per book', async () => {
    // What each model answers, by title (Luna answers with labels, as in the genre test).
    const H: Record<string, Partial<Record<string, unknown>>> = {
      'シリーズ 1': { genres: ['fantasy', 'comedy'], tags: ['magic'] },
      'シリーズ 2': { genres: ['fantasy'], tags: ['dragons'] },
      単発: { genres: ['mystery'], tags: ['crime'], anime_adaptation: true },
    };
    const Lu: Record<string, Partial<Record<string, unknown>>> = {
      'シリーズ 1': { genres: ['ファンタジー'], tags: ['魔法'] },
      'シリーズ 2': { genres: ['fantasy'], tags: ['ドラゴン'] },
      単発: { genres: ['ミステリー・サスペンス'], tags: ['犯罪'], anime_adaptation: true },
    };
    standin = await startAiStandin({
      anthropicKey: 'ak',
      openaiKey: 'ok',
      answer: ({ provider, user }: { provider: string; user: string }) => {
        const title = (JSON.parse(user) as { title: string }).title;
        const a = (provider === 'openai' ? Lu : H)[title] ?? {};
        return {
          kind: 'json',
          json: {
            genres: [],
            nonfiction_subjects: [],
            tags: [],
            anime_adaptation: false,
            manga_adaptation: false,
            confidence: 'high',
            basis: 'description',
            ...a,
          },
        };
      },
    });
    const s = initCleanupDatabase(makeTempDir('wp20f-step'));
    if (!s.ok) throw new Error(s.error);
    const db = s.db;
    const lib = 'L';
    // Labels for the gate (keys are Calibre ids).
    const labels = path.join(makeTempDir('wp20f-labels'), 'genre-labels.json');
    fs.writeFileSync(
      labels,
      JSON.stringify({
        genres: { '1': [['fantasy'], ['isekai']], '3': [['mystery'], []] },
        tags: { '1': [['magic'], ['dragons']], '3': [['crime'], []] },
      }),
    );
    updateSettings(db, {
      gate: { ...getSettings(db).gate, genreLabelsFile: labels },
    });
    // Calibre now: two volumes of a series (RanobeDB has the second), a standalone, a book stage
    // 4 never read (no EPUB).
    const books = new Map<number, Stage2Book>();
    const add = (id: number, title: string, tags: string[]) =>
      books.set(id, {
        calibreId: id,
        uuid: `u${id}`,
        title,
        titleSort: null,
        authors: ['作者'],
        authorSort: null,
        tags,
        hasCover: true,
        path: `a/${id}`,
        filePath: id === 4 ? null : `a/${id}/b.epub`,
        lastModified: '2026-11-21 10:00:00+00:00',
        identifiers: {},
        publisher: null,
        languages: [],
        illustrators: [],
      });
    add(1, 'シリーズ 1', ['PeepoHappyBooks', 'metadata-processed', 'Young Adult Fiction']);
    add(2, 'シリーズ 2', ['TMW-collection-3']);
    add(3, '単発', ['needs-metadata']);
    add(4, '漫画', ['metadata-unmatched', 'Manga', 'alpindale']);
    const series = new Map<number, string | null>([
      [1, 'シリーズ'],
      [2, 'シリーズ'],
      [3, null],
      [4, null],
    ]);
    const comments = new Map<number, string>([
      [1, '<p>魔法の物語。</p>'],
      [2, '竜の物語。'],
      [3, '事件の物語。TVアニメ化決定！'],
    ]);
    for (const id of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO stage4_books (library_id, calibre_uuid, calibre_id, analysis_id, labeled, state, updated_at)
         VALUES (?, ?, ?, 'a4', 0, 'proposed', 1)`,
      ).run(lib, `u${id}`, id);
      db.prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json,
           source, evidence_json, class, state, analysis_id, created_at, updated_at)
         VALUES (4, ?, ?, ?, 'format', NULL, ?, 'rules', '{}', 'auto', 'proposed', 'a4', 1, 1)`,
      ).run(lib, id, `u${id}`, JSON.stringify(id === 3 ? 'novel' : 'light novel'));
    }
    const p4 = { analysisId: 'a4', libraryId: lib, phase: 'done', finishedAt: 1 };
    const byUuid = (u: string) => [...books.values()].find((b) => b.uuid === u)!;
    const analysis = {
      progress: () => p4,
      loadSnapshot: () => ({ books, names: {}, illustratorColumn: true }),
      extrasAll: () =>
        new Map(
          [...books.keys()].map((id) => [
            id,
            {
              series: series.get(id) ?? null,
              seriesIndex: null,
              comments: comments.get(id) ?? null,
            },
          ]),
        ),
      extrasOf: (_p: unknown, id: number) => ({
        series: series.get(id) ?? null,
        seriesIndex: null,
        comments: comments.get(id) ?? null,
      }),
      aiInputs: (_p: unknown, uuid: string) => {
        const book = byUuid(uuid);
        const rec = {
          calibre: { cal_title: book.title },
          file: { front_text: '' },
          ranobedb:
            book.calibreId === 2
              ? {
                  series: {
                    tags: [
                      { name: 'isekai', type: 'tag' },
                      { name: 'anime tie-in', type: 'tag' },
                    ],
                  },
                }
              : {},
        };
        return {
          book,
          base: rec,
          record: rec,
          decision: {
            trace: {
              amazonIdentified: false,
              ranobedbIdentified: book.calibreId === 2,
              cleaned: { bookwalker: null },
            },
            amazonRejected: null,
          },
        };
      },
    } as unknown as Stage4Analysis;
    const stage4Ai = {
      isDone: () => true,
      progress: () => ({ finishedAt: 7 }),
    } as unknown as Stage4Ai;
    let now = 1_800_000_000_000;
    const { core } = makeAiCore({
      keys: { read: (n: string) => (n === 'anthropicApiKey' ? 'ak' : 'ok') },
      providers: (p: Provider, key: string): ProviderClient =>
        p === 'anthropic'
          ? new AnthropicProvider(key, standin!.anthropicUrl)
          : new OpenAiProvider(key, standin!.openaiUrl),
      now: () => now,
    });
    core.updateSettings({
      spendLimitUsd: 1,
      modes: { 'claude-haiku-5-5': 'direct', 'gpt-6-luna': 'direct' },
    });
    const runner = cleanupRunner(db, core, { now: () => now, sleep: async () => {} });
    const s5 = new Stage5({ db, runner, analysis, stage4Ai });
    setStageMode(db, 5, 'analyse');
    expect(s5.needsWork(lib)).toBe(true);
    for (let i = 0; i < 200 && s5.needsWork(lib); i++) {
      await s5.step(lib, () => false);
      await runner.settle();
      now += 1000;
    }
    const p = s5.progress()!;
    expect(p.phase).toBe('done');
    expect(p.error).toBeNull();
    expect(p.asked).toBe(3);
    // The marks went first.
    expect(p.marks).toBe(3);
    const rows = new Map(
      (
        db
          .prepare(`SELECT calibre_id, new_json, source FROM proposed_changes WHERE stage = 5`)
          .all() as { calibre_id: number; new_json: string; source: string }[]
      ).map((r) => [
        r.calibre_id,
        { ...(JSON.parse(r.new_json) as { add: string[]; remove: string[] }), source: r.source },
      ]),
    );
    // Per book (decided 2026-11-21): volume 1 keeps fantasy and magic (both models; comedy,
    // Haiku only, never); volume 2 its own: fantasy and dragons (both models), isekai and アニメ化
    // (its RanobeDB match). Nothing of one volume goes to the other.
    expect(rows.get(1)!.add).toEqual(['ファンタジー', 'ライトノベル', '魔法'].sort());
    expect(rows.get(2)!.add).toEqual(
      ['アニメ化', 'ドラゴン', 'ファンタジー', 'ライトノベル', '異世界'].sort(),
    );
    expect(rows.get(1)!.remove).toEqual(['metadata-processed', 'Young Adult Fiction']);
    expect(rows.get(2)!.remove).toEqual([]);
    // The standalone: its own; アニメ化 from both models with the statement in the description.
    expect(rows.get(3)!.add).toEqual(['アニメ化', 'ミステリー・サスペンス', '小説', '犯罪'].sort());
    expect(rows.get(3)!.remove).toEqual(['needs-metadata']);
    // A book stage 4 never read: removals only; alpindale stays.
    expect(rows.get(4)).toMatchObject({
      add: [],
      remove: ['metadata-unmatched', 'Manga'],
      source: 'stage5-removals',
    });
    // The gate on the labeled books.
    expect(p.gate?.final.genres).toMatchObject({ books: 2, core: 2, found: 2 });
    expect(p.gate?.final.tags).toMatchObject({ books: 2, found: 2 });
    expect(p.gate?.final.genres).toMatchObject({ right: 2, applied: 2 });
    expect(p.gate?.held).toEqual({ genres: false, tags: false });
    expect(p.gate?.passed).toBe(true);
    expect(p.counts).toMatchObject({ books: 4, outside: 1, outsideChanged: 1, noGenre: 0 });
    expect(p.counts!.removals).toMatchObject({ 'metadata-processed': 1, Manga: 1 });
    // The bar: done.
    expect(s5.bar()).toBeNull();
    // The propose phase's bar counts books, not the cursor (a Calibre id: the live run showed
    // "61,282 of 53,247").
    const saved = s5.progress()!;
    updateStage(db, 5, {
      progress: {
        ...saved,
        phase: 'propose',
        cursor: 61_282,
        total: 53_247,
        proposed: 1_000,
        phaseStartedAt: now - 60_000,
        phaseStartDone: 0,
      } as unknown as Record<string, unknown>,
    });
    expect(s5.bar(now)).toEqual({
      phase: 'propose',
      done: 1_000,
      total: 53_247,
      secondsLeft: Math.round((52_247 * 60_000) / 1_000 / 1000),
    });
    updateStage(db, 5, { progress: saved as unknown as Record<string, unknown> });
    // Nothing asked again after a rules change; decided and proposed again.
    const calls = standin.calls.length;
    updateSettings(db, { customTags: [...CUSTOM, 'Manga'] });
    expect(s5.needsWork(lib)).toBe(true);
    for (let i = 0; i < 50 && s5.needsWork(lib); i++) await s5.step(lib, () => false);
    expect(standin.calls.length).toBe(calls);
    const r4 = db
      .prepare(
        `SELECT new_json FROM proposed_changes WHERE stage = 5 AND calibre_id = 4 AND state = 'proposed'`,
      )
      .get() as { new_json: string };
    expect(JSON.parse(r4.new_json)).toEqual({ add: [], remove: ['metadata-unmatched'] });
    expect(getStage(db, 5).state).toBe('ready');
    db.close();
  });
});

// -----------------------------------------------------------------------------------------------
// The write: the real sidecar and the stand-in calibredb.

const FAKE = path.resolve(__dirname, 'fixtures', 'wp20a', 'fake-calibredb.cjs');
const PASSWORD = 'calibre-test-password';
const quiet = { info: () => {}, error: () => {} };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const listen = (s: http.Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)),
  );

describe('stage 5 On: the tags written through the field-write path', () => {
  let env: CleanupEnv;
  let server: http.Server;
  let calibreServer: http.Server;
  let quarantine: string;
  let log: string;
  let ids: Record<string, number>;
  let url: string;

  beforeEach(async () => {
    const made = await makeCleanupEnv({ leaseSeconds: 60 });
    env = made.env;
    addStage2Tables(env.lib);
    ids = {
      A: await env.lib.addBook({
        title: '本 A',
        authors: ['作者'],
        tags: ['PeepoHappyBooks', 'Young Adult Fiction', 'metadata-processed'],
      }),
      B: await env.lib.addBook({ title: '本 B', authors: ['作者'], tags: ['ln'] }),
    };
    for (let i = 0; i < 20; i++)
      await env.lib.addBook({ title: `棚の本 ${i}`, authors: ['棚の作者'] });
    await made.setup();
    server = http.createServer(env.app);
    calibreServer = http.createServer((_req, res) => {
      res.setHeader('Server', 'calibre 9.18.0');
      res.end('<html></html>');
    });
    const port = await listen(server);
    const cport = await listen(calibreServer);
    url = `http://127.0.0.1:${port}`;
    quarantine = makeTempDir('quarantine');
    log = path.join(makeTempDir('log'), 'calls.log');
    const user = env.userToken();
    await request(env.app)
      .put('/api/v1/cleanup/settings')
      .set(auth(user))
      .send({
        contentServerUrl: `http://127.0.0.1:${cport}`,
        calibreUsername: 'u',
        pacing: {
          itemDelaySeconds: 0,
          batchSize: 500,
          maxBatchPercent: 10,
          readMbPerSecond: 0,
          lookupChunk: 2,
        },
      })
      .expect(200);
    await request(env.app)
      .put('/api/v1/cleanup/secrets/calibrePassword')
      .set(auth(user))
      .send({ value: PASSWORD })
      .expect(200);
    updateStage(env.cleanupDb, 5, {
      progress: { analysisId: 'a5', stage4AnalysisId: 'a4', phase: 'done' } as Record<
        string,
        unknown
      >,
    });
    const uuid = (id: number) =>
      (
        new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true })
          .prepare('SELECT uuid FROM books WHERE id = ?')
          .get(id) as { uuid: string }
      ).uuid;
    const put = env.cleanupDb.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
         evidence_json, class, state, analysis_id, created_at, updated_at)
       VALUES (5, ?, ?, ?, 'tags', ?, ?, 'stage5', ?, 'auto', 'proposed', 'a5', 1, 1)`,
    );
    put.run(
      env.libraryId(),
      ids.A,
      uuid(ids.A),
      JSON.stringify(['PeepoHappyBooks', 'Young Adult Fiction', 'metadata-processed']),
      JSON.stringify({
        add: ['ファンタジー', 'ライトノベル'],
        // A custom tag in a change is never removed (also checked at the write).
        remove: ['Young Adult Fiction', 'metadata-processed', 'PeepoHappyBooks'],
      }),
      JSON.stringify({ title: '本 A' }),
    );
    put.run(
      env.libraryId(),
      ids.B,
      uuid(ids.B),
      JSON.stringify(['ln']),
      JSON.stringify({ add: [], remove: ['ln'] }),
      JSON.stringify({ title: '本 B' }),
    );
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => calibreServer.close(r));
    await env.close();
  });

  function worker() {
    const config: SidecarConfig = {
      serverUrl: url,
      token: env.applyToken(),
      quarantineDir: quarantine,
      calibredb: process.execPath,
      minFreeMb: 1,
      calibredbTimeoutSeconds: 60,
      checkSeconds: 3600,
      requestTimeoutSeconds: 10,
      trashRestoreWaitSeconds: 3,
      removeWaitSeconds: 3,
      waitPollSeconds: 0.1,
      writeWaitSeconds: 2,
      coverTmpDir: makeTempDir('covers'),
    };
    const calibredb = new Calibredb({
      program: process.execPath,
      prefixArgs: [FAKE],
      timeoutMs: 60_000,
      env: {
        FAKE_CALIBRE_LIBRARY: env.lib.dir,
        FAKE_PASSWORD: PASSWORD,
        FAKE_VERSION: '9.18.0',
        FAKE_ILLUSTRATOR: '1',
        FAKE_LOG: log,
        FAKE_TIMES: `${log}.times`,
      },
      helper: null,
    });
    return new Worker({ config, calibredb, log: quiet, retryMinMs: 20, retryMaxMs: 100 });
  }

  async function runBatch(w: Worker) {
    for (let i = 0; i < 20; i++) {
      const r = await w.cycle();
      if (r === 'idle' && !env.service.batches.open()) return;
    }
  }

  /** A tag put on a book in Calibre directly (the user, between the plan and the write). */
  function tagInCalibre(id: number, tag: string) {
    const db = new Database(path.join(env.lib.dir, 'metadata.db'));
    try {
      db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tag);
      const t = db.prepare('SELECT id FROM tags WHERE name = ?').get(tag) as { id: number };
      db.prepare('INSERT INTO books_tags_link (book, tag) VALUES (?, ?)').run(id, t.id);
    } finally {
      db.close();
    }
  }
  const tagsOf = (id: number) => {
    const db = new Database(path.join(env.lib.dir, 'metadata.db'), { readonly: true });
    try {
      return (
        db
          .prepare(
            'SELECT t.name FROM books_tags_link l JOIN tags t ON t.id = l.tag WHERE l.book = ?',
          )
          .all(id) as { name: string }[]
      )
        .map((r) => r.name)
        .sort();
    } finally {
      db.close();
    }
  };

  it('adds and removes as proposed on what Calibre holds at the write; Undo puts back exactly', async () => {
    const plan = await env.service.batches.stage5.plan(env.libraryId());
    expect(plan.batch).not.toBeNull();
    tagInCalibre(ids.A, '自分のタグ');
    const w = worker();
    await runBatch(w);
    expect(tagsOf(ids.A)).toEqual(
      ['PeepoHappyBooks', 'ファンタジー', 'ライトノベル', '自分のタグ'].sort(),
    );
    expect(tagsOf(ids.B)).toEqual([]);
    const state = env.cleanupDb
      .prepare(`SELECT state FROM proposed_changes WHERE stage = 5 ORDER BY calibre_id`)
      .all() as { state: string }[];
    expect(state.map((s) => s.state)).toEqual(['applied', 'applied']);
    const rec = env.cleanupDb
      .prepare(`SELECT old_json, new_json FROM field_undo WHERE calibre_id = ?`)
      .get(ids.A) as { old_json: string; new_json: string };
    const undoRec = JSON.parse(rec.new_json) as { added: string[]; removed: string[] };
    expect(undoRec.added.sort()).toEqual(['ファンタジー', 'ライトノベル']);
    expect(undoRec.removed.sort()).toEqual(['Young Adult Fiction', 'metadata-processed']);
    const applied = env.cleanupDb
      .prepare(
        `SELECT value_json FROM applied_values WHERE field = 'tags' AND calibre_uuid = (
        SELECT calibre_uuid FROM proposed_changes WHERE stage = 5 AND calibre_id = ?)`,
      )
      .get(ids.A) as { value_json: string };
    expect(JSON.parse(applied.value_json)).toEqual({ added: ['ファンタジー', 'ライトノベル'] });
    // The card's progress.
    const st = env.service.stage5Status(env.libraryId(), Date.now() + 60_000) as {
      write: { changes: { done: number; total: number }; books: { done: number } } | null;
    };
    expect(st.write).toMatchObject({ changes: { done: 2, total: 2 }, books: { done: 2 } });

    // Undo: the additions come off, the removals go back; the user's own tag stays.
    tagInCalibre(ids.A, '後のタグ');
    const batchId = (
      env.cleanupDb.prepare(`SELECT id FROM batches WHERE stage = 5 AND kind = 'apply'`).get() as {
        id: string;
      }
    ).id;
    env.service.batches.undo(batchId);
    await runBatch(w);
    expect(env.service.batches.get(batchId)!.state).toBe('undone');
    expect(tagsOf(ids.A)).toEqual(
      [
        'PeepoHappyBooks',
        'Young Adult Fiction',
        'metadata-processed',
        '自分のタグ',
        '後のタグ',
      ].sort(),
    );
    expect(tagsOf(ids.B)).toEqual(['ln']);
  });

  it('a sidecar older than 1.2.0 never gets a stage-5 batch', async () => {
    await env.service.batches.stage5.plan(env.libraryId());
    env.cleanupDb.prepare(`UPDATE sidecar_status SET version = '1.1.0' WHERE id = 1`).run();
    const c = await env.service.batches.claim();
    expect(c.batch).toBeNull();
    expect(c.wait).toMatch(/older than 1\.2\.0/);
  });
});
