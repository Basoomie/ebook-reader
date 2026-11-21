/**
 * WP21f-2: the story order of multi-file books (stop A, decided with the user) and, later in this
 * file, the changes to books already in the library.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  differsFromNames,
  linkNumbers,
  orderParts,
  storyOrders,
  type OrderFile,
} from '../src/cleanup/audio/story-order';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { planBuild } from '../src/cleanup/audio/build-plan';
import { loadPlanInputs, stageIds } from '../src/cleanup/audio/build-inputs';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { IDS, seedBuild, type BuildSeed } from './helpers/build-seed';
import { makeTempDir } from './helpers/spawn-server';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const file = (name: string, more: Partial<OrderFile> = {}): OrderFile => ({
  name,
  disc: null,
  track: null,
  discTag: null,
  ...more,
});
const names = (fs_: OrderFile[], order: number[]) => order.map((i) => fs_[i].name);

// The live library's two books out of name order (stop A), their files in name order.
const MAKE_BY_NAME = [
  '～１敗目～　プロ幼馴染　八奈見杏菜の負けっぷり【1】',
  '～１敗目～　プロ幼馴染　八奈見杏菜の負けっぷり【2】',
  '～２敗目～　約束された敗北を君に　焼塩檸檬【1】',
  '～２敗目～　約束された敗北を君に　焼塩檸檬【2】',
  '～３敗目～　戦う前から負けている　小鞠知花の撤退戦【1】',
  '～３敗目～　戦う前から負けている　小鞠知花の撤退戦【2】',
  '～４敗目～　負けヒロインを覗く時、負けヒロインもまたあなたを覗いているのだ',
  'Intermission　いいえ、お腹が空いても神様みたいないい子でした',
  'Intermission　ふりかえらなくてもそこに居る',
  'Intermission　モヤモヤの正体　先生が教えてあ・げ・る',
  'あとがき-奥付',
  'タイトル-著者-登場人物',
  'プロローグ',
  '鵜澤正太郎　感想コメント',
  '山一茉希　感想コメント',
  '柴田芽衣　感想コメント',
  '白田千尋　感想コメント',
  '本泉莉奈　感想コメント',
];
// The m4b [01] 負けヒロインが多すぎる！ [B0CGJ583HH]'s chapters (the live health row).
const MAKE_TWIN = [
  'タイトル/著者/登場人物',
  'プロローグ',
  '～１敗目～　プロ幼馴染　八奈見杏菜の負けっぷり',
  'Intermission　いいえ、お腹が空いても神様みたいないい子でした',
  '～２敗目～　約束された敗北を君に　焼塩檸檬',
  'Intermission　モヤモヤの正体　先生が教えてあ・げ・る',
  '～３敗目～　戦う前から負けている　小鞠知花の撤退戦',
  'Intermission　ふりかえらなくてもそこに居る',
  '～４敗目～　負けヒロインを覗く時、負けヒロインもまたあなたを覗いているのだ',
  'あとがき/奥付',
  '鵜澤正太郎　感想コメント',
  '本泉莉奈　感想コメント',
  '山一茉希　感想コメント',
  '柴田芽衣　感想コメント',
  '白田千尋　感想コメント',
];
const UTSU_BY_NAME = [
  '結章　新しい日本国憲法の制定',
  '序章　日本よ、美しく、強く、成長する国であれ！【1】',
  '序章　日本よ、美しく、強く、成長する国であれ！【2】',
  '第1章　私の『日本経済強靱化計画』とはー「サナエノミクス」の提案',
  '第2章　「危機管理投資」と「成長投資」ー「アフターコロナ」を見据えて【1】',
  '第7章　分厚い中間層を再構築する税制ー安心と成長のための改革を',
];

describe('the story order of a multi-file book', () => {
  it('負けヒロイン: the twin m4b’s chapter names order every file (the section words alone misplace the Intermissions)', () => {
    const files = MAKE_BY_NAME.map((n) => file(n));
    const o = storyOrders(files, [{ key: 'm4b', titles: MAKE_TWIN }]);
    expect(o.source).toBe('twin');
    expect(o.twin).toBe('m4b');
    expect(names(files, o.order)).toEqual([
      'タイトル-著者-登場人物',
      'プロローグ',
      '～１敗目～　プロ幼馴染　八奈見杏菜の負けっぷり【1】',
      '～１敗目～　プロ幼馴染　八奈見杏菜の負けっぷり【2】',
      'Intermission　いいえ、お腹が空いても神様みたいないい子でした',
      '～２敗目～　約束された敗北を君に　焼塩檸檬【1】',
      '～２敗目～　約束された敗北を君に　焼塩檸檬【2】',
      'Intermission　モヤモヤの正体　先生が教えてあ・げ・る',
      '～３敗目～　戦う前から負けている　小鞠知花の撤退戦【1】',
      '～３敗目～　戦う前から負けている　小鞠知花の撤退戦【2】',
      'Intermission　ふりかえらなくてもそこに居る',
      '～４敗目～　負けヒロインを覗く時、負けヒロインもまたあなたを覗いているのだ',
      'あとがき-奥付',
      '鵜澤正太郎　感想コメント',
      '本泉莉奈　感想コメント',
      '山一茉希　感想コメント',
      '柴田芽衣　感想コメント',
      '白田千尋　感想コメント',
    ]);
    // The section-word rule (reported at stop A): front and back right, the Intermissions not.
    expect(names(files, o.all.words!).slice(0, 2)).toEqual([
      'タイトル-著者-登場人物',
      'プロローグ',
    ]);
    expect(names(files, o.all.words!).slice(9, 12)).toEqual(MAKE_BY_NAME.slice(7, 10));
    expect(o.all.words).not.toEqual(o.all.twin);
    // A twin whose chapters don't name every file gives no order.
    expect(storyOrders(files, [{ key: 'x', titles: MAKE_TWIN.slice(0, 5) }]).source).toBe('words');
  });

  it('美しく、強く…: the section words put 序章 first and 結章 last', () => {
    const files = UTSU_BY_NAME.map((n) => file(n));
    const o = storyOrders(files);
    expect(o.source).toBe('words');
    expect(names(files, o.order)).toEqual([...UTSU_BY_NAME.slice(1), UTSU_BY_NAME[0]]);
    expect(differsFromNames(o.order)).toBe(true);
  });

  it('complete, unique track tags win; tags all "1" (ざこラジ’s mp3s) or missing don’t count', () => {
    const tagged = [3, 1, 2].map((t) => file(`女生徒【${t}】`, { track: `${t}/5` }));
    expect(storyOrders(tagged).source).toBe('tags');
    expect(names(tagged, storyOrders(tagged).order)).toEqual([
      '女生徒【1】',
      '女生徒【2】',
      '女生徒【3】',
    ]);
    const ones = ['#0', '#1', '#2'].map((n) => file(n, { track: '1' }));
    expect(storyOrders(ones).source).toBe('name');
    const some = [file('a', { track: '1' }), file('b')];
    expect(storyOrders(some).source).toBe('name');
    // Discs: the disc tag (else the Disc folder) first.
    const discs = [
      file('x', { track: '1', discTag: '2' }),
      file('y', { track: '1', discTag: '1' }),
    ];
    expect(names(discs, storyOrders(discs).order)).toEqual(['y', 'x']);
  });

  it('no section words and no tags: name order (radio episodes, 分割版, a bonus folder of おまけ)', () => {
    for (const set of [
      ['第7回', '第8回', '第9回'],
      ['藪の中　分割版001', '藪の中　分割版002'],
      ['パッケージ振り返りおまけ', '答えてメスガキちゃんのコーナー'],
      ['047 第三部 エピローグ'].concat(['048 x']),
    ]) {
      const o = storyOrders(set.map((n) => file(n)));
      expect(o.order, set.join(',')).toEqual(set.map((_, i) => i));
    }
  });

  it('twins are the single files stage 3 pairs as candidates (title + volume, or an ASIN)', () => {
    const copies = [
      {
        key: 'p',
        kind: 'parts',
        fileIds: [1, 2, 3],
        titleKey: '負けヒロインが多すぎる',
        volume: null,
        asins: [],
        absAsins: [],
      },
      {
        key: 'm',
        kind: 'file',
        fileIds: [9],
        titleKey: '負けヒロインが多すぎる',
        volume: null,
        asins: ['B0CGJ583HH'],
        absAsins: [],
      },
      {
        key: 'o',
        kind: 'file',
        fileIds: [8],
        titleKey: '別の本',
        volume: null,
        asins: [],
        absAsins: [],
      },
    ];
    const chapters: Record<number, string[]> = {
      9: ['タイトル', 'プロローグ', '第一章'],
      8: ['第一章', 'プロローグ', 'タイトル'],
    };
    const nameOf: Record<number, string> = { 1: '第一章', 2: 'タイトル', 3: 'プロローグ' };
    const look = {
      name: (id: number) => nameOf[id],
      disc: () => null,
      tags: () => null,
      chapters: (id: number) => chapters[id] ?? null,
    };
    const o = orderParts(copies, look).get('p')!;
    expect(o.source).toBe('twin');
    expect(o.twin).toBe('m');
    expect(o.order.map((i) => nameOf[copies[0].fileIds[i]])).toEqual([
      'タイトル',
      'プロローグ',
      '第一章',
    ]);
    // By an ASIN in common when the titles differ.
    const byAsin = orderParts(
      [
        { ...copies[0], titleKey: 'x', asins: ['B0CGJ583HH'] },
        { ...copies[1], titleKey: 'y' },
      ],
      look,
    ).get('p')!;
    expect(byAsin.twin).toBe('m');
  });

  it('the library’s link numbers: only when the story order is not the name order', () => {
    expect(linkNumbers(['01 a.mp3', '02 b.mp3'])).toBeNull();
    expect(linkNumbers(['タイトル.mp3', 'プロローグ.mp3', 'Intermission.mp3'])).toEqual([
      '01 ',
      '02 ',
      '03 ',
    ]);
    expect(linkNumbers(['a.mp3'])).toBeNull();
    const many = Array.from({ length: 120 }, (_, i) => `f${120 - i}.mp3`);
    expect(linkNumbers(many)![0]).toBe('001 ');
  });
});

// ---------------------------------------------------------------------------------------------
describe('stage 3 orders a multi-file copy’s files; the plan numbers its links', () => {
  function scenario(): BuildSeed {
    const folder = 'Discord/負けヒロイン';
    // Name order: ～１敗目～ 本編, タイトル, プロローグ (as the live folder sorts).
    const parts = ['～１敗目～ 本編', 'タイトル', 'プロローグ'];
    return {
      files: [
        ...parts.map((p) => ({
          root: 'torrents' as const,
          rel: `${folder}/${p}.mp3`,
          bytes: `audio ${p}`,
        })),
        { root: 'torrents', rel: 'TMW/[01] 負けヒロイン [B0CGJ583HH].m4b', bytes: 'audio m4b' },
      ],
      books: [
        { rel: folder, kind: 'folder', files: parts.map((p) => `${folder}/${p}.mp3`) },
        {
          rel: 'TMW/[01] 負けヒロイン [B0CGJ583HH].m4b',
          kind: 'file',
          files: ['TMW/[01] 負けヒロイン [B0CGJ583HH].m4b'],
        },
      ],
      copies: [
        {
          key: `torrents:${folder}#${folder}/～１敗目～ 本編.mp3`,
          bookKey: `torrents:${folder}`,
          kind: 'parts',
          // Stage 3's story order.
          files: ['タイトル', 'プロローグ', '～１敗目～ 本編'].map(
            (p) => `torrents:${folder}/${p}.mp3`,
          ),
        },
      ],
      units: [
        {
          key: 'u-make',
          kind: 'record',
          name: '負けヒロイン',
          copies: [`torrents:${folder}#${folder}/～１敗目～ 本編.mp3`],
          values: {
            title: '負けヒロイン',
            authors: ['雨森たきび'],
            narrators: ['読み手'],
            series: [],
          },
        },
      ],
      libraryCopies: {},
    };
  }

  it('the copy step puts the files in story order (the copy key stays its first file by name)', async () => {
    const dir = makeTempDir('wp21f2-order');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const s = initCleanupDatabase(dir);
    if (!s.ok) throw new Error(s.error);
    cleanups.push(() => s.db.close());
    const disk = seedBuild(s.db, dir, scenario());
    const db = s.db;
    db.prepare(`UPDATE audio_books SET multi_class = 'parts' WHERE unit_kind = 'folder'`).run();
    db.prepare(`UPDATE audio_books SET name_raw = '負けヒロイン' WHERE unit_kind = 'file'`).run();
    // Health: the m4b's chapters name the story order; no track tags anywhere.
    const health = db.prepare(
      `INSERT INTO audio_file_health (file_id, size, mtime_ms, duration, chapter_count, chapters_json, tags_json, header_ok, tags_version, checked_ms, checked_at)
       SELECT id, size, mtime_ms, 100, ?, ?, '{}', 1, 2, 1, 1 FROM audio_files WHERE id = ?`,
    );
    const m4b = disk.fileId('torrents:TMW/[01] 負けヒロイン [B0CGJ583HH].m4b');
    health.run(
      3,
      JSON.stringify(
        ['タイトル', 'プロローグ', '～１敗目～ 本編'].map((t, i) => ({
          start: i,
          end: i + 1,
          title: t,
        })),
      ),
      m4b,
    );
    for (const p of ['～１敗目～ 本編', 'タイトル', 'プロローグ'])
      health.run(0, '[]', disk.fileId(`torrents:Discord/負けヒロイン/${p}.mp3`));
    const stage3 = new AudioStage3({
      db,
      roots: { torrents: disk.torrents, library: disk.library },
      tools: { ffprobePath: 'nope', ffmpegPath: 'nope', fpcalcPath: 'nope', faadPath: 'nope' },
      lock: new DiskLock(5),
      readLabels: () => ({ text: '{"pairs":[]}', error: null }),
    });
    stage3.restart();
    for (
      let i = 0;
      i < 50 && ['copies', undefined].includes(stage3.progress()?.phase as never);
      i++
    )
      await stage3.step(() => false);
    const p = stage3.progress()!;
    expect(p.phase).not.toBe('copies');
    const row = db
      .prepare(
        `SELECT copy_key, file_ids FROM audio_dup_copies WHERE analysis_id = ? AND kind = 'parts'`,
      )
      .get(p.analysisId) as { copy_key: string; file_ids: string };
    const rel = (id: number) =>
      (db.prepare('SELECT rel_path FROM audio_files WHERE id = ?').get(id) as { rel_path: string })
        .rel_path;
    expect((JSON.parse(row.file_ids) as number[]).map((id) => path.basename(rel(id)))).toEqual([
      'タイトル.mp3',
      'プロローグ.mp3',
      '～１敗目～ 本編.mp3',
    ]);
    // The key stays its first file by name (stage 2's order), so the copy keeps its identity.
    expect(row.copy_key).toBe(
      'torrents:Discord/負けヒロイン#Discord/負けヒロイン/～１敗目～ 本編.mp3',
    );
    expect(p.storyOrder?.bySource).toEqual({ twin: 1 });
    void IDS;
  });

  it('a new book whose story order is not its name order gets numbered link names', async () => {
    const dir = makeTempDir('wp21f2-plan');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const s = initCleanupDatabase(dir);
    if (!s.ok) throw new Error(s.error);
    cleanups.push(() => s.db.close());
    seedBuild(s.db, dir, scenario());
    const { ids } = stageIds(s.db);
    const plan = planBuild(
      await loadPlanInputs(s.db, ids!, { readerWritten: [], libraryFolder: 'japanese' }),
    );
    const book = plan.books.find((b) => b.title === '負けヒロイン')!;
    const files = book.files.map((f) => path.posix.basename(f.dst));
    expect(files).toEqual(['01 タイトル.mp3', '02 プロローグ.mp3', '03 ～１敗目～ 本編.mp3']);
    expect(book.notes).toContain('numbered in story order');
  });
});
