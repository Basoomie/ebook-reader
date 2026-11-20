/**
 * WP21e-1: audiobook stage 6 builds japanese-new with hard links. The names, the metadata.json,
 * the plan from stages 1-5 (proven and unproven duplicates, collisions, AI books, library-only
 * files, PDFs, parts and discs, the move list), the linking sidecar's writer and its guarantees
 * (create-only, nothing else in the torrents or the live library changes: content, inode and
 * mtime), the full build through the sidecar over HTTP with the disk lock, restarts and
 * refusals, the check, and EXPLAIN of every polled query.
 *
 * The writer guarantees also run in the Linux image (.tmp-e2e/wp21e/Dockerfile.test).
 */
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkWriter, WriteRefused, BUILD_ROOTS } from '../../cleanup-link/src/writer';
import { LinkWorker } from '../../cleanup-link/src/worker';
import { mayLink } from '../../cleanup-link/src/inspect';
import {
  absMetadata,
  absSeries,
  bookValues,
  metadataBytes,
} from '../src/cleanup/audio/build-metadata';
import {
  cleanSegment,
  cutToBytes,
  fitFileName,
  fitName,
  formatPosition,
  nameKey,
} from '../src/cleanup/audio/build-names';
import { layoutFolder, layoutOf, planBuild } from '../src/cleanup/audio/build-plan';
import { loadPlanInputs, stageIds } from '../src/cleanup/audio/build-inputs';
import { compareManifests } from '../src/cleanup/audio/build-check';
import { getAudioStage, setAudioStageMode } from '../src/cleanup/audio/audio-stages';
import { createApplyToken } from '../src/cleanup/apply-tokens';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { DISK_OWNERS } from '../src/cleanup/disk-lock';
import { updateSettings } from '../src/cleanup/settings';
import { makeCleanupEnv, type CleanupEnv } from './helpers/cleanup-env';
import { makeTempDir } from './helpers/spawn-server';
import { IDS, seedBuild, type BuildSeed } from './helpers/build-seed';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const LINK_SRC = path.join(__dirname, '..', '..', 'cleanup-link', 'src');

/** Every entry under a folder: name, size, mtime, inode, links and content hash. */
function treeProof(dir: string): Map<string, { line: string; nlink: number }> {
  const out = new Map<string, { line: string; nlink: number }>();
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p, { bigint: true });
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (st.isDirectory()) {
        out.set(rel, { line: `D ${st.mtimeMs}`, nlink: 0 });
        walk(p);
      } else {
        out.set(rel, {
          line: `F ${st.size} ${st.mtimeMs} ${st.dev}:${st.ino} ${sha(fs.readFileSync(p))}`,
          nlink: Number(st.nlink),
        });
      }
    }
  };
  walk(dir);
  return out;
}

const audio = (n: number, size = 4000) => Buffer.alloc(size, n);

/** A library with the cases the plan must handle. */
function scenario(): BuildSeed {
  const v = (title: string, more: Record<string, unknown> = {}) => ({
    title,
    authors: ['作者A'],
    narrators: ['読み手'],
    series: [],
    drama: false,
    multi_narr: false,
    publisher: '出版社',
    year: 2021,
    language: 'ja',
    store_id: null,
    description: 'あらすじ。\n二行目。',
    ...more,
  });
  const X1 = 'TMW/[作者A] シリーズX/[01] シリーズX 1 [B0AAAAAAA1].m4b';
  const X2 = 'TMW/[作者A] シリーズX/[02] シリーズX 2 [B0AAAAAAA2].m4b';
  return {
    files: [
      { root: 'torrents', rel: X1, bytes: audio(1) },
      {
        root: 'torrents',
        rel: 'TMW/[作者A] シリーズX/[01] シリーズX 1 [B0AAAAAAA1].pdf',
        bytes: 'pdf1',
      },
      { root: 'torrents', rel: 'Discord/シリーズX 1/シリーズX 1.m4b', bytes: audio(1) },
      { root: 'torrents', rel: X2, bytes: audio(2) },
      { root: 'torrents', rel: 'Discord/シリーズX 2/シリーズX 2.m4b', bytes: audio(22, 4100) },
      { root: 'torrents', rel: 'Discord/雨の本/Disc 1/01.mp3', bytes: audio(3) },
      { root: 'torrents', rel: 'Discord/雨の本/Disc 1/02.mp3', bytes: audio(4) },
      { root: 'torrents', rel: 'Discord/雨の本/Disc 2/01.mp3', bytes: audio(5) },
      { root: 'torrents', rel: 'Discord/雨の本/booklet.pdf', bytes: 'pdf2' },
      { root: 'torrents', rel: 'MAM/同じ題/同じ題.m4b', bytes: audio(6) },
      { root: 'torrents', rel: 'MAM/同じ題 別版/同じ題.m4b', bytes: audio(7) },
      { root: 'torrents', rel: 'AI/AIシリーズ/AIシリーズ1.m4b', bytes: audio(8) },
      { root: 'torrents', rel: 'MAM/記号/記号.m4b', bytes: audio(9) },
      { root: 'torrents', rel: 'Discord/作者なし/作者なし.m4b', bytes: audio(10) },
      { root: 'torrents', rel: 'MAM/単巻/シリーズX.m4b', bytes: audio(11) },
      { root: 'torrents', rel: 'MAM/選択/選択 a.m4b', bytes: audio(12) },
      { root: 'torrents', rel: 'MAM/選択/選択 b.m4b', bytes: audio(13) },
      { root: 'torrents', rel: 'MAM/old.zip', bytes: 'zip' },
      { root: 'torrents', rel: 'MAM/lone.pdf', bytes: 'pdf3' },
      // The live library: copies of the torrent files, ABS's files, one library-only file and
      // one file the reader wrote.
      { root: 'library', rel: '_Unknown/シリーズX/Vol 1 - シリーズX 1/a.m4b', bytes: audio(1) },
      { root: 'library', rel: '_Unknown/シリーズX/Vol 1 - シリーズX 1/metadata.json', bytes: '{}' },
      { root: 'library', rel: '_Unknown/シリーズX 1 (Discord)/b.m4b', bytes: audio(1) },
      { root: 'library', rel: '_Unknown/シリーズX 2/c.m4b', bytes: audio(2) },
      { root: 'library', rel: '_Unknown/AIシリーズ1/ai.m4b', bytes: audio(8) },
      { root: 'library', rel: '_Unknown/選択 a/a.m4b', bytes: audio(12) },
      { root: 'library', rel: '_Unknown/ティアムーン10/ティアムーン10.m4b', bytes: audio(14) },
      { root: 'library', rel: '_Unknown/雨の本/merged.m4b', bytes: audio(15) },
    ],
    books: [
      { rel: X1, kind: 'file', files: [X1] },
      {
        rel: 'Discord/シリーズX 1',
        kind: 'folder',
        files: ['Discord/シリーズX 1/シリーズX 1.m4b'],
      },
      { rel: X2, kind: 'file', files: [X2] },
      {
        rel: 'Discord/シリーズX 2',
        kind: 'folder',
        files: ['Discord/シリーズX 2/シリーズX 2.m4b'],
      },
      {
        rel: 'Discord/雨の本',
        kind: 'folder',
        files: [
          'Discord/雨の本/Disc 1/01.mp3',
          'Discord/雨の本/Disc 1/02.mp3',
          'Discord/雨の本/Disc 2/01.mp3',
        ],
      },
      { rel: 'MAM/同じ題', kind: 'folder', files: ['MAM/同じ題/同じ題.m4b'] },
      { rel: 'MAM/同じ題 別版', kind: 'folder', files: ['MAM/同じ題 別版/同じ題.m4b'] },
      {
        rel: 'AI/AIシリーズ/AIシリーズ1.m4b',
        kind: 'file',
        files: ['AI/AIシリーズ/AIシリーズ1.m4b'],
      },
      { rel: 'MAM/記号', kind: 'folder', files: ['MAM/記号/記号.m4b'] },
      { rel: 'Discord/作者なし', kind: 'folder', files: ['Discord/作者なし/作者なし.m4b'] },
      { rel: 'MAM/単巻', kind: 'folder', files: ['MAM/単巻/シリーズX.m4b'] },
      { rel: 'MAM/選択/選択 a.m4b', kind: 'file', files: ['MAM/選択/選択 a.m4b'] },
      { rel: 'MAM/選択/選択 b.m4b', kind: 'file', files: ['MAM/選択/選択 b.m4b'] },
    ],
    copies: [
      {
        key: 'c-x1',
        bookKey: `torrents:${X1}`,
        kind: 'file',
        files: [`torrents:${X1}`],
        group: { key: 'g1', kind: 'group', outcome: 'auto', role: 'keep', rank: 0 },
      },
      {
        key: 'c-x1d',
        bookKey: 'torrents:Discord/シリーズX 1',
        kind: 'file',
        files: ['torrents:Discord/シリーズX 1/シリーズX 1.m4b'],
        group: { key: 'g1', kind: 'group', outcome: 'auto', role: 'drop', rank: 1 },
      },
      {
        key: 'c-x2',
        bookKey: `torrents:${X2}`,
        kind: 'file',
        files: [`torrents:${X2}`],
        group: { key: 'g2', kind: 'group', outcome: 'review', role: 'review', rank: 0 },
      },
      {
        key: 'c-x2d',
        bookKey: 'torrents:Discord/シリーズX 2',
        kind: 'file',
        files: ['torrents:Discord/シリーズX 2/シリーズX 2.m4b'],
        group: { key: 'g2', kind: 'group', outcome: 'review', role: 'review', rank: 1 },
      },
      {
        key: 'c-rain',
        bookKey: 'torrents:Discord/雨の本',
        kind: 'parts',
        files: [
          'torrents:Discord/雨の本/Disc 1/01.mp3',
          'torrents:Discord/雨の本/Disc 1/02.mp3',
          'torrents:Discord/雨の本/Disc 2/01.mp3',
        ],
      },
      {
        key: 'c-same1',
        bookKey: 'torrents:MAM/同じ題',
        kind: 'file',
        files: ['torrents:MAM/同じ題/同じ題.m4b'],
      },
      {
        key: 'c-same2',
        bookKey: 'torrents:MAM/同じ題 別版',
        kind: 'file',
        files: ['torrents:MAM/同じ題 別版/同じ題.m4b'],
      },
      {
        key: 'c-ai',
        bookKey: 'torrents:AI/AIシリーズ/AIシリーズ1.m4b',
        kind: 'file',
        files: ['torrents:AI/AIシリーズ/AIシリーズ1.m4b'],
        ai: true,
      },
      {
        key: 'c-sym',
        bookKey: 'torrents:MAM/記号',
        kind: 'file',
        files: ['torrents:MAM/記号/記号.m4b'],
      },
      {
        key: 'c-noauth',
        bookKey: 'torrents:Discord/作者なし',
        kind: 'file',
        files: ['torrents:Discord/作者なし/作者なし.m4b'],
      },
      {
        key: 'c-single',
        bookKey: 'torrents:MAM/単巻',
        kind: 'file',
        files: ['torrents:MAM/単巻/シリーズX.m4b'],
      },
      {
        key: 'c-cha',
        bookKey: 'torrents:MAM/選択/選択 a.m4b',
        kind: 'file',
        files: ['torrents:MAM/選択/選択 a.m4b'],
        group: { key: 'g3', kind: 'group', outcome: 'review', role: 'review', rank: 0 },
      },
      {
        key: 'c-chb',
        bookKey: 'torrents:MAM/選択/選択 b.m4b',
        kind: 'file',
        files: ['torrents:MAM/選択/選択 b.m4b'],
        group: { key: 'g3', kind: 'group', outcome: 'review', role: 'review', rank: 1 },
      },
      {
        key: 'c-tia',
        bookKey: 'library:_Unknown/ティアムーン10',
        kind: 'library_only',
        files: ['library:_Unknown/ティアムーン10/ティアムーン10.m4b'],
      },
    ],
    units: [
      {
        key: 'u-x1',
        kind: 'record',
        name: 'シリーズX 1',
        copies: ['c-x1', 'c-x1d'],
        values: v('シリーズX 1', {
          series: [{ name: 'シリーズX', position: 1, label: '1' }],
          store_id: 'audible:B0AAAAAAA1',
        }),
      },
      {
        key: 'u-x2',
        kind: 'record',
        name: 'シリーズX 2',
        copies: ['c-x2'],
        values: v('シリーズX 2', { series: [{ name: 'シリーズX', position: 2, label: '2' }] }),
      },
      {
        key: 'u-x2d',
        kind: 'record',
        name: 'シリーズX 2',
        copies: ['c-x2d'],
        values: v('シリーズX 2', { series: [{ name: 'シリーズX', position: 2, label: '2' }] }),
      },
      {
        key: 'u-rain',
        kind: 'record',
        name: '雨の本',
        copies: ['c-rain'],
        values: v('雨の本', {
          authors: ['作者B'],
          narrators: ['甲', '乙'],
          multi_narr: true,
          store_id: 'kikubon:12',
        }),
      },
      {
        key: 'u-same1',
        kind: 'record',
        name: '同じ題',
        copies: ['c-same1'],
        values: v('同じ題', { authors: ['作者C'], narrators: ['甲'] }),
      },
      {
        key: 'u-same2',
        kind: 'record',
        name: '同じ題',
        copies: ['c-same2'],
        values: v('同じ題', { authors: ['作者C'], narrators: ['乙'] }),
      },
      {
        key: 'u-ai',
        kind: 'ai',
        name: 'AIシリーズ1',
        copies: ['c-ai'],
        values: v('AIシリーズ1', {
          authors: [],
          narrators: [],
          '?series': [{ name: 'AIシリーズ', position: 1, label: '1' }],
        }),
      },
      {
        key: 'u-sym',
        kind: 'record',
        name: '記号',
        copies: ['c-sym'],
        values: v('Re:ゼロ? "A"/B', {
          series: [
            { name: 'S:1', position: 5.5, label: '5.5' },
            { name: 'From GOAT', position: 3, label: '3' },
          ],
          drama: true,
        }),
      },
      {
        key: 'u-noauth',
        kind: 'no_record',
        name: '作者なし',
        copies: ['c-noauth'],
        values: v('作者なし', { authors: [] }),
      },
      {
        key: 'u-single',
        kind: 'record',
        name: 'シリーズX',
        copies: ['c-single'],
        values: v('シリーズX', { narrators: ['単巻の声'] }),
      },
      {
        key: 'u-cha',
        kind: 'record',
        name: '選択',
        copies: ['c-cha'],
        values: v('選択', { authors: ['作者D'] }),
      },
      {
        key: 'u-chb',
        kind: 'record',
        name: '選択',
        copies: ['c-chb'],
        values: v('選択', { authors: ['作者D'] }),
      },
      {
        key: 'u-tia',
        kind: 'record',
        name: 'ティアムーン10',
        copies: ['c-tia'],
        values: v('ティアムーン帝国物語10', {
          authors: ['餅月望'],
          series: [{ name: 'ティアムーン帝国物語', position: 10, label: '10' }],
        }),
      },
    ],
    libraryCopies: {
      '_Unknown/シリーズX/Vol 1 - シリーズX 1/a.m4b': [X1, 'Discord/シリーズX 1/シリーズX 1.m4b'],
      '_Unknown/シリーズX 1 (Discord)/b.m4b': ['Discord/シリーズX 1/シリーズX 1.m4b'],
      '_Unknown/シリーズX 2/c.m4b': [X2],
      '_Unknown/AIシリーズ1/ai.m4b': ['AI/AIシリーズ/AIシリーズ1.m4b'],
      '_Unknown/選択 a/a.m4b': ['MAM/選択/選択 a.m4b'],
    },
    libraryOnly: ['_Unknown/ティアムーン10/ティアムーン10.m4b', '_Unknown/雨の本/merged.m4b'],
    decisions: { g3: 'keep:c-chb' },
  };
}

// ---------------------------------------------------------------------------------------------
describe('names', () => {
  it('full-width forms, the old colon look-alike, controls, dots at the ends', () => {
    expect(cleanSegment('Re:ゼロ? "A"/B\\C*D<E>F|G').name).toBe(
      'Re：ゼロ？ ＂A＂／B＼C＊D＜E＞F｜G',
    );
    expect(cleanSegment('a' + String.fromCharCode(0xa789) + 'b').name).toBe('a：b');
    expect(cleanSegment('a' + String.fromCharCode(9) + 'b' + String.fromCharCode(0)).name).toBe(
      'a b',
    );
    expect(cleanSegment('.hidden').name).toBe('．hidden');
    expect(cleanSegment('Mr.').name).toBe('Mr．');
    expect(cleanSegment('   ').name).toBe('_');
    expect(cleanSegment('ok').replaced).toBe(0);
  });

  it('cuts at 255 bytes on a character boundary, keeping a suffix and the extension', () => {
    const long = 'あ'.repeat(120); // 360 bytes
    const f = fitName(long, ' {甲}');
    expect(Buffer.byteLength(f.name)).toBeLessThanOrEqual(255);
    expect(f.name.endsWith(' {甲}')).toBe(true);
    expect(f.cut).toBe(true);
    // A character with a combining mark stays whole.
    const combined = ('か' + String.fromCharCode(0x3099)).repeat(60);
    const c = cutToBytes(combined, 100);
    expect(c.length % 2).toBe(0);
    const file = fitFileName('い'.repeat(100) + '.m4b');
    expect(file.name.endsWith('.m4b')).toBe(true);
    expect(Buffer.byteLength(file.name)).toBeLessThanOrEqual(255);
    expect(nameKey('ABC')).toBe(nameKey('abc'));
    expect(formatPosition(5)).toBe('5');
    expect(formatPosition(5.5)).toBe('5.5');
  });

  it('the layout: series with a position, a series without one, standalone, _Unknown', () => {
    const s = (name: string, position: number | null) => [{ name, position, label: null }];
    expect(
      layoutFolder('main', layoutOf({ title: 'T', authors: ['A', 'B'], series: s('S', 3) })),
    ).toBe('japanese-new/A/S/Vol 3 - T');
    expect(
      layoutFolder('main', layoutOf({ title: 'T', authors: ['A'], series: s('S', null) })),
    ).toBe('japanese-new/A/S/T');
    expect(layoutFolder('ai', layoutOf({ title: 'T', authors: [], series: [] }))).toBe(
      'japanese-generated-new/_Unknown/T',
    );
    // The folder takes the first series with a position (a drama CD's numbered sub-series).
    const drama = [
      { name: 'X ドラマCD', position: 2, label: '2' },
      { name: 'X', position: null, label: 'drama' },
    ];
    expect(layoutFolder('main', layoutOf({ title: 'T', authors: ['A'], series: drama }))).toBe(
      'japanese-new/A/X ドラマCD/Vol 2 - T',
    );
  });
});

describe('metadata.json', () => {
  it('ABS 2.37.1 form: series strings with decimals, several series, tags, Audible ids only', () => {
    const v = bookValues(
      {
        title: 'T',
        authors: ['A'],
        narrators: ['N1', 'N2'],
        series: [
          { name: 'S', position: 5.5, label: '5.5' },
          { name: 'From GOAT', position: 3, label: '3' },
          { name: 'X', position: null, label: 'drama' },
        ],
        drama: true,
        multi_narr: true,
        publisher: 'P',
        year: 2021,
        language: 'ja',
        store_id: 'audible:B0AAAAAAA1',
        description: 'D',
      },
      'fallback',
    );
    const m = absMetadata(v);
    expect(Object.keys(m)).toEqual([
      'tags',
      'title',
      'subtitle',
      'authors',
      'narrators',
      'series',
      'genres',
      'publishedYear',
      'publishedDate',
      'publisher',
      'description',
      'isbn',
      'asin',
      'language',
      'explicit',
      'abridged',
    ]);
    expect(m.series).toEqual(['S #5.5', 'From GOAT #3', 'X']);
    expect(m.tags).toEqual(['ドラマCD', '複数ナレーター']);
    expect(m.asin).toBe('B0AAAAAAA1');
    expect(m.publishedYear).toBe('2021');
    expect(m.subtitle).toBeNull();
    expect(absMetadata({ ...v, storeId: 'kikubon:12' }).asin).toBeNull();
    expect(absMetadata({ ...v, series: null }).series).toEqual([]);
    expect(absSeries({ name: 'N', position: 1, label: null })).toBe('N #1');
    const bytes = metadataBytes(v);
    expect(bytes.toString('utf8').endsWith('}\n')).toBe(true);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(m);
    // No stored values: the unit's name, nothing invented.
    expect(bookValues({}, 'name').title).toBe('name');
    expect(bookValues({}, 'name').authors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('the plan from stages 1-5', () => {
  async function planned() {
    const dir = makeTempDir('wp21e-plan');
    const s = initCleanupDatabase(dir);
    if (!s.ok) throw new Error(s.error);
    const disk = seedBuild(s.db, dir, scenario());
    const { ids } = stageIds(s.db);
    expect(ids).not.toBeNull();
    const inputs = await loadPlanInputs(s.db, ids!, {
      readerWritten: ['_Unknown/雨の本/merged.m4b'],
      libraryFolder: 'japanese',
    });
    return { plan: planBuild(inputs), disk, db: s.db };
  }

  it('links the kept copy of a proven group, every copy of an unproven one, and a chosen copy', async () => {
    const { plan } = await planned();
    const folders = plan.books.map((b) => b.folder).sort();
    expect(folders).toEqual(
      [
        'japanese-generated-new/_Unknown/AIシリーズ/Vol 1 - AIシリーズ1',
        'japanese-new/_Unknown/作者なし',
        'japanese-new/作者A/S：1/Vol 5.5 - Re：ゼロ？ ＂A＂／B',
        'japanese-new/作者A/シリーズX {単巻の声}',
        'japanese-new/作者A/シリーズX/Vol 1 - シリーズX 1',
        'japanese-new/作者A/シリーズX/Vol 2 - シリーズX 2',
        'japanese-new/作者A/シリーズX/Vol 2 - シリーズX 2 (2)',
        'japanese-new/作者B/雨の本',
        'japanese-new/作者C/同じ題 {乙}',
        'japanese-new/作者C/同じ題 {甲}',
        'japanese-new/作者D/選択',
        'japanese-new/餅月望/ティアムーン帝国物語/Vol 10 - ティアムーン帝国物語10',
      ].sort(),
    );
    const byFolder = new Map(plan.books.map((b) => [b.folder, b]));
    // The best guess (TMW, rank 0) keeps the plain name; the other copy gets (2).
    expect(byFolder.get('japanese-new/作者A/シリーズX/Vol 2 - シリーズX 2')!.copyKey).toBe('c-x2');
    expect(byFolder.get('japanese-new/作者A/シリーズX/Vol 2 - シリーズX 2 (2)')!.copyKey).toBe(
      'c-x2d',
    );
    // The review page's choice: only copy b.
    expect(byFolder.get('japanese-new/作者D/選択')!.copyKey).toBe('c-chb');
    // The library-only file is planned, not linked.
    const tia = byFolder.get(
      'japanese-new/餅月望/ティアムーン帝国物語/Vol 10 - ティアムーン帝国物語10',
    )!;
    expect(tia.state).toBe('pending');
    expect(plan.ops.some((o) => o.dst.startsWith(tia.folder))).toBe(false);
    expect(plan.counts.books).toEqual({ main: 10, ai: 1, pending: 1 });
    expect(plan.counts.collisions).toEqual({ narrator: 3, number: 1 });
    expect(plan.counts.unknownAuthor).toBe(2);
  });

  it('keeps file order and Disc folders, links PDFs next to the audio, counts the rest', async () => {
    const { plan } = await planned();
    const rain = plan.books.find((b) => b.folder === 'japanese-new/作者B/雨の本')!;
    expect(rain.files.map((f) => f.dst.slice(rain.folder.length + 1))).toEqual([
      'Disc 1/01.mp3',
      'Disc 1/02.mp3',
      'Disc 2/01.mp3',
    ]);
    expect(rain.pdfs.map((f) => f.dst.slice(rain.folder.length + 1))).toEqual(['booklet.pdf']);
    const x1 = plan.books.find((b) => b.copyKey === 'c-x1')!;
    expect(x1.files.map((f) => path.basename(f.dst))).toEqual([
      '[01] シリーズX 1 [B0AAAAAAA1].m4b',
    ]);
    expect(x1.pdfs.map((f) => path.basename(f.dst))).toEqual(['[01] シリーズX 1 [B0AAAAAAA1].pdf']);
    expect(plan.counts.pdfs).toEqual({ placed: 2, unplaced: 1, otherCopy: 0, noBook: 1, total: 3 });
    // Folders come before what goes in them.
    const seen = new Set<string>();
    for (const o of plan.ops) {
      const parent = o.dst.slice(0, o.dst.lastIndexOf('/'));
      if (parent.includes('/')) expect(seen.has(parent), o.dst).toBe(true);
      if (o.kind === 'folder') seen.add(o.dst);
    }
    const meta = JSON.parse(
      plan.books.find((b) => b.folder.includes('Re：ゼロ'))!.metadata.toString('utf8'),
    ) as Record<string, unknown>;
    expect(meta.title).toBe('Re:ゼロ? "A"/B');
    expect(meta.series).toEqual(['S:1 #5.5', 'From GOAT #3']);
    expect(meta.tags).toEqual(['ドラマCD']);
  });

  it('writes a move list entry for every audio file of the live library', async () => {
    const { plan } = await planned();
    const m = new Map(plan.moves.map((x) => [x.oldPath, x]));
    expect(plan.moves).toHaveLength(7);
    expect(m.get('japanese/_Unknown/シリーズX/Vol 1 - シリーズX 1/a.m4b')).toMatchObject({
      outcome: 'moved',
      newPath: 'japanese-new/作者A/シリーズX/Vol 1 - シリーズX 1/[01] シリーズX 1 [B0AAAAAAA1].m4b',
    });
    // A copy of the dropped Discord file: dropped, pointing at the kept copy's file.
    expect(m.get('japanese/_Unknown/シリーズX 1 (Discord)/b.m4b')).toMatchObject({
      outcome: 'dropped',
      keptPath:
        'japanese-new/作者A/シリーズX/Vol 1 - シリーズX 1/[01] シリーズX 1 [B0AAAAAAA1].m4b',
      detail: 'proven duplicate',
    });
    expect(m.get('japanese/_Unknown/選択 a/a.m4b')).toMatchObject({
      outcome: 'dropped',
      keptPath: 'japanese-new/作者D/選択/選択 b.m4b',
      detail: 'your choice on the review page',
    });
    expect(m.get('japanese/_Unknown/AIシリーズ1/ai.m4b')!.outcome).toBe('ai');
    expect(m.get('japanese/_Unknown/ティアムーン10/ティアムーン10.m4b')).toMatchObject({
      outcome: 'library_only_pending',
      newPath:
        'japanese-new/餅月望/ティアムーン帝国物語/Vol 10 - ティアムーン帝国物語10/ティアムーン10.m4b',
    });
    expect(m.get('japanese/_Unknown/雨の本/merged.m4b')!.outcome).toBe('reader_written');
    expect(plan.counts.moves.unaccounted).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('the writer (the only code that writes audiobook files)', () => {
  function disk() {
    const dir = makeTempDir('wp21e-writer');
    const data = path.join(dir, 'data');
    const t = path.join(data, 'torrents', 'audiobooks', 'japanese');
    const m = path.join(data, 'media', 'audiobooks');
    fs.mkdirSync(path.join(t, 'A'), { recursive: true });
    fs.mkdirSync(path.join(m, 'japanese', 'old'), { recursive: true });
    fs.mkdirSync(path.join(data, 'media', 'books'), { recursive: true });
    fs.writeFileSync(path.join(t, 'A', 'a.m4b'), audio(1));
    fs.writeFileSync(path.join(m, 'japanese', 'old', 'x.m4b'), audio(1));
    const st = fs.lstatSync(path.join(t, 'A', 'a.m4b'), { bigint: true });
    const src = {
      rel: 'A/a.m4b',
      raw: null,
      size: Number(st.size),
      mtimeMs: Math.floor(Number(st.mtimeMs)),
      dev: Number(st.dev),
      ino: Number(st.ino),
    };
    return { dir, data, t, m, src, w: new LinkWriter({ dataDir: data }) };
  }

  it('creates folders, links and metadata.json only inside the two new folders', async () => {
    const { w, m, src, t } = disk();
    expect(BUILD_ROOTS).toEqual(['japanese-new', 'japanese-generated-new']);
    expect(await w.makeFolder('japanese-new')).toEqual({ existed: false });
    expect(await w.makeFolder('japanese-new')).toEqual({ existed: true });
    await w.makeFolder('japanese-new/B');
    const r = await w.linkFile(src, 'japanese-new/B/a.m4b');
    expect(r.existed).toBe(false);
    const a = fs.lstatSync(path.join(t, 'A', 'a.m4b'), { bigint: true });
    const b = fs.lstatSync(path.join(m, 'japanese-new', 'B', 'a.m4b'), { bigint: true });
    expect(b.ino).toBe(a.ino);
    expect(Number(a.nlink)).toBe(2);
    // The same link again counts as done.
    expect((await w.linkFile(src, 'japanese-new/B/a.m4b')).existed).toBe(true);
    const bytes = Buffer.from('{"title":"T"}\n');
    expect(await w.writeMetadata('japanese-new/B/metadata.json', bytes, 7)).toEqual({
      existed: false,
    });
    expect(fs.readFileSync(path.join(m, 'japanese-new', 'B', 'metadata.json'))).toEqual(bytes);
    expect(await w.writeMetadata('japanese-new/B/metadata.json', bytes, 7)).toEqual({
      existed: true,
    });
    expect(fs.readdirSync(path.join(m, 'japanese-new', 'B')).sort()).toEqual([
      'a.m4b',
      'metadata.json',
    ]);
  });

  it('refuses everything else', async () => {
    const { w, src, m, data } = disk();
    await w.makeFolder('japanese-new');
    const refused = async (p: Promise<unknown>, re: RegExp) => {
      await expect(p).rejects.toBeInstanceOf(WriteRefused);
      await expect(p).rejects.toThrow(re);
    };
    for (const dst of [
      'japanese/new',
      'japanese/old/y.m4b',
      'japanese-generated/x',
      'books/x',
      '../books/x',
      'japanese-new/../japanese/x',
      'japanese-new/./x',
      'japanese-new//x',
      '/japanese-new/x',
    ]) {
      await refused(w.makeFolder(dst), /Not inside|Not an allowed name/);
      await refused(w.linkFile(src, dst + '/a.m4b'), /Not inside|Not an allowed name/);
    }
    await refused(w.makeFolder('japanese-new/a' + String.fromCharCode(1)), /Not an allowed name/);
    await refused(w.makeFolder('japanese-new/' + 'あ'.repeat(86)), /Not an allowed name/);
    await refused(w.makeFolder('japanese-new/.hidden'), /Not an allowed name/);
    await refused(w.makeFolder('japanese-new/x/y'), /missing/);
    // Sources: only the torrents, only the planned file, unchanged.
    await refused(
      w.linkFile(
        { ...src, rel: '../../media/audiobooks/japanese/old/x.m4b' },
        'japanese-new/x.m4b',
      ),
      /Not an allowed source/,
    );
    await refused(
      w.linkFile({ ...src, size: src.size + 1 }, 'japanese-new/x.m4b'),
      /changed \(size\)/,
    );
    await refused(
      w.linkFile({ ...src, ino: src.ino + 1 }, 'japanese-new/x.m4b'),
      /changed \(inode\)/,
    );
    await refused(w.linkFile({ ...src, rel: 'A/none.m4b' }, 'japanese-new/x.m4b'), /missing/);
    // Nothing is ever replaced.
    fs.writeFileSync(path.join(m, 'japanese-new', 'taken.m4b'), 'other');
    await refused(w.linkFile(src, 'japanese-new/taken.m4b'), /A different file is already there/);
    expect(fs.readFileSync(path.join(m, 'japanese-new', 'taken.m4b'), 'utf8')).toBe('other');
    fs.writeFileSync(path.join(m, 'japanese-new', 'metadata.json'), 'other');
    await refused(
      w.writeMetadata('japanese-new/metadata.json', Buffer.from('{}'), 1),
      /different file/,
    );
    expect(fs.readFileSync(path.join(m, 'japanese-new', 'metadata.json'), 'utf8')).toBe('other');
    await refused(
      w.writeMetadata('japanese-new/cover.jpg', Buffer.from('x'), 1),
      /Only metadata.json/,
    );
    // A symlinked folder can't lead out (where the system allows symlinks).
    let symlinks = true;
    try {
      fs.symlinkSync(
        path.join(data, 'media', 'books'),
        path.join(m, 'japanese-new', 'link'),
        'dir',
      );
    } catch {
      symlinks = false;
    }
    if (symlinks) {
      await refused(w.makeFolder('japanese-new/link/x'), /Not a real folder/);
      await refused(w.linkFile(src, 'japanese-new/link/a.m4b'), /Not a real folder/);
      expect(fs.readdirSync(path.join(data, 'media', 'books'))).toEqual([]);
    }
  });

  it('removes only its own interrupted temporary file', async () => {
    const { w, m } = disk();
    await w.makeFolder('japanese-new');
    const temp = path.join(m, 'japanese-new', '.ttsu-link-9.partial');
    fs.writeFileSync(temp, 'half');
    await w.writeMetadata('japanese-new/metadata.json', Buffer.from('{}\n'), 9);
    expect(fs.existsSync(temp)).toBe(false);
    expect(fs.readFileSync(path.join(m, 'japanese-new', 'metadata.json'), 'utf8')).toBe('{}\n');
  });

  it('knows what fs.protected_hardlinks allows', () => {
    const info = { uid: 99, gid: 100, groups: [100], protectedHardlinks: 1 };
    expect(mayLink(info, { uid: 99, gid: 100, mode: 0o100600 })).toBe(true);
    expect(mayLink(info, { uid: 0, gid: 0, mode: 0o100644 })).toBe(false);
    expect(mayLink(info, { uid: 0, gid: 0, mode: 0o100666 })).toBe(true);
    expect(mayLink(info, { uid: 0, gid: 100, mode: 0o100660 })).toBe(true);
    expect(mayLink(info, { uid: 0, gid: 100, mode: 0o104666 })).toBe(false);
    expect(mayLink({ ...info, uid: 0 }, { uid: 5, gid: 5, mode: 0o100600 })).toBe(true);
    expect(mayLink({ ...info, protectedHardlinks: 0 }, { uid: 5, gid: 5, mode: 0o100600 })).toBe(
      true,
    );
  });

  it('only writer.ts writes, and it has exactly the three operations', () => {
    const WRITES =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rename|renameSync|unlink|unlinkSync|rmdir|rmSync|rm\(|link\(|linkSync|symlink|copyFile|cp\(|cpSync|utimes|chmod|chown|truncate|createWriteStream|futimes|lchown|O_CREAT|O_WRONLY|O_RDWR)\b/;
    for (const f of fs.readdirSync(LINK_SRC).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(LINK_SRC, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      if (f === 'writer.ts') continue;
      expect(src.replace(/\/\/.*$/gm, ''), f).not.toMatch(WRITES);
      expect(src, f).not.toMatch(/fs\.open\(/);
    }
    const writer = fs
      .readFileSync(path.join(LINK_SRC, 'writer.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // Its only removal is its own temporary name; no rename, no symlink, no copy.
    expect(writer.match(/fs\.unlink\(/g)).toHaveLength(2);
    expect(writer).toMatch(/\.ttsu-link-\$\{tag\}\.partial/);
    expect(writer).not.toMatch(
      /\b(rename|symlink|copyFile|rm\(|rmSync|rmdir|truncate|utimes|chown)\b/,
    );
    const methods = Object.getOwnPropertyNames(LinkWriter.prototype).sort();
    expect(methods).toEqual([
      'constructor',
      'linkFile',
      'makeFolder',
      'realFolders',
      'source',
      'writeMetadata',
    ]);
    // chmod only on what it made: a folder it created and its own temporary file.
    expect(writer.match(/chmod\(/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
describe('the build through the linking sidecar', { timeout: 120_000 }, () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function setup(opts: { batch?: number } = {}) {
    const dir = makeTempDir('wp21e-build');
    // The roots exist before the env is made (the service is built with them).
    const data = path.join(dir, 'data');
    const roots = {
      torrents: path.join(data, 'torrents', 'audiobooks', 'japanese'),
      library: path.join(data, 'media', 'audiobooks', 'japanese'),
      media: path.join(data, 'media', 'audiobooks'),
    };
    let readerState = 'reader-1';
    const { env } = await makeCleanupEnv({
      audio: {
        roots,
        readerWrittenFiles: () => ['_Unknown/雨の本/merged.m4b'],
        readerState: () => readerState,
        readLabels: () => ({ text: JSON.stringify({ books: [] }), error: null }),
      },
    });
    const disk = seedBuild(env.cleanupDb, dir, scenario());
    updateSettings(env.cleanupDb, {
      audiobooks: { buildBatchOps: opts.batch ?? 5, buildPreflightOps: 10, buildRehashSample: 3 },
    });
    const server = http.createServer(env.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const token = createApplyToken(env.cleanupDb, 'link sidecar', Date.now(), 'link').token;
    const worker = () =>
      new LinkWorker(
        {
          serverUrl: `http://127.0.0.1:${port}`,
          token,
          dataDir: data,
          dirMode: 0o777,
          fileMode: 0o666,
          serverTimeoutSeconds: 10,
        },
        () => undefined,
      );
    close = async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await env.close();
    };
    const user = { Authorization: `Bearer ${env.userToken()}` };
    return { env, disk, roots, worker, user, token, setReader: (s: string) => (readerState = s) };
  }

  /** Runs stage 6's steps and the sidecar's rounds until `until` holds. */
  async function drive(
    env: CleanupEnv,
    w: LinkWorker,
    mode: 'analyse' | 'on',
    until: () => boolean,
    max = 400,
  ) {
    const s6 = env.audio!.stage6!;
    for (let i = 0; i < max && !until(); i++) {
      await s6.step(() => false, mode, { readerState: () => 'reader-1' });
      await w.cycle().catch(() => undefined);
    }
    expect(until()).toBe(true);
  }

  it('Preview plans and checks the sources; On builds and the check passes; nothing else changes', async () => {
    const { env, disk, worker, user } = await setup();
    const s6 = env.audio!.stage6!;
    const before = { t: treeProof(disk.torrents), l: treeProof(disk.library) };
    // On before the plan: refused.
    const early = await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'on' })
      .expect(409);
    expect(early.body.error.message).toMatch(/Preview first/);
    // Stages 1-5 still refuse On.
    await request(env.app)
      .put('/api/v1/cleanup/audio/stages/3')
      .set(user)
      .send({ mode: 'on' })
      .expect(409);
    await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'analyse' })
      .expect(200);
    const w = worker();
    await drive(env, w, 'analyse', () => s6.progress()?.phase === 'planned');
    const p = s6.progress()!;
    expect(p.preflight).toMatchObject({ total: 15, done: 15, problems: 0 });
    // Preview wrote nothing.
    expect(fs.existsSync(path.join(disk.media, 'japanese-new'))).toBe(false);
    const status = await request(env.app).get('/api/v1/cleanup/audio/status').set(user).expect(200);
    expect(status.body.stage6.onRefusals).toEqual([]);
    expect(status.body.stage6.sidecar.online).toBe(true);
    // The sample, the move list, the plan as CSV.
    const sample = await request(env.app)
      .get('/api/v1/cleanup/audio/build?list=sample')
      .set(user)
      .expect(200);
    expect(sample.body.total).toBe(12);
    const csv = await request(env.app)
      .get('/api/v1/cleanup/audio/build/moves.csv')
      .set(user)
      .expect(200);
    expect(csv.text).toMatch(/^.?old_path,outcome,new_path,kept_path,detail/);
    expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(8);
    // On.
    await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'on' })
      .expect(200);
    await drive(env, w, 'on', () => s6.progress()?.phase === 'done', 800);
    const done = s6.progress()!;
    expect(done.build.done).toBe(done.build.total);
    expect(done.build.batches).toBeGreaterThan(3);
    expect(done.check!.items.filter((i) => i.ok === false)).toEqual([]);
    expect(done.check!.passed).toBe(true);
    // Every audio file and PDF in the new folders is a hard link to its torrent file.
    const newTree = treeProof(path.join(disk.media, 'japanese-new'));
    const gen = treeProof(path.join(disk.media, 'japanese-generated-new'));
    const torrentInodes = new Map(
      [...treeProof(disk.torrents).entries()].map(([rel, e]) => [e.line.split(' ')[3], rel]),
    );
    let links = 0;
    for (const [rel, e] of [...newTree.entries(), ...gen.entries()]) {
      if (e.line.startsWith('D') || rel.endsWith('metadata.json')) continue;
      expect(torrentInodes.has(e.line.split(' ')[3]), rel).toBe(true);
      expect(e.nlink).toBeGreaterThanOrEqual(2);
      links++;
    }
    expect(links).toBe(13 + 2);
    // The torrents and the live library: byte-identical, same inode and mtime; only the link
    // counts of the linked files grew, by exactly the links made.
    const after = { t: treeProof(disk.torrents), l: treeProof(disk.library) };
    expect([...after.l.entries()]).toEqual([...before.l.entries()]);
    expect([...after.t.keys()]).toEqual([...before.t.keys()]);
    const linked = new Map<string, number>();
    for (const o of env.cleanupDb
      .prepare(`SELECT src_rel FROM audio_build_ops WHERE kind IN ('link', 'pdf')`)
      .all() as { src_rel: string }[])
      linked.set(o.src_rel, (linked.get(o.src_rel) ?? 0) + 1);
    for (const [rel, e] of after.t) {
      const b = before.t.get(rel)!;
      expect(e.line, rel).toBe(b.line);
      expect(e.nlink, rel).toBe(b.nlink + (linked.get(rel) ?? 0));
    }
    // The metadata files are the planned bytes.
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(disk.media, 'japanese-new', '作者B', '雨の本', 'metadata.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({
      title: '雨の本',
      authors: ['作者B'],
      narrators: ['甲', '乙'],
      tags: ['複数ナレーター'],
    });
    // The page: the stage is done; Check again works.
    await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'analyse' })
      .expect(200);
    await request(env.app).post('/api/v1/cleanup/audio/build/check-again').set(user).expect(200);
    expect(s6.progress()!.phase).toBe('walk_after');
    // From Preview the walk and the check run again (they only read) and pass again.
    await drive(env, w, 'analyse', () => s6.progress()?.phase === 'done');
    expect(s6.progress()!.check!.passed).toBe(true);
    expect(s6.progress()!.build.done).toBe(done.build.done);
  });

  it('builds again safely after a sidecar restart mid-batch and an expired lease', async () => {
    const { env, worker, disk } = await setup({ batch: 3 });
    const s6 = env.audio!.stage6!;
    const w1 = worker();
    setAudioStageMode(env.cleanupDb, 6, 'analyse');
    await drive(env, w1, 'analyse', () => s6.progress()?.phase === 'planned');
    setAudioStageMode(env.cleanupDb, 6, 'on');
    // Into the build: take a batch, do half of it, "crash" without reporting.
    await drive(env, w1, 'on', () => s6.progress()?.phase === 'build' && s6.isHanding(), 50);
    const batch = s6.claim()!;
    expect(batch.kind).toBe('build');
    const half = { ...batch, ops: batch.ops.slice(0, 2) };
    await w1.process(half as never);
    // The lease runs out: the batch's operations are handed out again and finish as done.
    s6.expireLeases(Date.now() + 10 * 60_000);
    const w2 = worker();
    await drive(env, w2, 'on', () => s6.progress()?.phase === 'done', 800);
    expect(s6.progress()!.check!.passed).toBe(true);
    const existed = (
      env.cleanupDb
        .prepare(`SELECT result_json FROM audio_build_ops WHERE state = 'done'`)
        .all() as {
        result_json: string;
      }[]
    ).filter((r) => (JSON.parse(r.result_json) as { existed: boolean }).existed).length;
    expect(existed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(disk.media, 'japanese-new'))).toBe(true);
  });

  it('hands out no batch while a Calibre job waits for the disk', async () => {
    const { env, worker } = await setup({ batch: 2 });
    const s6 = env.audio!.stage6!;
    const w = worker();
    setAudioStageMode(env.cleanupDb, 6, 'analyse');
    await drive(env, w, 'analyse', () => s6.progress()?.phase === 'planned');
    setAudioStageMode(env.cleanupDb, 6, 'on');
    await drive(env, w, 'on', () => s6.progress()?.phase === 'build' && s6.isHanding(), 50);
    const lock = env.service.diskLock;
    const calibre = lock.acquire(DISK_OWNERS.calibre3, 'calibre');
    // The build gives the lock back on its next step; no batch meanwhile.
    await s6.step(() => false, 'on');
    expect(s6.claim()).toBeNull();
    await calibre;
    expect(lock.holds(DISK_OWNERS.calibre3)).toBe(true);
    const doneBefore = s6.progress()!.build.done;
    for (let i = 0; i < 5; i++) {
      await s6.step(() => false, 'on');
      expect(s6.claim()).toBeNull();
    }
    expect(s6.progress()!.build.done).toBe(doneBefore);
    lock.release(DISK_OWNERS.calibre3);
    await drive(env, w, 'on', () => s6.progress()?.phase === 'done', 800);
    expect(s6.progress()!.build.yields + s6.progress()!.build.lockWaits).toBeGreaterThan(0);
  });

  it('refuses On when a source changed, and pauses when a file changes during the build', async () => {
    const { env, worker, disk, user } = await setup({ batch: 2 });
    const s6 = env.audio!.stage6!;
    const w = worker();
    // A torrent file touched after stage 1: the preflight finds it, On is refused.
    const f = path.join(disk.torrents, 'MAM', '記号', '記号.m4b');
    const old = fs.statSync(f).mtime;
    fs.utimesSync(f, old, new Date(old.getTime() + 60_000));
    setAudioStageMode(env.cleanupDb, 6, 'analyse');
    await drive(env, w, 'analyse', () => s6.progress()?.phase === 'planned');
    expect(s6.progress()!.preflight.problems).toBe(1);
    const r = await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'on' })
      .expect(409);
    expect(r.body.error.message).toMatch(/can’t link/);
    const list = await request(env.app)
      .get('/api/v1/cleanup/audio/build?list=preflight')
      .set(user)
      .expect(200);
    expect(list.body.items[0].preflight).toMatch(/^changed \(mtime\)/);
    // Back as it was: plan again (Run the analysis again), then a change during the build.
    // utimes can't restore a sub-millisecond mtime exactly (it may land a microsecond early),
    // so the file's mtime is recorded again, as stage 1 would on its next walk.
    fs.utimesSync(f, old, old);
    env.cleanupDb
      .prepare('UPDATE audio_files SET mtime_ms = ? WHERE id = ?')
      .run(
        Math.floor(Number(fs.lstatSync(f, { bigint: true }).mtimeMs)),
        disk.fileId('torrents:MAM/記号/記号.m4b'),
      );
    env.audio!.reanalyse(6);
    await drive(env, w, 'analyse', () => s6.progress()?.phase === 'planned');
    expect(s6.progress()!.preflight.problems).toBe(0);
    setAudioStageMode(env.cleanupDb, 6, 'on');
    await drive(env, w, 'on', () => s6.progress()?.phase === 'build' && s6.isHanding(), 50);
    fs.utimesSync(f, old, new Date(old.getTime() + 120_000));
    for (let i = 0; i < 400 && !getAudioStage(env.cleanupDb, 6).pauseReason; i++) {
      await s6.step(() => false, 'on');
      await w.cycle().catch(() => undefined);
    }
    const st = getAudioStage(env.cleanupDb, 6);
    expect(st.pauseReason).toBe('build_failed');
    expect(st.pauseDetail).toMatch(/changed \(mtime\)/);
    const failed = await request(env.app)
      .get('/api/v1/cleanup/audio/build?list=failed')
      .set(user)
      .expect(200);
    expect(failed.body.total).toBe(1);
    // A rerun of stage 5 after the build started pauses instead of planning over the disk.
    fs.utimesSync(f, old, old);
    env.cleanupDb.prepare(`UPDATE audio_stages SET pause_reason = NULL WHERE stage = 6`).run();
    env.cleanupDb
      .prepare(
        `UPDATE audio_stages SET progress_json = json_set(progress_json, '$.rulesKey', 'r2') WHERE stage = 5`,
      )
      .run();
    await s6.step(() => false, 'on');
    expect(getAudioStage(env.cleanupDb, 6).pauseReason).toBe('inputs_changed');
  });

  it('refuses On when japanese-new is already there, and the sidecar routes need the link token', async () => {
    const { env, worker, disk, user, token } = await setup();
    const s6 = env.audio!.stage6!;
    setAudioStageMode(env.cleanupDb, 6, 'analyse');
    await drive(env, worker(), 'analyse', () => s6.progress()?.phase === 'planned');
    fs.mkdirSync(path.join(disk.media, 'japanese-new'));
    const r = await request(env.app)
      .put('/api/v1/cleanup/audio/stages/6')
      .set(user)
      .send({ mode: 'on' })
      .expect(409);
    expect(r.body.error.message).toMatch(/japanese-new already exist/);
    await request(env.app).post('/api/v1/cleanup-link/claim').expect(401);
    await request(env.app).post('/api/v1/cleanup-link/claim').set(user).expect(401);
    await request(env.app)
      .post('/api/v1/cleanup-link/claim')
      .set({ Authorization: `Bearer ${env.applyToken()}` })
      .expect(401);
    await request(env.app)
      .post('/api/v1/cleanup-link/claim')
      .set({ Authorization: `Bearer ${token}` })
      .expect(200);
    // A link token reaches nothing else.
    await request(env.app)
      .get('/api/v1/cleanup/audio/status')
      .set({ Authorization: `Bearer ${token}` })
      .expect(401);
    await request(env.app)
      .post('/api/v1/cleanup-apply/claim')
      .set({ Authorization: `Bearer ${token}` })
      .expect(401);
  });

  it('every polled query uses an index', async () => {
    const { env, worker } = await setup();
    const s6 = env.audio!.stage6!;
    setAudioStageMode(env.cleanupDb, 6, 'analyse');
    await drive(env, worker(), 'analyse', () => s6.progress()?.phase === 'planned');
    const a = s6.progress()!.analysisId;
    const plans: [string, unknown[]][] = [
      [
        `SELECT id FROM audio_build_batches WHERE analysis_id = ? AND state = 'claimed' AND lease_until < ?`,
        [a, 0],
      ],
      [
        `SELECT * FROM audio_build_ops INDEXED BY audio_build_ops_preflight WHERE analysis_id = ? AND preflight IS NULL AND kind IN ('link', 'pdf') ORDER BY id LIMIT 5`,
        [a],
      ],
      [
        `SELECT * FROM audio_build_ops WHERE analysis_id = ? AND state = 'planned' ORDER BY id LIMIT 5`,
        [a],
      ],
      [
        `SELECT state, COUNT(*) AS n FROM audio_build_ops WHERE analysis_id = ? GROUP BY state`,
        [a],
      ],
      [
        `SELECT preflight, COUNT(*) AS n FROM audio_build_ops WHERE analysis_id = ? AND kind IN ('link', 'pdf') GROUP BY preflight`,
        [a],
      ],
      [
        `SELECT * FROM audio_build_books WHERE analysis_id = ? AND sample = 1 ORDER BY id LIMIT 50 OFFSET 0`,
        [a],
      ],
      [
        `SELECT outcome, COUNT(*) AS n FROM audio_build_moves WHERE analysis_id = ? GROUP BY outcome`,
        [a],
      ],
    ];
    for (const [sql, args] of plans) {
      const detail = (
        env.cleanupDb.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args) as { detail: string }[]
      )
        .map((r) => r.detail)
        .join(' | ');
      expect(detail, sql).toMatch(/USING (COVERING )?INDEX|PRIMARY KEY/);
      expect(detail, sql).not.toMatch(/^SCAN audio_build/);
    }
  });
});

describe('the check compares before and after', () => {
  it('allows only the link counts the build made', () => {
    const e = (rel: string, nlink: number, size = 1) => ({
      rel,
      raw: null,
      isDir: false,
      size,
      mtimeMs: 1,
      dev: 1,
      ino: rel.length,
      nlink,
    });
    const before = [e('a', 1), e('b', 1), e('c', 1)];
    const ok = compareManifests(before, [e('a', 2), e('b', 1), e('c', 1)], new Map([['a', 1]]));
    expect(ok.counts).toEqual({ added: 0, removed: 0, changed: 0, nlinkWrong: 0 });
    expect(ok.linkedAsPlanned).toBe(1);
    const bad = compareManifests(before, [e('a', 1), e('b', 2, 9), e('d', 1)], new Map([['a', 1]]));
    expect(bad.counts).toEqual({ added: 1, removed: 1, changed: 1, nlinkWrong: 2 });
  });
});

// The stage ids the seed writes are the ones the plan reads.
it('the seed is a finished stage 1-5 chain', () => {
  const dir = makeTempDir('wp21e-seed');
  const s = initCleanupDatabase(dir);
  if (!s.ok) throw new Error(s.error);
  seedBuild(s.db, dir, scenario());
  expect(stageIds(s.db).ids).toMatchObject({ s1: IDS.s1, s5: IDS.s5 });
});
