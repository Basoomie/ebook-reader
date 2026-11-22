/**
 * WP15f: "Merge into one file". Real ffmpeg/ffprobe (skipped when not installed) join
 * tiny generated audiobooks; a fake ffmpeg (tests/fixtures/wp15f/fake-ffmpeg.cjs) stands
 * in to stall, fail and run long. After every merge, successful or not, the existing
 * files are proved byte-identical, nothing partial is left, and the work folder is empty.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAudioFolderByRelPath } from '../src/audio/audio-index';
import { AudioWriter } from '../src/audio/audio-write';
import {
  buildConcatList,
  buildFfmetadata,
  canStreamCopy,
  chapterMismatch,
  ffmpegArgs,
  mergedChapters,
  type MergeJob,
  MergeService,
  type MergeServiceOptions,
  parseProbe,
  shortenPaths,
} from '../src/audio/merge-service';
import { measureMerge } from '../scripts/merge-chapter-drift';
import { MergeWorkdir } from '../src/audio/merge-workdir';
import { looksLikeCopies } from '../src/audio/match';
import type { AudioScanService } from '../src/audio/scan-service';
import { type AudioMergeConfig, DEFAULT_AUDIO_MERGE } from '../src/config';
import { createToken } from '../src/db/tokens';
import { audioEnv, treeDiff, treeHashes, write } from './helpers/audio-fixtures';
import type { IndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';

function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');
if (!HAS_FFMPEG) console.warn('WP15f merge tests SKIPPED: ffmpeg/ffprobe not found on PATH');

const FAKE_FFMPEG = path.join(__dirname, 'fixtures', 'wp15f', 'fake-ffmpeg.cjs');

// ---------------------------------------------------------------- pure parts

describe('merge helpers', () => {
  it('hints at copies only for long files of almost the same length', () => {
    const opts = { minMinutes: 60, percent: 3 };
    expect(looksLikeCopies([35_000, 34_900], opts)).toBe(true);
    expect(looksLikeCopies([35_000, 30_000], opts)).toBe(false);
    expect(looksLikeCopies([1_800, 1_800], opts)).toBe(false); // too short: parts
    expect(looksLikeCopies([35_000], opts)).toBe(false);
    expect(looksLikeCopies([35_000, null], opts)).toBe(false);
    expect(looksLikeCopies([35_000, 34_900, 35_100], opts)).toBe(true);
  });

  it('writes the chapter file and the file list', () => {
    const meta = buildFfmetadata(
      mergedChapters([
        { name: '01 第一部.m4b', duration: 2.5, chapters: [] },
        { name: 'b=c;d.m4a', duration: 1, chapters: [] },
      ]).chapters,
      { album: 'アルバム', artist: '著者', title: 'part 1', encoder: 'x' },
      'フォルダ',
    );
    expect(meta).toBe(
      [
        ';FFMETADATA1',
        'title=アルバム',
        'artist=著者',
        'album=アルバム',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=0',
        'END=2500',
        'title=01 第一部',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=2500',
        'END=3500',
        'title=b\\=c\\;d',
        '',
      ].join('\n'),
    );
    expect(buildConcatList([`a${path.sep}it's.m4b`])).toBe(`file 'a/it'\\''s.m4b'\n`);
  });

  it('reads each file’s chapters from ffprobe', () => {
    const p = parseProbe(
      JSON.stringify({
        format: { duration: '10.0' },
        streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac', duration: '9.98' }],
        chapters: [
          // Exact from start × time_base, not the rounded start_time.
          {
            time_base: '1/44100',
            start: 0,
            end: 132301,
            start_time: '0.000000',
            tags: { title: '序' },
          },
          { time_base: '1/1000', start: 3000, end: 10000, tags: { TITLE: '一' } },
          { start_time: '5.5', end_time: '6.0' },
        ],
      }),
    );
    expect(p.streams[0].duration).toBe(9.98);
    expect(p.chapters).toEqual([
      { start: 0, end: 132301 / 44100, title: '序' },
      { start: 3, end: 10, title: '一' },
      { start: 5.5, end: 6, title: null },
    ]);
    expect(parseProbe(JSON.stringify({ format: {}, streams: [] })).chapters).toEqual([]);
  });

  it('shows no server folders in messages', () => {
    expect(
      shortenPaths('C:\\ab\\audiobooks\\japanese\\x\\b.m4a: Invalid data', ['C:\\ab\\audiobooks']),
    ).toBe('b.m4a: Invalid data');
    expect(
      shortenPaths(
        '/audiobooks/japanese/Vol 1/a (1).m4a: Invalid; /cache/audio-merge/3/merged.m4b: x',
        ['/audiobooks', '/cache/audio-merge'],
      ),
    ).toBe('a (1).m4a: Invalid; merged.m4b: x');
    expect(shortenPaths('ffmpeg failed', ['/audiobooks', null])).toBe('ffmpeg failed');
  });

  it('copies only AAC files of the same layout', () => {
    const probe = (codec: string, rate = 22050, extra: string[] = []) =>
      parseProbe(
        JSON.stringify({
          format: { duration: '2.0' },
          streams: [
            {
              index: 0,
              codec_type: 'audio',
              codec_name: codec,
              sample_rate: String(rate),
              channels: 1,
              profile: 'LC',
            },
            ...extra.map((t, i) => ({
              index: i + 1,
              codec_type: t,
              codec_name: 'mjpeg',
              disposition: { attached_pic: 1 },
            })),
          ],
        }),
      );
    expect(canStreamCopy([probe('aac'), probe('aac')])).toBe(true);
    expect(canStreamCopy([probe('aac'), probe('mp3')])).toBe(false);
    expect(canStreamCopy([probe('aac'), probe('aac', 44100)])).toBe(false);
    expect(canStreamCopy([probe('aac', 22050, ['video']), probe('aac')])).toBe(false);
    expect(canStreamCopy([probe('aac', 22050, ['video']), probe('aac', 22050, ['video'])])).toBe(
      true,
    );
    expect(canStreamCopy([probe('aac')])).toBe(false);
  });
});

describe('the merged file’s chapters', () => {
  const ch = (start: number, end: number, title: string | null = `c${start}`) => ({
    start,
    end,
    title,
  });
  const list = (files: { name: string; duration: number; chapters: ReturnType<typeof ch>[] }[]) =>
    mergedChapters(files).chapters.map((c) => [c.startMs, c.endMs, c.title]);

  it('shifts each file’s own chapters by the file’s start, titles unchanged', () => {
    expect(
      list([
        {
          name: '01.m4b',
          duration: 100.5,
          chapters: [ch(0, 40, 'オープニング'), ch(40, 100.5, '第1章')],
        },
        { name: '02.m4b', duration: 60.25, chapters: [ch(0, 30, '第2章'), ch(30, 60.25, '第3章')] },
      ]),
    ).toEqual([
      [0, 40_000, 'オープニング'],
      [40_000, 100_500, '第1章'],
      [100_500, 130_500, '第2章'],
      [130_500, 160_750, '第3章'],
    ]);
  });

  it('gives a file without chapters one chapter titled with its name', () => {
    expect(
      list([
        { name: 'Disc 1.mp3', duration: 10, chapters: [] },
        { name: 'Disc 2.part.mp3', duration: 5, chapters: [] },
      ]),
    ).toEqual([
      [0, 10_000, 'Disc 1'],
      [10_000, 15_000, 'Disc 2.part'],
    ]);
  });

  it('mixes files with and without chapters in the user’s order', () => {
    expect(
      list([
        { name: 'b.m4a', duration: 5, chapters: [] },
        { name: 'a.m4b', duration: 10, chapters: [ch(0, 4, 'A1'), ch(4, 10, 'A2')] },
        { name: 'c.mp3', duration: 2, chapters: [] },
      ]),
    ).toEqual([
      [0, 5_000, 'b'],
      [5_000, 9_000, 'A1'],
      [9_000, 15_000, 'A2'],
      [15_000, 17_000, 'c'],
    ]);
  });

  it('starts a file’s first chapter at 0:00', () => {
    expect(
      list([
        { name: 'a.m4a', duration: 3, chapters: [] },
        { name: 'b.m4b', duration: 10, chapters: [ch(1.25, 6, 'B1'), ch(6, 10, 'B2')] },
      ]),
    ).toEqual([
      [0, 3_000, 'a'],
      [3_000, 9_000, 'B1'],
      [9_000, 13_000, 'B2'],
    ]);
  });

  it('cuts a chapter running past its file’s end at the end', () => {
    expect(
      list([
        { name: 'a.m4b', duration: 10, chapters: [ch(0, 5, 'A1'), ch(5, 12.5, 'A2')] },
        { name: 'b.m4b', duration: 4, chapters: [ch(0, 4.2, 'B1')] },
      ]),
    ).toEqual([
      [0, 5_000, 'A1'],
      [5_000, 10_000, 'A2'],
      [10_000, 14_000, 'B1'],
    ]);
  });

  it('drops (and reports) a chapter starting at or after its file’s end', () => {
    const r = mergedChapters([
      {
        name: 'a.m4b',
        duration: 10,
        chapters: [ch(0, 9, 'A1'), ch(10, 11, 'end'), ch(12, 13, 'past')],
      },
      { name: 'b.m4b', duration: 2, chapters: [ch(2, 3, 'only past')] },
    ]);
    expect(r.chapters.map((c) => [c.startMs, c.endMs, c.title])).toEqual([
      [0, 10_000, 'A1'],
      [10_000, 12_000, 'b'], // nothing left: one chapter for the whole file
    ]);
    expect(r.dropped).toEqual([
      { file: 'a.m4b', title: 'end', start: 10 },
      { file: 'a.m4b', title: 'past', start: 12 },
      { file: 'b.m4b', title: 'only past', start: 2 },
    ]);
  });

  it('ends each chapter where the next starts (overlaps and gaps), in time order', () => {
    expect(
      list([
        {
          name: 'a.m4b',
          duration: 20,
          // Out of order, an overlap (c5 ends after c8 starts), a gap (c8 → c15).
          chapters: [ch(15, 18), ch(0, 4), ch(8, 10), ch(5, 9)],
        },
      ]),
    ).toEqual([
      [0, 5_000, 'c0'],
      [5_000, 8_000, 'c5'],
      [8_000, 15_000, 'c8'],
      [15_000, 20_000, 'c15'],
    ]);
  });

  it('keeps the file’s order for chapters with the same start', () => {
    expect(
      list([
        { name: 'a.m4b', duration: 10, chapters: [ch(0, 5, 'x'), ch(5, 5, 'y'), ch(5, 10, 'z')] },
      ]),
    ).toEqual([
      [0, 5_000, 'x'],
      [5_000, 5_000, 'y'],
      [5_000, 10_000, 'z'],
    ]);
  });

  it('keeps an untitled chapter untitled', () => {
    expect(
      list([{ name: 'a.m4b', duration: 4, chapters: [ch(0, 2, 'A'), ch(2, 4, null)] }]),
    ).toEqual([
      [0, 2_000, 'A'],
      [2_000, 4_000, null],
    ]);
  });

  it('rounds offsets from the running total, so rounding does not add up', () => {
    const files = Array.from({ length: 1000 }, (_, i) => ({
      name: `${i}.mp3`,
      duration: 1.0004,
      chapters: [],
    }));
    const last = mergedChapters(files).chapters.at(-1)!;
    expect(last.startMs).toBe(Math.round(999 * 1.0004 * 1000));
    expect(last.endMs).toBe(1000 * 1000 + 400);
  });

  it('escapes = ; # \\ and newlines in titles and always writes a title line', () => {
    const meta = buildFfmetadata(
      [
        { title: 'a=b;c#d\\e\nf', startMs: 0, endMs: 1000 },
        { title: null, startMs: 1000, endMs: 2000 },
      ],
      {},
      'f',
    );
    expect(meta).toBe(
      [
        ';FFMETADATA1',
        'title=f',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=0',
        'END=1000',
        'title=a\\=b\\;c\\#d\\\\e\\\nf',
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        'START=1000',
        'END=2000',
        'title=',
        '',
      ].join('\n'),
    );
  });

  it('compares the read-back chapters with the expected ones', () => {
    const expected = [
      { title: 'A', startMs: 0, endMs: 1000 },
      { title: null, startMs: 1000, endMs: 2000 },
    ];
    const ok = [
      { start: 0, end: 1, title: 'A' },
      { start: 1.004, end: 2, title: '' },
    ];
    expect(chapterMismatch(ok, expected, 5)).toBeNull();
    expect(chapterMismatch(ok, expected, 3)).toBe(
      'Chapter 2 of the merged file starts at 1.004 s, expected 1.000 s',
    );
    expect(chapterMismatch([ok[0]], expected, 5)).toBe(
      'The merged file has 1 chapters, expected 2',
    );
    expect(chapterMismatch([{ ...ok[0], title: 'B' }, ok[1]], expected, 5)).toBe(
      'Chapter 1 of the merged file is titled "B", expected "A"',
    );
  });
});

// ---------------------------------------------------------------- fixtures

const SPLIT = 'japanese/_Unknown/分割の本/Vol 1 - 分割の本 1';
const COVER = 'japanese/_Unknown/表紙つき';
const MIXED = 'japanese/_Unknown/混合';
const BROKEN = 'japanese/_Unknown/壊れた';
const SINGLE = 'japanese/_Unknown/ひとつ';
/** Files with chapters of their own (stream copy), and the same kinds re-encoded. */
const CHAPTERED = 'japanese/_Unknown/章つき';
const CHAPTERED_MIX = 'japanese/_Unknown/章つき混合';
/** WP21e-2: a merge of `folder` goes to `japanese-merged/<the same path>`. */
const merged = (folder: string) => folder.replace(/^japanese\//, 'japanese-merged/');
const BOOKS = ['分割の本 1', '表紙つき', '混合', '壊れた', 'ひとつ', '章つき', '章つき混合'];
const ODD_TITLE = 'a=b;c#d\\e\nf';

let template = '';

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true });
}

function aac(
  file: string,
  seconds: number,
  { freq = 440, rate = 22050, channels = 1, cover = '' } = {},
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const input = [
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:sample_rate=${rate}:duration=${seconds}`,
  ];
  if (cover) {
    ffmpeg([
      ...input,
      '-i',
      cover,
      '-map',
      '0:a',
      '-map',
      '1:v',
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      '-ac',
      String(channels),
      '-c:v',
      'copy',
      '-disposition:v:0',
      'attached_pic',
      file,
    ]);
  } else {
    ffmpeg([...input, '-c:a', 'aac', '-b:a', '32k', '-ac', String(channels), file]);
  }
}

/**
 * A file of noise (so the drift measure can find it) with chapters of its own:
 * [startMs, endMs, title]. AAC in .m4a/.m4b, or MP3 with ID3 chapters.
 */
function withChapters(
  file: string,
  seconds: number,
  chapters: [number, number, string][],
  { rate = 22050, channels = 1, seed = 1 } = {},
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const esc = (s: string) => s.replace(/[=;#\\\n]/g, (c) => (c === '\n' ? '\\\n' : `\\${c}`));
  const meta = `${file}.ffmeta.txt`;
  fs.writeFileSync(
    meta,
    [
      ';FFMETADATA1',
      ...chapters.flatMap(([s, e, t]) => [
        '[CHAPTER]',
        'TIMEBASE=1/1000',
        `START=${s}`,
        `END=${e}`,
        `title=${esc(t)}`,
      ]),
      '',
    ].join('\n'),
  );
  const mp3 = file.endsWith('.mp3');
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    `anoisesrc=color=pink:seed=${seed}:sample_rate=${rate}:duration=${seconds}:amplitude=0.3`,
    '-f',
    'ffmetadata',
    '-i',
    meta,
    '-map',
    '0:a',
    '-map_chapters',
    '1',
    '-ac',
    String(channels),
    ...(mp3
      ? ['-c:a', 'libmp3lame', '-b:a', '64k', '-id3v2_version', '3']
      : ['-c:a', 'aac', '-b:a', '48k']),
    file,
  ]);
  fs.rmSync(meta);
}

beforeAll(() => {
  if (!HAS_FFMPEG) return;
  template = makeTempDir('wp15f-template');
  const at = (rel: string) => path.join(template, ...rel.split('/'));
  aac(at(`${SPLIT}/01.m4a`), 3, { freq: 300 });
  aac(at(`${SPLIT}/02.m4a`), 2, { freq: 500 });
  aac(at(`${SPLIT}/03.m4a`), 2, { freq: 700 });
  const cover = at('cover.png');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', cover]);
  aac(at(`${COVER}/a.m4a`), 2, { cover });
  aac(at(`${COVER}/b.m4a`), 2, { cover });
  fs.rmSync(cover);
  fs.mkdirSync(at(MIXED), { recursive: true });
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=22050:duration=2',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '32k',
    at(`${MIXED}/a.mp3`),
  ]);
  aac(at(`${MIXED}/b.m4a`), 2, { rate: 44100, channels: 2 });
  aac(at(`${BROKEN}/a.m4a`), 2);
  write(template, `${BROKEN}/b.m4a`, 'this is not audio');
  aac(at(`${SINGLE}/only.m4a`), 2);
  // Chapters: the last runs past the file's end; one starting after 0:00. Every file of the
  // copy folder has chapters: a chapter track is a data stream, and files that differ in
  // their streams are re-encoded (canStreamCopy); files without chapters are joined by copy
  // in the first test below and re-encoded in the mixed folder.
  withChapters(
    at(`${CHAPTERED}/01.m4b`),
    4,
    [
      [0, 1500, 'オープニング'],
      [1500, 3000, ODD_TITLE],
      [3000, 6000, '第2章'],
    ],
    { seed: 1 },
  );
  withChapters(at(`${CHAPTERED}/02.m4b`), 3, [[0, 3000, '間奏']], { seed: 2 });
  withChapters(
    at(`${CHAPTERED}/03.m4b`),
    4,
    [
      [500, 2000, '後半'],
      [2000, 4000, '終わり'],
    ],
    { seed: 3 },
  );
  withChapters(
    at(`${CHAPTERED_MIX}/a.mp3`),
    3,
    [
      [0, 1000, 'MP3 一'],
      [1000, 3000, 'MP3 二'],
    ],
    { seed: 4 },
  );
  withChapters(at(`${CHAPTERED_MIX}/b.m4a`), 2, [], { rate: 44100, channels: 2, seed: 5 });
  withChapters(
    at(`${CHAPTERED_MIX}/c.m4b`),
    3,
    [
      [0, 2000, 'M4B 一'],
      [2000, 3000, 'M4B 二'],
    ],
    { rate: 44100, channels: 2, seed: 6 },
  );
  write(template, 'japanese-srt/分割の本 1.srt', '1\n00:00:00,000 --> 00:00:01,000\nテスト\n');
}, 120_000);

afterAll(() => {
  if (template) fs.rmSync(template, { recursive: true, force: true });
});

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
const mergeServices: MergeService[] = [];
afterEach(async () => {
  delete process.env.FAKE_FFMPEG_MODE;
  while (mergeServices.length) await mergeServices.pop()!.stop();
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

async function mergeEnv({
  config = {},
  fake = false,
  hooks = {},
}: {
  config?: Partial<AudioMergeConfig>;
  fake?: boolean;
  hooks?: Partial<MergeServiceOptions>;
} = {}) {
  const root = makeTempDir('wp15f-root');
  fs.cpSync(template, root, { recursive: true, preserveTimestamps: true });
  const env = await audioEnv({ envs, services }, { root, books: BOOKS });
  const cache = makeTempDir('wp15f-cache');
  const logs: string[] = [];
  const workdir = new MergeWorkdir(cache, root);
  const merges = new MergeService({
    db: env.e.db,
    scan: env.service,
    writer: new AudioWriter({ db: env.e.db, root, log: (m) => logs.push(m) }),
    workdir,
    config: {
      ...DEFAULT_AUDIO_MERGE,
      minFreeMb: 0,
      stallMinutes: 1,
      ...(fake ? { ffmpegPath: process.execPath } : {}),
      ...config,
    },
    log: (m) => logs.push(m),
    logError: (m) => logs.push(`ERROR ${m}`),
    ...(fake ? { ffmpegPrefixArgs: [FAKE_FFMPEG] } : {}),
    ...hooks,
  });
  mergeServices.push(merges);
  env.audio.merges = merges;
  await merges.start();
  const folder = (rel: string) => {
    const f = getAudioFolderByRelPath(env.e.db, rel);
    if (!f) throw new Error(`not indexed: ${rel}`);
    return f;
  };
  const post = (book: string, rel: string, files: unknown, auth = env.auth) =>
    request(env.e.app)
      .post(`/api/v1/books/${env.bookId(book)}/audio-merge`)
      .set(auth)
      .send({ folderId: folder(rel).id, files });
  const latest = async (book: string, auth = env.auth): Promise<MergeJob | null> =>
    (
      await request(env.e.app)
        .get(`/api/v1/books/${env.bookId(book)}/audio-merge`)
        .set(auth)
    ).body.job;
  const link = async (book: string) =>
    (
      await request(env.e.app)
        .get(`/api/v1/books/${env.bookId(book)}/audio-link`)
        .set(env.auth)
    ).body.link;
  const workFiles = () => (fs.existsSync(workdir.root) ? fs.readdirSync(workdir.root) : []);
  return {
    ...env,
    merges,
    workdir,
    logs,
    folder,
    post,
    latest,
    link,
    workFiles,
    start: treeHashes(root),
  };
}

function probeJson(file: string) {
  return JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file],
      { windowsHide: true },
    ).toString('utf8'),
  ) as {
    format: { duration: string };
    streams: { codec_type: string; codec_name: string; disposition?: { attached_pic?: number } }[];
    chapters: { start_time: string; end_time: string; tags?: { title?: string } }[];
  };
}

/** Top-level MP4 boxes in order (to check moov comes before mdat: playable while streaming). */
function topBoxes(file: string): string[] {
  const buf = fs.readFileSync(file);
  const out: string[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8));
    else if (size === 0) size = buf.length - pos;
    out.push(type);
    pos += size;
  }
  return out;
}

async function waitFor<T>(
  fn: () => Promise<T> | T,
  ok: (v: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const UNCHANGED = { added: [], removed: [], changed: [] };

// ---------------------------------------------------------------- merges

describe.skipIf(!HAS_FFMPEG)('merging with ffmpeg', () => {
  it('joins AAC parts by stream copy in the chosen order, one chapter per file, and links the book', async () => {
    const t = await mergeEnv();
    const res = await t.post('分割の本 1', SPLIT, ['02.m4a', '01.m4a', '03.m4a']);
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ state: 'queued', files: ['02.m4a', '01.m4a', '03.m4a'] });
    expect(res.body.job.userId).toBeUndefined();
    await t.merges.idle();

    const job = (await t.latest('分割の本 1'))!;
    expect(job).toMatchObject({
      state: 'done',
      mode: 'copy',
      progress: 1,
      linked: true,
      outputName: 'Vol 1 - 分割の本 1.m4b',
      error: null,
    });
    const outRel = `${merged(SPLIT)}/Vol 1 - 分割の本 1.m4b`;
    const out = path.join(t.root, ...outRel.split('/'));
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual({
      added: [outRel],
      removed: [],
      changed: [],
    });

    const p = probeJson(out);
    expect(Number(p.format.duration)).toBeCloseTo(7, 0);
    expect(p.chapters.map((c) => c.tags?.title)).toEqual(['02', '01', '03']);
    expect(Number(p.chapters[1].start_time)).toBeCloseTo(2, 1);
    expect(Number(p.chapters[2].end_time)).toBeCloseTo(7, 0);
    expect(p.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name)).toEqual([
      'aac',
    ]);
    const boxes = topBoxes(out);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));

    // The merged folder is indexed with the new file (and its length), and the book plays it;
    // the originals' folder is as it was.
    expect(t.folder(SPLIT).files.map((f) => f.name)).not.toContain('Vol 1 - 分割の本 1.m4b');
    const folder = t.folder(merged(SPLIT));
    expect(folder.files.map((f) => f.name)).toEqual(['Vol 1 - 分割の本 1.m4b']);
    expect(folder.files.find((f) => f.name.endsWith('.m4b'))!.durationSeconds).toBeCloseTo(7, 0);
    const link = await t.link('分割の本 1');
    expect(link).toMatchObject({
      state: 'linked',
      folderRelPath: merged(SPLIT),
      fileName: 'Vol 1 - 分割の本 1.m4b',
      playable: true,
      status: 'ok',
      subtitleState: null,
      file: { name: 'Vol 1 - 分割の本 1.m4b' },
    });
    const stream = await request(t.e.app).get(link.playUrl).set('Range', 'bytes=0-99');
    expect(stream.status).toBe(206);
    expect(stream.headers['content-type']).toBe('audio/mp4');

    expect(t.workFiles()).toEqual([]);
    expect(
      t.e.db
        .prepare('SELECT state FROM audio_writes')
        .all()
        .map((r) => (r as { state: string }).state),
    ).toEqual(['done']);
  });

  it("keeps the first file's cover", async () => {
    const t = await mergeEnv();
    await t.post('表紙つき', COVER, ['a.m4a', 'b.m4a']);
    await t.merges.idle();
    const job = (await t.latest('表紙つき'))!;
    expect(job).toMatchObject({ state: 'done', mode: 'copy' });
    const p = probeJson(path.join(t.root, ...merged(COVER).split('/'), job.outputName!));
    expect(
      p.streams.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1),
    ).toBe(true);
    expect(p.chapters).toHaveLength(2);
    expect(Number(p.format.duration)).toBeCloseTo(4, 0);
  });

  it('re-encodes files that cannot be joined by copying', async () => {
    const t = await mergeEnv();
    await t.post('混合', MIXED, ['a.mp3', 'b.m4a']);
    await t.merges.idle();
    const job = (await t.latest('混合'))!;
    expect(job).toMatchObject({ state: 'done', mode: 'reencode', linked: true });
    const p = probeJson(path.join(t.root, ...merged(MIXED).split('/'), job.outputName!));
    expect(p.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name)).toEqual([
      'aac',
    ]);
    expect(p.chapters).toHaveLength(2);
    expect(Number(p.format.duration)).toBeCloseTo(4, 0);
  });

  const chapterList = (file: string) =>
    probeJson(file).chapters.map((c) => [
      Math.round(Number(c.start_time) * 1000),
      c.tags?.title ?? '',
    ]);

  it('keeps every original chapter, shifted by its file’s start (stream copy)', async () => {
    const t = await mergeEnv();
    await t.post('章つき', CHAPTERED, ['01.m4b', '02.m4b', '03.m4b']);
    await t.merges.idle();
    const job = (await t.latest('章つき'))!;
    expect(job).toMatchObject({ state: 'done', mode: 'copy', linked: true });
    const out = path.join(t.root, ...merged(CHAPTERED).split('/'), job.outputName!);
    const p = probeJson(out);
    expect(
      p.chapters.map((c) => [Number(c.start_time), Number(c.end_time), c.tags?.title]),
    ).toEqual([
      [0, 1.5, 'オープニング'],
      [1.5, 3, ODD_TITLE],
      [3, 4, '第2章'], // cut at its file's end
      [4, 7, '間奏'],
      [7, 9, '後半'], // moved to 0:00 of its file
      [9, 11, '終わり'],
    ]);
    const drift = measureMerge(
      out,
      ['01.m4b', '02.m4b', '03.m4b'].map((f) => path.join(t.root, ...CHAPTERED.split('/'), f)),
    );
    console.log(
      'drift (copy, generated):',
      JSON.stringify(
        drift.files.map((f) => [f.name, f.driftMs, f.score, f.duration, f.streamDuration]),
      ),
      drift.chapters.maxStartDiffMs,
      drift.durationDiffMs,
    );
    expect(drift.chapters).toMatchObject({ countEqual: true, titlesEqual: true });
    expect(drift.chapters.maxStartDiffMs).toBeLessThanOrEqual(1);
    // Where each file's audio really is: AAC priming and padding move it by up to about two
    // AAC frames (46 ms each at 22 kHz) for every file up to it (measured; decisions.md
    // "Merge keeps the original chapters"); never seconds.
    expect(
      drift.files.every((f, i) => Math.abs(f.driftMs!) <= (i + 1) * 100 && f.score! > 0.9),
    ).toBe(true);
  });

  it('keeps the original chapters when it has to re-encode (MP3 ID3 chapters too)', async () => {
    const t = await mergeEnv();
    await t.post('章つき混合', CHAPTERED_MIX, ['c.m4b', 'a.mp3', 'b.m4a']);
    await t.merges.idle();
    const job = (await t.latest('章つき混合'))!;
    expect(job).toMatchObject({ state: 'done', mode: 'reencode', linked: true });
    const out = path.join(t.root, ...merged(CHAPTERED_MIX).split('/'), job.outputName!);
    const list = chapterList(out);
    expect(list.map((c) => c[1])).toEqual(['M4B 一', 'M4B 二', 'MP3 一', 'MP3 二', 'b']);
    const drift = measureMerge(
      out,
      ['c.m4b', 'a.mp3', 'b.m4a'].map((f) => path.join(t.root, ...CHAPTERED_MIX.split('/'), f)),
    );
    console.log(
      'drift (re-encode, generated):',
      JSON.stringify(
        drift.files.map((f) => [f.name, f.driftMs, f.score, f.duration, f.streamDuration]),
      ),
      drift.chapters.maxStartDiffMs,
      drift.durationDiffMs,
    );
    expect(drift.chapters).toMatchObject({ countEqual: true, titlesEqual: true });
    expect(drift.chapters.maxStartDiffMs).toBeLessThanOrEqual(1);
    expect(
      drift.files.every((f, i) => Math.abs(f.driftMs!) <= (i + 1) * 100 && f.score! > 0.9),
    ).toBe(true);
  });

  it('writes the same chapter list in both modes', () => {
    const dir = makeTempDir('wp15f-modes');
    try {
      const inputs = ['01.m4b', '02.m4b', '03.m4b'].map((f) =>
        path.join(template, ...CHAPTERED.split('/'), f),
      );
      const probes = inputs.map((f) =>
        parseProbe(
          execFileSync(
            'ffprobe',
            [
              '-v',
              'error',
              '-show_entries',
              'format=duration:format_tags:stream=index,codec_type,codec_name,sample_rate,channels,profile,duration:stream_disposition=attached_pic:chapter=id,time_base,start,end,start_time,end_time:chapter_tags=title',
              '-of',
              'json',
              f,
            ],
            { windowsHide: true },
          ).toString('utf8'),
        ),
      );
      const { chapters } = mergedChapters(
        inputs.map((f, i) => ({
          name: path.basename(f),
          duration: probes[i].duration,
          chapters: probes[i].chapters,
        })),
      );
      const listFile = path.join(dir, 'files.txt');
      const metaFile = path.join(dir, 'chapters.txt');
      fs.writeFileSync(listFile, buildConcatList(inputs));
      fs.writeFileSync(metaFile, buildFfmetadata(chapters, probes[0].tags, '章つき'));
      const lists = (['copy', 'reencode'] as const).map((mode) => {
        const output = path.join(dir, `${mode}.m4b`);
        execFileSync(
          'ffmpeg',
          ffmpegArgs({ mode, inputs, listFile, metaFile, output, probes, bitrate: '64k' }).filter(
            (a, i, all) => !(a === '-progress' || all[i - 1] === '-progress'),
          ),
          { windowsHide: true },
        );
        const back = parseProbe(
          execFileSync(
            'ffprobe',
            ['-v', 'error', '-show_chapters', '-show_format', '-of', 'json', output],
            { windowsHide: true },
          ).toString('utf8'),
        ).chapters;
        expect(chapterMismatch(back, chapters, 1)).toBeNull();
        return back.map((c) => [Math.round(c.start * 1000), c.title]);
      });
      expect(lists[1]).toEqual(lists[0]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a file that is not audio fails and adds nothing', async () => {
    const t = await mergeEnv();
    await t.post('壊れた', BROKEN, ['a.m4a', 'b.m4a']);
    await t.merges.idle();
    expect(await t.latest('壊れた')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/b\.m4a/),
      linked: false,
    });
    expect(await t.link('壊れた')).toBeNull();
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
    expect(t.workFiles()).toEqual([]);
  });

  it('refuses to start without enough free space', async () => {
    const t = await mergeEnv({ config: { minFreeMb: 1e9 } });
    await t.post('分割の本 1', SPLIT, ['01.m4a', '02.m4a']);
    await t.merges.idle();
    expect(await t.latest('分割の本 1')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/Not enough free space in the server's cache folder/),
    });
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
  });

  it('stops while saving when cancelled, leaving nothing', async () => {
    const t: Awaited<ReturnType<typeof mergeEnv>> = await mergeEnv({
      hooks: {
        beforeSave: async (job) => {
          expect(job.state).toBe('saving');
          const res = await request(t.e.app)
            .post(`/api/v1/audio/merges/${job.id}/cancel`)
            .set(t.auth);
          expect(res.status).toBe(200);
        },
      },
    });
    await t.post('分割の本 1', SPLIT, ['01.m4a', '02.m4a']);
    await t.merges.idle();
    expect(await t.latest('分割の本 1')).toMatchObject({ state: 'cancelled', error: null });
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
    expect(t.workFiles()).toEqual([]);
    expect(await t.link('分割の本 1')).toBeNull();
  });

  it('does not link when the link changed during the merge', async () => {
    const t: Awaited<ReturnType<typeof mergeEnv>> = await mergeEnv({
      hooks: {
        beforeSave: async () => {
          const res = await request(t.e.app)
            .put(`/api/v1/books/${t.bookId('分割の本 1')}/audio-link`)
            .set(t.auth)
            .send({ audio: { state: 'linked', folderId: t.folder(SINGLE).id } });
          expect(res.status).toBe(200);
        },
      },
    });
    await t.post('分割の本 1', SPLIT, ['01.m4a', '02.m4a']);
    await t.merges.idle();
    expect(await t.latest('分割の本 1')).toMatchObject({ state: 'done', linked: false });
    expect(await t.link('分割の本 1')).toMatchObject({
      folderRelPath: SINGLE,
      fileName: 'only.m4a',
    });
    expect(treeDiff(t.start, treeHashes(t.root)).added).toEqual([
      `${merged(SPLIT)}/Vol 1 - 分割の本 1.m4b`,
    ]);
  });

  it('queues, refuses a second merge of the same folder, and keeps merges per user', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await mergeEnv({ hooks: { beforeSave: () => gate } });
    expect((await t.post('分割の本 1', SPLIT, ['01.m4a', '02.m4a'])).status).toBe(202);
    const again = await t.post('分割の本 1', SPLIT, ['02.m4a', '03.m4a']);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('busy');
    const second = await t.post('表紙つき', COVER, ['a.m4a', 'b.m4a']);
    expect(second.body.job.state).toBe('queued');

    // Another user sees and stops nothing of these.
    t.e.db
      .prepare("INSERT INTO users (id, name, created_at) VALUES ('other-user', 'other', 0)")
      .run();
    const other = { Authorization: `Bearer ${createToken(t.e.db, 'other-user', 'B').token}` };
    const cancelOther = await request(t.e.app)
      .post(`/api/v1/audio/merges/${second.body.job.id}/cancel`)
      .set(other);
    expect(cancelOther.status).toBe(404);

    // A waiting merge is cancelled at once.
    const cancel = await request(t.e.app)
      .post(`/api/v1/audio/merges/${second.body.job.id}/cancel`)
      .set(t.auth);
    expect(cancel.body.job.state).toBe('cancelled');
    release();
    await t.merges.idle();
    expect((await t.latest('分割の本 1'))!.state).toBe('done');
    expect((await t.latest('表紙つき'))!.state).toBe('cancelled');
    expect(treeDiff(t.start, treeHashes(t.root)).added).toEqual([
      `${merged(SPLIT)}/Vol 1 - 分割の本 1.m4b`,
    ]);
  });

  it('validates requests', async () => {
    const t = await mergeEnv();
    const url = `/api/v1/books/${t.bookId('分割の本 1')}/audio-merge`;
    const send = (body: unknown) =>
      request(t.e.app)
        .post(url)
        .set(t.auth)
        .send(body as object);
    const id = t.folder(SPLIT).id;
    expect((await send({ folderId: id, files: ['01.m4a'] })).status).toBe(400);
    expect((await send({ folderId: id, files: ['01.m4a', '01.m4a'] })).status).toBe(400);
    expect((await send({ folderId: id, files: '01.m4a' })).status).toBe(400);
    expect((await send({ folderId: id, files: ['01.m4a', 'nope.m4a'] })).status).toBe(404);
    expect((await send({ folderId: 'x', files: ['01.m4a', '02.m4a'] })).status).toBe(400);
    expect((await send({ folderId: 99999, files: ['01.m4a', '02.m4a'] })).status).toBe(404);
    expect(
      (
        await request(t.e.app)
          .post('/api/v1/books/no-such-book/audio-merge')
          .set(t.auth)
          .send({ folderId: id, files: ['01.m4a', '02.m4a'] })
      ).status,
    ).toBe(404);
    expect(await t.latest('分割の本 1')).toBeNull();
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
  });

  it('says when merging is off (read-only folder) and links and plays still work', async () => {
    const t = await mergeEnv();
    t.service.status.writable = false;
    const status = await request(t.e.app).get('/api/v1/audio/status').set(t.auth);
    expect(status.body.merge).toEqual({
      available: false,
      reason: expect.stringMatching(/read-only/),
    });
    const res = await t.post('分割の本 1', SPLIT, ['01.m4a', '02.m4a']);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('merge_off');
    t.service.status.writable = true;
    expect((await request(t.e.app).get('/api/v1/audio/status').set(t.auth)).body.merge).toEqual({
      available: true,
      reason: null,
    });
  });
});

describe.skipIf(!HAS_FFMPEG)('a merge that goes wrong leaves nothing behind', () => {
  it('ffmpeg failing (copy, then re-encode) adds nothing', async () => {
    process.env.FAKE_FFMPEG_MODE = 'fail';
    const t = await mergeEnv({ fake: true });
    await t.post('分割の本 1', SPLIT, ['01.m4a', '02.m4a']);
    await t.merges.idle();
    expect(await t.latest('分割の本 1')).toMatchObject({
      state: 'failed',
      mode: 'reencode',
      error: 'ffmpeg failed: Invalid data found when processing input',
    });
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
    expect(t.workFiles()).toEqual([]);
  });

  it('ffmpeg making no progress is stopped', async () => {
    process.env.FAKE_FFMPEG_MODE = 'hang';
    const t = await mergeEnv({ fake: true, config: { stallMinutes: 0.01 } });
    await t.post('混合', MIXED, ['a.mp3', 'b.m4a']);
    await t.merges.idle();
    expect(await t.latest('混合')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/no progress for 0\.01 minute/),
    });
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
    expect(t.workFiles()).toEqual([]);
  });

  it('cancelling a running ffmpeg stops it and adds nothing', async () => {
    process.env.FAKE_FFMPEG_MODE = 'slow';
    const t = await mergeEnv({ fake: true });
    const { job } = (await t.post('混合', MIXED, ['a.mp3', 'b.m4a'])).body;
    const running = await waitFor(
      () => t.latest('混合'),
      (j) => !!j && j.state === 'running' && j.progress > 0,
    );
    expect(running!.progress).toBeLessThanOrEqual(0.9);
    await request(t.e.app).post(`/api/v1/audio/merges/${job.id}/cancel`).set(t.auth);
    await t.merges.idle();
    expect(await t.latest('混合')).toMatchObject({ state: 'cancelled' });
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
    expect(t.workFiles()).toEqual([]);
  });

  it('a server stop during a merge marks it interrupted and adds nothing', async () => {
    process.env.FAKE_FFMPEG_MODE = 'slow';
    const t = await mergeEnv({ fake: true });
    await t.post('混合', MIXED, ['a.mp3', 'b.m4a']);
    await waitFor(
      () => t.latest('混合'),
      (j) => !!j && j.progress > 0,
    );
    await t.merges.stop();
    expect(await t.latest('混合')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/^Interrupted/),
    });
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
  });

  it('after a crash, the next start removes the partial file and the work folder', async () => {
    const t = await mergeEnv();
    // What a crash in the middle of saving leaves: a running job, a recorded temp file in
    // the audiobook's folder and ffmpeg's output in the work folder.
    const now = Date.now();
    const userId = (t.e.db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
    t.e.db
      .prepare(
        `INSERT INTO audio_merge_jobs (user_id, book_id, library_id, folder_rel_path, file_names,
           state, progress, created_at, updated_at)
         VALUES (?, ?, ?, ?, '["01.m4a","02.m4a"]', 'saving', 0.95, ?, ?)`,
      )
      .run(userId, t.bookId('分割の本 1'), t.libId, SPLIT, now, now);
    const temp = `${SPLIT}/.ttsu-write-0123456789ab.partial`;
    write(t.root, temp, 'half a file');
    t.e.db
      .prepare(
        `INSERT INTO audio_writes (purpose, temp_rel_path, direct, state, created_at, updated_at)
         VALUES ('merge', ?, 0, 'writing', ?, ?)`,
      )
      .run(temp, now, now);
    fs.mkdirSync(path.join(t.workdir.root, '7'), { recursive: true });
    fs.writeFileSync(path.join(t.workdir.root, '7', 'merged.m4b'), 'leftover');

    const restarted = new MergeService({
      db: t.e.db,
      scan: t.service,
      writer: new AudioWriter({ db: t.e.db, root: t.root, log: () => undefined }),
      workdir: t.workdir,
      config: { ...DEFAULT_AUDIO_MERGE, minFreeMb: 0 },
      log: () => undefined,
    });
    mergeServices.push(restarted);
    await restarted.start();
    expect(await t.latest('分割の本 1')).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/^Interrupted/),
    });
    expect(treeDiff(t.start, treeHashes(t.root))).toEqual(UNCHANGED);
    expect(t.workFiles()).toEqual([]);
  });
});
