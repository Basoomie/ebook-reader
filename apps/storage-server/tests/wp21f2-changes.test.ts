/**
 * WP21f-2: the story order of multi-file books (stop A, decided with the user) and, later in this
 * file, the changes to books already in the library.
 */
import { createHash } from 'crypto';
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
import { LinkWriter } from '../../cleanup-link/src/writer';
import { AudioStage3 } from '../src/cleanup/audio/stage3-dups';
import { planBuild, type PlannedBook } from '../src/cleanup/audio/build-plan';
import { bookValues, metadataBytes } from '../src/cleanup/audio/build-metadata';
import type { ExistingTree } from '../src/cleanup/audio/arrivals-plan';
import {
  absKeptSomething,
  fieldState,
  leftBehind,
  orderMoves,
  planLibraryChanges,
  sha256,
  type AbsBookState,
  type LedgerBook,
} from '../src/cleanup/audio/library-plan';
import { loadPlanInputs, stageIds } from '../src/cleanup/audio/build-inputs';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DiskLock } from '../src/cleanup/disk-lock';
import { IDS, seedBuild, type BuildSeed } from './helpers/build-seed';
import { LibraryChanges } from '../src/cleanup/audio/library-changes';
import { setBody } from '../src/cleanup/audio/abs-set-fields';
import { switchReader } from '../src/cleanup/audio/switch-reader';
import { AudioScanService } from '../src/audio/scan-service';
import { DEFAULT_AUDIO } from '../src/config';
import { updateLibrary } from '../src/calibre/libraries';
import { listUsers } from '../src/db/users';
import { updateSettings } from '../src/cleanup/settings';
import { LinkWorker } from '../../cleanup-link/src/worker';
import { makeCleanupEnv } from './helpers/cleanup-env';
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

// ---------------------------------------------------------------------------------------------
describe('the linking sidecar’s WP21f-2 abilities (tree proofs and refusals)', () => {
  function disk() {
    const dir = makeTempDir('wp21f2-writer');
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const data = path.join(dir, 'data');
    const torrents = path.join(data, 'torrents', 'audiobooks', 'japanese');
    const media = path.join(data, 'media', 'audiobooks');
    const put = (abs: string, bytes: string) => {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
    };
    put(path.join(torrents, 'TMW', 'a.m4b'), 'audio a');
    put(path.join(torrents, 'Discord', '本P', 'タイトル.mp3'), 'title');
    put(path.join(torrents, 'Discord', '本P', 'プロローグ.mp3'), 'prologue');
    const lib = path.join(media, 'japanese');
    fs.mkdirSync(path.join(lib, '作者', 'シリーズ', 'Vol 3 - 本A'), { recursive: true });
    fs.linkSync(
      path.join(torrents, 'TMW', 'a.m4b'),
      path.join(lib, '作者', 'シリーズ', 'Vol 3 - 本A', 'a.m4b'),
    );
    fs.writeFileSync(
      path.join(lib, '作者', 'シリーズ', 'Vol 3 - 本A', 'metadata.json'),
      '{"title":"本A"}\n',
    );
    fs.mkdirSync(path.join(lib, '作者', '本P'), { recursive: true });
    for (const n of ['タイトル.mp3', 'プロローグ.mp3'])
      fs.linkSync(path.join(torrents, 'Discord', '本P', n), path.join(lib, '作者', '本P', n));
    fs.writeFileSync(path.join(lib, '作者', '本P', 'metadata.json'), '{"title":"本P"}\n');
    put(path.join(media, 'japanese-generated', '作者G', '本G (v1)', '本G.m4b'), 'tts');
    put(path.join(media, 'japanese-generated', '作者G', '本G (v1)', '本G.srt'), '1\n');
    put(path.join(media, 'japanese-merged', '作者', '本M', '本M (merged).m4b'), 'merged');
    const writer = new LinkWriter({ dataDir: data });
    const ino = (abs: string) => fs.lstatSync(abs).ino;
    const tree = (root: string) => {
      const out: Record<string, string> = {};
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else {
            const st = fs.lstatSync(p);
            out[path.relative(root, p).replace(/\\/g, '/')] =
              `${st.ino}|${st.size}|${fs.readFileSync(p, 'utf8')}`;
          }
        }
      };
      walk(root);
      return out;
    };
    return { data, torrents, media, lib, writer, ino, tree };
  }
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const stat = (abs: string) => {
    const st = fs.lstatSync(abs);
    return { size: st.size, mtimeMs: Math.floor(st.mtimeMs), dev: st.dev, ino: st.ino };
  };

  it('replaceBookMetadata: only over the file read (its hash), in one rename; never an author folder', async () => {
    const d = disk();
    const book = 'japanese/作者/シリーズ/Vol 3 - 本A';
    const file = path.join(d.lib, '作者', 'シリーズ', 'Vol 3 - 本A', 'metadata.json');
    const torrents = d.tree(d.torrents);
    const next = Buffer.from('{"title":"新"}\n');
    await expect(
      d.writer.replaceBookMetadata(book, next, sha('something else'), 1),
    ).rejects.toThrow(/changed since it was read/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"title":"本A"}\n');
    expect(await d.writer.replaceBookMetadata(book, next, sha('{"title":"本A"}\n'), 2)).toEqual({
      existed: false,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"title":"新"}\n');
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['a.m4b', 'metadata.json']);
    // Repeated: the same bytes are there.
    expect(await d.writer.replaceBookMetadata(book, next, sha('x'), 3)).toEqual({ existed: true });
    await expect(
      d.writer.replaceBookMetadata('japanese/作者/シリーズ', Buffer.from('{}'), sha('x'), 4),
    ).rejects.toThrow(/Not a book folder/);
    await expect(
      d.writer.replaceBookMetadata('japanese-old/作者/本', Buffer.from('{}'), sha('x'), 5),
    ).rejects.toThrow(/Not inside/);
    expect(d.tree(d.torrents)).toEqual(torrents);
  });

  it('renameBookFolder: a book of japanese/ to a new path there (parents made), never over a name or across roots', async () => {
    const d = disk();
    const from = 'japanese/作者/シリーズ/Vol 3 - 本A';
    const abs = path.join(d.lib, '作者', 'シリーズ', 'Vol 3 - 本A');
    const ino = d.ino(abs);
    const torrents = d.tree(d.torrents);
    const inside = d.tree(abs);
    await expect(d.writer.renameBookFolder(from, 'japanese/作者/本P', ino)).rejects.toThrow(
      /already there/,
    );
    await expect(
      d.writer.renameBookFolder(from, 'japanese-generated/作者/本A', ino),
    ).rejects.toThrow(/Not inside japanese/);
    await expect(d.writer.renameBookFolder(from, 'japanese/作者/本P/中', ino)).rejects.toThrow(
      /can't hold another book/,
    );
    await expect(d.writer.renameBookFolder(from, 'japanese/作者/本A', ino + 1)).rejects.toThrow(
      /inode/,
    );
    const series = path.join(d.lib, '作者', 'シリーズ');
    await expect(
      d.writer.renameBookFolder('japanese/作者/シリーズ', 'japanese/作者/別', d.ino(series)),
    ).rejects.toThrow(/Not a book folder/);
    expect(await d.writer.renameBookFolder(from, 'japanese/新しい作者/本A', ino)).toEqual({
      existed: false,
    });
    const moved = path.join(d.lib, '新しい作者', '本A');
    expect(d.ino(moved)).toBe(ino);
    expect(d.tree(moved)).toEqual(inside);
    expect(fs.existsSync(abs)).toBe(false);
    expect(await d.writer.renameBookFolder(from, 'japanese/新しい作者/本A', ino)).toEqual({
      existed: true,
    });
    // A cycle goes through a temporary name in the same folder only.
    await expect(
      d.writer.renameBookFolder('japanese/新しい作者/本A', 'japanese/作者/.ttsu-move-1', ino),
    ).rejects.toThrow(/same folder/);
    expect(
      await d.writer.renameBookFolder(
        'japanese/新しい作者/本A',
        'japanese/新しい作者/.ttsu-move-1',
        ino,
      ),
    ).toEqual({ existed: false });
    expect(
      await d.writer.renameBookFolder(
        'japanese/新しい作者/.ttsu-move-1',
        'japanese/新しい作者/本B',
        ino,
      ),
    ).toEqual({ existed: false });
    expect(d.tree(d.torrents)).toEqual(torrents);
  });

  it('removeEmptyFolder: only an empty folder inside japanese/; never the root', async () => {
    const d = disk();
    fs.mkdirSync(path.join(d.lib, '空', '空のシリーズ'), { recursive: true });
    expect(await d.writer.removeEmptyFolder('japanese/作者/シリーズ')).toEqual({
      removed: false,
      existed: true,
    });
    expect(await d.writer.removeEmptyFolder('japanese/空/空のシリーズ')).toEqual({
      removed: true,
      existed: true,
    });
    expect(await d.writer.removeEmptyFolder('japanese/空')).toEqual({
      removed: true,
      existed: true,
    });
    expect(await d.writer.removeEmptyFolder('japanese/空')).toEqual({
      removed: false,
      existed: false,
    });
    await expect(d.writer.removeEmptyFolder('japanese')).rejects.toThrow(/Not a folder inside/);
    await expect(d.writer.removeEmptyFolder('japanese-generated/作者G')).rejects.toThrow(
      /Not inside japanese/,
    );
    expect(fs.existsSync(path.join(d.lib, '作者', 'シリーズ', 'Vol 3 - 本A', 'a.m4b'))).toBe(true);
  });

  it('linkReaderFile: a reader-written file gets its name under AI/ or _merged/, the same file; nothing else', async () => {
    const d = disk();
    const torrents = d.tree(d.torrents);
    const gen = 'japanese-generated/作者G/本G (v1)/本G.m4b';
    const genAbs = path.join(d.media, ...gen.split('/'));
    const r = await d.writer.linkReaderFile({ rel: gen, raw: null, ...stat(genAbs) });
    expect(r).toMatchObject({ existed: false, dst: 'AI/作者G/本G (v1)/本G.m4b' });
    expect(d.ino(path.join(d.torrents, 'AI', '作者G', '本G (v1)', '本G.m4b'))).toBe(d.ino(genAbs));
    expect(fs.lstatSync(genAbs).nlink).toBe(2);
    const merged = 'japanese-merged/作者/本M/本M (merged).m4b';
    const mAbs = path.join(d.media, ...merged.split('/'));
    expect((await d.writer.linkReaderFile({ rel: merged, raw: null, ...stat(mAbs) })).dst).toBe(
      '_merged/作者/本M/本M (merged).m4b',
    );
    // Repeated: done. Changed since planned: refused. Not a reader folder: refused.
    expect((await d.writer.linkReaderFile({ rel: gen, raw: null, ...stat(genAbs) })).existed).toBe(
      true,
    );
    const srt = 'japanese-generated/作者G/本G (v1)/本G.srt';
    const srtAbs = path.join(d.media, ...srt.split('/'));
    const planned = stat(srtAbs);
    fs.appendFileSync(srtAbs, 'more');
    await expect(d.writer.linkReaderFile({ rel: srt, raw: null, ...planned })).rejects.toThrow(
      /changed/,
    );
    const title = path.join(d.lib, '作者', '本P', 'タイトル.mp3');
    await expect(
      d.writer.linkReaderFile({ rel: 'japanese/作者/本P/タイトル.mp3', raw: null, ...stat(title) }),
    ).rejects.toThrow(/Not a reader-written file/);
    // A different file already at the name: refused, nothing replaced.
    fs.mkdirSync(path.join(d.torrents, '_merged', '作者', '本X'), { recursive: true });
    fs.writeFileSync(path.join(d.torrents, '_merged', '作者', '本X', 'x.m4b'), 'other');
    const xAbs = path.join(d.media, 'japanese-merged', '作者', '本X', 'x.m4b');
    fs.mkdirSync(path.dirname(xAbs), { recursive: true });
    fs.writeFileSync(xAbs, 'mine');
    await expect(
      d.writer.linkReaderFile({ rel: 'japanese-merged/作者/本X/x.m4b', raw: null, ...stat(xAbs) }),
    ).rejects.toThrow(/different file/);
    expect(fs.readFileSync(path.join(d.torrents, '_merged', '作者', '本X', 'x.m4b'), 'utf8')).toBe(
      'other',
    );
    // Every torrent file that was there is as it was.
    const after = d.tree(d.torrents);
    for (const [k, v] of Object.entries(torrents)) expect(after[k], k).toBe(v);
  });

  it('renameBookFile: a link inside its book folder only; the torrent’s own name stays', async () => {
    const d = disk();
    const book = 'japanese/作者/本P';
    const abs = path.join(d.lib, '作者', '本P', 'タイトル.mp3');
    const ino = d.ino(abs);
    const torrents = d.tree(d.torrents);
    await expect(
      d.writer.renameBookFile(book, 'タイトル.mp3', 'プロローグ.mp3', ino),
    ).rejects.toThrow(/already there/);
    await expect(
      d.writer.renameBookFile(book, 'タイトル.mp3', 'Disc 1/01 タイトル.mp3', ino),
    ).rejects.toThrow(/own folder/);
    await expect(d.writer.renameBookFile(book, 'metadata.json', 'x.json', ino)).rejects.toThrow(
      /Not an audio link/,
    );
    await expect(
      d.writer.renameBookFile(book, 'タイトル.mp3', '01 タイトル.mp3', ino + 1),
    ).rejects.toThrow(/inode/);
    await expect(
      d.writer.renameBookFile('japanese-generated/作者G/本G (v1)', '本G.m4b', '01 本G.m4b', 1),
    ).rejects.toThrow(/Not inside japanese/);
    expect(await d.writer.renameBookFile(book, 'タイトル.mp3', '01 タイトル.mp3', ino)).toEqual({
      existed: false,
    });
    expect(d.ino(path.join(d.lib, '作者', '本P', '01 タイトル.mp3'))).toBe(ino);
    expect(await d.writer.renameBookFile(book, 'タイトル.mp3', '01 タイトル.mp3', ino)).toEqual({
      existed: true,
    });
    expect(d.tree(d.torrents)).toEqual(torrents);
  });
});

// ---------------------------------------------------------------------------------------------
describe('what changes for a book already in the library (library-plan.ts)', () => {
  const values = (over: Record<string, unknown> = {}) =>
    bookValues(
      {
        title: '本A',
        authors: ['作者'],
        narrators: ['読み手A'],
        publisher: '出版社',
        year: 2020,
        ...over,
      },
      '本A',
    );
  const planned = (
    over: Partial<PlannedBook> & { v?: Record<string, unknown> } = {},
  ): PlannedBook => {
    const v = values(over.v);
    const folder = over.folder ?? 'japanese-new/作者/シリーズ/Vol 3 - 本A';
    return {
      unitKey: 'u1',
      copyKey: 'c1',
      area: 'main',
      state: 'build',
      folder,
      baseFolder: over.baseFolder ?? folder,
      author: '作者',
      series: 'シリーズ',
      title: 'Vol 3 - 本A',
      notes: [],
      files: over.files ?? [{ fileId: 1, dst: `${folder}/a.m4b` }],
      pdfs: [],
      cover: true,
      metadata: metadataBytes(v),
      values: v,
      rank: 0,
      ...over,
    } as PlannedBook;
  };
  const ledger = (over: Partial<LedgerBook> = {}): LedgerBook => ({
    id: 1,
    folder: 'japanese/作者/シリーズ/Vol 3 - 本A',
    baseFolder: 'japanese/作者/シリーズ/Vol 3 - 本A',
    area: 'main',
    files: [{ fileId: 1, name: 'a.m4b', ino: 11 }],
    metadata: metadataBytes(values()),
    decided: metadataBytes(values()),
    folderIno: 99,
    ...over,
  });
  const tree = (): ExistingTree => ({
    dirs: new Set([
      'japanese',
      'japanese/作者',
      'japanese/作者/シリーズ',
      'japanese/作者/シリーズ/Vol 3 - 本A',
    ]),
    bookDirs: new Set(['japanese/作者/シリーズ/Vol 3 - 本A']),
    narrators: new Map([['japanese/作者/シリーズ/Vol 3 - 本A', '読み手A']]),
  });
  const run = (o: {
    book?: LedgerBook;
    cur?: PlannedBook | null;
    disk?: Buffer | null;
    abs?: AbsBookState | null;
    keep?: string | null;
    choices?: Record<string, string>;
  }) =>
    planLibraryChanges({
      books: [o.book ?? ledger()],
      current: () => (o.cur === undefined ? planned() : o.cur),
      disk: (b) => (o.disk === undefined ? b.metadata : o.disk),
      abs: () => (o.abs === undefined ? null : o.abs),
      keep: () => o.keep ?? null,
      tree: tree(),
      choices: () => o.choices ?? {},
    });
  const json = (b: Buffer | null) => JSON.parse(b!.toString('utf8')) as Record<string, unknown>;

  it('nothing differs: no change', () => {
    expect(run({})).toEqual([]);
  });

  it('a decided value changed: written; the sidecar replaces only the file read', () => {
    const [c] = run({ cur: planned({ v: { publisher: '新しい出版社' } }) });
    expect(c.fields).toEqual([{ field: 'publisher', from: '出版社', to: '新しい出版社' }]);
    expect(json(c.metadataNew).publisher).toBe('新しい出版社');
    expect(c.metadataShaRead).toBe(sha256(metadataBytes(values())));
    expect(c.folderTo).toBeNull();
    expect(c.reviews).toEqual([]);
  });

  it('your ABS edit of another field is kept; ABS’s own form (series sorted, chapters added) is not an edit', () => {
    const mine = { ...json(metadataBytes(values())), title: 'あなたの題名', chapters: [{ id: 0 }] };
    const disk = Buffer.from(JSON.stringify(mine, null, 2));
    const [c] = run({ cur: planned({ v: { publisher: '新しい出版社' } }), disk });
    expect(c.userFields).toEqual(['title']);
    expect(c.conflicts).toEqual([]);
    expect(json(c.metadataNew)).toMatchObject({ title: 'あなたの題名', publisher: '新しい出版社' });
    expect(c.metadataShaRead).toBe(sha256(disk));
    // Series in another order is ABS's rewrite, not your edit.
    const two = values({
      series: [
        { name: 'B', position: 1, label: null },
        { name: 'A', position: 2, label: null },
      ],
    });
    const sorted = { ...json(metadataBytes(two)), series: ['A #2', 'B #1'] };
    const r = run({
      book: ledger({ metadata: metadataBytes(two), decided: metadataBytes(two) }),
      cur: planned({
        v: {
          series: [
            { name: 'B', position: 1, label: null },
            { name: 'A', position: 2, label: null },
          ],
        },
      }),
      disk: Buffer.from(JSON.stringify(sorted)),
    });
    expect(r).toEqual([]);
  });

  it('your edit and our new value differ for one field: yours kept, the field to review; "ours" writes ours', () => {
    const mine = { ...json(metadataBytes(values())), narrators: ['あなたの読み手'] };
    const disk = Buffer.from(JSON.stringify(mine));
    const cur = planned({ v: { narrators: ['新しい読み手'], publisher: '新しい出版社' } });
    const [c] = run({ cur, disk });
    expect(c.conflicts.map((x) => x.field)).toEqual(['narrators']);
    expect(c.reviews.map((r) => r.kind)).toEqual(['conflict']);
    expect(json(c.metadataNew)).toMatchObject({
      narrators: ['あなたの読み手'],
      publisher: '新しい出版社',
    });
    const [d] = run({ cur, disk, choices: { narrators: 'ours' } });
    expect(d.conflicts).toEqual([]);
    expect(json(d.metadataNew).narrators).toEqual(['新しい読み手']);
    const [e] = run({ cur, disk, choices: { narrators: 'mine' } });
    expect(e.conflicts).toEqual([]);
    expect(json(e.metadataNew).narrators).toEqual(['あなたの読み手']);
  });

  it('a new layout moves the book (named against the library); never an AI book or one whose path fields you edited', () => {
    const cur = planned({
      folder: 'japanese-new/作者/本A',
      baseFolder: 'japanese-new/作者/本A',
      series: null,
      title: '本A',
      v: { title: '本A' },
      files: [{ fileId: 1, dst: 'japanese-new/作者/本A/a.m4b' }],
    });
    const [c] = run({ cur });
    expect(c.folderTo).toBe('japanese/作者/本A');
    expect(c.baseTo).toBe('japanese/作者/本A');
    const [ai] = run({
      book: ledger({
        area: 'ai',
        folder: 'japanese-generated/作者/本A',
        baseFolder: 'japanese-generated/作者/本A2',
      }),
      cur,
    });
    expect(ai.folderTo).toBeNull();
    expect(ai.reviews.map((r) => r.kind)).toEqual(['ai_path']);
    const mine = { ...json(metadataBytes(values())), authors: ['あなたの作者'] };
    const [ed] = run({ cur, disk: Buffer.from(JSON.stringify(mine)) });
    expect(ed.folderTo).toBeNull();
    expect(ed.reviews.map((r) => r.kind)).toEqual(['move_edited']);
  });

  it('numbered link names: renamed when nobody listens; held for review with progress or bookmarks', () => {
    const folder = 'japanese-new/作者/シリーズ/Vol 3 - 本A';
    const book = ledger({
      files: [
        { fileId: 1, name: 'プロローグ.mp3', ino: 11 },
        { fileId: 2, name: 'タイトル.mp3', ino: 12 },
      ],
    });
    const cur = planned({
      files: [
        { fileId: 2, dst: `${folder}/01 タイトル.mp3` },
        { fileId: 1, dst: `${folder}/02 プロローグ.mp3` },
      ],
    });
    const free: AbsBookState = {
      found: true,
      itemId: 'i1',
      inProgress: false,
      finished: false,
      bookmarks: 0,
      places: [],
    };
    const [c] = run({ book, cur, abs: free });
    expect(c.renames).toEqual([
      { from: 'プロローグ.mp3', to: '02 プロローグ.mp3', ino: 11 },
      { from: 'タイトル.mp3', to: '01 タイトル.mp3', ino: 12 },
    ]);
    expect(c.renamesHeld).toBe(false);
    // Finished without a bookmark: renamed too.
    expect(run({ book, cur, abs: { ...free, finished: true } })[0].renamesHeld).toBe(false);
    const listening = run({ book, cur, abs: { ...free, inProgress: true, bookmarks: 1 } })[0];
    expect(listening.renamesHeld).toBe(true);
    expect(listening.reviews.map((r) => r.kind)).toEqual(['rename_progress']);
    expect(run({ book, cur, abs: { ...free, bookmarks: 1 } })[0].renamesHeld).toBe(true);
    // ABS not asked: held. "Rename now": renamed.
    expect(run({ book, cur, abs: null })[0].reviews.map((r) => r.kind)).toEqual(['abs_unknown']);
    expect(
      run({ book, cur, abs: { ...free, inProgress: true }, choices: { rename: 'now' } })[0]
        .renamesHeld,
    ).toBe(false);
  });

  it('kept as built: nothing changes, listed as kept', () => {
    const [c] = run({
      cur: planned({ v: { publisher: '新しい出版社' } }),
      keep: 'Kept as built (your decision)',
    });
    expect(c.skipped).toBe('Kept as built (your decision)');
    expect(c.metadataNew).toBeNull();
    expect(c.fields).toEqual([]);
  });

  it('no current decision for the book’s files: left alone', () => {
    expect(run({ cur: null })).toEqual([]);
  });

  it('moves in an order where no target exists; a cycle through a temporary name; emptied folders deepest first', () => {
    expect(
      orderMoves([
        { from: 'japanese/a/s/Vol 1', to: 'japanese/a/s/Vol 2', ino: 1 },
        { from: 'japanese/a/s/Vol 2', to: 'japanese/a/s/Vol 3', ino: 2 },
      ]),
    ).toEqual([
      { from: 'japanese/a/s/Vol 2', to: 'japanese/a/s/Vol 3', ino: 2 },
      { from: 'japanese/a/s/Vol 1', to: 'japanese/a/s/Vol 2', ino: 1 },
    ]);
    const cycle = orderMoves([
      { from: 'japanese/a/x', to: 'japanese/a/y', ino: 1 },
      { from: 'japanese/a/y', to: 'japanese/a/x', ino: 2 },
    ]);
    expect(cycle).toEqual([
      { from: 'japanese/a/x', to: 'japanese/a/.ttsu-move-1', ino: 1 },
      { from: 'japanese/a/y', to: 'japanese/a/x', ino: 2 },
      { from: 'japanese/a/.ttsu-move-1', to: 'japanese/a/y', ino: 1 },
    ]);
    expect(
      leftBehind([
        { from: 'japanese/芥川龍之介/芥川龍之介/Vol 3 - x', to: 'japanese/芥川龍之介/x' },
      ]),
    ).toEqual(['japanese/芥川龍之介/芥川龍之介', 'japanese/芥川龍之介']);
  });
});

// ---------------------------------------------------------------------------------------------
describe(
  'library changes through the sidecar, the reader and a stand-in Audiobookshelf',
  { timeout: 120_000 },
  () => {
    let close: (() => Promise<void>) | null = null;
    afterEach(async () => {
      await close?.();
      close = null;
    });

    const V = {
      A: {
        title: '本A',
        authors: ['作者'],
        narrators: ['読み手'],
        series: [{ name: 'シリーズ', position: 3, label: '3' }],
        publisher: '出版社',
        year: 2020,
      },
      P: {
        title: '本P',
        authors: ['作者'],
        narrators: ['読み手'],
        series: [],
        publisher: '出版社',
        year: 2020,
      },
      C: {
        title: '本C',
        authors: ['作者'],
        narrators: ['読み手'],
        series: [],
        publisher: '出版社',
        year: 2020,
      },
    };

    async function setup(opts: { absRewrites?: boolean } = {}) {
      const dir = makeTempDir('wp21f2-run');
      const data = path.join(dir, 'data');
      const roots = {
        torrents: path.join(data, 'torrents', 'audiobooks', 'japanese'),
        library: path.join(data, 'media', 'audiobooks', 'japanese'),
        media: path.join(data, 'media', 'audiobooks'),
      };
      const { env, setup: indexSetup } = await makeCleanupEnv({
        audio: {
          roots,
          readerWrittenFiles: () => [],
          readerState: () => 'reader',
          readLabels: () => ({ text: JSON.stringify({ books: [] }), error: null }),
        },
      });
      await indexSetup();
      // Decided values now: 本A has no series any more, 本C has a new publisher.
      const seed: BuildSeed = {
        files: [
          { root: 'torrents', rel: 'TMW/本A.m4b', bytes: Buffer.alloc(3000, 1) },
          {
            root: 'torrents',
            rel: 'Discord/本P/～１敗目～ 本編.mp3',
            bytes: Buffer.alloc(2000, 2),
          },
          { root: 'torrents', rel: 'Discord/本P/タイトル.mp3', bytes: Buffer.alloc(1000, 3) },
          { root: 'torrents', rel: 'TMW/本C.m4b', bytes: Buffer.alloc(3500, 4) },
        ],
        books: [
          { rel: 'TMW/本A.m4b', kind: 'file', files: ['TMW/本A.m4b'] },
          {
            rel: 'Discord/本P',
            kind: 'folder',
            files: ['Discord/本P/～１敗目～ 本編.mp3', 'Discord/本P/タイトル.mp3'],
          },
          { rel: 'TMW/本C.m4b', kind: 'file', files: ['TMW/本C.m4b'] },
        ],
        copies: [
          {
            key: 'cA',
            bookKey: 'torrents:TMW/本A.m4b',
            kind: 'file',
            files: ['torrents:TMW/本A.m4b'],
          },
          // Stage 3's story order: タイトル first (its name sorts after ～１敗目～).
          {
            key: 'cP',
            bookKey: 'torrents:Discord/本P',
            kind: 'parts',
            files: [
              'torrents:Discord/本P/タイトル.mp3',
              'torrents:Discord/本P/～１敗目～ 本編.mp3',
            ],
          },
          {
            key: 'cC',
            bookKey: 'torrents:TMW/本C.m4b',
            kind: 'file',
            files: ['torrents:TMW/本C.m4b'],
          },
        ],
        units: [
          {
            key: 'uA',
            kind: 'record',
            name: '本A',
            copies: ['cA'],
            values: { ...V.A, series: [] },
          },
          { key: 'uP', kind: 'record', name: '本P', copies: ['cP'], values: V.P },
          {
            key: 'uC',
            kind: 'record',
            name: '本C',
            copies: ['cC'],
            values: { ...V.C, publisher: '新しい出版社' },
          },
        ],
        libraryCopies: {},
      };
      const disk = seedBuild(env.cleanupDb, dir, seed);
      const db = env.cleanupDb;
      // What stage 6 built (as after the switch): the folders, links and metadata.json.
      db.prepare(`UPDATE audio_stages SET progress_json = ? WHERE stage = 6`).run(
        JSON.stringify({ analysisId: 'b6', phase: 'done' }),
      );
      const built = [
        {
          unit: 'uA',
          copy: 'cA',
          folder: '作者/シリーズ/Vol 3 - 本A',
          series: 'シリーズ',
          v: V.A,
          files: [['TMW/本A.m4b', '本A.m4b']],
        },
        {
          unit: 'uP',
          copy: 'cP',
          folder: '作者/本P',
          series: null,
          v: V.P,
          files: [
            ['Discord/本P/～１敗目～ 本編.mp3', '～１敗目～ 本編.mp3'],
            ['Discord/本P/タイトル.mp3', 'タイトル.mp3'],
          ],
        },
        {
          unit: 'uC',
          copy: 'cC',
          folder: '作者/本C',
          series: null,
          v: V.C,
          files: [['TMW/本C.m4b', '本C.m4b']],
        },
      ];
      for (const b of built) {
        const meta = metadataBytes(bookValues(b.v, b.v.title));
        const id = Number(
          db
            .prepare(
              `INSERT INTO audio_build_books (analysis_id, unit_key, copy_key, area, state, folder, base_folder, author, series, title, notes_json, files, pdfs, cover, metadata)
             VALUES ('b6', ?, ?, 'main', 'build', ?, ?, '作者', ?, ?, '[]', ?, 0, 1, ?)`,
            )
            .run(
              b.unit,
              b.copy,
              `japanese-new/${b.folder}`,
              `japanese-new/${b.folder}`,
              b.series,
              b.folder.split('/').pop(),
              b.files.length,
              meta,
            ).lastInsertRowid,
        );
        const abs = path.join(roots.library, ...b.folder.split('/'));
        fs.mkdirSync(abs, { recursive: true });
        for (const [src, name] of b.files) {
          fs.linkSync(path.join(roots.torrents, ...src.split('/')), path.join(abs, name));
          db.prepare(
            `INSERT INTO audio_build_ops (analysis_id, book_id, kind, dst, src_file_id, src_rel, state) VALUES ('b6', ?, 'link', ?, ?, ?, 'done')`,
          ).run(id, `japanese-new/${b.folder}/${name}`, disk.fileId(`torrents:${src}`), src);
        }
        fs.writeFileSync(path.join(abs, 'metadata.json'), meta);
      }
      // Your edit of 本C's title in Audiobookshelf (ABS writes it into metadata.json).
      const cMeta = path.join(roots.library, '作者', '本C', 'metadata.json');
      fs.writeFileSync(
        cMeta,
        JSON.stringify(
          { ...JSON.parse(fs.readFileSync(cMeta, 'utf8')), title: 'あなたの題名', chapters: [] },
          null,
          2,
        ),
      );
      // A merged file the reader wrote (settled long ago).
      const merged = path.join(roots.media, 'japanese-merged', '作者', '本P', '本P (merged).m4b');
      fs.mkdirSync(path.dirname(merged), { recursive: true });
      fs.writeFileSync(merged, 'merged audio');
      const old = new Date('2020-01-01T00:00:00Z');
      fs.utimesSync(merged, old, old);
      fs.mkdirSync(path.join(roots.media, 'japanese-generated'), { recursive: true });
      updateSettings(db, { audiobooks: { libraryChanges: 'on' } });
      // The reader: its scanner over media/audiobooks, a link to 本A.
      updateLibrary(env.db, env.libraryId(), { audioDir: 'japanese' });
      const scan = new AudioScanService({
        db: env.db,
        config: { ...DEFAULT_AUDIO, dir: roots.media },
        otherDirs: [],
      });
      await scan.start({ timer: false });
      await scan.idle();
      const uid = listUsers(env.db)[0].id;
      env.db
        .prepare(
          `INSERT INTO audio_links (user_id, book_id, state, folder_rel_path, file_name, source, confirmed_at) VALUES (?, 'book-a', 'linked', ?, '本A.m4b', 'library', 1234)`,
        )
        .run(uid, 'japanese/作者/シリーズ/Vol 3 - 本A');
      // The reader's own record of the merge it wrote.
      env.db
        .prepare(
          `INSERT INTO audio_writes (purpose, temp_rel_path, final_rel_path, direct, state, created_at, updated_at)
           VALUES ('merge', 'japanese-merged/作者/本P/.tmp', 'japanese-merged/作者/本P/本P (merged).m4b', 0, 'done', 1, 1)`,
        )
        .run();
      const reader = switchReader({
        db: env.db,
        scan,
        resumeMerges: () => undefined,
        dbDir: env.dbDir,
      });
      // A stand-in Audiobookshelf: three items; progress and a bookmark on 本A; a library scan
      // moves 本A's item to its new folder.
      const items: { id: string; relPath: string; addedAt: number; lastScan?: number }[] = [
        { id: 'i1', relPath: '作者/シリーズ/Vol 3 - 本A', addedAt: 1 },
        { id: 'i2', relPath: '作者/本P', addedAt: 1 },
        { id: 'i3', relPath: '作者/本C', addedAt: 1 },
      ];
      const calls: string[] = [];
      const patched: unknown[] = [];
      const patchedBy: Record<string, unknown[]> = {};
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${u.pathname}`);
        const json = (v: unknown) =>
          new Response(JSON.stringify(v), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (u.pathname === '/api/libraries')
          return json({
            libraries: [
              {
                id: 'lib1',
                name: 'Japanese Audiobooks',
                folders: [{ fullPath: '/audiobooks/japanese' }],
              },
            ],
          });
        if (u.pathname === '/api/libraries/lib1/items')
          return json({ results: items, total: items.length });
        if (u.pathname === '/api/users') return json({ users: [{ id: 'u1', username: 'root' }] });
        if (u.pathname === '/api/users/u1')
          return json({
            username: 'root',
            mediaProgress: [{ libraryItemId: 'i1', currentTime: 30, isFinished: false }],
            bookmarks: [{ libraryItemId: 'i1', time: 30 }],
          });
        if (u.pathname === '/api/libraries/lib1/scan' && method === 'POST') {
          items[0].relPath = '作者/本A';
          // As ABS 2.37.1 does: its scan rewrites every book's metadata.json (its own form).
          if (opts.absRewrites)
            for (const it of items) {
              const f = path.join(roots.library, ...it.relPath.split('/'), 'metadata.json');
              if (fs.existsSync(f)) fs.writeFileSync(f, fs.readFileSync(f));
            }
          return new Response('OK', { status: 200 });
        }
        // ABS's edit call clears the series it kept (B1's finding); the item reads back cleared.
        const edit = /^\/api\/items\/(i\d)\/media$/.exec(u.pathname);
        if (edit && method === 'PATCH') {
          const body = JSON.parse(String(init?.body));
          if (edit[1] === 'i1') patched.push(body);
          (patchedBy[edit[1]] ??= []).push(body);
          return json({ updated: true });
        }
        if (u.pathname === '/api/items/i2')
          return json({
            media: {
              metadata: (patchedBy.i2?.at(-1) as { metadata?: unknown } | undefined)?.metadata ?? {
                publisher: '古い出版社',
              },
              tags: [],
            },
          });
        if (/^\/api\/items\/i\d$/.test(u.pathname))
          return json({
            lastScan: items.find((it) => `/api/items/${it.id}` === u.pathname)?.lastScan ?? null,
            media: {
              metadata: { series: patched.length ? [] : [{ name: 'シリーズ', sequence: '3' }] },
              tags: [],
            },
          });
        return new Response('{}', { status: 404 });
      }) as typeof fetch;
      const stage7 = env.audio!.stage7! as unknown as {
        existingTree: () => Promise<ExistingTree>;
        currentPlan: () => Promise<PlannedBook[]>;
      };
      const changes = new LibraryChanges({
        db,
        media: roots.media,
        lock: new DiskLock(5),
        abs: () => ({ baseUrl: 'http://abs.test', apiKey: 'k', timeoutMs: 1000 }),
        fetchImpl,
        reader: () => reader,
        tree: () => stage7.existingTree(),
        plan: () => stage7.currentPlan(),
        sidecarVersion: () => ({ version: '1.3.0', lastSeen: Date.now() }),
      });
      const worker = new LinkWorker(
        {
          serverUrl: 'http://x',
          token: 'ttsu_x',
          dataDir: data,
          dirMode: 0o777,
          fileMode: 0o666,
          serverTimeoutSeconds: 5,
          bsdtar: 'bsdtar',
          archiveCharset: 'CP932',
        },
        () => undefined,
      );
      close = async () => {
        await scan.stop();
        await env.close();
      };
      return {
        env,
        db,
        roots,
        changes,
        worker,
        reader,
        uid,
        calls,
        items,
        scan,
        patched,
        patchedBy,
      };
    }

    async function drive(
      t: Awaited<ReturnType<typeof setup>>,
      mode: 'analyse' | 'on',
      runId: number,
    ) {
      const c = t.changes.start(mode);
      for (let i = 0; i < 300; i++) {
        const r = await t.changes.step(runId, c, () => false);
        if (typeof r === 'object') throw new Error(r.pause);
        if (r === 'done') return c;
        const b = t.changes.claim(runId, c);
        if (b) t.changes.report(b.id, (await t.worker.process(b as never)) as never);
      }
      throw new Error(`not done: ${c.phase}`);
    }

    const tree = (root: string) => {
      const out: Record<string, string> = {};
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          const rel = path.relative(root, p).replace(/\\/g, '/');
          if (e.isDirectory()) {
            out[rel + '/'] = 'dir';
            walk(p);
          } else {
            const st = fs.lstatSync(p);
            out[rel] =
              `${st.ino}|${st.size}|${createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
          }
        }
      };
      walk(root);
      return out;
    };

    it('Preview plans every change and writes nothing; On makes them, remaps the link, and ABS keeps the items', async () => {
      const t = await setup();
      const before = { media: tree(t.roots.media), torrents: tree(t.roots.torrents) };
      // Preview.
      const p = await drive(t, 'analyse', 1);
      expect(p.counts).toMatchObject({
        changes: 3,
        metadata: 2,
        moves: 1,
        renames: 2,
        rmdirs: 1,
        readerFiles: 1,
        links: 1,
        userFields: 1,
        reviews: 0,
      });
      expect(tree(t.roots.media)).toEqual(before.media);
      expect(tree(t.roots.torrents)).toEqual(before.torrents);
      expect(t.calls.some((c) => c.startsWith('POST'))).toBe(false);
      const listed = t.changes.list(1, 'changes').items as {
        folderFrom: string;
        folderTo: string | null;
        fields: { field: string }[];
        userFields: string[];
        renames: { to: string }[];
      }[];
      expect(listed.map((x) => [x.folderFrom, x.folderTo])).toEqual([
        ['japanese/作者/シリーズ/Vol 3 - 本A', 'japanese/作者/本A'],
        ['japanese/作者/本C', null],
        ['japanese/作者/本P', null],
      ]);
      expect(listed[1].userFields).toEqual(['title']);
      expect(listed[2].renames.map((r) => r.to).sort()).toEqual([
        '01 タイトル.mp3',
        '02 ～１敗目～ 本編.mp3',
      ]);
      // On.
      const inoA = fs.lstatSync(path.join(t.roots.library, '作者', 'シリーズ', 'Vol 3 - 本A')).ino;
      const c = await drive(t, 'on', 2);
      expect(c.error).toBeNull();
      // 本A moved (the same folder), its new metadata.json without the series; シリーズ removed.
      const a = path.join(t.roots.library, '作者', '本A');
      expect(fs.lstatSync(a).ino).toBe(inoA);
      expect(JSON.parse(fs.readFileSync(path.join(a, 'metadata.json'), 'utf8')).series).toEqual([]);
      expect(fs.existsSync(path.join(t.roots.library, '作者', 'シリーズ'))).toBe(false);
      // 本P's links numbered in story order (the same files).
      expect(fs.readdirSync(path.join(t.roots.library, '作者', '本P')).sort()).toEqual([
        '01 タイトル.mp3',
        '02 ～１敗目～ 本編.mp3',
        'metadata.json',
      ]);
      expect(fs.lstatSync(path.join(t.roots.library, '作者', '本P', '01 タイトル.mp3')).ino).toBe(
        fs.lstatSync(path.join(t.roots.torrents, 'Discord', '本P', 'タイトル.mp3')).ino,
      );
      // 本C: your title kept, the new publisher written.
      const cm = JSON.parse(
        fs.readFileSync(path.join(t.roots.library, '作者', '本C', 'metadata.json'), 'utf8'),
      );
      expect(cm).toMatchObject({ title: 'あなたの題名', publisher: '新しい出版社' });
      // The reader-written file has its original name under _merged/ (the same file).
      const mergedT = path.join(t.roots.torrents, '_merged', '作者', '本P', '本P (merged).m4b');
      expect(fs.lstatSync(mergedT).ino).toBe(
        fs.lstatSync(path.join(t.roots.media, 'japanese-merged', '作者', '本P', '本P (merged).m4b'))
          .ino,
      );
      // The torrents: every file as it was; only _merged/ is new.
      const after = tree(t.roots.torrents);
      for (const [k, v] of Object.entries(before.torrents)) expect(after[k], k).toBe(v);
      expect(
        Object.keys(after)
          .filter((k) => !(k in before.torrents))
          .every((k) => k.startsWith('_merged/')),
      ).toBe(true);
      // The reader's link follows the move; confirmed_at kept; it plays; the hold is gone.
      const link = t.env.db
        .prepare(
          `SELECT folder_rel_path, file_name, confirmed_at FROM audio_links WHERE book_id = 'book-a'`,
        )
        .get() as Record<string, unknown>;
      expect(link).toEqual({
        folder_rel_path: 'japanese/作者/本A',
        file_name: '本A.m4b',
        confirmed_at: 1234,
      });
      expect(c.remap).toMatchObject({ changed: 1, resolveBefore: 1, resolveAfter: 1 });
      expect(c.snapshot).toMatch(/library-changes/);
      expect(t.reader.held('switch')).toBe(false);
      // ABS: one library scan; every changed book seen, the same item; progress and bookmark kept.
      expect(t.calls.filter((x) => x.startsWith('POST'))).toEqual([
        'POST /api/libraries/lib1/scan',
      ]);
      // The series 本A lost: cleared through ABS's edit call (only that field), read back empty.
      expect(t.patched).toEqual([{ metadata: { series: [] } }]);
      expect(t.calls.filter((x) => x.startsWith('PATCH'))).toEqual(['PATCH /api/items/i1/media']);
      expect(c.abs).toMatchObject({ verified: 3, notYet: 0, problems: [], cleared: 1 });
      // The ledger follows: nothing more to change at the next run.
      const again = await drive(t, 'on', 3);
      expect(again.counts.changes).toBe(0);
      expect(again.counts.readerFiles).toBe(0);
    });

    it('item 6: what ABS made of our write is proven by its import of the book or its own last scan; a later change is not; a real edit stays yours in a proven file', async () => {
      const t = await setup();
      const now = Date.now();
      t.items[1].addedAt = now; // 本P: imported by ABS just after we built it
      t.items[0].lastScan = now; // 本A: ABS's own scan of it just now (imported long before)
      t.items[2].addedAt = now; // 本C: imported now, with your title edit in its file
      const c = await drive(t, 'analyse', 1);
      expect(c.seen).toMatchObject({ checked: 3, proven: 3, unproven: 0, notInAbs: 0 });
      expect(t.calls.filter((x) => x.startsWith('GET /api/items/'))).toEqual(['GET /api/items/i1']);
      // Proven, yet your title is no form of ABS's: still yours.
      const listed = t.changes.list(1, 'changes').items as {
        folderFrom: string;
        userFields: string[];
      }[];
      expect(listed.find((x) => x.folderFrom === 'japanese/作者/本C')!.userFields).toEqual([
        'title',
      ]);
      // A file that changed long after every scan of the book: not provable.
      const P = (
        t.db
          .prepare(`SELECT id FROM audio_library_books WHERE folder = 'japanese/作者/本P'`)
          .get() as { id: number }
      ).id;
      t.db.prepare('UPDATE audio_library_books SET seen_state = NULL WHERE id = ?').run(P);
      const later = new Date(now + 3_600_000);
      fs.utimesSync(path.join(t.roots.library, '作者', '本P', 'metadata.json'), later, later);
      const c2 = await drive(t, 'analyse', 2);
      expect(c2.seen).toMatchObject({ checked: 1, proven: 0, unproven: 1 });
      expect(
        t.db.prepare('SELECT seen_state, seen FROM audio_library_books WHERE id = ?').get(P),
      ).toEqual({ seen_state: 'unproven', seen: null });
      // A book ABS doesn't show yet is asked again at the next run.
      t.items.splice(1, 1);
      t.db.prepare('UPDATE audio_library_books SET seen_state = NULL WHERE id = ?').run(P);
      const c3 = await drive(t, 'analyse', 3);
      expect(c3.seen).toMatchObject({ checked: 1, notInAbs: 1 });
      expect(
        (
          t.db.prepare('SELECT seen_state FROM audio_library_books WHERE id = ?').get(P) as {
            seen_state: string | null;
          }
        ).seen_state,
      ).toBeNull();
    });

    it('item 6: a metadata-only run is applied and scanned; your edit stays yours at the next write; what ABS made of each write; the older value it kept, set on your word', async () => {
      const t = await setup({ absRewrites: true });
      // As stage 7 keeps each run's progress (the seen step reads the scans we asked for there).
      const remember = (runId: number, c: { startedAt: number }) =>
        t.db
          .prepare(
            `INSERT OR REPLACE INTO audio_arrival_runs (id, trigger, mode, state, phase, started_at, finished_at, progress_json)
             VALUES (?, 'now', 'on', 'done', 'done', ?, ?, ?)`,
          )
          .run(runId, c.startedAt, Date.now(), JSON.stringify({ changes: c }));
      const bookId = (folder: string) =>
        (
          t.db.prepare('SELECT id FROM audio_library_books WHERE folder = ?').get(folder) as {
            id: number;
          }
        ).id;
      const c2 = await drive(t, 'on', 2);
      remember(2, c2);
      expect(c2.error).toBeNull();
      const C = bookId('japanese/作者/本C');
      const P = bookId('japanese/作者/本P');
      // Your title, kept by run 2's write, is recorded as yours.
      expect(
        t.db.prepare('SELECT field FROM audio_library_owners WHERE book_id = ?').all(C),
      ).toEqual([{ field: 'title' }]);
      // A later decision changes only 本C's publisher: a run with no move and no rename.
      expect(
        t.db
          .prepare(
            `UPDATE ai_values SET value_json = ? WHERE stage = 'audio5' AND item_key = 'uC' AND field = 'publisher'`,
          )
          .run(JSON.stringify('三番目の出版社')).changes,
      ).toBe(1);
      const scans = () => t.calls.filter((x) => x === 'POST /api/libraries/lib1/scan').length;
      const scansBefore = scans();
      const c3 = await drive(t, 'on', 3);
      remember(3, c3);
      expect(c3.counts).toMatchObject({ changes: 1, metadata: 1, moves: 0, renames: 0 });
      // Bug A: the change is applied (the ledger updated) and ABS scans (both were skipped).
      expect(
        t.db.prepare('SELECT state FROM audio_library_changes WHERE run_id = 3').all(),
      ).toEqual([{ state: 'applied' }]);
      expect(scans()).toBe(scansBefore + 1);
      // Bug B: your title is kept at this second write (it was taken back to the cleanup's).
      const cFile = path.join(t.roots.library, '作者', '本C', 'metadata.json');
      expect(JSON.parse(fs.readFileSync(cFile, 'utf8'))).toMatchObject({
        title: 'あなたの題名',
        publisher: '三番目の出版社',
      });
      // The next run: nothing to change; 本C's file since run 3's scan is ABS's (proven by time).
      const c4 = await drive(t, 'on', 4);
      remember(4, c4);
      expect(c4.counts.changes).toBe(0);
      expect(c4.seen).toMatchObject({ checked: 1, proven: 1, unproven: 0 });
      const seenC = t.db
        .prepare('SELECT seen_state, seen, written_run FROM audio_library_books WHERE id = ?')
        .get(C) as { seen_state: string; seen: Buffer; written_run: number };
      expect(seenC.seen_state).toBe('seen');
      expect(seenC.written_run).toBe(3);
      expect(seenC.seen.equals(fs.readFileSync(cFile))).toBe(true);
      // 本P's file changed before any scan of ours could explain it: not provable, so a
      // differing field would be yours.
      expect(
        (
          t.db.prepare('SELECT seen_state FROM audio_library_books WHERE id = ?').get(P) as {
            seen_state: string;
          }
        ).seen_state,
      ).toBe('unproven');

      // ABS kept an older value after our write (ST 黄's case, on 本P's publisher).
      const pFile = path.join(t.roots.library, '作者', '本P', 'metadata.json');
      const oldP = { ...JSON.parse(fs.readFileSync(pFile, 'utf8')), publisher: '古い出版社' };
      const oldBytes = Buffer.from(JSON.stringify(oldP, null, 2));
      fs.writeFileSync(pFile, oldBytes);
      t.db
        .prepare(
          `UPDATE audio_library_books SET before = ?, seen = ?, seen_state = 'seen' WHERE id = ?`,
        )
        .run(oldBytes, oldBytes, P);
      const c5 = await drive(t, 'on', 5);
      remember(5, c5);
      expect(c5.counts).toMatchObject({ changes: 1, absKept: 1, metadata: 0, userFields: 0 });
      const review = t.changes.list(5, 'review').items as {
        absKept: { field: string; mine: unknown }[];
        reviews: { kind: string }[];
      }[];
      expect(review.map((r) => r.absKept.map((x) => [x.field, x.mine]))).toEqual([
        [['publisher', '古い出版社']],
      ]);
      expect(review[0].reviews.map((r) => r.kind)).toEqual(['abs_kept']);
      expect(JSON.parse(fs.readFileSync(pFile, 'utf8')).publisher).toBe('古い出版社');
      expect(t.patchedBy.i2).toBeUndefined();
      // "Use the cleanup's": written, then set through ABS's edit call; the choice is spent.
      t.changes.choose(P, 'publisher', 'ours');
      const c6 = await drive(t, 'on', 6);
      remember(6, c6);
      expect(c6.error).toBeNull();
      expect(JSON.parse(fs.readFileSync(pFile, 'utf8')).publisher).toBe('出版社');
      expect(t.patchedBy.i2).toEqual([{ metadata: { publisher: '出版社' } }]);
      expect(c6.abs).toMatchObject({ set: 1, problems: [] });
      expect(
        t.db.prepare('SELECT COUNT(*) AS n FROM audio_library_choices WHERE book_id = ?').get(P),
      ).toEqual({ n: 0 });
      // Nothing left; your title still yours.
      const c7 = await drive(t, 'on', 7);
      expect(c7.counts.changes).toBe(0);
      expect(c7.seen).toMatchObject({ proven: 1 });
      expect(JSON.parse(fs.readFileSync(cFile, 'utf8')).title).toBe('あなたの題名');
    });
  },
);

// ---------------------------------------------------------------------------------------------
describe('the two ABS calls the library changes make', () => {
  it('abs-clear-fields.ts: one request, PATCH …/items/:id/media, only empty values; only library-changes.ts imports it', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const strip = (s: string) =>
      s
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const code = strip(
      fs.readFileSync(path.join(srcDir, 'cleanup', 'audio', 'abs-clear-fields.ts'), 'utf8'),
    );
    expect((code.match(/fetchImpl\(/g) ?? []).length).toBe(1);
    expect(code.match(/method: '([A-Z]+)'/g)).toEqual(["method: 'PATCH'"]);
    expect(code).toMatch(/\/api\/items\/\$\{itemId\}\/media`/);
    expect(code).not.toMatch(/POST|DELETE|PUT|\/scan|\/settings|watcher|\/cover/);
    // Only null or [] goes into the body.
    expect(code).toMatch(/metadata\[f\] = list\.has\(f\) \? \[\] : null;/);
    const importers: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /abs-clear-fields'/.test(fs.readFileSync(p, 'utf8')))
          importers.push(path.relative(srcDir, p).replace(/\\/g, '/'));
      }
    };
    walk(srcDir);
    expect(importers).toEqual(['cleanup/audio/library-changes.ts']);
  });

  it('abs-set-fields.ts (item 6): one request, PATCH …/items/:id/media, only our fields from the bytes written; only library-changes.ts imports it', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const strip = (s: string) =>
      s
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const code = strip(
      fs.readFileSync(path.join(srcDir, 'cleanup', 'audio', 'abs-set-fields.ts'), 'utf8'),
    );
    expect((code.match(/fetchImpl\(/g) ?? []).length).toBe(1);
    expect(code.match(/method: '([A-Z]+)'/g)).toEqual(["method: 'PATCH'"]);
    expect(code).toMatch(/\/api\/items\/\$\{itemId\}\/media`/);
    expect(code).not.toMatch(/POST|DELETE|PUT|\/scan|\/settings|watcher|\/cover/);
    // The body is built only from the metadata.json bytes passed in, for the listed fields.
    expect(code).toMatch(/const body = setBody\(written, fields\);/);
    expect(
      setBody(
        Buffer.from(
          JSON.stringify({
            series: ['色シリーズ #3', 'STシリーズ'],
            authors: ['今野敏'],
            publisher: '出版社',
            title: 'x',
          }),
        ),
        ['series', 'authors'],
      ),
    ).toEqual({
      metadata: {
        series: [
          { name: '色シリーズ', sequence: '3' },
          { name: 'STシリーズ', sequence: null },
        ],
        authors: [{ name: '今野敏' }],
      },
    });
    // WP21g: genres are ours too (stage 8), set as a list; any other field still is not.
    expect(
      setBody(Buffer.from(JSON.stringify({ genres: ['ファンタジー', '恋愛'] })), ['genres']),
    ).toEqual({
      metadata: { genres: ['ファンタジー', '恋愛'] },
    });
    expect(() => setBody(Buffer.from('{}'), ['isbn' as never])).toThrow(/Not a field/);
    const importers: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /abs-set-fields'/.test(fs.readFileSync(p, 'utf8')))
          importers.push(path.relative(srcDir, p).replace(/\\/g, '/'));
      }
    };
    walk(srcDir);
    expect(importers).toEqual(['cleanup/audio/library-changes.ts']);
  });

  it('abs-library-scan.ts: one request, POST …/scan, no other route; only library-changes.ts imports it', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const strip = (s: string) =>
      s
        .replace(/\r\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    const code = strip(
      fs.readFileSync(path.join(srcDir, 'cleanup', 'audio', 'abs-library-scan.ts'), 'utf8'),
    );
    expect((code.match(/fetchImpl\(/g) ?? []).length).toBe(1);
    expect(code.match(/method: '([A-Z]+)'/g)).toEqual(["method: 'POST'"]);
    expect(code).toMatch(/\/api\/libraries\/\$\{libraryId\}\/scan`/);
    expect(code).not.toMatch(/PATCH|DELETE|PUT|\/items\/|\/settings|watcher/);
    const importers: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          p.endsWith('.ts') &&
          /from '\.\/abs-library-scan'|abs-library-scan'/.test(fs.readFileSync(p, 'utf8'))
        )
          importers.push(path.relative(srcDir, p).replace(/\\/g, '/'));
      }
    };
    walk(srcDir);
    expect(importers.filter((f) => f !== 'cleanup/audio/abs-library-scan.ts')).toEqual([
      'cleanup/audio/library-changes.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('ABS’s own fills are not your edits (the live Preview on a copy, 芥川龍之介 03/04)', () => {
  const v = (over: Record<string, unknown> = {}) =>
    bookValues(
      { title: '芥川龍之介 04', authors: ['芥川龍之介'], narrators: ['読み手'], ...over },
      '芥川龍之介 04',
    );
  const folder = 'japanese-new/芥川龍之介/芥川龍之介 04';
  const book: LedgerBook = {
    id: 1,
    folder: 'japanese/芥川龍之介/芥川龍之介 04',
    baseFolder: 'japanese/芥川龍之介/芥川龍之介 04',
    area: 'main',
    files: [{ fileId: 1, name: 'a.m4b', ino: 1 }],
    metadata: metadataBytes(v()),
    decided: metadataBytes(v()),
    folderIno: 9,
  };
  const cur = {
    unitKey: 'u',
    copyKey: 'c',
    area: 'main',
    state: 'build',
    folder,
    baseFolder: folder,
    author: '芥川龍之介',
    series: null,
    title: '芥川龍之介 04',
    notes: [],
    files: [{ fileId: 1, dst: `${folder}/a.m4b` }],
    pdfs: [],
    cover: true,
    rank: 0,
    values: v({ publisher: 'パンローリング', year: 2015 }),
    metadata: metadataBytes(v({ publisher: 'パンローリング', year: 2015 })),
  } as unknown as PlannedBook;
  const plan = (disk: Record<string, unknown>, tags: Record<string, string> | null) =>
    planLibraryChanges({
      books: [book],
      current: () => cur,
      disk: () => Buffer.from(JSON.stringify(disk)),
      abs: () => null,
      keep: () => null,
      tree: {
        dirs: new Set(['japanese', 'japanese/芥川龍之介']),
        bookDirs: new Set(),
        narrators: new Map(),
      },
      choices: () => ({}),
      fileTags: () => tags,
    });
  const built = JSON.parse(metadataBytes(v()).toString('utf8')) as Record<string, unknown>;

  it('a field we wrote empty that ABS filled from the file’s own tag: ABS’s; our decided value replaces it', () => {
    const disk = { ...built, publisher: 'Pan Rolling', publishedYear: '2014', genres: ['朗読'] };
    const [c] = plan(disk, { publisher: 'Pan Rolling', date: '2014-05-01', genre: '朗読' });
    expect(c.userFields).toEqual([]);
    expect(c.conflicts).toEqual([]);
    const m = JSON.parse(c.metadataNew!.toString('utf8'));
    expect(m).toMatchObject({
      publisher: 'パンローリング',
      publishedYear: '2015',
      genres: ['朗読'],
    });
  });

  it('a value in an empty field that is not the file’s tag is yours: kept, and it conflicts with ours', () => {
    const disk = { ...built, publisher: 'あなたの出版社' };
    const [c] = plan(disk, { publisher: 'Pan Rolling' });
    expect(c.userFields).toEqual(['publisher']);
    expect(c.conflicts.map((x) => x.field)).toEqual(['publisher']);
    expect(JSON.parse(c.metadataNew!.toString('utf8')).publisher).toBe('あなたの出版社');
  });

  it('fields we never decide (isbn, …) stay as ABS has them and are never yours', () => {
    const disk = { ...built, isbn: '978-4' };
    const [c] = plan(disk, null);
    expect(c.userFields).toEqual([]);
    expect(JSON.parse(c.metadataNew!.toString('utf8'))).toMatchObject({ isbn: '978-4' });
  });

  it('genres are ours since WP21g: a value that is not the file’s genre tag is yours and kept', () => {
    const disk = { ...built, genres: ['文学'] };
    const [c] = plan(disk, { genre: '朗読' });
    expect(c.userFields).toEqual(['genres']);
    expect(JSON.parse(c.metadataNew!.toString('utf8')).genres).toEqual(['文学']);
  });
});

// ---------------------------------------------------------------------------------------------
// Audiobook cleanup leftovers, item 6 (approved by the user 2026-11-21): a field is yours only
// when no evidence says Audiobookshelf changed it; your edits are never overwritten.
describe('Audiobookshelf leftovers and its own form vs your edits (fieldState, library-plan.ts)', () => {
  const v = (over: Record<string, unknown> = {}) =>
    bookValues(
      {
        title: 'ST 黄',
        authors: ['今野敏'],
        narrators: ['読み手'],
        publisher: '出版社',
        description: 'King & Prince<br>映画',
        year: 2020,
        series: [
          { name: 'STシリーズ', position: null, label: null },
          { name: '色シリーズ', position: 3, label: null },
        ],
        ...over,
      },
      'ST 黄',
    );
  const obj = (b: Buffer) => JSON.parse(b.toString('utf8')) as Record<string, unknown>;
  const buf = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o, null, 2));
  const written = obj(metadataBytes(v()));
  const folder = 'japanese-new/今野敏/色シリーズ/Vol 3 - ST 黄';
  const planned = (vals = v()): PlannedBook =>
    ({
      unitKey: 'u1',
      copyKey: 'c1',
      area: 'main',
      state: 'build',
      folder,
      baseFolder: folder,
      author: '今野敏',
      series: '色シリーズ',
      title: 'Vol 3 - ST 黄',
      notes: [],
      files: [{ fileId: 1, dst: `${folder}/a.m4b` }],
      pdfs: [],
      cover: true,
      metadata: metadataBytes(vals),
      values: vals,
      rank: 0,
    }) as PlannedBook;
  const ledger = (over: Partial<LedgerBook> = {}): LedgerBook => ({
    id: 1,
    folder: 'japanese/今野敏/色シリーズ/Vol 3 - ST 黄',
    baseFolder: 'japanese/今野敏/色シリーズ/Vol 3 - ST 黄',
    area: 'main',
    files: [{ fileId: 1, name: 'a.m4b', ino: 1 }],
    metadata: metadataBytes(v()),
    decided: metadataBytes(v()),
    folderIno: 9,
    ...over,
  });
  const plan = (book: LedgerBook, disk: Buffer, cur = planned(), choices = {}) =>
    planLibraryChanges({
      books: [book],
      current: () => cur,
      disk: () => disk,
      abs: () => null,
      keep: () => null,
      tree: {
        dirs: new Set(['japanese', 'japanese/今野敏', 'japanese/今野敏/色シリーズ', book.folder]),
        bookDirs: new Set([book.folder]),
        narrators: new Map(),
      },
      choices: () => choices,
      fileTags: () => ({ date: '2024-12-17' }),
    });
  // ST 黄 as on the live library: the file had #6 before our write; ABS's scan of our write
  // (without the number) kept it, so the file (and `seen`) has it again.
  const kept = { ...written, series: ['色シリーズ #3', 'STシリーズ #6'] };
  const st = (over: Partial<LedgerBook> = {}) =>
    ledger({ before: buf(kept), seen: buf(kept), ...over });

  it('each state: ours, ABS’s form or fill, the older value ABS kept, yours', () => {
    const s = (
      field: string,
      disk: Record<string, unknown>,
      more: Partial<Parameters<typeof fieldState>[0]> = {},
    ) =>
      fieldState({
        field,
        disk,
        written,
        seen: null,
        before: null,
        yours: false,
        tags: null,
        ...more,
      });
    expect(s('title', written)).toBe('ours');
    // The survey's 37 descriptions: "&" as "&amp;", "<br>" as "<br />" — ABS's only after its scan.
    const amp = { ...written, description: 'King &amp; Prince<br />映画' };
    expect(s('description', amp, { seen: amp })).toBe('abs_form');
    expect(s('description', amp)).toBe('yours');
    // The survey's 20 author lists in ABS's order.
    const two = { ...written, authors: ['橘公司', '東出祐一郎'] };
    const w2 = { ...written, authors: ['東出祐一郎', '橘公司'] };
    expect(s('authors', two, { written: w2, seen: two })).toBe('abs_form');
    // The survey's 20 `_Unknown` and 5 full dates: ABS's fill of a field we wrote empty.
    const empty = { ...written, authors: [], publishedYear: null };
    expect(s('authors', { ...empty, authors: ['_Unknown'] }, { written: empty })).toBe('abs_fill');
    expect(
      s(
        'publishedYear',
        { ...empty, publishedYear: '2024-12-17' },
        { written: empty, tags: { date: '2024-12-17' } },
      ),
    ).toBe('abs_fill');
    // ST 黄: the value the file had before our write, still there since ABS's scan.
    expect(s('series', kept, { seen: kept, before: kept })).toBe('abs_kept');
    // The same value without the proof (no `seen`): yours (never overwritten).
    expect(s('series', kept, { before: kept })).toBe('yours');
    // Changed after ABS's scan (the file differs from `seen`): yours.
    expect(
      s('series', { ...kept, series: ['あなたのシリーズ'] }, { seen: kept, before: kept }),
    ).toBe('yours');
    // Yours once, yours always: even when the file now holds what we wrote.
    expect(s('title', written, { yours: true })).toBe('yours');
  });

  it('ST 黄: the older value ABS kept goes to review; nothing is written until you choose', () => {
    const book = st();
    expect(absKeptSomething(book)).toBe(true);
    const [c] = plan(book, buf(kept));
    expect(c.absKept).toEqual([
      { field: 'series', from: written.series, to: written.series, mine: kept.series },
    ]);
    expect(c.reviews.map((r) => r.kind)).toEqual(['abs_kept']);
    expect(c.userFields).toEqual([]);
    expect(c.metadataNew).toBeNull();
    expect(c.absSet).toEqual([]);
  });

  it('"Use the cleanup’s": ours is written and set through ABS’s edit call; "Keep Audiobookshelf’s": kept as yours', () => {
    const [o] = plan(st(), buf(kept), planned(), { series: 'ours' });
    expect(o.absKept).toEqual([]);
    expect(o.absSet).toEqual(['series']);
    expect(obj(o.metadataNew!).series).toEqual(written.series);
    expect(o.metadataRead).toEqual(buf(kept));
    const [m] = plan(st(), buf(kept), planned(), { series: 'mine' });
    expect(m?.absKept ?? []).toEqual([]);
    expect(m?.metadataNew ?? null).toBeNull();
    // With another change, the kept value is written back as it is and counted as yours.
    const [m2] = plan(st(), buf(kept), planned(v({ publisher: '新しい出版社' })), {
      series: 'mine',
    });
    expect(m2.userFields).toEqual(['series']);
    expect(obj(m2.metadataNew!)).toMatchObject({ series: kept.series, publisher: '新しい出版社' });
  });

  it('the #6 correction: our value is ABS’s, nothing to review', () => {
    const six = v({
      series: [
        { name: 'STシリーズ', position: 6, label: null },
        { name: '色シリーズ', position: 3, label: null },
      ],
    });
    const [c] = plan(st(), buf(kept), planned(six));
    expect(c.absKept).toEqual([]);
    expect(c.reviews).toEqual([]);
    expect(c.userFields).toEqual([]);
    expect(obj(c.metadataNew!).series).toEqual(['STシリーズ #6', '色シリーズ #3']);
  });

  it('your edit kept by one write stays yours at the next (bug B: it was taken back to ours)', () => {
    // After a write that kept your title, the ledger holds your title and our decided values.
    const mine = obj(metadataBytes(v({ title: 'あなたの題名' })));
    const book = ledger({
      metadata: buf(mine),
      decided: metadataBytes(v()),
      yours: new Set(['title']),
    });
    const [c] = plan(book, buf(mine), planned(v({ publisher: '三番目の出版社' })));
    expect(obj(c.metadataNew!)).toMatchObject({
      title: 'あなたの題名',
      publisher: '三番目の出版社',
    });
    expect(c.userFields).toEqual(['title']);
    // Without the record the same file reads as ours, and ours would be written over it.
    const [old] = plan(
      { ...book, yours: new Set() },
      buf(mine),
      planned(v({ publisher: '三番目の出版社' })),
    );
    expect(obj(old.metadataNew!).title).toBe('ST 黄');
  });
});
