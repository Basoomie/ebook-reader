/**
 * WP16: the GPU worker (apps/gpu-worker) against a real storage server on a local port,
 * with a fake `docker` (tests/fixtures/wp16/fake-docker.cjs) in place of Docker Desktop
 * and SubPlz. Checks the exact `docker run` call, the plain ASCII job folder, progress
 * reports, failures with SubPlz's last lines, stopping (docker kill), the time limit,
 * Docker problems, pause, and that the job folder is always removed.
 */
import fs from 'fs';
import type { AddressInfo } from 'net';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerApi } from '../../gpu-worker/src/api';
import {
  ConfigError,
  DEFAULTS,
  isPlainPath,
  parseSettings,
  PINNED_IMAGE,
  type WorkerSettings,
} from '../../gpu-worker/src/config';
import { memoryLogger } from '../../gpu-worker/src/log';
import { LineSplitter, subplzArgs, SubplzProgress, Tail } from '../../gpu-worker/src/subplz';
import {
  audioNameFor,
  jobProgress,
  plainError,
  Worker,
  WORKER_VERSION,
} from '../../gpu-worker/src/worker';
import type { AudioScanService } from '../src/audio/scan-service';
import type { WorkerConfig } from '../src/config';
import type { IndexerEnv } from './helpers/indexer-env';
import { makeTempDir } from './helpers/spawn-server';
import { HITSUJI, HITSUJI_FOLDER, jobEnv, type JobEnv } from './helpers/worker-env';

const FAKE_DOCKER = path.join(__dirname, 'fixtures', 'wp16', 'fake-docker.cjs');

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.FAKE_DOCKER_MODE;
  delete process.env.FAKE_DOCKER_STATE;
  while (closers.length) await closers.pop()!();
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const TOKEN = `ttsu_${'a'.repeat(43)}`;

describe('worker settings and helpers', () => {
  it('fills in the defaults and refuses a bad config', () => {
    const s = parseSettings({ serverUrl: 'http://192.168.1.5:3081/', token: TOKEN });
    expect(s).toMatchObject({
      serverUrl: 'http://192.168.1.5:3081',
      cacheDir: 'C:\\Data\\Japanese\\Books\\SyncCache',
      workDir: 'C:\\ttsu-worker\\work',
      image: PINNED_IMAGE,
      maxRunHours: 8,
    });
    expect(PINNED_IMAGE).toBe(
      'kanjieater/subplz@sha256:58cddc13c51789d65edb2b81ef47b2dd76613e54f9c4726cc96d94f2aff7b310',
    );
    expect(() => parseSettings({ serverUrl: 'nas', token: TOKEN })).toThrow(ConfigError);
    expect(() => parseSettings({ serverUrl: 'http://x', token: 'abc' })).toThrow(/worker token/);
    // The work folder must be plain: the real folders have spaces and Japanese characters.
    expect(() =>
      parseSettings({ serverUrl: 'http://x', token: TOKEN, workDir: 'C:\\本 の\\work' }),
    ).toThrow(/plain path/);
    // The cache folder may be anything (it is one docker argument).
    expect(
      parseSettings({ serverUrl: 'http://x', token: TOKEN, cacheDir: 'D:\\My Books\\同期' })
        .cacheDir,
    ).toBe('D:\\My Books\\同期');
    expect(() =>
      parseSettings({ serverUrl: 'http://x', token: TOKEN, maxRunHours: 'eight' }),
    ).toThrow(/maxRunHours/);
    expect(isPlainPath(DEFAULTS.workDir)).toBe(true);
  });

  it('builds exactly the manual SubPlz call, plus only a container name', () => {
    expect(
      subplzArgs({
        jobId: 12,
        jobDir: 'C:\\ttsu-worker\\work\\job-12',
        cacheDir: 'C:\\Data\\Japanese\\Books\\SyncCache',
        image: PINNED_IMAGE,
      }),
    ).toEqual([
      'run',
      '--rm',
      '--gpus',
      'all',
      '--name',
      'ttsu-subplz-12',
      '-v',
      'C:\\ttsu-worker\\work\\job-12:/sync',
      '-v',
      'C:\\Data\\Japanese\\Books\\SyncCache:/config',
      PINNED_IMAGE,
      'sync',
      '-d',
      '/sync/book',
    ]);
  });

  it('turns SubPlz lines into one progress for the whole run', () => {
    // Lines as the pinned image prints them (from a real run, 2026-11-12).
    const at = (msg: string, level = 'TQDM') =>
      `\u001b[32m2026-11-12 20:28:32\u001b[0m | ${level.padEnd(8)} | P:1 | ${msg}`;
    const p = new SubplzProgress(1000);
    p.feed(at('0%|          | 0/3087 [00:00<?, ?it/s]')); // reading the book: ignored
    expect(p.value()).toBeNull();
    p.feed(at('Transcribe:  50%|#####     | 200.00/400.00 [00:35<00:14, 46.52sec/s]'));
    expect(p.value()).toBeCloseTo(0.2 * 0.95);
    p.feed(at('[A'));
    p.feed(at('Transcribe: 100%|##########| 400.00/400.00 [00:35<00:00, 46.52sec/s]'));
    expect(p.value()).toBeCloseTo(0.4 * 0.95);
    // The next chapter's bar starts at 0: the whole run keeps going up.
    p.feed(at('Transcribe:   1%|          | 4.52/600.00 [00:00<02:18,  6.44sec/s]'));
    expect(p.value()).toBeCloseTo(((400 + 4.52) / 1000) * 0.95);
    p.feed(at('Transcribe:  50%|#####     | 300.00/600.00 [00:10<00:10, 45.00sec/s]'));
    expect(p.value()).toBeCloseTo(0.7 * 0.95);
    // A chapter's after-bar in " seconds" (no "Transcribe:") changes nothing.
    p.feed(at('第一章: 100%|##########| 400/400 [00:00<00:00, 9.99k seconds/s]'));
    expect(p.value()).toBeCloseTo(0.7 * 0.95);
    p.feed(at("✅ Transcription successful with model 'tiny' on 'cuda'.", 'SUCCESS'));
    expect(p.value()).toBeCloseTo(0.95);
    p.feed(at('100%|##########| 1/1 [00:00<00:00,  5.79it/s]')); // one item: ignored
    expect(p.value()).toBeCloseTo(0.95);
    p.feed(at('0%|          | 0/8 [00:00<?, ?it/s]'));
    p.feed(at(' 50%|#####     | 4/8 [00:22<00:25,  6.41s/it]'));
    expect(p.value()).toBeCloseTo(0.975);
    p.feed(at('100%|##########| 8/8 [00:40<00:00,  5.00s/it]'));
    expect(p.value()).toBeCloseTo(1);
    // Without the audio's length: nothing until matching.
    const q = new SubplzProgress(null);
    q.feed(at('Transcribe:  50%|#####     | 200.00/400.00 [00:35<00:14, 46.52sec/s]'));
    expect(q.value()).toBeNull();
    q.feed(at("✅ Transcription successful with model 'tiny' on 'cuda'.", 'SUCCESS'));
    expect(q.value()).toBeCloseTo(0.95);
    // Whole job: download up to 2 %, SubPlz up to 98 %.
    expect(jobProgress(0)).toBeCloseTo(0.02);
    expect(jobProgress(1)).toBeCloseTo(0.98);
    expect(jobProgress(null)).toBeNull();
    const lines: string[] = [];
    const split = new LineSplitter((l) => lines.push(l));
    split.push('a\r\nb');
    split.push('\rc\n\nd');
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('keeps the last lines of output', () => {
    const tail = new Tail(3);
    tail.push('a\nb\n 10%|█|\r 20%|██|\r');
    tail.push(' 30%|███|\nc\nd');
    expect(tail.text()).toBe(' 30%|███|\nc\nd');
    expect(audioNameFor('羊と鋼の森 [B0X].M4B')).toBe('audio.m4b');
    expect(audioNameFor('01.mp3')).toBe('audio.mp3');
    expect(plainError('ENOENT C:\\ttsu-worker\\work\\job-3\\book', 'C:\\ttsu-worker\\work')).toBe(
      'ENOENT <work folder>\\job-3\\book',
    );
  });
});

/** A storage server on a local port, the book linked, a worker on the fake docker. */
async function workerEnv(
  mode: string,
  {
    config = {},
    settings = {},
  }: { config?: Partial<WorkerConfig>; settings?: Partial<WorkerSettings> } = {},
) {
  const t = await jobEnv({ envs, services }, config);
  const server = t.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const state = makeTempDir('wp16-docker');
  process.env.FAKE_DOCKER_MODE = mode;
  process.env.FAKE_DOCKER_STATE = state;
  const workDir = path.join(makeTempDir('wp16-work'), 'work');
  const s: WorkerSettings = {
    ...DEFAULTS,
    serverUrl: `http://127.0.0.1:${port}`,
    token: t.worker.Authorization.slice('Bearer '.length),
    cacheDir: path.join(makeTempDir('wp16-cache'), 'Sync Cache 同期'),
    workDir,
    logDir: path.join(workDir, '..', 'logs'),
    dockerPath: process.execPath,
    dockerPrefixArgs: [FAKE_DOCKER],
    reportSeconds: 0.05,
    ...settings,
  };
  const sent: { path: string; body: any }[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.body && typeof init.body === 'string') {
      sent.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
    }
    return fetch(input, init);
  };
  const api = new ServerApi({ ...s, fetchImpl: recordingFetch });
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
  return { ...t, s, api, worker, log, sent, calls, state };
}

async function queued(t: JobEnv): Promise<number> {
  expect((await t.linkAudio(HITSUJI, HITSUJI_FOLDER)).status).toBe(200);
  const res = await t.queue(HITSUJI);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.job.id;
}

async function waitFor<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('the worker against the server', () => {
  it('runs a job: ASCII job folder, the exact docker call, upload, link, clean-up', async () => {
    const t = await workerEnv('progress');
    const id = await queued(t);
    expect(await t.worker.tick()).toBe(0);

    const job = await t.latest(HITSUJI);
    expect(job, JSON.stringify(t.log.lines)).toMatchObject({ state: 'done', linked: true });
    const rel = `japanese-srt/_generated/${HITSUJI}.srt`;
    const saved = fs.readFileSync(path.join(t.root, rel), 'utf8');
    // The fake SubPlz lists what it found in /sync/book: plain names only.
    expect(saved).toContain('audio.m4b,book.epub');
    expect((await t.link(HITSUJI)).subtitleRelPath).toBe(rel);

    const run = t.calls().find((c) => c[0] === 'run')!;
    expect(run).toEqual(
      subplzArgs({
        jobId: id,
        jobDir: path.join(t.s.workDir, `job-${id}`),
        cacheDir: t.s.cacheDir,
        image: PINNED_IMAGE,
      }),
    );
    // WP17: two image checks (SubPlz, then the TTS program).
    expect(t.calls().map((c) => c[0])).toEqual(['info', 'image', 'image', 'run']);
    // Reports: downloading up to 1, then SubPlz's own percentages, then uploading.
    const reports = t.sent.filter((x) => x.path.endsWith('/progress')).map((x) => x.body);
    expect(reports.some((r) => r.stage === 'downloading')).toBe(true);
    expect(reports.some((r) => r.stage === 'syncing' && r.progress >= 0.3)).toBe(true);
    // One progress for the whole job: it only goes up, and downloading stays under 2 %.
    const values = reports.map((r) => r.progress).filter((v) => v !== null);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(reports.filter((r) => r.stage === 'downloading').every((r) => r.progress <= 0.02)).toBe(
      true,
    );
    expect(reports.some((r) => r.stage === 'uploading' && r.progress === 0.98)).toBe(true);
    expect(reports.some((r) => r.stage === 'uploading')).toBe(true);
    const hb = t.sent.find((x) => x.path.endsWith('/heartbeat'))!.body;
    expect(hb).toMatchObject({ version: WORKER_VERSION, image: PINNED_IMAGE, problem: null });
    // Nothing left on the PC.
    expect(fs.readdirSync(t.s.workDir)).toEqual([]);
    // Idle: nothing to do.
    expect(await t.worker.tick()).toBe(30);
  });

  it('reports SubPlz failures with its last lines and cleans up', async () => {
    for (const [mode, error] of [
      ['fail', 'SubPlz failed (exit code 1): ValueError: no text'],
      ['oom', 'SubPlz was stopped by the system (out of memory?)'],
      ['nosrt', 'SubPlz finished without making a subtitle file'],
    ] as const) {
      const t = await workerEnv(mode);
      await queued(t);
      await t.worker.tick();
      const job = await t.latest(HITSUJI);
      expect(job, mode).toMatchObject({ state: 'failed', error });
      if (mode === 'fail') expect(job.logTail).toContain('Traceback');
      expect(fs.readdirSync(t.s.workDir), mode).toEqual([]);
      expect(fs.existsSync(path.join(t.root, 'japanese-srt', '_generated')), mode).toBe(false);
    }
  });

  it('stops SubPlz with docker kill when the job is stopped in the reader', async () => {
    const t = await workerEnv('hang');
    const id = await queued(t);
    const running = t.worker.tick();
    await waitFor(
      () => t.latest(HITSUJI),
      (j) => j.stage === 'syncing',
    );
    await waitFor(
      () => fs.existsSync(path.join(t.state, `ttsu-subplz-${id}.pid`)),
      (v) => v,
    );
    await request(t.app).post(`/api/v1/audio/subtitle-jobs/${id}/cancel`).set(t.auth);
    await running;
    expect(await t.latest(HITSUJI)).toMatchObject({ state: 'cancelled' });
    expect(t.calls()).toContainEqual(['kill', `ttsu-subplz-${id}`]);
    expect(fs.readdirSync(t.s.workDir)).toEqual([]);
  });

  it('stops SubPlz after the time limit', async () => {
    const t = await workerEnv('hang', { settings: { maxRunHours: 0.0003 } });
    const id = await queued(t);
    await t.worker.tick();
    const job = await t.latest(HITSUJI);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/ran longer than 0.0003 hours/);
    expect(t.calls()).toContainEqual(['kill', `ttsu-subplz-${id}`]);
  });

  it('takes no job while Docker or the image is missing, or while paused', async () => {
    for (const [mode, problem] of [
      ['no-docker', 'Docker Desktop is not running on the PC'],
      [
        'no-image',
        // WP17: both programs are missing in this mode.
        `The SubPlz image is not on the PC (docker pull ${PINNED_IMAGE}); The TTS program is not on the PC (node main.js build-tts)`,
      ],
    ] as const) {
      const t = await workerEnv(mode);
      await queued(t);
      expect(await t.worker.tick()).toBe(30);
      expect((await t.latest(HITSUJI)).state).toBe('queued');
      const status = await t.status();
      expect(status).toMatchObject({ online: true, problem });
      expect(t.calls().some((c) => c[0] === 'run')).toBe(false);
    }
    const t = await workerEnv('ok');
    await queued(t);
    await request(t.app).put('/api/v1/gpu-worker/paused').set(t.auth).send({ paused: true });
    await t.worker.tick();
    expect((await t.latest(HITSUJI)).state).toBe('queued');
    expect((await t.status()).problem).toBeNull();
  });

  it('removes job folders left by an earlier run, and only those', async () => {
    const t = await workerEnv('ok');
    fs.mkdirSync(path.join(t.s.workDir, 'job-99', 'book'), { recursive: true });
    fs.writeFileSync(path.join(t.s.workDir, 'job-99', 'book', 'audio.m4b'), 'x');
    fs.writeFileSync(path.join(t.s.workDir, 'notes.txt'), 'mine');
    await t.worker.clearLeftovers();
    expect(fs.readdirSync(t.s.workDir)).toEqual(['notes.txt']);
  });
});
