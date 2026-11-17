/**
 * Season 2 Phase 12 session 5: the GPU worker (apps/gpu-worker, 1.4.0) running speaker jobs
 * against a real storage server on a local port, with a fake `docker`
 * (fixtures/speakers/fake-speaker-docker.cjs) that starts a fake llama.cpp server
 * (fake-llama-server.cjs, answering with the stand-in model), and a local stand-in for
 * Hugging Face that serves the model file (with Range, for a continued download).
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerApi } from '../../gpu-worker/src/api';
import {
  DEFAULTS,
  parseSettings,
  SPEAKER_IMAGE,
  type WorkerSettings,
} from '../../gpu-worker/src/config';
import { memoryLogger } from '../../gpu-worker/src/log';
import { speakerArgs, speakerModelPath } from '../../gpu-worker/src/speakers';
import { Worker } from '../../gpu-worker/src/worker';
import type { BookScript } from '../src/audio/book-script';
import { HAS_FFMPEG, ttsEnv } from './helpers/tts-env';
import { makeTempDir } from './helpers/spawn-server';
import { HITSUJI, type Track } from './helpers/worker-env';

const FAKE_DOCKER = path.join(__dirname, 'fixtures', 'speakers', 'fake-speaker-docker.cjs');

const track: Track = { envs: [], services: [] };
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.FAKE_DOCKER_STATE;
  while (closers.length) await closers.pop()!();
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

const sentence = (text: string, position: number, quote?: number, end = 0) => ({
  text,
  reading: text,
  ruby: [],
  position,
  paragraphEnd: true,
  ...(quote !== undefined ? { parts: [{ start: 0, end, role: 'dialogue' as const, quote }] } : {}),
});
const SCRIPT: BookScript = {
  version: 3,
  characters: 60,
  chapters: [
    {
      index: 0,
      title: '一',
      startCharacter: 0,
      characters: 60,
      sentences: [
        sentence('「行こう」とホロは言った。', 0, 0, 5),
        sentence('「どこへ？」とロレンスは聞いた。', 12, 1, 6),
        sentence('「北へ」', 28, 2, 4),
      ],
    },
  ],
};

/** A free local port (for the fake llama.cpp server). */
async function freePort(): Promise<number> {
  const s = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(() => r(null)));
  return port;
}

async function workerEnv(mode = 'ok') {
  const t = await ttsEnv(track, { script: SCRIPT });
  const server = t.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  // Hugging Face's stand-in: the model file, Range answered with 206.
  const model = randomBytes(200_000);
  const sha256 = createHash('sha256').update(model).digest('hex');
  const ranges: string[] = [];
  const hf = http.createServer((req, res) => {
    const range = req.headers.range;
    ranges.push(range ?? '');
    const m = /^bytes=(\d+)-$/.exec(range ?? '');
    if (m) {
      const from = Number(m[1]);
      res.writeHead(206, { 'content-length': model.length - from });
      res.end(model.subarray(from));
    } else {
      res.writeHead(200, { 'content-length': model.length });
      res.end(model);
    }
  });
  hf.listen(0, '127.0.0.1');
  await new Promise((r) => hf.once('listening', r));
  closers.push(() => new Promise((r) => hf.close(() => r())));
  // The model the job uses: this file (the seeded gemma stays for the list).
  const modelId = Number(
    t.e.db
      .prepare(
        `INSERT INTO speaker_models (repo, file, revision, size, sha256, label, is_default, added_at)
         VALUES ('test/tiny-GGUF', 'tiny.gguf', ?, ?, ?, 'Tiny', 0, 1)`,
      )
      .run('a'.repeat(40), model.length, sha256).lastInsertRowid,
  );
  t.speakerModels.setDefault(modelId);
  const state = makeTempDir('spk-docker');
  fs.writeFileSync(path.join(state, 'mode'), mode);
  fs.writeFileSync(path.join(state, 'load-ms'), '150');
  process.env.FAKE_DOCKER_STATE = state;
  const workDir = path.join(makeTempDir('spk-work'), 'work');
  const modelsDir = path.join(makeTempDir('spk-models'), 'ttsu reader speakers');
  const s: WorkerSettings = {
    ...DEFAULTS,
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token: t.worker.Authorization.slice('Bearer '.length),
    workDir,
    logDir: path.join(workDir, '..', 'logs'),
    dockerPath: process.execPath,
    dockerPrefixArgs: [FAKE_DOCKER],
    reportSeconds: 0.05,
    idleWaitSeconds: 0.2,
    speakerModelsDir: modelsDir,
    speakerPort: await freePort(),
    huggingFaceUrl: `http://127.0.0.1:${(hf.address() as AddressInfo).port}`,
  };
  const log = memoryLogger();
  const worker = new Worker({
    settings: s,
    api: new ServerApi(s),
    log,
    freeBytes: async () => null,
  });
  closers.push(async () => worker.engine.kill());
  // Any fake llama.cpp server left (a failed test) is stopped.
  closers.push(async () => {
    for (const f of fs.readdirSync(state).filter((n) => n.endsWith('.pid'))) {
      try {
        process.kill(Number(fs.readFileSync(path.join(state, f), 'utf8')));
      } catch {
        // gone
      }
    }
  });
  const calls = () =>
    fs.existsSync(path.join(state, 'calls.jsonl'))
      ? fs
          .readFileSync(path.join(state, 'calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
      : [];
  const requests = () =>
    fs.existsSync(path.join(state, 'requests.jsonl'))
      ? fs
          .readFileSync(path.join(state, 'requests.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  const api = (method: 'get' | 'post' | 'put', url: string) =>
    request(t.app)[method](`/api/v1${url}`).set(t.auth);
  const book = t.bookId(HITSUJI);
  const rel = speakerModelPath({
    repo: 'test/tiny-GGUF',
    revision: 'a'.repeat(40),
    file: 'tiny.gguf',
  });
  const modelFile = path.join(modelsDir, ...rel);
  return {
    ...t,
    s,
    worker,
    log,
    calls,
    requests,
    state,
    api,
    book,
    model,
    rel,
    modelFile,
    ranges,
    modelId,
  };
}

describe('speaker worker pieces', () => {
  it('builds the docker call and keeps model names to plain folders', () => {
    const s = parseSettings({ serverUrl: 'http://nas:3081', token: `ttsu_${'a'.repeat(30)}` });
    expect(s).toMatchObject({
      speakerImage: SPEAKER_IMAGE,
      speakerModelsDir: 'C:\\Data\\LLM\\Models\\ttsu-reader-speakers',
      speakerPort: 8791,
    });
    const rel = speakerModelPath({
      repo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
      revision: 'c099eb48e663fd284577b04978a94ffccb261841',
      file: 'gemma-4-26B-A4B-it-UD-IQ4_XS.gguf',
    });
    expect(speakerArgs(s, 9, rel, 16384)).toEqual([
      'run',
      '--rm',
      '-d',
      '--gpus',
      'all',
      '--name',
      'ttsu-llm-9',
      '-p',
      '127.0.0.1:8791:8080',
      '-v',
      'C:\\Data\\LLM\\Models\\ttsu-reader-speakers:/models:ro',
      SPEAKER_IMAGE,
      '-m',
      '/models/unsloth--gemma-4-26B-A4B-it-GGUF/c099eb48e663fd284577b04978a94ffccb261841/gemma-4-26B-A4B-it-UD-IQ4_XS.gguf',
      '-c',
      '16384',
      '-fa',
      'on',
      '-lm',
      'none',
      '--parallel',
      '1',
      '--jinja',
      '-rea',
      'off',
    ]);
    expect(() => speakerModelPath({ repo: 'a/b c', revision: 'r', file: 'a.gguf' })).toThrow();
    expect(() => speakerModelPath({ repo: 'a/b', revision: '..', file: 'a.gguf' })).toThrow();
  });
});

describe.skipIf(!HAS_FFMPEG)('the worker running speaker jobs (1.4.0)', () => {
  it('downloads and checks the model, runs every request, saves; the container goes', async () => {
    const t = await workerEnv();
    const run = await t.api('post', `/books/${t.book}/speakers/run`).send({});
    expect(run.body.job.params.model.file).toBe('tiny.gguf');
    expect(await t.worker.tick()).toBe(0);
    const o = (await t.api('get', `/books/${t.book}/speakers`)).body;
    expect(o.job, t.log.lines.join('\n')).toMatchObject({ state: 'done' });
    expect(o.characters.map((c: { name: string; quotes: number }) => [c.name, c.quotes])).toEqual([
      ['ホロ', 2],
      ['ロレンス', 1],
    ]);
    // The model: downloaded once, its sha256 checked (the .ok file), no .part left.
    expect(fs.readFileSync(t.modelFile).equals(t.model)).toBe(true);
    expect(fs.existsSync(`${t.modelFile}.ok`)).toBe(true);
    expect(fs.existsSync(`${t.modelFile}.part`)).toBe(false);
    // The exact container, then removed.
    const calls = t.calls();
    expect(calls.find((c) => c[0] === 'run')).toEqual(speakerArgs(t.s, o.job.id, t.rel, 16384));
    expect(calls[calls.length - 1]).toEqual(['rm', '-f', `ttsu-llm-${o.job.id}`]);
    // Temperature 0; probabilities asked for the speakers only.
    const req = t.requests();
    expect(req.every((r: { temperature: number }) => r.temperature === 0)).toBe(true);
    expect(
      req
        .filter((r: { n_probs: number }) => r.n_probs > 0)
        .every((r: { grammar: boolean }) => r.grammar),
    ).toBe(true);
    // A second run uses the file as it is (no download).
    const before = t.ranges.length;
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.worker.tick();
    expect(t.ranges.length).toBe(before);
  }, 60_000);

  it('continues a broken download; a damaged file is deleted and the job fails', async () => {
    const t = await workerEnv();
    fs.mkdirSync(path.dirname(t.modelFile), { recursive: true });
    fs.writeFileSync(`${t.modelFile}.part`, t.model.subarray(0, 50_000));
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.worker.tick();
    expect(t.ranges).toEqual(['bytes=50000-']);
    expect((await t.api('get', `/books/${t.book}/speakers`)).body.job.state).toBe('done');
    // A file whose bytes are wrong (no .ok yet): checked, deleted, failed with the reason.
    fs.rmSync(`${t.modelFile}.ok`);
    const bad = Buffer.from(t.model);
    bad[10] ^= 0xff;
    fs.writeFileSync(t.modelFile, bad);
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.worker.tick();
    const job = (await t.api('get', `/books/${t.book}/speakers`)).body.job;
    expect(job).toMatchObject({ state: 'failed' });
    expect(job.error).toMatch(/damaged/);
    expect(fs.existsSync(t.modelFile)).toBe(false);
    // Run again: downloaded afresh and done.
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.worker.tick();
    expect((await t.api('get', `/books/${t.book}/speakers`)).body.job.state).toBe('done');
  }, 60_000);

  it('makes way when paused and continues; Stop ends it; the container goes each time', async () => {
    const t = await workerEnv();
    fs.writeFileSync(path.join(t.state, 'request-ms'), '150');
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    const ticking = t.worker.tick();
    // Pause once the first request is answered.
    for (let i = 0; i < 200 && t.requests().length < 1; i++)
      await new Promise((r) => setTimeout(r, 25));
    await t.api('put', '/gpu-worker/paused').send({ paused: true });
    await ticking;
    let job = (await t.api('get', `/books/${t.book}/speakers`)).body.job;
    expect(job).toMatchObject({ state: 'queued', attempts: 0 });
    const answered = t.requests().length;
    const rm = t.calls().filter((c) => c[0] === 'rm');
    expect(rm.length).toBeGreaterThanOrEqual(2);
    // Resumed: it continues from the answers it has (no request asked twice).
    await t.api('put', '/gpu-worker/paused').send({ paused: false });
    await t.worker.tick();
    job = (await t.api('get', `/books/${t.book}/speakers`)).body.job;
    expect(job.state).toBe('done');
    // This book is one window of each stage: 3 requests in all, none asked twice.
    expect(t.requests().length).toBe(3);
    expect(answered).toBeLessThan(3);
    // Stop while it runs.
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    const second = t.worker.tick();
    for (let i = 0; i < 200 && t.requests().length < 4; i++)
      await new Promise((r) => setTimeout(r, 25));
    const id = (await t.api('get', `/books/${t.book}/speakers`)).body.job.id;
    await t.api('post', `/audio/subtitle-jobs/${id}/cancel`).send({});
    await second;
    expect((await t.api('get', `/books/${t.book}/speakers`)).body.job.state).toBe('cancelled');
    expect(fs.readdirSync(t.state).filter((f) => f.endsWith('.pid'))).toEqual([]);
  }, 60_000);

  it('says why: the model did not load; the speaker program missing', async () => {
    const t = await workerEnv('load-fail');
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.worker.tick();
    const job = (await t.api('get', `/books/${t.book}/speakers`)).body.job;
    expect(job).toMatchObject({ state: 'failed' });
    expect(job.error).toMatch(/stopped while loading/);
    fs.writeFileSync(path.join(t.state, 'mode'), 'no-speaker-image');
    const r = await t.worker.readiness();
    expect(r.kinds).not.toContain('attribute_speakers');
    expect(r.problem).toMatch(/speaker program is not on the PC \(node main\.js pull-speakers\)/);
  }, 60_000);

  it('deletes the files of speaker models removed in the reader', async () => {
    const t = await workerEnv();
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.worker.tick();
    expect(fs.existsSync(t.modelFile)).toBe(true);
    await request(t.app).delete(`/api/v1/speaker-models/${t.modelId}`).set(t.auth);
    await t.worker.tick();
    expect(fs.existsSync(path.dirname(t.modelFile))).toBe(false);
  }, 60_000);
});
