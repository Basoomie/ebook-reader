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
  type MergeJob,
  MergeService,
  type MergeServiceOptions,
  parseProbe,
  shortenPaths,
} from '../src/audio/merge-service';
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
      [
        { name: '01 第一部.m4b', duration: 2.5 },
        { name: 'b=c;d.m4a', duration: 1 },
      ],
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

// ---------------------------------------------------------------- fixtures

const SPLIT = 'japanese/_Unknown/分割の本/Vol 1 - 分割の本 1';
const COVER = 'japanese/_Unknown/表紙つき';
const MIXED = 'japanese/_Unknown/混合';
const BROKEN = 'japanese/_Unknown/壊れた';
const SINGLE = 'japanese/_Unknown/ひとつ';
const BOOKS = ['分割の本 1', '表紙つき', '混合', '壊れた', 'ひとつ'];

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
    const outRel = `${SPLIT}/Vol 1 - 分割の本 1.m4b`;
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

    // The folder is re-indexed with the new file (and its length), and the book plays it.
    const folder = t.folder(SPLIT);
    expect(folder.files.map((f) => f.name)).toContain('Vol 1 - 分割の本 1.m4b');
    expect(folder.files.find((f) => f.name.endsWith('.m4b'))!.durationSeconds).toBeCloseTo(7, 0);
    const link = await t.link('分割の本 1');
    expect(link).toMatchObject({
      state: 'linked',
      folderRelPath: SPLIT,
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
    const p = probeJson(path.join(t.root, ...COVER.split('/'), job.outputName!));
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
    const p = probeJson(path.join(t.root, ...MIXED.split('/'), job.outputName!));
    expect(p.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name)).toEqual([
      'aac',
    ]);
    expect(p.chapters).toHaveLength(2);
    expect(Number(p.format.duration)).toBeCloseTo(4, 0);
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
      `${SPLIT}/Vol 1 - 分割の本 1.m4b`,
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
      `${SPLIT}/Vol 1 - 分割の本 1.m4b`,
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
