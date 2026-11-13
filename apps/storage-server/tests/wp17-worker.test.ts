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
import { Worker } from '../../gpu-worker/src/worker';
import { HAS_FFMPEG, ttsEnv } from './helpers/tts-env';
import { makeTempDir } from './helpers/spawn-server';
import { HITSUJI, type Track } from './helpers/worker-env';

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

async function workerEnv(mode: string, settings: Partial<WorkerSettings> = {}) {
  const t = await ttsEnv(track);
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
  return { ...t, s, worker, log, calls, state, jobJson, setMode, modelsDir };
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
    expect(await t.worker.tick()).toBeGreaterThan(0); // paused: nothing taken
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
