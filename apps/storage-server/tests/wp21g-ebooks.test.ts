/**
 * WP21g: audiobook stage 8, the second pass from the Calibre ebooks. The pairing rules on real
 * names from the live library (each case below was a wrong pair or a review item in the stop-1
 * measurement, `scripts/wp21g-measure.ts`), the series rule, the genres/tags split, the stage's
 * passes on a cleanup.db and a Calibre snapshot copy (what changed is noticed by one stat when
 * nothing did; new, changed, renamed and removed ebooks), covers under the disk lock, the gate,
 * the overlay into metadata.json, and the library changes' ownership and move protection.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bareTitle,
  ebookTerms,
  judge,
  labelNumber,
  ownNumbers,
  pairRecording,
  partOf,
  type AudioFacts,
  type EbookFacts,
} from '../src/cleanup/audio/ebook-pair';
import { readEbookSnapshot } from '../src/cleanup/audio/ebook-snapshot';
import {
  AudioStage8,
  LOST,
  scoreEbookGate,
  seriesOpen,
  titleNamesSeries,
  type CalibreTarget,
} from '../src/cleanup/audio/stage8-ebooks';
import { absMetadata, bookValues } from '../src/cleanup/audio/build-metadata';
import { fieldState, planLibraryChanges, type LedgerBook } from '../src/cleanup/audio/library-plan';
import type { PlannedBook } from '../src/cleanup/audio/build-plan';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { setAudioStageMode } from '../src/cleanup/audio/audio-stages';
import { makeTempDir } from './helpers/spawn-server';
import express from 'express';
import request from 'supertest';
import { createCleanupLinkRouter } from '../src/cleanup/audio/link-routes';
import { LIBRARY_BATCH_BASE } from '../src/cleanup/audio/library-changes';
import { BOOK_ARCHIVE_BATCH_BASE } from '../src/cleanup/arrivals/archives';
import { createApplyToken } from '../src/cleanup/apply-tokens';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const S = { titleScore: 0.9, titleMinChars: 3, titleMinShare: 0.25 };

function audio(title: string, authors: string[], more: Partial<AudioFacts> = {}): AudioFacts {
  return {
    unitKey: 'u',
    kind: 'record',
    title,
    otherTitles: [],
    authors,
    series: [],
    drama: false,
    ...more,
  };
}
function ebook(
  id: number,
  title: string,
  authors: string[],
  more: Partial<EbookFacts> = {},
): EbookFacts {
  return { id, title, authors, series: null, index: null, tags: ['小説'], ...more };
}
const ser = (name: string, position: number | null, label: string | null = null) => [
  { name, position, label },
];

describe('WP21g pairing rules (real names from the stop-1 measurement)', () => {
  it('pairs the exact volume and only it', () => {
    const a = audio('ロクでなし魔術講師と禁忌教典3', ['羊太郎'], {
      series: ser('ロクでなし魔術講師と禁忌教典', 3, '3'),
    });
    const r = pairRecording(
      a,
      [
        ebook(1, 'ロクでなし魔術講師と禁忌教典3', ['羊太郎'], {
          series: 'ロクでなし魔術講師と禁忌教典',
          index: 3,
        }),
        ebook(2, 'ロクでなし魔術講師と禁忌教典17', ['羊太郎'], {
          series: 'ロクでなし魔術講師と禁忌教典',
          index: 17,
        }),
        ebook(3, 'ロクでなし魔術講師と禁忌教典', ['羊太郎'], {
          series: 'ロクでなし魔術講師と禁忌教典',
          index: 1,
        }),
      ],
      S,
    );
    expect(r.class).toBe('auto');
    expect(r.calibreId).toBe(1);
  });

  it('never pairs a volume printed in a bracket with another number: 転生貴族…(9)', () => {
    const a = audio(
      '転生貴族、鑑定スキルで成り上がる ～弱小領地を受け継いだので、優秀な人材を増やしていたら、最強領地になってた～',
      ['未来人A'],
      {
        series: ser('転生貴族、鑑定スキルで成り上がる', 1, '1'),
      },
    );
    const e = ebook(
      12255,
      '転生貴族、鑑定スキルで成り上がる ~弱小領地を受け継いだので、優秀な人材を増やしていたら、最強領地になってた~(9)',
      ['井上菜摘', '未来人A'],
    );
    expect(judge(a, e, S).outcome).toBe('fail');
  });

  it('a pair share below the bar is another book: 知っておきたい日本の神話 / 名僧', () => {
    const a = audio('知っておきたい日本の神話', ['瓜生中']);
    const e = ebook(11973, '知っておきたい日本の名僧', ['瓜生中'], {
      series: '知っておきたい',
      index: 21,
    });
    expect(judge(a, e, S).outcome).toBe('fail');
  });

  it("the store's short title never pairs another edition's volume: 三国志10 五丈原の巻 / 三国志 10 出師の巻", () => {
    const a = audio('三国志10 五丈原の巻', ['吉川英治'], {
      series: ser('三国志', 10, '10'),
      otherTitles: ['三国志 10'],
    });
    expect(
      judge(a, ebook(38034, '三国志 10 出師の巻', ['吉川英治'], { series: '三国志', index: 10 }), S)
        .outcome,
    ).toBe('fail');
    const b = audio('三国志 02 群青の巻', ['吉川英治'], {
      series: ser('三国志', 2, '2'),
      otherTitles: ['三国志 02'],
    });
    expect(
      judge(b, ebook(46249, '三国志（二）', ['吉川英治'], { series: '三国志', index: 2 }), S)
        .outcome,
    ).not.toBe('pass');
  });

  it('reads a bracketed store label: 骨音―池袋ウエストゲートパーク＜3＞ is not vol. 1', () => {
    expect(labelNumber('＜3＞')).toBe(3);
    const a = audio('骨音―池袋ウエストゲートパーク＜3＞', ['石田衣良'], {
      series: ser('池袋ウエストゲートパーク', 3, '＜3＞'),
    });
    expect(
      judge(
        a,
        ebook(4118, '池袋ウエストゲートパーク', ['石田衣良'], {
          series: '池袋ウエストゲートパーク',
          index: 1,
        }),
        S,
      ).outcome,
    ).toBe('fail');
  });

  it('a later volume titled after its own subtitle is never vol. 1 of the series name: スマホ… 囚われの殺人鬼', () => {
    const a = audio('スマホを落としただけなのに 囚われの殺人鬼', ['志駕晃'], {
      series: ser('スマホを落としただけなのに', 2),
    });
    const r = pairRecording(
      a,
      [
        ebook(12263, 'スマホを落としただけなのに', ['志駕晃'], {
          series: 'スマホを落としただけなのに',
          index: 1,
        }),
      ],
      S,
    );
    expect(r.class).toBe('review');
  });

  it('reads （前）/（後） as parts: 魔法少女育成計画limited（前）', () => {
    expect(partOf('魔法少女育成計画limited（前）')).toBe('上');
    expect(partOf('魔法少女育成計画limited（後）')).toBe('下');
    expect(partOf('前を向いて')).toBeNull();
    const a = audio('魔法少女育成計画limited（前）', ['遠藤浅蜊']);
    const r = pairRecording(
      a,
      [
        ebook(9180, '魔法少女育成計画limited（前）', ['遠藤浅蜊'], {
          series: '魔法少女育成計画',
          index: 5,
        }),
        ebook(9182, '魔法少女育成計画limited（後）', ['遠藤浅蜊'], {
          series: '魔法少女育成計画',
          index: 6,
          tags: ['小説', 'ファンタジー'],
        }),
      ],
      S,
    );
    expect(r).toMatchObject({ class: 'auto', calibreId: 9180 });
  });

  it('a mark is part of the title: GJ部◎ is not GJ部', () => {
    const a = audio('GJ部◎', ['新木伸'], { series: ser('GJ部', null) });
    const both = pairRecording(
      a,
      [
        ebook(7894, 'GJ部', ['新木伸'], { series: 'GJ部', index: 1 }),
        ebook(7898, 'GJ部◎', ['新木伸'], { series: 'GJ部', index: 10 }),
      ],
      S,
    );
    expect(both).toMatchObject({ class: 'auto', calibreId: 7898 });
    expect(
      pairRecording(a, [ebook(7894, 'GJ部', ['新木伸'], { series: 'GJ部', index: 1 })], S).class,
    ).toBe('review');
  });

  it('every number counts: 第一部「兵士の娘2」 is not 第一部 兵士の娘3', () => {
    expect(
      ownNumbers('本好きの下剋上 第一部 兵士の娘2', '本好きの下剋上 第一部 兵士の娘3'),
    ).toEqual({ a: [2], b: [3] });
    const a = audio(
      '本好きの下剋上～司書になるためには手段を選んでいられません～第一部「兵士の娘2」',
      ['香月美夜'],
      { series: ser('本好きの下剋上', 2, '2') },
    );
    expect(
      judge(
        a,
        ebook(4959, '本好きの下剋上 第一部 兵士の娘3', ['香月美夜'], {
          series: '本好きの下剋上',
          index: 3,
        }),
        S,
      ).outcome,
    ).toBe('fail');
  });

  it('dates and counts are not volumes; the shared part never ends inside a number', () => {
    expect(ownNumbers('1Q84―BOOK1〈4月－6月〉', '1Q84 BOOK1')).toEqual({ a: [1], b: [1] });
    expect(ownNumbers('X 1', 'X 11')).toEqual({ a: [1], b: [11] });
    expect(
      ownNumbers(
        '老後に備えて異世界で8万枚の金貨を貯めます2',
        '老後に備えて異世界で8万枚の金貨を貯めます',
      ),
    ).toEqual({ a: [2], b: [] });
    expect(bareTitle('緋弾のアリアXLIII ローマで返して')).toBe(
      bareTitle('緋弾のアリア43 ローマで返して'),
    );
  });

  it('a part of one printed volume pairs with that volume; an ebook in parts against a whole recording is review', () => {
    const a = audio('幼女戦記 11 Alea iacta est 後編', ['カルロ・ゼン'], {
      series: ser('幼女戦記', 22, '11巻・後編'),
    });
    const r = pairRecording(
      a,
      [
        ebook(6955, '幼女戦記 11 Alea iacta est', ['カルロ・ゼン'], {
          series: '幼女戦記',
          index: 11,
        }),
      ],
      S,
    );
    expect(r).toMatchObject({ class: 'auto', calibreId: 6955 });
    expect(r.candidates[0].split).toBe(true);
    const whole = audio('海賊とよばれた男', ['百田尚樹']);
    const w = pairRecording(
      whole,
      [
        ebook(6371, '海賊とよばれた男（上）', ['百田尚樹'], {
          series: '海賊とよばれた男',
          index: 1,
        }),
        ebook(15056, '海賊とよばれた男（下）', ['百田尚樹'], {
          series: '海賊とよばれた男',
          index: 2,
        }),
      ],
      S,
    );
    expect(w.class).toBe('review');
    const part = audio('海賊とよばれた男 上', ['百田尚樹']);
    expect(
      pairRecording(
        part,
        [
          ebook(6371, '海賊とよばれた男（上）', ['百田尚樹'], {
            series: '海賊とよばれた男',
            index: 1,
          }),
          ebook(15056, '海賊とよばれた男（下）', ['百田尚樹'], {
            series: '海賊とよばれた男',
            index: 2,
          }),
        ],
        S,
      ),
    ).toMatchObject({ class: 'auto', calibreId: 6371 });
  });

  it('never pairs AI books, radio clips, drama CDs, a manga or a side book', () => {
    for (const a of [
      audio('X', ['A'], { kind: 'ai' }),
      audio('X', ['A'], { kind: 'radio' }),
      audio('穏やか貴族の休暇のすすめ。ドラマCD2', ['岬'], { drama: true }),
      audio('X', ['A'], { series: ser('X ドラマCD', 2) }),
    ])
      expect(pairRecording(a, [ebook(1, 'X', ['A'])], S).class).toBe('excluded');
    expect(
      pairRecording(
        audio('1984', ['ジョージ・オーウェル']),
        [ebook(5263, '1984年', ['ジョージ・オーウェル'], { tags: ['マンガ'] })],
        S,
      ).class,
    ).not.toBe('auto');
    expect(
      pairRecording(
        audio('蜘蛛ですが、なにか？ 2', ['馬場翁'], { series: ser('蜘蛛ですが、なにか?', 2, '2') }),
        [
          ebook(16174, '蜘蛛ですが、なにか？ Ex2', ['馬場翁'], {
            series: '蜘蛛ですが、なにか?',
            index: 2,
          }),
        ],
        S,
      ).class,
    ).not.toBe('auto');
  });

  it('another work joined on, or an arc numbered again, is review', () => {
    expect(
      pairRecording(
        audio('杜子春', ['芥川龍之介']),
        [ebook(58357, '杜子春・南京の基督', ['芥川龍之介'])],
        S,
      ).class,
    ).toBe('review');
    const a = audio('やはり俺の青春ラブコメはまちがっている。1', ['渡航'], {
      series: ser('やはり俺の青春ラブコメはまちがっている。', 1, '1'),
    });
    expect(
      pairRecording(
        a,
        [
          ebook(12793, 'やはり俺の青春ラブコメはまちがっている。結1', ['渡航'], {
            series: 'やはり俺の青春ラブコメはまちがっている。',
            index: 15,
          }),
        ],
        S,
      ).class,
    ).toBe('review');
  });

  it('copies of one volume pair with the one with its series and the most terms', () => {
    const r = pairRecording(
      audio('安達としまむら5', ['入間人間'], { series: ser('安達としまむら', 5, '5') }),
      [
        ebook(4413, '安達としまむら5 (電撃文庫)', ['入間 人間']),
        ebook(6267, '安達としまむら5', ['入間人間'], {
          series: '安達としまむら',
          index: 5,
          tags: ['ライトノベル', '百合'],
        }),
      ],
      S,
    );
    expect(r).toMatchObject({ class: 'auto', calibreId: 6267 });
  });

  it('no author, or the same title by someone else, is review', () => {
    expect(pairRecording(audio('河童', []), [ebook(56173, '河童', ['芥川竜之介'])], S).class).toBe(
      'review',
    );
    expect(
      pairRecording(audio('河童', ['芥川龍之介']), [ebook(56173, '河童', ['芥川竜之介'])], S).class,
    ).toBe('review');
  });

  it("the ebook's tags: genres and subjects to Genres; story tags, adaptations and format to Tags; yours never", () => {
    const t = ebookTerms([
      'TMW-collection-3',
      'ライトノベル',
      'アニメ化',
      '男性主人公',
      'ファンタジー',
      '自己啓発',
      'PeepoHappyBooks',
      'Kakuyomu',
    ]);
    expect(t.genres).toEqual(['ファンタジー', '自己啓発']);
    expect(t.tags).toEqual(['男性主人公', 'アニメ化', 'ライトノベル']);
  });
});

describe('WP21g series rule', () => {
  it('fills only where stage 5 has no store, folder or user series', () => {
    expect(seriesOpen(undefined)).toBe(true);
    expect(seriesOpen({ value: null, source: 'unknown', rules: null })).toBe(true);
    expect(seriesOpen({ value: [], source: 'rules', rules: [] })).toBe(true);
    expect(seriesOpen({ value: ser('彩雲国物語', 11), source: 'both_models', rules: null })).toBe(
      true,
    );
    expect(
      seriesOpen({ value: ser('彩雲国物語', 11), source: 'rules', rules: ser('彩雲国物語', 11) }),
    ).toBe(false);
    expect(seriesOpen({ value: ser('X', 2), source: 'both_models', rules: ser('X', 2) })).toBe(
      false,
    );
    expect(seriesOpen({ value: [], source: 'user', rules: null })).toBe(false);
    expect(
      titleNamesSeries(
        '老後に備えて異世界で8万枚の金貨を貯めます7',
        '老後に備えて異世界で8万枚の金貨を貯めます',
      ),
    ).toBe(true);
    expect(titleNamesSeries('人間失格', 'Reading Japanese Literature in Japanese')).toBe(false);
  });
});

describe('WP21g gate', () => {
  it('passes only with no wrong automatic pair; counts per kind', () => {
    const labels = [
      { id: 'E1', kind: 'audible', torrent: 'a.m4b', calibre: [1] },
      { id: 'E2', kind: 'audible', torrent: 'b.m4b', calibre: null },
      { id: 'E3', kind: 'kikubon', torrent: 'c.m4b', calibre: [3] },
    ];
    const units: Record<string, string> = { 'a.m4b': 'ua', 'b.m4b': 'ub', 'c.m4b': 'uc' };
    const good = scoreEbookGate(
      labels,
      (t) => units[t] ?? null,
      (u) =>
        ({
          ua: { cls: 'auto', id: 1, title: 'A' },
          ub: { cls: 'none', id: null, title: 'B' },
          uc: { cls: 'review', id: 3, title: 'C' },
        })[u] ?? null,
    );
    expect(good.passed).toBe(true);
    expect(good.kinds.audible).toMatchObject({
      withEbook: 1,
      found: 1,
      right: 1,
      none: 1,
      noneRight: 1,
    });
    expect(good.kinds.kikubon).toMatchObject({ withEbook: 1, found: 0, review: 1 });
    const bad = scoreEbookGate(
      labels,
      (t) => units[t] ?? null,
      (u) =>
        u === 'ub' ? { cls: 'auto', id: 9, title: 'B' } : { cls: 'none', id: null, title: '' },
    );
    expect(bad.passed).toBe(false);
    expect(bad.wrong).toEqual([{ id: 'E2', title: 'B', got: 9, want: null }]);
  });
});

describe('WP21g metadata.json and the library changes', () => {
  it('writes the ebook terms first, then ドラマCD/複数ナレーター; unchanged without stage 8', () => {
    const base = { title: 'T', authors: ['A'], multi_narr: true };
    expect(absMetadata(bookValues(base, 'x'))).toMatchObject({
      tags: ['複数ナレーター'],
      genres: [],
    });
    const v = bookValues(
      {
        ...base,
        genres: ['ファンタジー'],
        ebook_tags: ['男性主人公', 'ライトノベル'],
        series: ser('S', 2),
        series_from: 'ebook',
      },
      'x',
    );
    expect(v.seriesFromEbook).toBe(true);
    expect(absMetadata(v)).toMatchObject({
      tags: ['男性主人公', 'ライトノベル', '複数ナレーター'],
      genres: ['ファンタジー'],
      series: ['S #2'],
    });
  });

  it("ABS's genre fill from the file's genre tag is not your edit; a genre you set is", () => {
    const written = { genres: [] };
    const tags = { genre: '文学・フィクション・ライトノベル, ライトノベル(ラノベ)' };
    const fill = { genres: ['文学・フィクション・ライトノベル, ライトノベル(ラノベ)'] };
    expect(
      fieldState({
        field: 'genres',
        disk: fill,
        written,
        seen: null,
        before: null,
        yours: false,
        tags,
      }),
    ).toBe('abs_fill');
    expect(
      fieldState({
        field: 'genres',
        disk: { genres: ['推し'] },
        written,
        seen: null,
        before: null,
        yours: false,
        tags,
      }),
    ).toBe('yours');
  });

  it('a move the ebook series causes waits while anyone listens; "Move now" moves it', () => {
    const meta = (o: Record<string, unknown>) =>
      Buffer.from(
        JSON.stringify(
          { title: 'T', authors: ['A'], series: [], genres: [], tags: [], ...o },
          null,
          2,
        ) + '\n',
      );
    const book: LedgerBook = {
      id: 1,
      folder: 'japanese/A/T',
      baseFolder: 'japanese/A/T',
      area: 'main',
      files: [{ fileId: 10, name: 'T.m4b', ino: 5 }],
      metadata: meta({}),
      decided: meta({}),
      folderIno: 77,
    };
    const cur = {
      state: 'build',
      area: 'main',
      unitKey: 'u1',
      copyKey: 'c1',
      author: 'A',
      series: 'S',
      title: 'T',
      notes: [],
      pdfs: [],
      folder: 'japanese/A/S/Vol 2 - T',
      baseFolder: 'japanese/A/S/Vol 2 - T',
      files: [{ fileId: 10, dst: 'japanese/A/S/Vol 2 - T/T.m4b' }],
      metadata: meta({ series: ['S #2'] }),
      values: {
        ...bookValues(
          { title: 'T', authors: ['A'], series: ser('S', 2), series_from: 'ebook' },
          'T',
        ),
        narrators: [],
      },
    } as unknown as PlannedBook;
    const listen = {
      found: true,
      itemId: 'li',
      inProgress: true,
      finished: false,
      bookmarks: 0,
      places: [],
    };
    const plan = (abs: typeof listen | null, choices: Record<string, string> = {}) =>
      planLibraryChanges({
        books: [book],
        current: () => cur,
        disk: () => book.metadata,
        abs: () => abs,
        keep: () => null,
        tree: {
          dirs: new Set(['japanese', 'japanese/A', 'japanese/A/T']),
          bookDirs: new Set(['japanese/A/T']),
          narrators: new Map(),
        },
        choices: () => choices,
      })[0];
    const held = plan(listen);
    expect(held.folderTo).toBeNull();
    expect(held.reviews.map((r) => r.kind)).toContain('ebook_series_listening');
    expect(held.metadataNew).not.toBeNull();
    expect(plan(null).folderTo).toBeNull();
    expect(plan({ ...listen, inProgress: false }).folderTo).toBe('japanese/A/S/Vol 2 - T');
    expect(plan(listen, { move: 'now' }).folderTo).toBe('japanese/A/S/Vol 2 - T');
  });
});

// ---------------------------------------------------------------------------------------------
// The stage on a cleanup.db and a Calibre snapshot copy

function makeCalibre(
  file: string,
  books: {
    id: number;
    title: string;
    authors: string[];
    series?: string;
    index?: number;
    tags?: string[];
    cover?: boolean;
    mod?: string;
  }[],
) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE books (id INTEGER PRIMARY KEY, uuid TEXT, title TEXT, author_sort TEXT, series_index REAL DEFAULT 1, has_cover INTEGER DEFAULT 0, path TEXT, last_modified TEXT);
    CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT UNIQUE, sort TEXT);
    CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
    CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
    CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
  `);
  const upsert = (table: string, name: string) => {
    db.prepare(`INSERT OR IGNORE INTO ${table} (name) VALUES (?)`).run(name);
    return (db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name) as { id: number }).id;
  };
  for (const b of books) {
    db.prepare(
      'INSERT INTO books (id, uuid, title, author_sort, series_index, has_cover, path, last_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      b.id,
      `uuid-${b.id}`,
      b.title,
      b.authors.join(' & '),
      b.index ?? 1,
      b.cover ? 1 : 0,
      `${b.authors[0]}/${b.title} (${b.id})`,
      b.mod ?? '2026-11-01 00:00:00+00:00',
    );
    for (const a of b.authors)
      db.prepare('INSERT INTO books_authors_link (book, author) VALUES (?, ?)').run(
        b.id,
        upsert('authors', a),
      );
    if (b.series)
      db.prepare('INSERT INTO books_series_link (book, series) VALUES (?, ?)').run(
        b.id,
        upsert('series', b.series),
      );
    for (const t of b.tags ?? [])
      db.prepare('INSERT INTO books_tags_link (book, tag) VALUES (?, ?)').run(
        b.id,
        upsert('tags', t),
      );
    db.prepare('INSERT INTO comments (book, text) VALUES (?, ?)').run(
      b.id,
      `<p>${b.title}の説明</p>`,
    );
  }
  db.close();
}

function seedStage5(
  db: Database.Database,
  units: {
    key: string;
    kind?: string;
    title: string;
    authors: string[];
    series?: unknown;
    seriesSource?: string;
    seriesRules?: unknown;
    drama?: boolean;
  }[],
) {
  db.prepare('UPDATE audio_stages SET progress_json = ? WHERE stage = 5').run(
    JSON.stringify({ analysisId: 'a5', stage4Id: 'a4', phase: 'done', rulesKey: 'r', askKey: 'k' }),
  );
  const now = Date.now();
  for (const u of units) {
    db.prepare(
      "INSERT INTO audio_meta_units (analysis_id, unit_key, name, kind, state, updated_at) VALUES ('a5', ?, ?, ?, 'decided', ?)",
    ).run(u.key, u.title, u.kind ?? 'record', now);
    const put = db.prepare(
      "INSERT INTO ai_values (stage, item_key, field, value_json, source, flagged, rules_json, decided_at) VALUES ('audio5', ?, ?, ?, ?, 0, ?, ?) ON CONFLICT DO UPDATE SET value_json = excluded.value_json, source = excluded.source, rules_json = excluded.rules_json",
    );
    put.run(u.key, 'title', JSON.stringify(u.title), 'rules', null, now);
    put.run(u.key, 'authors', JSON.stringify(u.authors), 'rules', null, now);
    put.run(
      u.key,
      'series',
      JSON.stringify(u.series ?? []),
      u.seriesSource ?? 'rules',
      u.seriesRules === undefined ? null : JSON.stringify(u.seriesRules),
      now,
    );
    put.run(u.key, 'drama', JSON.stringify(u.drama ?? false), 'rules', null, now);
    put.run(
      u.key,
      'store_id',
      JSON.stringify(`audible:B0${u.key.padStart(8, '0').slice(-8)}`),
      'rules',
      null,
      now,
    );
  }
}

async function runPass(s8: AudioStage8, runId = 1, onWait: () => void = () => undefined) {
  s8.begin(runId);
  for (let i = 0; i < 500; i++) {
    const r = await s8.step(() => false, null);
    if (r === 'done') return;
    if (r === 'wait') onWait();
    if (typeof r === 'object') throw new Error(r.stop);
  }
  throw new Error('the pass did not finish');
}

describe('WP21g stage 8 passes', () => {
  function setup() {
    const dir = makeTempDir('wp21g');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const s = initCleanupDatabase(dir);
    if (!s.ok) throw new Error(s.error);
    const db = s.db;
    cleanups.push(() => db.close());
    const snap = path.join(dir, 'snapshot.db');
    const lib = path.join(dir, 'calibre', 'japanese-library');
    fs.mkdirSync(lib, { recursive: true });
    const target: CalibreTarget = { libraryId: 'lib1', snapshotFile: snap, libraryDir: lib };
    const lock = new DiskLock();
    const labels = { text: JSON.stringify({ books: [] }) as string | null };
    const s8 = new AudioStage8({
      db,
      lock,
      calibre: () => target,
      readLabels: () => ({ text: labels.text, error: null }),
    });
    return { dir, db, snap, lib, lock, s8, labels };
  }

  it('pairs, fills, reviews; then notices only what changed in Calibre', async () => {
    const { db, snap, lib, s8, lock } = setup();
    makeCalibre(snap, [
      {
        id: 1,
        title: '老後に備えて異世界で8万枚の金貨を貯めます7',
        authors: ['FUNA'],
        series: '老後に備えて異世界で8万枚の金貨を貯めます',
        index: 7,
        tags: ['ライトノベル', 'ファンタジー', '異世界', 'TMW-collection-4'],
        cover: true,
      },
      {
        id: 2,
        title: '人間失格',
        authors: ['太宰治'],
        series: 'Reading Japanese Literature in Japanese',
        index: 1,
        tags: ['小説'],
      },
      {
        id: 3,
        title: '風の万里 黎明の空（上）',
        authors: ['小野不由美'],
        series: '十二国記',
        index: 6,
        tags: ['小説', 'ファンタジー'],
      },
    ]);
    // The cover of book 1 (read under the disk lock; Calibre's own file, only read).
    const coverDir = path.join(lib, 'FUNA', '老後に備えて異世界で8万枚の金貨を貯めます7 (1)');
    fs.mkdirSync(coverDir, { recursive: true });
    fs.writeFileSync(path.join(coverDir, 'cover.jpg'), 'JPEG');
    seedStage5(db, [
      {
        key: 'u1',
        title: '老後に備えて異世界で8万枚の金貨を貯めます7',
        authors: ['FUNA'],
        series: null,
        seriesSource: 'unknown',
      },
      { key: 'u2', title: '人間失格', authors: ['太宰治'], series: [] },
      {
        key: 'u3',
        title: '風の万里 黎明の空（上）',
        authors: ['小野不由美'],
        series: ser('十二国記', 6, '6'),
        seriesRules: ser('十二国記', 6, '6'),
      },
      { key: 'u4', title: '侠飯5 嵐のペンション篇', authors: ['福澤徹三'] },
      { key: 'u5', title: '穏やか貴族の休暇のすすめ。ドラマCD2', authors: ['岬'], drama: true },
    ]);
    setAudioStageMode(db, 8, 'analyse');
    // Calibre uses the disk: the covers wait, then go on.
    lock.tryAcquire('Calibre stage 1', 'calibre');
    let waited = 0;
    await runPass(s8, 1, () => {
      waited++;
      expect(s8.progress()).toMatchObject({
        phase: 'covers',
        waiting: expect.stringMatching(/Calibre/),
      });
      lock.release('Calibre stage 1');
    });
    expect(waited).toBe(1);
    const p = s8.progress()!;
    expect(p.counts).toMatchObject({ auto: 3, none: 1, excluded: 1 });
    const v = s8.values();
    expect(v.get('u1')).toMatchObject({
      genres: ['ファンタジー', '異世界'],
      ebook_tags: ['ライトノベル'],
      series: ser('老後に備えて異世界で8万枚の金貨を貯めます', 7),
      series_from: 'ebook',
    });
    expect(v.get('u2')?.series).toBeUndefined();
    expect(v.get('u3')?.series).toBeUndefined();
    expect(s8.list('series-review').items).toMatchObject([{ unitKey: 'u2' }]);
    const cover = db
      .prepare(
        'SELECT cover_json, description, authors_json FROM audio_ebook_books WHERE calibre_id = 1',
      )
      .get() as { cover_json: string; description: string; authors_json: string };
    expect(JSON.parse(cover.cover_json)).toMatchObject({ size: 4 });
    expect(cover.description).toBe('老後に備えて異世界で8万枚の金貨を貯めます7の説明');
    // Nothing changed: the next pass is one stat.
    await runPass(s8, 2);
    expect(s8.progress()!.reason).toMatch(/Nothing changed/);
    // Calibre changes: a tag renamed (no last_modified change), a new ebook, a removed one.
    const c = new Database(snap);
    c.prepare("UPDATE tags SET name = '冒険' WHERE name = '異世界'").run();
    c.prepare(
      "INSERT INTO books (id, uuid, title, author_sort, series_index, path, last_modified) VALUES (4, 'uuid-4', '侠飯5 嵐のペンション篇', '福澤徹三', 5, 'x', '2026-11-22')",
    ).run();
    c.prepare("INSERT INTO authors (name, sort) VALUES ('福澤徹三', 'フクザワ, テツゾウ')").run();
    c.prepare(
      "INSERT INTO books_authors_link (book, author) VALUES (4, (SELECT id FROM authors WHERE name = '福澤徹三'))",
    ).run();
    c.prepare('DELETE FROM books WHERE id = 2').run();
    c.close();
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(snap, t, t);
    await runPass(s8, 3);
    const p3 = s8.progress()!;
    expect(p3.ebooks).toMatchObject({ changed: 1, new: 1, removed: 1 });
    expect(s8.values().get('u1')?.genres).toEqual(['ファンタジー', '冒険']);
    expect(
      db.prepare("SELECT class, calibre_id FROM audio_ebook_pairs WHERE unit_key = 'u4'").get(),
    ).toEqual({ class: 'auto', calibre_id: 4 });
    expect(
      db.prepare("SELECT class, reason FROM audio_ebook_pairs WHERE unit_key = 'u2'").get(),
    ).toEqual({ class: 'review', reason: LOST });
    // Your choice for the lost one: no ebook.
    s8.choose('u2', 'pair', null);
    await runPass(s8, 4);
    expect(db.prepare("SELECT class FROM audio_ebook_pairs WHERE unit_key = 'u2'").get()).toEqual({
      class: 'none',
    });
  });

  it("the other recordings' series name only when this title names it (とある飛空士への追憶); else review, and your choice takes Calibre's", async () => {
    const { db, snap, s8 } = setup();
    makeCalibre(snap, [
      {
        id: 1,
        title: 'とある飛空士への恋歌2',
        authors: ['犬村小六'],
        series: '飛空士シリーズ',
        index: 3,
        tags: ['ライトノベル'],
      },
      {
        id: 2,
        title: 'とある飛空士への追憶',
        authors: ['犬村小六'],
        series: '飛空士シリーズ',
        index: 1,
        tags: ['ライトノベル'],
      },
    ]);
    seedStage5(db, [
      {
        key: 'u1',
        title: 'とある飛空士への恋歌2',
        authors: ['犬村小六'],
        series: ser('とある飛空士への恋歌', 2),
        seriesRules: ser('とある飛空士への恋歌', 2),
      },
      {
        key: 'u2',
        title: 'とある飛空士への追憶',
        authors: ['犬村小六'],
        series: null,
        seriesSource: 'unknown',
      },
    ]);
    setAudioStageMode(db, 8, 'analyse');
    await runPass(s8, 1);
    expect(s8.values().get('u2')?.series).toBeUndefined();
    expect(s8.list('series-review').items).toMatchObject([
      {
        unitKey: 'u2',
        name: '飛空士シリーズ',
        reason: expect.stringMatching(/carry 「とある飛空士への恋歌」/),
      },
    ]);
    s8.choose('u2', 'series', 'calibre');
    await runPass(s8, 2);
    expect(s8.values().get('u2')).toMatchObject({
      series: ser('飛空士シリーズ', 1),
      series_from: 'ebook',
    });
  });

  it('the overlay only when On and the gate passed; the gate stops an On pass', async () => {
    const { db, snap, s8, labels } = setup();
    makeCalibre(snap, [
      { id: 1, title: 'A本', authors: ['著者'], tags: ['小説', 'ミステリー・サスペンス'] },
    ]);
    seedStage5(db, [{ key: 'u1', title: 'A本', authors: ['著者'] }]);
    setAudioStageMode(db, 8, 'analyse');
    await runPass(s8);
    expect(s8.overlay()).toBeNull();
    expect(s8.progress()!.gate?.passed).toBe(false);
    // A labeled recording; the unit finder reads stage 4's inputs.
    db.prepare(
      "INSERT INTO audio_online_units (analysis_id, unit_key, copy_keys, book_keys, name, kind, state, inputs_json, updated_at) VALUES ('a4', 'u1', '[]', '[]', 'A本', 'lookup', 'decided', ?, 0)",
    ).run(
      JSON.stringify({
        opening: [{ root: 'torrents', rel: 'A本.m4b' }],
        paths: ['torrents:A本.m4b'],
      }),
    );
    labels.text = JSON.stringify({
      books: [{ id: 'E1', kind: 'audible', torrent: 'A本.m4b', calibre: [1] }],
    });
    await runPass(s8, 2);
    expect(s8.progress()!.gate?.passed).toBe(true);
    db.prepare("UPDATE audio_stages SET mode = 'on' WHERE stage = 8").run();
    expect(s8.overlay()?.get('u1')).toMatchObject({
      genres: ['ミステリー・サスペンス'],
      ebook_tags: ['小説'],
    });
    labels.text = JSON.stringify({
      books: [{ id: 'E1', kind: 'audible', torrent: 'A本.m4b', calibre: [9] }],
    });
    s8.begin(3);
    let stop: string | null = null;
    for (let i = 0; i < 100 && !stop; i++) {
      const r = await s8.step(() => false, null);
      if (typeof r === 'object') stop = r.stop;
      if (r === 'done') break;
    }
    expect(stop).toMatch(/gate failed/);
    expect(s8.overlay()).toBeNull();
  });

  it('reads the snapshot copy only (never writes it)', async () => {
    const { db, snap, s8 } = setup();
    makeCalibre(snap, [{ id: 1, title: 'A本', authors: ['著者'] }]);
    seedStage5(db, [{ key: 'u1', title: 'A本', authors: ['著者'] }]);
    setAudioStageMode(db, 8, 'analyse');
    const before = fs.readFileSync(snap);
    const st = fs.statSync(snap);
    await runPass(s8);
    expect(fs.readFileSync(snap).equals(before)).toBe(true);
    expect(fs.statSync(snap).mtimeMs).toBe(st.mtimeMs);
    expect(readEbookSnapshot(snap).books.size).toBe(1);
  });
});

describe('WP21g static checks', () => {
  it('stage 8 never writes Calibre: no write call in its files', () => {
    for (const f of ['stage8-ebooks.ts', 'ebook-snapshot.ts', 'ebook-pair.ts']) {
      const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'cleanup', 'audio', f), 'utf8');
      expect(s).not.toMatch(/writeFile|appendFile|unlink|rename\(|rmSync|mkdir|copyFile|calibredb/);
      expect(s).not.toMatch(/readonly: false/);
    }
  });
});

describe("the linking sidecar's reports reach the batch's own owner (found in WP21g's e2e)", () => {
  it('a library-changes batch (from 3e9) goes to the audiobooks, a book archive batch (from 4e9) to the import', async () => {
    const dir = makeTempDir('wp21g-link');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const s = initCleanupDatabase(dir);
    if (!s.ok) throw new Error(s.error);
    cleanups.push(() => s.db.close());
    const { token } = createApplyToken(s.db, 'e2e link', Date.now(), 'link');
    const audio: number[] = [];
    const archives: number[] = [];
    const app = express();
    app.use(
      '/api/v1',
      createCleanupLinkRouter({
        service: {
          db: s.db,
          arrivals: {
            archiveReport: (id: number) => (archives.push(id), { accepted: 1 }),
            archiveClaim: () => null,
          },
        } as never,
        audio: { linkReport: (id: number) => (audio.push(id), { accepted: 1 }) } as never,
      }),
    );
    const report = (id: number) =>
      request(app)
        .post(`/api/v1/cleanup-link/batches/${id}/report`)
        .set('Authorization', `Bearer ${token}`)
        .send({ results: [{ id: 1, ok: true }] });
    expect((await report(LIBRARY_BATCH_BASE + 1)).status).toBe(200);
    expect((await report(BOOK_ARCHIVE_BATCH_BASE + 123)).status).toBe(200);
    expect(audio).toEqual([LIBRARY_BATCH_BASE + 1]);
    expect(archives).toEqual([BOOK_ARCHIVE_BATCH_BASE + 123]);
    // The archives' ids (the base plus up to 1e8 from the clock) never reach a library batch's.
    expect(BOOK_ARCHIVE_BATCH_BASE).toBeGreaterThanOrEqual(LIBRARY_BATCH_BASE + 1e9);
    expect(BOOK_ARCHIVE_BATCH_BASE + 1e8 + 1e6).toBeLessThan(2 ** 32);
  });
});
