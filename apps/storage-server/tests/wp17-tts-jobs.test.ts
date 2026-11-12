/**
 * WP17: generated audiobooks on the GPU worker queue. Real ffmpeg/ffprobe (skipped when
 * not installed) make the chapter parts the PC would upload (FLAC tones) and put the book
 * together; the book's text comes from a stand-in script reader (the real one, with the
 * reader's import code in a child process, is checked at the end).
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { readBookScript, type BookScript } from '../src/audio/book-script';
import {
  buildSrt,
  srtTime,
  TtsJobService,
  versionFolderNames,
  seedFor,
} from '../src/audio/tts-jobs';
import { TtsModelService } from '../src/audio/tts-models';
import { DEFAULT_AUDIO_MERGE, DEFAULT_TTS } from '../src/config';
import { COUNTER_BUNDLE } from '../src/counts/counter-bundle';
import { VoiceService } from '../src/voices/voice-service';
import { VoiceStore } from '../src/voices/voice-store';
import { treeDiff, write } from './helpers/audio-fixtures';
import { makeZip } from './helpers/epub-fixture';
import { makeTempDir } from './helpers/spawn-server';
import { HITSUJI, jobEnv, SPY, type Track } from './helpers/worker-env';

function hasTool(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const HAS_FFMPEG = hasTool('ffmpeg') && hasTool('ffprobe');
if (!HAS_FFMPEG) console.warn('WP17 TTS tests SKIPPED: ffmpeg/ffprobe not found on PATH');

const track: Track = { envs: [], services: [] };
afterEach(async () => {
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

const TOOL_DIR = makeTempDir('wp17-tools');
/** A mono 48 kHz FLAC tone of `seconds` (what the PC uploads for a chapter). */
function flac(name: string, seconds: number): string {
  const file = path.join(TOOL_DIR, `${name}.flac`);
  if (!fs.existsSync(file)) {
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-ac',
        '1',
        '-ar',
        '48000',
        '-c:a',
        'flac',
        file,
      ],
      { windowsHide: true },
    );
  }
  return file;
}
function wav(name: string, seconds: number): Buffer {
  const file = path.join(TOOL_DIR, `${name}.wav`);
  if (!fs.existsSync(file)) {
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=330:duration=${seconds}`,
        '-ac',
        '2',
        '-ar',
        '44100',
        file,
      ],
      { windowsHide: true },
    );
  }
  return fs.readFileSync(file);
}
function probe(file: string) {
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:format_tags=title,artist,genre:chapter=start_time,end_time:chapter_tags=title:stream=codec_name,codec_type,channels',
      '-of',
      'json',
      file,
    ],
    { windowsHide: true },
  ).toString();
  return JSON.parse(out) as {
    format: { duration: string; tags?: Record<string, string> };
    chapters: { start_time: string; end_time: string; tags: { title: string } }[];
    streams: { codec_name: string; codec_type: string; channels?: number }[];
  };
}

const SCRIPT: BookScript = {
  version: 1,
  characters: 40,
  chapters: [
    {
      index: 0,
      title: '第一章',
      startCharacter: 0,
      characters: 20,
      sentences: [
        {
          text: '善なるものは畢竟、遠い。',
          reading: '善なるものはひっきょう、遠い。',
          position: 0,
          paragraphEnd: false,
        },
        {
          text: 'けれども悪は近い！',
          reading: 'けれども悪は近い！',
          position: 11,
          paragraphEnd: true,
        },
      ],
    },
    {
      index: 1,
      title: '第二章',
      startCharacter: 20,
      characters: 20,
      sentences: [{ text: '最後の文。', reading: '最後の文。', position: 20, paragraphEnd: true }],
    },
  ],
};

async function ttsEnv(opts: { script?: BookScript } = {}) {
  const t = await jobEnv(track, { leaseSeconds: 60 });
  let clock = Date.now();
  const cacheDir = makeTempDir('wp17-cache');
  const models = new TtsModelService(
    t.e.db,
    async () => 'f'.repeat(40),
    () => clock,
  );
  const voices = new VoiceService({
    db: t.e.db,
    store: new VoiceStore(t.e.config.dataRoot),
    config: { ...DEFAULT_TTS, voiceClipMinSeconds: 1 },
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
  });
  await voices.start();
  const scripts: string[] = [];
  const tts = new TtsJobService({
    db: t.e.db,
    jobs: t.jobs,
    scan: t.service,
    writer: (t.jobs as unknown as { writer: never }).writer,
    models,
    voices,
    config: DEFAULT_TTS,
    tools: { ...DEFAULT_AUDIO_MERGE, minFreeMb: 0 },
    cacheDir,
    calibreDir: t.e.config.calibre.dir,
    uploads: null,
    importOptions: {},
    readScript: async (file) => {
      scripts.push(file);
      return opts.script ?? SCRIPT;
    },
    now: () => clock,
    log: (m) => t.logs.push(m),
    logError: (m) => t.logs.push(`ERROR ${m}`),
  });
  await tts.start();
  t.audio.tts = tts;
  t.audio.models = models;
  t.audio.voices = voices;
  const app = t.app;
  const addVoice = async (name = 'Narrator') =>
    (
      await request(app)
        .post(`/api/v1/voices?name=${encodeURIComponent(name)}&consent=1`)
        .set(t.auth)
        .set('Content-Type', 'application/octet-stream')
        .send(wav('voice', 4))
    ).body.voice as { id: string };
  const startBook = (book: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/v1/books/${t.bookId(book)}/audiobook-job`)
      .set(t.auth)
      .send(body);
  const uploadChapter = (id: number, idx: number, file: string) =>
    request(app)
      .put(`/api/v1/worker/jobs/${id}/chapters/${idx}`)
      .set(t.worker)
      .set('Content-Type', 'audio/flac')
      .send(fs.readFileSync(file));
  const doneChapter = (id: number, idx: number, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/worker/jobs/${id}/chapters/${idx}/done`).set(t.worker).send(body);
  const latestBook = async (book: string) =>
    (
      await request(app)
        .get(`/api/v1/books/${t.bookId(book)}/audiobook-job`)
        .set(t.auth)
    ).body.job;
  return {
    ...t,
    // Every file of the audiobooks folder now (SHA-256, size, mtime), to prove what changes.
    before: t.tree(),
    tts,
    models,
    voices,
    scripts,
    cacheDir,
    addVoice,
    startBook,
    uploadChapter,
    doneChapter,
    latestBook,
    tickAll: (ms: number) => {
      clock += ms;
      t.tick(ms);
    },
  };
}

describe('pure helpers', () => {
  it('formats SRT times and builds one cue per sentence across chapters', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3_723_004)).toBe('01:02:03,004');
    const srt = buildSrt([
      {
        durationMs: 3000,
        cues: [
          [0, 1200],
          [1500, 2600],
        ],
        texts: ['一。', '二。'],
      },
      { durationMs: 2000, cues: [[0, 1500]], texts: ['三。'] },
    ]);
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:01,200\n一。\n\n2\n00:00:01,500 --> 00:00:02,600\n二。\n\n3\n00:00:03,000 --> 00:00:04,500\n三。\n',
    );
  });

  it('names versions <title>, then <title> (vN)', () => {
    expect(versionFolderNames('本: 題', 1, 3)).toEqual(['本_ 題', '本_ 題 (v2)', '本_ 題 (v3)']);
    expect(versionFolderNames('本', 2, 2)).toEqual(['本 (v2)', '本 (v3)']);
  });

  it('keeps the seed of a book and voice', () => {
    expect(seedFor('b1', 'v')).toBe(seedFor('b1', 'v'));
    expect(seedFor('b1', 'v')).not.toBe(seedFor('b2', 'v'));
  });
});

describe.skipIf(!HAS_FFMPEG)('voices and models', () => {
  it('needs the consent confirmation and a usable clip; keeps clips only in .uploads/voices', async () => {
    const t = await ttsEnv();
    const upload = (q: string, body: Buffer) =>
      request(t.app)
        .post(`/api/v1/voices?${q}`)
        .set(t.auth)
        .set('Content-Type', 'application/octet-stream')
        .send(body);
    expect((await upload('name=Me', wav('voice', 4))).body.error.code).toBe('consent_required');
    expect((await upload('consent=1', wav('voice', 4))).body.error.code).toBe('invalid_name');
    expect((await upload('name=Me&consent=1', Buffer.from('not audio'))).body.error.code).toBe(
      'not_audio',
    );
    expect((await upload('name=Short&consent=1', wav('tiny', 0.3))).body.error.code).toBe(
      'bad_length',
    );
    const ok = await upload('name=Me&consent=1', wav('voice', 4));
    expect(ok.status).toBe(201);
    expect(ok.body.voice).toMatchObject({ name: 'Me', kind: 'clip' });
    expect(ok.body.voice.clipSeconds).toBeCloseTo(4, 0);
    expect((await upload('name=me&consent=1', wav('voice', 4))).body.error.code).toBe('name_taken');
    const stored = path.join(
      t.e.config.dataRoot,
      '.uploads',
      'voices',
      ok.body.voice.id,
      'clip.wav',
    );
    const p = probe(stored);
    expect(p.streams[0]).toMatchObject({ codec_name: 'pcm_s16le', channels: 1 });
    // Nothing left in the voice folder but the clip; nothing in the audiobooks folder.
    expect(fs.readdirSync(path.join(t.e.config.dataRoot, '.uploads', 'voices'))).toEqual([
      ok.body.voice.id,
    ]);
    expect(treeDiff(t.before, t.tree())).toEqual({ added: [], removed: [], changed: [] });
    const clip = await request(t.app)
      .get(`/api/v1/voices/${ok.body.voice.id}/clip`)
      .set(t.auth)
      .buffer(true);
    expect(clip.status).toBe(200);
    expect(clip.headers['content-type']).toBe('audio/wav');
    expect(
      (await request(t.app).delete(`/api/v1/voices/${ok.body.voice.id}`).set(t.auth)).status,
    ).toBe(204);
    expect(fs.existsSync(stored)).toBe(false);
    expect((await request(t.app).get('/api/v1/voices').set(t.auth)).body.voices).toEqual([]);
  });

  it('lists the starting models, adds one pinned to its revision, removes one', async () => {
    const t = await ttsEnv();
    const list = async () =>
      (await request(t.app).get('/api/v1/tts/models').set(t.auth)).body.models;
    const start = await list();
    expect(start.map((m: { source: string }) => m.source)).toEqual([
      'Aratako/Irodori-TTS-v4.1-Small',
      'Aratako/Irodori-TTS-v4.1-Small-MF',
      'Aratako/Irodori-TTS-500M-v3',
      'Aratako/Irodori-TTS-v4-Large-Quantized/float8-weight-only',
    ]);
    expect(start[0].isDefault).toBe(true);
    expect(
      (await request(t.app).post('/api/v1/tts/models').set(t.auth).send({ source: '../x' })).body
        .error.code,
    ).toBe('invalid_model');
    expect(
      (
        await request(t.app)
          .post('/api/v1/tts/models')
          .set(t.auth)
          .send({ source: start[0].source })
      ).body.error.code,
    ).toBe('exists');
    const added = await request(t.app)
      .post('/api/v1/tts/models')
      .set(t.auth)
      .send({ source: 'https://huggingface.co/Someone/New-TTS/' });
    expect(added.status).toBe(201);
    expect(added.body.model).toMatchObject({ source: 'Someone/New-TTS', revision: 'f'.repeat(40) });
    expect(
      (await request(t.app).delete(`/api/v1/tts/models/${start[2].id}`).set(t.auth)).status,
    ).toBe(204);
    expect((await list()).map((m: { id: number }) => m.id)).not.toContain(start[2].id);
    const worker = (await request(t.app).get('/api/v1/worker/models').set(t.worker)).body;
    expect(worker.removed).toEqual([
      {
        source: 'Aratako/Irodori-TTS-500M-v3',
        revision: '236c1e56591279fc24e3c1bf6609fc06e48dde28',
        dir: 'Aratako--Irodori-TTS-500M-v3/236c1e56591279fc24e3c1bf6609fc06e48dde28',
      },
    ]);
    // A user token can't use the worker's routes, nor a worker token the user's.
    expect((await request(t.app).get('/api/v1/worker/models').set(t.auth)).status).toBe(403);
    expect((await request(t.app).get('/api/v1/tts/models').set(t.worker)).status).toBe(403);
  });
});

describe.skipIf(!HAS_FFMPEG)('making an audiobook', () => {
  it('reads chapter by chapter, survives the PC going away, puts the book together and links it', async () => {
    const t = await ttsEnv();
    const voice = await t.addVoice();
    const res = await t.startBook(HITSUJI, { voiceId: voice.id, pauses: { sentenceMs: 300 } });
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({
      kind: 'generate_audiobook',
      state: 'queued',
      version: 1,
      chaptersTotal: 2,
      chaptersDone: 0,
    });
    expect(res.body.job.params).toMatchObject({
      mapVersion: 1,
      narrator: { voiceId: voice.id, name: 'Narrator', kind: 'clip' },
      model: {
        source: 'Aratako/Irodori-TTS-v4.1-Small',
        revision: '2b28324dc263ed5e6638b3cf3dd94c82ead07b4b',
      },
      pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 2000 },
    });
    expect((await t.startBook(HITSUJI, { voiceId: voice.id })).body.error.code).toBe('busy');
    const id = res.body.job.id as number;

    await t.heartbeat();
    const claimed = await t.claim();
    expect(claimed).toMatchObject({ id, kind: 'generate_audiobook' });
    expect(claimed.tts).toMatchObject({
      model: { source: 'Aratako/Irodori-TTS-v4.1-Small' },
      voice: { seconds: expect.any(Number) },
      caption: null,
      whole: false,
      chaptersTotal: 2,
      chaptersDone: 0,
    });
    const script = (await request(t.app).get(`/api/v1/worker/jobs/${id}/script`).set(t.worker))
      .body;
    expect(script.chapters.map((c: { index: number }) => c.index)).toEqual([0, 1]);
    expect(script.chapters[0].sentences[0]).toEqual({
      text: '善なるものは畢竟、遠い。',
      reading: '善なるものはひっきょう、遠い。',
      paragraphEnd: false,
    });
    const clip = await request(t.app)
      .get(`/api/v1/worker/jobs/${id}/voice`)
      .set(t.worker)
      .buffer(true);
    expect(clip.status).toBe(200);
    // The worker's routes only: a user token is refused.
    expect((await request(t.app).get(`/api/v1/worker/jobs/${id}/script`).set(t.auth)).status).toBe(
      403,
    );

    // Chapter 1 (index 0): wrong timings are refused, then the right ones.
    expect((await t.uploadChapter(id, 0, flac('ch0', 3))).status).toBe(200);
    expect(
      (await t.doneChapter(id, 0, { durationMs: 3000, cues: [[0, 1200]] })).body.error.code,
    ).toBe('bad_cues');
    expect(
      (
        await t.doneChapter(id, 0, {
          durationMs: 9000,
          cues: [
            [0, 1200],
            [1500, 2600],
          ],
        })
      ).body.error.code,
    ).toBe('bad_audio');
    expect((await t.uploadChapter(id, 0, flac('ch0', 3))).status).toBe(200);
    const done0 = await t.doneChapter(id, 0, {
      durationMs: 3000,
      cues: [
        [0, 1200],
        [1500, 2600],
      ],
      spoken: ['a', 'b'],
    });
    expect(done0.body).toEqual({ state: 'running', chaptersDone: 1 });

    // The PC goes away: the lease runs out, the job goes back to the queue without losing
    // an attempt, and the next claim reads only the chapter still to do.
    t.tickAll(61_000);
    expect((await t.latestBook(HITSUJI)).state).toBe('queued');
    expect((await t.latestBook(HITSUJI)).attempts).toBe(0);
    const again = await t.claim();
    expect(again.tts).toMatchObject({ chaptersDone: 1 });
    const rest = (await request(t.app).get(`/api/v1/worker/jobs/${id}/script`).set(t.worker)).body;
    expect(rest.chapters.map((c: { index: number }) => c.index)).toEqual([1]);

    await t.uploadChapter(id, 1, flac('ch1', 2));
    const done1 = await t.doneChapter(id, 1, { durationMs: 2000, cues: [[0, 1500]] });
    expect(done1.body.chaptersDone).toBe(2);
    await t.tts.idle();

    const job = await t.latestBook(HITSUJI);
    expect(job).toMatchObject({ state: 'done', linked: true, version: 1, progress: 1 });
    const folder = 'japanese-generated/Unknown/羊と鋼の森';
    expect(job.outputRelPath).toBe(`${folder}/羊と鋼の森.m4b`);
    // Only the two new files were added to the audiobooks folder.
    expect(treeDiff(t.before, t.tree())).toEqual({
      added: [`${folder}/羊と鋼の森.m4b`, `${folder}/羊と鋼の森.srt`],
      removed: [],
      changed: [],
    });
    const m4b = probe(path.join(t.root, ...folder.split('/'), '羊と鋼の森.m4b'));
    expect(Number(m4b.format.duration)).toBeCloseTo(5, 0);
    expect(m4b.chapters.map((c) => c.tags.title)).toEqual(['第一章', '第二章']);
    expect(Number(m4b.chapters[1].start_time)).toBeCloseTo(3, 1);
    expect(m4b.format.tags).toMatchObject({
      title: HITSUJI,
      artist: 'Unknown',
      genre: 'Audiobook',
    });
    expect(m4b.streams.some((s) => s.codec_type === 'video')).toBe(true); // the cover
    const srt = fs.readFileSync(path.join(t.root, ...folder.split('/'), '羊と鋼の森.srt'), 'utf8');
    expect(srt).toContain('3\n00:00:03,000 --> 00:00:04,500\n最後の文。');
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,200\n善なるものは畢竟、遠い。');

    // Linked to the m4b and the srt, both indexed as generated.
    const link = await t.link(HITSUJI);
    expect(link).toMatchObject({
      state: 'linked',
      folderRelPath: folder,
      fileName: '羊と鋼の森.m4b',
      subtitleState: 'linked',
    });
    expect(link.subtitleRelPath).toBe(`${folder}/羊と鋼の森.srt`);
    const folders = (await request(t.app).get('/api/v1/audio/search?q=generated').set(t.auth)).body
      .audio;
    expect(folders).toEqual([
      expect.objectContaining({ relPath: folder, generated: true, playable: true }),
    ]);
    const subs = (
      await request(t.app).get('/api/v1/audio/search?q=羊と鋼&kind=subtitle').set(t.auth)
    ).body.subtitles;
    expect(subs).toEqual([expect.objectContaining({ generated: true, name: '羊と鋼の森.srt' })]);

    // A full rescan keeps them (generated rows are seen) and the work folder is emptied.
    await t.service.scanLibrary(t.service.libraries()[0]);
    expect((await t.link(HITSUJI)).missing ?? false).toBe(false);
    expect(fs.existsSync(path.join(t.cacheDir, 'tts', String(id)))).toBe(false);

    // A second audiobook is a new version in a new folder; nothing else changes.
    const second = await t.startBook(HITSUJI, { voiceId: voice.id });
    expect(second.body.job.version).toBe(2);
    const id2 = second.body.job.id as number;
    await t.claim();
    await t.uploadChapter(id2, 0, flac('ch0', 3));
    await t.doneChapter(id2, 0, {
      durationMs: 3000,
      cues: [
        [0, 1200],
        [1500, 2600],
      ],
    });
    await t.uploadChapter(id2, 1, flac('ch1', 2));
    await t.doneChapter(id2, 1, { durationMs: 2000, cues: [[0, 1500]] });
    await t.tts.idle();
    expect((await t.latestBook(HITSUJI)).outputRelPath).toBe(
      'japanese-generated/Unknown/羊と鋼の森 (v2)/羊と鋼の森.m4b',
    );
    expect(treeDiff(t.before, t.tree()).changed).toEqual([]);
  });

  it("doesn't link when the book's link changed meanwhile", async () => {
    const t = await ttsEnv();
    const voice = await t.addVoice();
    const id = (await t.startBook(HITSUJI, { voiceId: voice.id })).body.job.id as number;
    await t.claim();
    await t.linkAudio(HITSUJI, 'japanese/_Unknown/羊と鋼の森 (文春文庫)');
    await t.uploadChapter(id, 0, flac('ch0', 3));
    await t.doneChapter(id, 0, {
      durationMs: 3000,
      cues: [
        [0, 1200],
        [1500, 2600],
      ],
    });
    await t.uploadChapter(id, 1, flac('ch1', 2));
    await t.doneChapter(id, 1, { durationMs: 2000, cues: [[0, 1500]] });
    await t.tts.idle();
    expect(await t.latestBook(HITSUJI)).toMatchObject({ state: 'done', linked: false });
    expect((await t.link(HITSUJI)).folderRelPath).toBe('japanese/_Unknown/羊と鋼の森 (文春文庫)');
  });

  it('pauses between chapters and stops on request, keeping nothing of a stopped job', async () => {
    const t = await ttsEnv();
    const voice = await t.addVoice();
    const id = (await t.startBook(SPY, { voiceId: voice.id })).body.job.id as number;
    await t.claim();
    await t.uploadChapter(id, 0, flac('ch0', 3));
    await t.doneChapter(id, 0, {
      durationMs: 3000,
      cues: [
        [0, 1200],
        [1500, 2600],
      ],
    });
    t.jobs.setPaused(true);
    expect((await t.progress(id, { stage: 'generating', progress: 0.5 })).body).toEqual({
      cancel: false,
      pause: true,
    });
    expect(
      (await request(t.app).post(`/api/v1/worker/jobs/${id}/release`).set(t.worker).send({})).body
        .state,
    ).toBe('queued');
    const paused = await t.latestBook(SPY);
    expect(paused).toMatchObject({ state: 'queued', chaptersDone: 1, attempts: 0 });
    expect(await t.claim()).toBeNull();
    t.jobs.setPaused(false);
    await t.claim();
    await request(t.app).post(`/api/v1/audio/subtitle-jobs/${id}/cancel`).set(t.auth).send({});
    expect((await t.progress(id, { stage: 'generating' })).body.cancel).toBe(true);
    await request(t.app).post(`/api/v1/worker/jobs/${id}/fail`).set(t.worker).send({});
    expect((await t.latestBook(SPY)).state).toBe('cancelled');
    await t.tts.sweep();
    expect(fs.existsSync(path.join(t.cacheDir, 'tts', String(id)))).toBe(false);
    expect(treeDiff(t.before, t.tree())).toEqual({ added: [], removed: [], changed: [] });
  });

  it('refuses what it cannot do', async () => {
    const t = await ttsEnv();
    expect((await t.startBook(HITSUJI, {})).body.error.code).toBe('no_voice');
    const voice = await t.addVoice();
    expect((await t.startBook(HITSUJI, { voiceId: voice.id, modelId: 999 })).body.error.code).toBe(
      'no_model',
    );
    // A deleted voice fails the job when the PC asks for it.
    const id = (await t.startBook(HITSUJI, { voiceId: voice.id })).body.job.id as number;
    await request(t.app).delete(`/api/v1/voices/${voice.id}`).set(t.auth);
    expect(await t.claim()).toBeNull();
    expect(await t.latestBook(HITSUJI)).toMatchObject({
      id,
      state: 'failed',
      error: 'The voice preset of this job was deleted',
    });
  });
});

describe.skipIf(!HAS_FFMPEG)('previews and described voices', () => {
  it('makes a preview of a chapter and serves its audio', async () => {
    const t = await ttsEnv();
    const voice = await t.addVoice();
    const res = await request(t.app)
      .post(`/api/v1/books/${t.bookId(HITSUJI)}/audiobook-preview`)
      .set(t.auth)
      .send({ voiceId: voice.id, chapterIndex: 1 });
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ kind: 'preview_audiobook', chaptersTotal: 1 });
    expect(res.body.job.params).toMatchObject({ chapterIndex: 1, chapterTitle: '第二章' });
    const id = res.body.job.id as number;
    // Same seed as the full book with this voice (the preview sounds like the book).
    const book = await t.startBook(HITSUJI, { voiceId: voice.id });
    expect(book.body.job.params.seed).toBe(res.body.job.params.seed);
    const claimed = await t.claim();
    expect(claimed.id).toBe(id); // the older one first: the preview
    const script = (await request(t.app).get(`/api/v1/worker/jobs/${id}/script`).set(t.worker))
      .body;
    expect(script.chapters).toEqual([
      {
        index: 0,
        title: '第二章',
        sentences: [{ text: '最後の文。', reading: '最後の文。', paragraphEnd: true }],
      },
    ]);
    await t.uploadChapter(id, 0, flac('ch1', 2));
    expect((await t.doneChapter(id, 0, { durationMs: 2000, cues: [[0, 1500]] })).body.state).toBe(
      'done',
    );
    const audio = await request(t.app)
      .get(`/api/v1/audio/tts-jobs/${id}/audio`)
      .set(t.auth)
      .buffer(true);
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/flac');
    const latest = (
      await request(t.app)
        .get(`/api/v1/books/${t.bookId(HITSUJI)}/audiobook-preview`)
        .set(t.auth)
    ).body.job;
    expect(latest).toMatchObject({ id, state: 'done' });
    expect(treeDiff(t.before, t.tree())).toEqual({ added: [], removed: [], changed: [] });
  });

  it('makes a described voice in one call and keeps it as a preset', async () => {
    const t = await ttsEnv();
    expect(
      (await request(t.app).post('/api/v1/voices/samples').set(t.auth).send({ name: 'Calm' })).body
        .error.code,
    ).toBe('invalid_description');
    const res = await request(t.app)
      .post('/api/v1/voices/samples')
      .set(t.auth)
      .send({ name: 'Calm', description: '落ち着いた女性の声' });
    expect(res.status).toBe(202);
    const id = res.body.job.id as number;
    const claimed = await t.claim();
    expect(claimed.tts).toMatchObject({
      kind: 'voice_sample',
      voice: null,
      caption: '落ち着いた女性の声',
      whole: true,
    });
    await t.uploadChapter(id, 0, flac('ch0', 3));
    expect((await t.doneChapter(id, 0, { durationMs: 3000, cues: [[0, 2800]] })).body.state).toBe(
      'done',
    );
    expect(
      (await request(t.app).get('/api/v1/voices/samples/latest').set(t.auth)).body.job,
    ).toMatchObject({ id, state: 'done' });
    const kept = await request(t.app)
      .post(`/api/v1/voices/samples/${id}/keep`)
      .set(t.auth)
      .send({});
    expect(kept.status).toBe(201);
    expect(kept.body.voice).toMatchObject({
      name: 'Calm',
      kind: 'design',
      description: '落ち着いた女性の声',
    });
    expect(
      (await request(t.app).post(`/api/v1/voices/samples/${id}/keep`).set(t.auth).send({})).body
        .error.code,
    ).toBe('name_taken');
  });
});

describe('the real book script (the reader import in a child process)', () => {
  it('reads chapters, sentences and furigana from an EPUB', async () => {
    const dir = makeTempDir('wp17-epub');
    const xhtml = (body: string) =>
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
    const epub = makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      {
        name: 'META-INF/container.xml',
        data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'OEBPS/content.opf',
        data: `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>試験</dc:title><dc:identifier id="id">x</dc:identifier></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
      },
      {
        name: 'OEBPS/nav.xhtml',
        data: xhtml(
          '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="c1.xhtml">一章</a></li><li><a href="c2.xhtml">二章</a></li></ol></nav>',
        ),
      },
      {
        name: 'OEBPS/c1.xhtml',
        data: xhtml('<p><ruby>畢竟<rt>ひっきょう</rt></ruby>、遠い。近い！</p>'),
      },
      { name: 'OEBPS/c2.xhtml', data: xhtml('<p>最後。</p>') },
    ]);
    const file = write(dir, 'book.epub', epub);
    expect(fs.existsSync(COUNTER_BUNDLE)).toBe(true);
    const script = await readBookScript(file, {
      importOptions: { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true },
      maxSentence: 120,
      timeoutMs: 120_000,
    });
    expect(script.chapters.map((c) => c.title)).toEqual(['一章', '二章']);
    expect(script.chapters[0].sentences).toEqual([
      { text: '畢竟、遠い。', reading: 'ひっきょう、遠い。', position: 0, paragraphEnd: false },
      // 畢竟遠い = 4 counted characters (、。 are not counted, as in the reader).
      { text: '近い！', reading: '近い！', position: 4, paragraphEnd: true },
    ]);
    expect(script.characters).toBe(8);
  }, 120_000);
});
