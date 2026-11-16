/**
 * WP17: the GPU worker (apps/gpu-worker) running TTS jobs against a real storage server on
 * a local port, with a fake `docker` (tests/fixtures/wp17/fake-tts-docker.cjs) in place of
 * Docker Desktop and the TTS program; the fake makes real FLAC chapters with ffmpeg.
 * Checks the exact `docker run` call and job.json, chapter uploads, resuming, pause between
 * chapters, Stop (docker kill), failures, a missing TTS program, and removed models.
 */
import fs from 'fs';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerApi } from '../../gpu-worker/src/api';
import {
  DEFAULTS,
  parseSettings,
  TTS_IMAGE,
  type WorkerSettings,
} from '../../gpu-worker/src/config';
import { memoryLogger } from '../../gpu-worker/src/log';
import { overallProgress, parseTtsLine, ttsArgs } from '../../gpu-worker/src/tts';
import { engineArgs } from '../../gpu-worker/src/engine';
import { Worker } from '../../gpu-worker/src/worker';
import type { BookScript } from '../src/audio/book-script';
import { HAS_FFMPEG, SCRIPT, ttsEnv } from './helpers/tts-env';
import { makeTempDir } from './helpers/spawn-server';
import { HITSUJI, SPY, type Track } from './helpers/worker-env';

const FAKE_DOCKER = path.join(__dirname, 'fixtures', 'wp17', 'fake-tts-docker.cjs');

const track: Track = { envs: [], services: [] };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.FAKE_TTS_MODE;
  delete process.env.FAKE_DOCKER_STATE;
  while (closers.length) await closers.pop()!();
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

describe('worker pieces', () => {
  it('builds the docker call, reads the program lines and the whole-job progress', () => {
    expect(
      ttsArgs({
        jobId: 7,
        jobDir: 'C:\\ttsu-worker\\work\\job-7',
        modelsDir: 'C:\\M\\tts',
        image: 'ttsu-irodori:1',
      }),
    ).toEqual([
      'run',
      '--rm',
      '--gpus',
      'all',
      '--name',
      'ttsu-tts-7',
      '-v',
      'C:\\ttsu-worker\\work\\job-7:/work',
      '-v',
      'C:\\M\\tts:/models',
      '-e',
      'HF_HOME=/models/.shared',
      '-e',
      'HF_HUB_DISABLE_SYMLINKS=1',
      'ttsu-irodori:1',
      'run',
      '--job',
      '/work/job.json',
    ]);
    expect(parseTtsLine('TTSU chapter-done {"index":3}')).toEqual({
      kind: 'chapter-done',
      rest: '{"index":3}',
      json: { index: 3 },
    });
    expect(parseTtsLine('TTSU stage loading')).toMatchObject({ kind: 'stage', rest: 'loading' });
    expect(parseTtsLine('Loading weights...')).toBeNull();
    expect(overallProgress(1, 4, { done: 5, total: 10 })).toBeCloseTo(0.375);
    expect(overallProgress(4, 4, null)).toBe(0.99);
    const s = parseSettings({ serverUrl: 'http://nas:3081', token: `ttsu_${'a'.repeat(30)}` });
    expect(s).toMatchObject({
      ttsImage: TTS_IMAGE,
      ttsModelsDir: 'C:\\Data\\LLM\\Models\\ttsu-reader-tts',
      ttsBatchSize: 8,
      ttsPrecision: 'bf16',
    });
    expect(() =>
      parseSettings({
        serverUrl: 'http://nas',
        token: `ttsu_${'a'.repeat(30)}`,
        ttsPrecision: 'fp8',
      }),
    ).toThrow(/ttsPrecision/);
  });
});

async function workerEnv(
  mode: string,
  settings: Partial<WorkerSettings> = {},
  script?: BookScript,
) {
  const t = await ttsEnv(track, script ? { script } : {});
  const server = t.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const state = makeTempDir('wp17-docker');
  fs.writeFileSync(path.join(state, 'mode'), mode);
  process.env.FAKE_DOCKER_STATE = state;
  const workDir = path.join(makeTempDir('wp17-work'), 'work');
  const modelsDir = path.join(makeTempDir('wp17-models'), 'ttsu reader tts');
  const s: WorkerSettings = {
    ...DEFAULTS,
    serverUrl: `http://127.0.0.1:${port}`,
    token: t.worker.Authorization.slice('Bearer '.length),
    workDir,
    logDir: path.join(workDir, '..', 'logs'),
    dockerPath: process.execPath,
    dockerPrefixArgs: [FAKE_DOCKER],
    reportSeconds: 0.05,
    ttsModelsDir: modelsDir,
    // Season 2 Phase 12 session 3: the idle check-in waits on the server; short in tests.
    idleWaitSeconds: 0.2,
    ...settings,
  };
  const api = new ServerApi(s);
  const log = memoryLogger();
  const worker = new Worker({ settings: s, api, log, freeBytes: async () => null });
  const calls = () =>
    fs.existsSync(path.join(state, 'calls.jsonl'))
      ? fs
          .readFileSync(path.join(state, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
      : [];
  const jobJson = (n: number) =>
    JSON.parse(fs.readFileSync(path.join(state, `job-${n}.json`), 'utf8'));
  const setMode = (m: string) => fs.writeFileSync(path.join(state, 'mode'), m);
  // Season 2 Phase 12 session 3: what the voice kept loaded was asked (serve mode).
  const served = () =>
    fs.existsSync(path.join(state, 'serve.jsonl'))
      ? fs
          .readFileSync(path.join(state, 'serve.jsonl'), 'utf8')
          .trim()
          .split(/\r?\n/)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  closers.push(async () => worker.engine.kill());
  return { ...t, s, worker, log, calls, state, jobJson, setMode, modelsDir, served };
}

async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 20_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!HAS_FFMPEG)('the worker running TTS jobs', () => {
  it('makes a whole audiobook: the exact docker call, job.json, uploads, link, clean-up', async () => {
    const t = await workerEnv('ok');
    const voice = await t.addVoice();
    const id = (await t.startBook(HITSUJI, { voiceId: voice.id })).body.job.id as number;
    expect(await t.worker.tick()).toBe(0);
    await t.tts.idle();
    const job = await t.latestBook(HITSUJI);
    expect(job, JSON.stringify(t.log.lines)).toMatchObject({
      id,
      state: 'done',
      linked: true,
      chaptersDone: 2,
    });
    expect((await t.link(HITSUJI)).folderRelPath).toBe('japanese-generated/Unknown/羊と鋼の森');

    const run = t.calls().find((c) => c[0] === 'run')!;
    const jobDir = path.join(t.s.workDir, `job-${id}`);
    expect(run).toEqual(ttsArgs({ jobId: id, jobDir, modelsDir: t.modelsDir, image: TTS_IMAGE }));
    expect(t.jobJson(1)).toMatchObject({
      model: {
        source: 'Aratako/Irodori-TTS-v4.1-Small',
        revision: '2b28324dc263ed5e6638b3cf3dd94c82ead07b4b',
      },
      modelsDir: '/models',
      precision: 'bf16',
      voice: '/work/voice.wav',
      caption: null,
      whole: false,
      batch: 8,
      out: '/work/out',
      pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 2000 },
    });
    expect(t.jobJson(1).chapters.map((c: { index: number }) => c.index)).toEqual([0, 1]);
    // The job folder is gone; the models folder was made (shared by every account).
    expect(fs.existsSync(jobDir)).toBe(false);
    expect(fs.existsSync(t.modelsDir)).toBe(true);
    // What the PC found out about the model was recorded.
    const models = (await request(t.app).get('/api/v1/tts/models').set(t.auth)).body.models;
    expect(models[0]).toMatchObject({ supportsDescription: true, supportsClip: true });
  }, 60_000);

  it('reads the waiting sentence clips for Anki with the voice kept loaded (1.2.0)', async () => {
    const t = await workerEnv('ok');
    const voice = await t.addVoice();
    await request(t.app)
      .put('/api/v1/tts/voice-choice')
      .set(t.auth)
      .send({ voiceId: voice.id, modelId: 1 });
    const queue = async (text: string, position: number) =>
      (
        await request(t.app)
          .post(`/api/v1/books/${t.bookId(HITSUJI)}/sentence-audio`)
          .set(t.auth)
          .send({ text, position })
      ).body.clip.id as string;
    const a = await queue('善なるものは畢竟、遠い。', 0);
    const b = await queue('けれども悪は近い！', 11);
    expect(await t.worker.tick()).toBe(0);
    // No container of its own: the voice process loaded the model once and read both.
    expect(t.calls().filter((c) => c[0] === 'run')).toEqual([
      engineArgs({
        liveDir: path.join(t.s.workDir, 'live'),
        modelsDir: t.modelsDir,
        image: TTS_IMAGE,
      }),
    ]);
    const served = t.served();
    expect(served.map((r) => r.op)).toEqual(['load', 'read', 'read']);
    expect(served[0]).toMatchObject({
      model: { source: 'Aratako/Irodori-TTS-v4.1-Small' },
      precision: 'bf16',
      modelsDir: '/models',
    });
    expect(served[1]).toMatchObject({
      voice: expect.stringMatching(/^\/work\/voices\/[0-9a-f]{64}\.wav$/),
      caption: null,
      whole: false,
      lastGapMs: 0,
      pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 0 },
    });
    expect(served.slice(1).map((r) => (r.sentences as { reading: string }[])[0].reading)).toEqual([
      '善なるものはひっきょう、遠い。',
      'けれども悪は近い！',
    ]);
    for (const [id, ms] of [
      [a, 1200],
      [b, 900],
    ] as const) {
      const st = (await request(t.app).get(`/api/v1/sentence-audio/${id}`).set(t.auth)).body;
      expect(st.clip, JSON.stringify(t.log.lines)).toMatchObject({
        state: 'done',
        durationMs: ms,
      });
      expect(st.pc.readsClips).toBe(true);
      const audio = await request(t.app).get(`/api/v1/sentence-audio/${id}/audio`).set(t.auth);
      expect(audio.status).toBe(200);
      expect(audio.headers['content-type']).toBe('audio/mpeg');
    }
  }, 60_000);

  it('a running audiobook makes way for a sentence clip after its chapter', async () => {
    const t = await workerEnv('slow');
    // The voice is let go right after the clip (else the audiobook waits for the keep time).
    t.jobs.setKeepLoaded(0);
    const voice = await t.addVoice();
    await request(t.app)
      .put('/api/v1/tts/voice-choice')
      .set(t.auth)
      .send({ voiceId: voice.id, modelId: 1 });
    const book = (await t.startBook(HITSUJI, { voiceId: voice.id })).body.job.id as number;
    const running = t.worker.tick();
    await waitFor(
      () => t.latestBook(HITSUJI),
      (j) => j.stage === 'generating',
    );
    const clip = (
      await request(t.app)
        .post(`/api/v1/books/${t.bookId(HITSUJI)}/sentence-audio`)
        .set(t.auth)
        .send({ text: '最後の文。', position: 20 })
    ).body.clip.id as string;
    await running;
    expect(t.jobs.get(book)).toMatchObject({
      state: 'queued',
      chaptersDone: 1,
      message: 'Paused for sentence audio for Anki; it continues next.',
    });
    t.setMode('ok');
    await t.worker.tick(); // the clip
    expect(
      (await request(t.app).get(`/api/v1/sentence-audio/${clip}`).set(t.auth)).body.clip.state,
    ).toBe('done');
    await t.worker.tick(); // the voice is let go, then the rest of the audiobook
    await t.tts.idle();
    expect(await t.latestBook(HITSUJI)).toMatchObject({ state: 'done', linked: true });
    expect(t.served().map((r) => r.op)).toEqual(['load', 'read', 'quit']);
    expect(t.jobJson(2).chapters.map((c: { index: number }) => c.index)).toEqual([1]);
  }, 60_000);

  it('pauses after the current chapter and continues with the next one', async () => {
    const t = await workerEnv('slow');
    const voice = await t.addVoice();
    const id = (await t.startBook(HITSUJI, { voiceId: voice.id })).body.job.id as number;
    const running = t.worker.tick();
    await waitFor(
      () => t.latestBook(HITSUJI),
      (j) => j.stage === 'generating',
    );
    t.jobs.setPaused(true);
    await running;
    expect(await t.latestBook(HITSUJI)).toMatchObject({
      state: 'queued',
      chaptersDone: 1,
      attempts: 0,
    });
    expect(t.calls()).toContainEqual(['kill', `ttsu-tts-${id}`]);
    await t.worker.tick(); // paused: nothing taken
    expect(await t.latestBook(HITSUJI)).toMatchObject({ state: 'queued' });
    t.jobs.setPaused(false);
    t.setMode('ok');
    await t.worker.tick();
    await t.tts.idle();
    expect(await t.latestBook(HITSUJI)).toMatchObject({ state: 'done', linked: true });
    // The second run read only the chapter still to do.
    expect(t.jobJson(2).chapters.map((c: { index: number }) => c.index)).toEqual([1]);
  }, 60_000);

  it('stops with docker kill when the job is stopped in the reader; nothing is saved', async () => {
    const t = await workerEnv('hang');
    const voice = await t.addVoice();
    const id = (await t.startBook(HITSUJI, { voiceId: voice.id })).body.job.id as number;
    const running = t.worker.tick();
    await waitFor(
      () => t.latestBook(HITSUJI),
      (j) => j.chaptersDone === 1,
    );
    await request(t.app).post(`/api/v1/audio/subtitle-jobs/${id}/cancel`).set(t.auth);
    await running;
    expect(await t.latestBook(HITSUJI)).toMatchObject({ state: 'cancelled' });
    expect(t.calls()).toContainEqual(['kill', `ttsu-tts-${id}`]);
    expect(fs.existsSync(path.join(t.s.workDir, `job-${id}`))).toBe(false);
    expect(fs.existsSync(path.join(t.root, 'japanese-generated'))).toBe(false);
  }, 60_000);

  it("reports the program's failure with its last lines", async () => {
    const t = await workerEnv('fail');
    const voice = await t.addVoice();
    await t.startBook(HITSUJI, { voiceId: voice.id });
    await t.worker.tick();
    const job = await t.latestBook(HITSUJI);
    expect(job.state).toBe('failed');
    expect(job.error).toBe(
      'The TTS program failed (exit code 1): RuntimeError: CUDA out of memory',
    );
    expect(job.logTail).toContain('Traceback');
  }, 60_000);

  it('leaves TTS jobs waiting while the TTS program is missing, and says so', async () => {
    const t = await workerEnv('no-tts-image');
    const voice = await t.addVoice();
    await t.startBook(HITSUJI, { voiceId: voice.id });
    expect(await t.worker.tick()).toBeGreaterThan(0);
    expect(await t.latestBook(HITSUJI)).toMatchObject({ state: 'queued' });
    const status = (await request(t.app).get('/api/v1/gpu-worker').set(t.auth)).body;
    expect(status.problem).toBe('The TTS program is not on the PC (node main.js build-tts)');
    expect(status.ttsImage).toBe(TTS_IMAGE);
  }, 60_000);

  it('deletes the files of models removed from the list, and nothing else', async () => {
    const t = await workerEnv('ok');
    const keep = path.join(
      t.modelsDir,
      'Aratako--Irodori-TTS-v4.1-Small',
      '2b28324dc263ed5e6638b3cf3dd94c82ead07b4b',
    );
    const gone = path.join(
      t.modelsDir,
      'Aratako--Irodori-TTS-500M-v3',
      '236c1e56591279fc24e3c1bf6609fc06e48dde28',
    );
    for (const d of [keep, gone]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'model.safetensors'), 'x');
    }
    const models = (await request(t.app).get('/api/v1/tts/models').set(t.auth)).body.models;
    const old = models.find((m: { source: string }) => m.source === 'Aratako/Irodori-TTS-500M-v3');
    await request(t.app).delete(`/api/v1/tts/models/${old.id}`).set(t.auth);
    await t.worker.tick();
    expect(fs.existsSync(gone)).toBe(false);
    expect(fs.existsSync(path.dirname(gone))).toBe(false);
    expect(fs.existsSync(path.join(keep, 'model.safetensors'))).toBe(true);
  }, 60_000);
});

describe.skipIf(!HAS_FFMPEG)('the worker with two voices (Season 2 Phase 12 session 4)', () => {
  /** The test book with a mixed sentence and a quote (script v3 parts). */
  const DIALOGUE: BookScript = {
    ...SCRIPT,
    chapters: [
      {
        ...SCRIPT.chapters[0],
        sentences: [
          SCRIPT.chapters[0].sentences[0],
          {
            text: '「行こう」と彼は言った。',
            reading: '「行こう」と彼は言った。',
            ruby: [],
            position: 11,
            paragraphEnd: false,
            parts: [{ start: 0, end: 5, role: 'dialogue', quote: 0 }],
          },
          {
            text: '「近い！」',
            reading: '「近い！」',
            ruby: [],
            position: 23,
            paragraphEnd: true,
            parts: [{ start: 0, end: 5, role: 'dialogue', quote: 1 }],
          },
        ],
      },
      SCRIPT.chapters[1],
    ],
  };

  async function twoVoices(mode: string) {
    const t = await workerEnv(mode, {}, DIALOGUE);
    const narrator = await t.addVoice('Narrator');
    const speaker = await t.addVoice('Speaker', 5);
    const sha = (id: string) =>
      (t.e.db.prepare('SELECT sha256 FROM tts_voices WHERE id = ?').get(id) as { sha256: string })
        .sha256;
    return { ...t, narrator, speaker, sha };
  }

  it('makes an audiobook reading the dialogue with its own voice', async () => {
    const t = await twoVoices('ok');
    const res = await t.startBook(HITSUJI, {
      voiceId: t.narrator.id,
      dialogueVoiceId: t.speaker.id,
    });
    const id = res.body.job.id as number;
    expect(await t.worker.tick()).toBe(0);
    await t.tts.idle();
    expect(await t.latestBook(HITSUJI), JSON.stringify(t.log.lines)).toMatchObject({
      id,
      state: 'done',
    });
    const job = t.jobJson(1);
    const dialogueFile = `/work/voice-${t.sha(t.speaker.id).slice(0, 16)}.wav`;
    expect(job.voice).toBe('/work/voice.wav');
    expect(job.voices).toEqual({
      narration: { voice: '/work/voice.wav', seed: job.seed },
      dialogue: { voice: dialogueFile, seed: expect.any(Number) },
    });
    expect(job.chapters[0].sentences[1].segments).toEqual([
      { reading: '「行こう」', voice: 'dialogue' },
      { reading: 'と彼は言った。', voice: 'narration' },
    ]);
    // What the program said, sentence by sentence (one cue each, as before).
    const row = t.e.db
      .prepare('SELECT cues FROM tts_job_chapters WHERE job_id = ? AND idx = 0')
      .get(id) as { cues: string };
    const kept = JSON.parse(row.cues) as { cues: number[][]; spoken: string[] };
    expect(kept.cues).toHaveLength(3);
    expect(kept.spoken).toEqual([
      '善なるものはひっきょう、遠い。',
      '[dialogue]「行こう」[narration]と彼は言った。',
      '[dialogue]「近い！」',
    ]);
  }, 60_000);

  it('waits for a newer program on the PC (an older one would read it with one voice)', async () => {
    const t = await twoVoices('ok');
    await t.startBook(HITSUJI, { voiceId: t.narrator.id, dialogueVoiceId: t.speaker.id });
    await t.heartbeat({ version: '1.2.0' });
    expect(await t.claim()).toBeNull();
    expect((await t.latestBook(HITSUJI)).state).toBe('queued');
  }, 60_000);

  it('reads aloud and reads Enrich clips with both voices kept in the voice process', async () => {
    const t = await twoVoices('ok');
    await request(t.app)
      .put('/api/v1/tts/voice-choice')
      .set(t.auth)
      .send({ voiceId: t.narrator.id, dialogueVoiceId: t.speaker.id, modelId: 1 });
    const session = (
      await request(t.app)
        .post('/api/v1/read-aloud/sessions')
        .set(t.auth)
        .send({ bookId: t.bookId(HITSUJI) })
    ).body.session.id as string;
    await request(t.app)
      .post(`/api/v1/read-aloud/sessions/${session}/batches`)
      .set(t.auth)
      .send({ sentences: DIALOGUE.chapters[0].sentences.slice(1) });
    const serving = t.worker.tick();
    const poll = async () =>
      (await request(t.app).get(`/api/v1/read-aloud/sessions/${session}`).set(t.auth)).body.session;
    const done = await waitFor(poll, (s) => ['done', 'failed'].includes(s.batches[0]?.state));
    expect(done.batches[0], JSON.stringify(t.log.lines)).toMatchObject({ state: 'done' });
    await request(t.app)
      .get(`/api/v1/read-aloud/sessions/${session}?playing=0&after=1`)
      .set(t.auth);
    expect(await serving).toBe(0);
    const read = t.served().find((r) => r.op === 'read')!;
    expect(read.voices).toEqual({
      narration: { voice: `/work/voices/${t.sha(t.narrator.id)}.wav`, seed: expect.any(Number) },
      dialogue: { voice: `/work/voices/${t.sha(t.speaker.id)}.wav`, seed: expect.any(Number) },
    });
    expect((read.sentences as { segments?: unknown }[])[0].segments).toEqual([
      { reading: '「行こう」', voice: 'dialogue' },
      { reading: 'と彼は言った。', voice: 'narration' },
    ]);
    // Both clips are in the voice process's folder.
    for (const id of [t.narrator.id, t.speaker.id]) {
      expect(fs.existsSync(path.join(t.s.workDir, 'live', 'voices', `${t.sha(id)}.wav`))).toBe(
        true,
      );
    }
    // An Enrich clip of the mixed sentence through the kept voice.
    const clip = (
      await request(t.app)
        .post(`/api/v1/books/${t.bookId(HITSUJI)}/sentence-audio`)
        .set(t.auth)
        .send({ text: '「行こう」と彼は言った。', position: 11 })
    ).body.clip.id as string;
    await t.worker.tick();
    const st = (await request(t.app).get(`/api/v1/sentence-audio/${clip}`).set(t.auth)).body;
    expect(st.clip, JSON.stringify(t.log.lines)).toMatchObject({ state: 'done' });
    const reads = t.served().filter((r) => r.op === 'read');
    expect((reads[reads.length - 1].sentences as { segments?: unknown }[])[0].segments).toEqual([
      { reading: '「行こう」', voice: 'dialogue' },
      { reading: 'と彼は言った。', voice: 'narration' },
    ]);
    expect(t.served().filter((r) => r.op === 'load')).toHaveLength(1);
  }, 60_000);
});

describe.skipIf(!HAS_FFMPEG)('the worker reading aloud (Season 2 Phase 12 session 3)', () => {
  const SENTENCES = [
    {
      text: '善なるものは畢竟、遠い。',
      reading: '善なるものはひっきょう、遠い。',
      ruby: [{ start: 6, end: 8, rt: 'ひっきょう' }],
      position: 0,
      paragraphEnd: false,
    },
    {
      text: 'けれども悪は近い！',
      reading: 'けれども悪は近い！',
      ruby: [],
      position: 11,
      paragraphEnd: true,
    },
  ];

  async function liveEnv(mode: string) {
    const t = await workerEnv(mode);
    const voice = await t.addVoice();
    await request(t.app)
      .put('/api/v1/tts/voice-choice')
      .set(t.auth)
      .send({ voiceId: voice.id, modelId: 1 });
    const open = async () =>
      (
        await request(t.app)
          .post('/api/v1/read-aloud/sessions')
          .set(t.auth)
          .send({ bookId: t.bookId(HITSUJI) })
      ).body.session.id as string;
    const batch = (id: string, sentences = SENTENCES) =>
      request(t.app)
        .post(`/api/v1/read-aloud/sessions/${id}/batches`)
        .set(t.auth)
        .send({ sentences });
    const poll = async (id: string, q = '') =>
      (await request(t.app).get(`/api/v1/read-aloud/sessions/${id}${q}`).set(t.auth)).body.session;
    return { ...t, voice, open, batch, poll };
  }

  it('loads the voice once, reads the batches, then keeps the voice for the keep time', async () => {
    const t = await liveEnv('ok');
    const id = await t.open();
    await t.batch(id);
    const serving = t.worker.tick();
    const first = await waitFor(
      () => t.poll(id),
      (s) => s.batches[0]?.state === 'done',
    );
    expect(first.batches[0]).toMatchObject({
      seq: 1,
      // max(600, 100 × characters) of tone each, the sentence pause between, and the
      // paragraph pause after the last (it ends its paragraph).
      cues: [
        [0, 1200],
        [1500, 2400],
      ],
      durationMs: 3100,
    });
    expect(first.pc).toMatchObject({ answering: true, engine: { state: 'ready' } });
    await t.batch(id, [SENTENCES[1]]);
    await waitFor(
      () => t.poll(id),
      (s) =>
        s.batches.some((b: { seq: number; state: string }) => b.seq === 2 && b.state === 'done'),
    );
    // Paused on the device: the PC goes back to its queue, the voice stays loaded.
    await t.poll(id, '?playing=0&after=2');
    expect(await serving).toBe(0);
    const served = t.served();
    expect(served.map((r) => r.op)).toEqual(['load', 'read', 'read']);
    expect(served[1]).toMatchObject({
      sentences: [
        { text: SENTENCES[0].text, reading: '善なるものはひっきょう、遠い。', paragraphEnd: false },
        { text: SENTENCES[1].text, reading: SENTENCES[1].reading, paragraphEnd: true },
      ],
      lastGapMs: 700,
      pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 0 },
    });
    // While kept, an audiobook waits; nothing quits the voice.
    await t.startBook(SPY, { voiceId: t.voice.id });
    await t.worker.tick();
    expect(await t.latestBook(SPY)).toMatchObject({ state: 'queued' });
    expect(t.served().map((r) => r.op)).toEqual(['load', 'read', 'read']);
    const status = (await request(t.app).get('/api/v1/gpu-worker').set(t.auth)).body;
    expect(status.engine).toMatchObject({ state: 'ready' });
    expect(status.keepVoiceUntil).toBeGreaterThan(Date.now());
    // The keep time is over: the voice is let go and the audiobook runs.
    t.jobs.setKeepLoaded(0);
    await t.worker.tick();
    await t.tts.idle();
    expect(t.served().map((r) => r.op)).toEqual(['load', 'read', 'read', 'quit']);
    expect(await t.latestBook(SPY)).toMatchObject({ state: 'done' });
  }, 60_000);

  it('stops a running audiobook at once for read-aloud and continues it afterwards', async () => {
    const t = await liveEnv('slow');
    const book = (await t.startBook(HITSUJI, { voiceId: t.voice.id })).body.job.id as number;
    const running = t.worker.tick();
    await waitFor(
      () => t.latestBook(HITSUJI),
      (j) => j.stage === 'generating',
    );
    const id = await t.open();
    await t.batch(id);
    await running;
    expect(t.calls()).toContainEqual(['kill', `ttsu-tts-${book}`]);
    expect(t.jobs.get(book)).toMatchObject({
      state: 'queued',
      attempts: 0,
      message: 'Paused for read-aloud; it continues afterwards.',
    });
    t.setMode('ok');
    const serving = t.worker.tick();
    await waitFor(
      () => t.poll(id),
      (s) => s.batches[0]?.state === 'done',
    );
    await request(t.app).delete(`/api/v1/read-aloud/sessions/${id}`).set(t.auth);
    await serving;
    t.jobs.setKeepLoaded(0);
    await t.worker.tick();
    await t.tts.idle();
    expect(await t.latestBook(HITSUJI)).toMatchObject({ state: 'done', linked: true });
  }, 60_000);

  it('tells the device when the voice cannot be loaded', async () => {
    const t = await liveEnv('load-fail');
    const id = await t.open();
    await t.batch(id);
    const serving = t.worker.tick();
    const failed = await waitFor(
      () => t.poll(id),
      (s) => s.batches[0]?.state === 'failed',
    );
    expect(failed.batches[0].error).toBe('RuntimeError: CUDA out of memory');
    await request(t.app).delete(`/api/v1/read-aloud/sessions/${id}`).set(t.auth);
    await serving;
  }, 60_000);
});
