/**
 * WP14 "Enrich last card": GET /books/:id/audio-clip cuts sentence audio out of the
 * book's linked audiobook file. Real ffmpeg (skipped when not installed) cuts a generated
 * file that is silent for 2 s and then a tone; a fake ffmpeg stands in to hang, fail and
 * flood. Every cut proves the audiobooks folder and DATA_DIR unchanged.
 */
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getAudioFolderByRelPath } from '../src/audio/audio-index';
import { ClipService, clipArgs } from '../src/audio/clip-service';
import type { AudioScanService } from '../src/audio/scan-service';
import { type AudioClipConfig, DEFAULT_AUDIO_CLIP, parseAudioConfig } from '../src/config';
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
if (!HAS_FFMPEG)
  console.warn('WP14 clip tests with real ffmpeg SKIPPED: ffmpeg/ffprobe not on PATH');

const FAKE = path.join(__dirname, 'fixtures', 'wp14', 'fake-ffmpeg-clip.cjs');

const SINGLE = 'japanese/_Unknown/ひとつ';
const SPLIT = 'japanese/_Unknown/分割の本 1';
const GONE = 'japanese/_Unknown/消える';
const BOOKS = ['ひとつ', '分割の本 1', '消える', 'リンクなし'];
const UNCHANGED = { added: [], removed: [], changed: [] };

let template = '';

function ffmpeg(args: string[]) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { windowsHide: true });
}

/** 2 s of silence, then 2 s of a 440 Hz tone, as AAC in .m4a. */
function silenceThenTone(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=if(lt(t\\,2)\\,0\\,0.5*sin(2*PI*440*t)):s=22050:d=4',
    '-c:a',
    'aac',
    '-b:a',
    '48k',
    file,
  ]);
}

beforeAll(() => {
  template = makeTempDir('wp14-template');
  const at = (rel: string) => path.join(template, ...rel.split('/'));
  if (HAS_FFMPEG) {
    silenceThenTone(at(`${SINGLE}/only.m4a`));
    silenceThenTone(at(`${SPLIT}/01.m4a`));
    silenceThenTone(at(`${SPLIT}/02.m4a`));
    silenceThenTone(at(`${GONE}/gone.m4a`));
  } else {
    // Stand-ins: enough for the fake-ffmpeg tests (durations unreadable).
    write(template, `${SINGLE}/only.m4a`, 'not really audio');
    write(template, `${SPLIT}/01.m4a`, 'a');
    write(template, `${SPLIT}/02.m4a`, 'b');
    write(template, `${GONE}/gone.m4a`, 'c');
  }
}, 120_000);

afterAll(() => {
  if (template) fs.rmSync(template, { recursive: true, force: true });
});

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  delete process.env.FAKE_CLIP_MODE;
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

/** The response body as bytes (supertest would otherwise try to parse audio/mpeg). */
function bytes(res: request.Response): Buffer {
  return Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.text ?? '');
}
function errorCode(res: request.Response): string | undefined {
  try {
    return JSON.parse(bytes(res).toString('utf8')).error?.code;
  } catch {
    return undefined;
  }
}

async function clipEnv({
  config = {},
  fake = false,
}: { config?: Partial<AudioClipConfig>; fake?: boolean } = {}) {
  const root = makeTempDir('wp14-root');
  fs.cpSync(template, root, { recursive: true, preserveTimestamps: true });
  const env = await audioEnv({ envs, services }, { root, books: BOOKS });
  const logs: string[] = [];
  env.audio.clips = new ClipService({
    config: {
      ...DEFAULT_AUDIO_CLIP,
      ...(fake ? { ffmpegPath: process.execPath } : {}),
      ...config,
    },
    hideRoots: () => [root],
    logError: (m) => logs.push(`ERROR ${m}`),
    ...(fake ? { ffmpegPrefixArgs: [FAKE] } : {}),
  });
  const folder = (rel: string) => {
    const f = getAudioFolderByRelPath(env.e.db, rel);
    if (!f) throw new Error(`not indexed: ${rel}`);
    return f;
  };
  const link = (book: string, rel: string, fileName?: string) =>
    request(env.e.app)
      .put(`/api/v1/books/${env.bookId(book)}/audio-link`)
      .set(env.auth)
      .send({
        audio: { state: 'linked', folderId: folder(rel).id, ...(fileName ? { fileName } : {}) },
      })
      .expect(200);
  const clip = (book: string, query: string, auth: Record<string, string> = env.auth) =>
    request(env.e.app)
      .get(`/api/v1/books/${env.bookId(book)}/audio-clip?${query}`)
      .set(auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  const dataFiles = () => treeHashes(env.e.config.dataRoot);
  return {
    ...env,
    logs,
    folder,
    link,
    clip,
    startTree: treeHashes(root),
    data: dataFiles(),
    dataFiles,
  };
}

type Env = Awaited<ReturnType<typeof clipEnv>>;
function expectNothingWritten(t: Env) {
  expect(treeDiff(t.startTree, treeHashes(t.root))).toEqual(UNCHANGED);
  expect(treeDiff(t.data, t.dataFiles())).toEqual(UNCHANGED);
}

/** Codec, length (s) and mean volume (dB) of an MP3, through a temp file outside every root. */
function measure(mp3: Buffer): { codec: string; duration: number; meanDb: number } {
  const dir = makeTempDir('wp14-measure');
  try {
    const file = path.join(dir, 'clip.mp3');
    fs.writeFileSync(file, mp3);
    const probe = JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
        { windowsHide: true },
      ).toString('utf8'),
    ) as { format: { duration: string }; streams: { codec_name: string }[] };
    const vol = spawnSync(
      'ffmpeg',
      ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
      { windowsHide: true, encoding: 'utf8' },
    );
    const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(vol.stderr);
    return {
      codec: probe.streams[0].codec_name,
      duration: Number(probe.format.duration),
      meanDb: m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : NaN,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- pure parts

describe('clip helpers', () => {
  it('cuts by input seek to stdout, audio only, MP3 without metadata', () => {
    expect(clipArgs('/a/b.m4b', 1.23456, 4.5, '128k')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-ss',
      '1.235',
      '-i',
      '/a/b.m4b',
      '-t',
      '3.265',
      '-map',
      '0:a:0',
      '-vn',
      '-map_metadata',
      '-1',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      '-f',
      'mp3',
      'pipe:1',
    ]);
  });

  it('reads the AUDIO_CLIP_* settings, falling back on bad values', () => {
    const warnings: string[] = [];
    const c = parseAudioConfig(
      {
        AUDIO_CLIP_MAX_SECONDS: '45',
        AUDIO_CLIP_BITRATE: '96K',
        AUDIO_CLIP_TIMEOUT_SECONDS: '10',
        AUDIO_CLIP_CONCURRENCY: '3',
        FFMPEG_PATH: '/usr/bin/ffmpeg',
      },
      warnings,
    ).clip;
    expect(c).toEqual({
      ffmpegPath: '/usr/bin/ffmpeg',
      maxSeconds: 45,
      bitrate: '96k',
      timeoutSeconds: 10,
      concurrency: 3,
    });
    expect(warnings).toEqual([]);
    const bad: string[] = [];
    expect(
      parseAudioConfig({ AUDIO_CLIP_BITRATE: 'loud', AUDIO_CLIP_CONCURRENCY: '0' }, bad).clip,
    ).toEqual(DEFAULT_AUDIO_CLIP);
    expect(bad).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- real ffmpeg

describe.skipIf(!HAS_FFMPEG)('cutting sentence audio with ffmpeg', () => {
  it('answers MP3 of the asked range: the silent part is silent, the tone part is loud', async () => {
    const t = await clipEnv();
    await t.link('ひとつ', SINGLE);

    const quiet = await t.clip('ひとつ', 'start=0.2&end=1.7');
    expect(quiet.status).toBe(200);
    expect(quiet.headers['content-type']).toBe('audio/mpeg');
    expect(quiet.headers['cache-control']).toBe('no-store');
    const q = measure(bytes(quiet));
    expect(q.codec).toBe('mp3');
    expect(Math.abs(q.duration - 1.5)).toBeLessThan(0.15);
    expect(q.meanDb).toBeLessThan(-60);

    const loud = await t.clip('ひとつ', 'start=2.3&end=3.5');
    expect(loud.status).toBe(200);
    const l = measure(bytes(loud));
    expect(Math.abs(l.duration - 1.2)).toBeLessThan(0.15);
    expect(l.meanDb).toBeGreaterThan(-20);

    // A range past the end is cut at the end of the file.
    const tail = await t.clip('ひとつ', 'start=3.5&end=9');
    expect(tail.status).toBe(200);
    expect(measure(bytes(tail)).duration).toBeLessThan(0.75);
    expectNothingWritten(t);
  }, 60_000);

  it('cuts from the chosen file of a folder of several', async () => {
    const t = await clipEnv();
    await t.link('分割の本 1', SPLIT, '02.m4a');
    const res = await t.clip('分割の本 1', 'start=2.5&end=3');
    expect(res.status).toBe(200);
    expect(measure(bytes(res)).meanDb).toBeGreaterThan(-20);
    expectNothingWritten(t);
  }, 60_000);

  it('refuses a start after the end of the audiobook', async () => {
    const t = await clipEnv();
    await t.link('ひとつ', SINGLE);
    const res = await t.clip('ひとつ', 'start=10&end=11');
    expect([res.status, errorCode(res)]).toEqual([400, 'out_of_range']);
  }, 60_000);
});

// ---------------------------------------------------------------- refusals

describe('refusals', () => {
  it('needs a token, a known book and a sensible range', async () => {
    const t = await clipEnv({ fake: true });
    await t.link('ひとつ', SINGLE);
    const noAuth = await request(t.e.app).get(
      `/api/v1/books/${t.bookId('ひとつ')}/audio-clip?start=0&end=1`,
    );
    expect(noAuth.status).toBe(401);
    const unknown = await request(t.e.app)
      .get('/api/v1/books/no-such-book/audio-clip?start=0&end=1')
      .set(t.auth);
    expect(unknown.status).toBe(404);
    const code = async (query: string) => {
      const res = await t.clip('ひとつ', query);
      return [res.status, errorCode(res)];
    };
    expect(await code('start=&end=1')).toEqual([400, 'invalid_query']);
    expect(await code('start=abc&end=1')).toEqual([400, 'invalid_query']);
    expect(await code('start=-1&end=1')).toEqual([400, 'invalid_query']);
    expect(await code('start=2&end=2')).toEqual([400, 'invalid_query']);
    expect(await code('start=0&end=61')).toEqual([400, 'too_long']);
    expectNothingWritten(t);
  });

  it('needs a linked audiobook that plays', async () => {
    const t = await clipEnv({ fake: true });
    const code = async (book: string) => {
      const res = await t.clip(book, 'start=0&end=1');
      return [res.status, errorCode(res)];
    };
    expect(await code('リンクなし')).toEqual([409, 'no_audiobook']);
    await request(t.e.app)
      .put(`/api/v1/books/${t.bookId('リンクなし')}/audio-link`)
      .set(t.auth)
      .send({ audio: { state: 'none' } })
      .expect(200);
    expect(await code('リンクなし')).toEqual([409, 'no_audiobook']);
    await t.link('分割の本 1', SPLIT); // the whole folder: can't play
    expect(await code('分割の本 1')).toEqual([409, 'not_one_file']);

    await t.link('消える', GONE);
    fs.rmSync(path.join(t.root, ...GONE.split('/')), { recursive: true });
    await t.service.scanLibrary(t.service.libraries()[0]);
    expect(await code('消える')).toEqual([409, 'missing']);
  });

  it('answers 503 when audiobooks or clips are off', async () => {
    const t = await clipEnv({ fake: true });
    await t.link('ひとつ', SINGLE);
    t.audio.clips = null;
    const off = await t.clip('ひとつ', 'start=0&end=1');
    expect([off.status, errorCode(off)]).toEqual([503, 'clip_off']);
    t.audio.service = null;
    const audioOff = await t.clip('ひとつ', 'start=0&end=1');
    expect([audioOff.status, errorCode(audioOff)]).toEqual([503, 'audio_off']);
  });
});

// ---------------------------------------------------------------- fake ffmpeg

describe('a cut that goes wrong', () => {
  it('stops a hung ffmpeg after the timeout; a cut beyond the limit is busy', async () => {
    process.env.FAKE_CLIP_MODE = 'hang';
    const t = await clipEnv({ fake: true, config: { timeoutSeconds: 1.5, concurrency: 1 } });
    await t.link('ひとつ', SINGLE);
    const first = t.clip('ひとつ', 'start=0&end=1').then((r) => r);
    await new Promise((r) => setTimeout(r, 400));
    const second = await t.clip('ひとつ', 'start=0&end=1');
    expect([second.status, errorCode(second)]).toEqual([429, 'busy']);
    const res = await first;
    expect([res.status, errorCode(res)]).toEqual([504, 'timeout']);
    // Free again afterwards.
    const again = await t.clip('ひとつ', 'start=0&end=1');
    expect([again.status, errorCode(again)]).toEqual([504, 'timeout']);
    expectNothingWritten(t);
  }, 20_000);

  it('reports a failure without server folders in the message', async () => {
    process.env.FAKE_CLIP_MODE = 'fail';
    const t = await clipEnv({ fake: true });
    await t.link('ひとつ', SINGLE);
    const res = await t.clip('ひとつ', 'start=0&end=1');
    expect([res.status, errorCode(res)]).toEqual([500, 'clip_failed']);
    const message = JSON.parse(bytes(res).toString('utf8')).error.message as string;
    expect(message).toContain('Invalid data');
    expect(message).not.toContain(t.root);
    expect(message).not.toContain(t.root.split('\\').join('/'));
    expectNothingWritten(t);
  });

  it('stops output that grows past the size cap', async () => {
    process.env.FAKE_CLIP_MODE = 'big';
    const t = await clipEnv({ fake: true });
    await t.link('ひとつ', SINGLE);
    const res = await t.clip('ひとつ', 'start=0&end=1');
    expect([res.status, errorCode(res)]).toEqual([500, 'clip_failed']);
    expectNothingWritten(t);
  }, 20_000);
});
