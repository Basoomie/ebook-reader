/**
 * WP20e, the stage-4 On preparation (2026-11-21): one spelling per series ("most books'
 * spelling", decided with the user).
 */
import { describe, expect, it } from 'vitest';
import {
  balanced,
  chooseSpellings,
  seriesKey,
  spellingOf,
} from '../src/cleanup/stage4/series-spelling';
import { proposeStage4 } from '../src/cleanup/stage4/proposals';
import type { RefRecord } from '../src/cleanup/stage4/rules-v3';
import type { Stage4Decision } from '../src/cleanup/stage4/stage4-rules';
import type { Stage2Book } from '../src/cleanup/stage2-snapshot';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { makeTempDir } from './helpers/spawn-server';

describe('one spelling per series', () => {
  it('gives spellings that differ only in width, spaces, dashes or punctuation one key', () => {
    const k = seriesKey('Re:ゼロから始める異世界生活');
    expect(seriesKey('Re：ゼロから始める異世界生活')).toBe(k);
    expect(seriesKey('本好きの下剋上 〜司書になるためには手段を選んでいられません〜')).toBe(
      seriesKey('本好きの下剋上～司書になるためには手段を選んでいられません～'),
    );
    expect(seriesKey('「金田一耕助」シリーズ')).toBe(seriesKey('金田一耕助シリーズ'));
    // A short name and the name with its subtitle are different series (spin-offs look alike).
    expect(seriesKey('本好きの下剋上')).not.toBe(
      seriesKey('本好きの下剋上 〜司書になるためには手段を選んでいられません〜'),
    );
    // The long vowel mark is part of the name.
    expect(seriesKey('スター')).not.toBe(seriesKey('スタ'));
  });

  it('knows a name whose wave dashes or brackets do not pair up', () => {
    expect(balanced('無職転生 ~異世界行ったら本気だす~')).toBe(true);
    expect(balanced('無職転生 ~異世界行ったら本気だす')).toBe(false);
    expect(balanced('「金田一耕助」シリーズ')).toBe(true);
    expect(balanced('魔法科高校の劣等生(')).toBe(false);
    expect(balanced('喰 -kuu')).toBe(false);
    expect(balanced('喰 -kuu-')).toBe(true);
    expect(balanced('ソード-アート')).toBe(true);
  });

  it('takes the spelling most books would have, a whole name first, then Calibre, then code order', () => {
    const b = (after: string | null, now: string | null = null) => ({ after, now });
    const map = chooseSpellings([
      ...Array(48).fill(b('Re:ゼロから始める異世界生活')),
      ...Array(3).fill(b('Re：ゼロから始める異世界生活')),
      // The cut-off name has most books but never wins over the whole name.
      ...Array(22).fill(b('無職転生 ~異世界行ったら本気だす')),
      ...Array(4).fill(b('無職転生 ~異世界行ったら本気だす~')),
      ...Array(3).fill(b('無職転生 ～異世界行ったら本気だす～')),
      // A tie: the spelling Calibre has now.
      b('負けヒロインが多すぎる!'),
      b('負けヒロインが多すぎる！', '負けヒロインが多すぎる！'),
      // A tie Calibre doesn't break: code order (half-width first).
      b('りゅうおうのおしごと!'),
      b('りゅうおうのおしごと！'),
      // A name cut before its closing punctuation never wins over the whole name.
      ...Array(3).fill(b('F‐エフ')),
      b('F‐エフ‐'),
      ...Array(4).fill(b('ぷりぷり')),
      b('ぷりぷり!!'),
      // A stray ・ at the end is not a closing mark.
      ...Array(3).fill(b('シャーロック・ホームズ')),
      b('シャーロック・ホームズ・'),
      // One spelling: not in the map.
      ...Array(5).fill(b('ソードアート・オンライン')),
      // Calibre's own name for a book whose series stays counts as that book's.
      b('八男って、それはないでしょう!', '八男って、それはないでしょう!'),
      b('八男って、それはないでしょう！'),
      b('八男って、それはないでしょう!'),
    ]);
    expect(spellingOf(map, 'Re：ゼロから始める異世界生活')).toBe('Re:ゼロから始める異世界生活');
    expect(spellingOf(map, '無職転生 ~異世界行ったら本気だす')).toBe(
      '無職転生 ~異世界行ったら本気だす~',
    );
    expect(spellingOf(map, '負けヒロインが多すぎる!')).toBe('負けヒロインが多すぎる！');
    expect(spellingOf(map, 'りゅうおうのおしごと！')).toBe('りゅうおうのおしごと!');
    expect(spellingOf(map, '八男って、それはないでしょう！')).toBe('八男って、それはないでしょう!');
    expect(spellingOf(map, 'F‐エフ')).toBe('F‐エフ‐');
    expect(spellingOf(map, 'ぷりぷり')).toBe('ぷりぷり!!');
    expect(spellingOf(map, 'シャーロック・ホームズ・')).toBe('シャーロック・ホームズ');
    expect(map.has(seriesKey('ソードアート・オンライン'))).toBe(false);
    expect(spellingOf(map, 'ソードアート・オンライン')).toBe('ソードアート・オンライン');
  });
});

const book: Stage2Book = {
  calibreId: 1,
  uuid: 'u1',
  title: 'Re:ゼロから始める異世界生活 3',
  titleSort: null,
  authors: ['作者'],
  authorSort: null,
  tags: [],
  hasCover: false,
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
  file: { opf_title: book.title },
  amazon: { product: { title: book.title }, picked_from_search: false },
  ranobedb: {},
  bookwalker: {},
} as unknown as RefRecord;
const decision = (se: string | null): Stage4Decision =>
  ({
    values: { t: book.title, au: ['作者'], il: [], se, ix: 3, fmt: 'light novel', kind: 'full' },
    auto: { t: true, au: true, il: true, se: true, ix: true, fmt: true, kind: true },
    numberGuess: null,
    amazonRejected: null,
    kindMarker: null,
    trace: {
      amazonIdentified: true,
      amazonByAsin: true,
      ranobedbIdentified: false,
      amazon: { se },
      cleaned: { file: '', amazon: null, ranobedb: null, bookwalker: null },
      colophonIllustrators: [],
      imprints: [],
    },
  }) as unknown as Stage4Decision;
const map = new Map([[seriesKey('Re:ゼロから始める異世界生活'), 'Re:ゼロから始める異世界生活']]);
const input = (
  se: string | null,
  extras: { series: string | null; seriesIndex: number | null },
  ai: Parameters<typeof proposeStage4>[0]['ai'] = null,
) => ({
  book,
  extras: { comments: null, ...extras } as never,
  record,
  decision: decision(se),
  bookmeter: null,
  natively: null,
  readings: new Map(),
  cover: null,
  applied: new Map(),
  sameDistance: 5,
  smallCoverPx: 800,
  ai,
  seriesSpelling: map,
});
const seriesOf = (ps: ReturnType<typeof proposeStage4>) => ps.find((p) => p.field === 'series');

describe('series proposals with the chosen spelling', () => {
  it('writes the chosen spelling and keeps the decided one in the evidence', () => {
    const p = seriesOf(
      proposeStage4(input('Re：ゼロから始める異世界生活', { series: null, seriesIndex: null })),
    );
    expect(p).toMatchObject({
      class: 'auto',
      new: { name: 'Re:ゼロから始める異世界生活', index: 3 },
      evidence: { spelling: { asDecided: 'Re：ゼロから始める異世界生活' } },
    });
  });

  it("changes only the spelling of Calibre's own name when nothing else changes", () => {
    const p = seriesOf(
      proposeStage4(
        input('Re：ゼロから始める異世界生活', {
          series: 'Re：ゼロから始める異世界生活',
          seriesIndex: 3,
        }),
      ),
    );
    expect(p).toMatchObject({
      class: 'auto',
      old: { name: 'Re：ゼロから始める異世界生活', index: 3 },
      new: { name: 'Re:ゼロから始める異世界生活', index: 3 },
    });
    // The decided name is the chosen one and equals Calibre's but for the spelling: Calibre's
    // name would be kept as it is, so only its spelling changes.
    const kept = seriesOf(
      proposeStage4(
        input('Re:ゼロから始める異世界生活', {
          series: 'Re：ゼロから始める異世界生活',
          seriesIndex: 3,
        }),
      ),
    );
    expect(kept).toMatchObject({
      source: 'spelling',
      new: { name: 'Re:ゼロから始める異世界生活', index: 3 },
    });
    // Already the chosen spelling: nothing.
    expect(
      seriesOf(
        proposeStage4(
          input('Re：ゼロから始める異世界生活', {
            series: 'Re:ゼロから始める異世界生活',
            seriesIndex: 3,
          }),
        ),
      ),
    ).toBeUndefined();
  });

  it('never changes a value the user set', () => {
    const user = {
      value: { name: 'Re：ゼロから始める異世界生活' },
      source: 'user',
      flagged: false,
      reason: null,
    };
    const p = seriesOf(
      proposeStage4(
        input('Re：ゼロから始める異世界生活', { series: null, seriesIndex: null }, {
          asked: true,
          se: user,
        } as never),
      ),
    );
    expect(p?.new).toMatchObject({ name: 'Re：ゼロから始める異世界生活' });
  });
});

describe("the AI step's spelling phase", () => {
  it("chooses after deciding, proposes those series' books again, then runs the gate", async () => {
    const { Stage4Ai } = await import('../src/cleanup/stage4/ai-step');
    const { AiRunner } = await import('../src/cleanup/ai/runner');
    const s = initCleanupDatabase(makeTempDir('wp20e-spell'));
    if (!s.ok) throw new Error(s.error);
    const db = s.db;
    const ai: Record<string, unknown> = {
      analysisId: 'run1',
      rulesFinishedAt: 5,
      phase: 'spelling',
      cursor: 0,
      items: 4,
      decided: 4,
      invented: 0,
      finishedAt: null,
      gate: null,
      times: {},
      seriesSpelling: { at: 1, names: { [seriesKey('古い')]: '古い' } },
    };
    const progress = {
      analysisId: 'run1',
      libraryId: 'lib',
      phase: 'done',
      finishedAt: 5,
      bookmeterEditions: { phase: 'done' },
      ai,
    };
    const proposed: string[] = [];
    const analysis = {
      progress: () => progress,
      seriesAfterOn: () => [
        { uuid: 'a', after: 'X!', now: null },
        { uuid: 'b', after: 'X!', now: null },
        { uuid: 'c', after: 'X！', now: null },
        { uuid: 'd', after: 'Y', now: null },
        { uuid: 'e', after: null, now: '古い' },
      ],
      proposeWithAi: async (_p: unknown, uuid: string) => {
        proposed.push(uuid);
        return true;
      },
    };
    const step = new Stage4Ai({
      db,
      runner: new AiRunner({ db, secrets: { read: () => null } }),
      analysis: analysis as never,
    });
    await step.step(() => false);
    expect(ai.seriesSpelling).toMatchObject({ names: { [seriesKey('X!')]: 'X!' } });
    expect(Object.keys((ai.seriesSpelling as { names: object }).names)).toHaveLength(1);
    // X's books, and the book of the last choice's series.
    expect(proposed).toEqual(['a', 'b', 'c', 'e']);
    expect(ai.spelling).toEqual({ series: 1, books: 4, total: 4 });
    expect(ai.phase).toBe('gate');
  });
});
