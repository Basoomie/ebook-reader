/**
 * WP16: the GPU worker's job queue. The worker is played by these tests over HTTP with
 * its own token; SubPlz's result is a small .srt. Checks the token scopes (R7), the queue
 * rules and the archive check, claiming, leases (the PC going away), pause, stop, result
 * checks, the guarded write into `japanese-srt/_generated/` (new files only, everything
 * else byte-identical), indexing and the automatic link.
 */
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { getSubtitleFileByRelPath } from '../src/audio/audio-index';
import { AudioWriter, subtitleNameCandidates } from '../src/audio/audio-write';
import type { AudioScanService } from '../src/audio/scan-service';
import { checkSrt, SubtitleJobService } from '../src/audio/subtitle-jobs';
import { updateLibrary } from '../src/calibre/libraries';
import { DEFAULT_WORKER, type WorkerConfig } from '../src/config';
import { createToken } from '../src/db/tokens';
import { listUsers } from '../src/db/users';
import {
  audioEnv,
  m4b,
  makeAudiobooksRoot,
  treeDiff,
  treeHashes,
  write,
} from './helpers/audio-fixtures';
import type { IndexerEnv } from './helpers/indexer-env';

const envs: IndexerEnv[] = [];
const services: AudioScanService[] = [];
afterEach(async () => {
  while (services.length) await services.pop()!.stop();
  while (envs.length) await envs.pop()!.close();
});

const SRT =
  '1\n00:00:01,000 --> 00:00:02,500\n羊と鋼の森\n\n2\n00:00:03,000 --> 00:00:04,000\nテスト\n';
const HITSUJI = '羊と鋼の森';
const SPY = 'スパイ教室02 《愛娘》のグレーテ';
const GUIN = 'グイン・サーガ';
const HITSUJI_FOLDER = 'japanese/_Unknown/羊と鋼の森 (文春文庫)';

async function jobEnv(config: Partial<WorkerConfig> = {}) {
  const root = makeAudiobooksRoot();
  write(root, `${HITSUJI_FOLDER}/羊と鋼の森.m4b`, m4b(30_000));
  const env = await audioEnv({ envs, services }, { root, books: [HITSUJI, SPY, GUIN] });
  let clock = Date.now();
  const logs: string[] = [];
  const jobs = new SubtitleJobService({
    db: env.e.db,
    scan: env.service,
    writer: new AudioWriter({ db: env.e.db, root, log: (m) => logs.push(m) }),
    config: { ...DEFAULT_WORKER, ...config },
    now: () => clock,
    log: (m) => logs.push(m),
    logError: (m) => logs.push(`ERROR ${m}`),
  });
  env.audio.jobs = jobs;
  const owner = listUsers(env.e.db)[0].id;
  const worker = {
    Authorization: `Bearer ${createToken(env.e.db, owner, 'PC', Date.now(), 'worker').token}`,
  };
  const app = env.e.app;
  const folderId = (rel: string) =>
    (env.e.db.prepare('SELECT id FROM audio_folders WHERE rel_path = ?').get(rel) as { id: number })
      .id;
  const linkAudio = (book: string, rel: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .put(`/api/v1/books/${env.bookId(book)}/audio-link`)
      .set(env.auth)
      .send({ audio: { state: 'linked', folderId: folderId(rel), ...extra } });
  const queue = (book: string, body: Record<string, unknown> = {}) =>
    request(app)
      .post(`/api/v1/books/${env.bookId(book)}/subtitle-job`)
      .set(env.auth)
      .send(body);
  const latest = async (book: string) =>
    (
      await request(app)
        .get(`/api/v1/books/${env.bookId(book)}/subtitle-job`)
        .set(env.auth)
    ).body.job;
  const link = async (book: string) =>
    (
      await request(app)
        .get(`/api/v1/books/${env.bookId(book)}/audio-link`)
        .set(env.auth)
    ).body.link;
  const heartbeat = (body: Record<string, unknown> = {}) =>
    request(app)
      .post('/api/v1/worker/heartbeat')
      .set(worker)
      .send({
        version: '1.0.0',
        image: 'kanjieater/subplz@sha256:abc',
        currentJobId: null,
        ...body,
      });
  const claim = async () =>
    (await request(app).post('/api/v1/worker/claim').set(worker).send({})).body.job;
  const progress = (id: number, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/worker/jobs/${id}/progress`).set(worker).send(body);
  const upload = (id: number, body: Buffer | string) =>
    request(app)
      .put(`/api/v1/worker/jobs/${id}/result`)
      .set(worker)
      .set('Content-Type', 'application/x-subrip')
      .send(Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'));
  const status = async () => (await request(app).get('/api/v1/gpu-worker').set(env.auth)).body;
  return {
    ...env,
    jobs,
    logs,
    worker,
    app,
    linkAudio,
    queue,
    latest,
    link,
    heartbeat,
    claim,
    progress,
    upload,
    status,
    tick: (ms: number) => {
      clock += ms;
    },
    tree: () => treeHashes(root),
  };
}

type Env = Awaited<ReturnType<typeof jobEnv>>;

/** Links the book's single-file audiobook and queues a job; returns the job id. */
async function linkedAndQueued(t: Env, book = HITSUJI, rel = HITSUJI_FOLDER): Promise<number> {
  expect((await t.linkAudio(book, rel)).status).toBe(200);
  const res = await t.queue(book);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  return res.body.job.id as number;
}

describe('pure parts', () => {
  it('accepts UTF-8 SRT with cues and refuses anything else', () => {
    expect(checkSrt(Buffer.from(`\uFEFF${SRT}`))).toEqual({ ok: true, text: SRT });
    expect(checkSrt(Buffer.from([0xff, 0xfe, 0x00, 0x41]))).toEqual({
      ok: false,
      error: 'The subtitle file is not UTF-8 text',
    });
    expect(checkSrt(Buffer.from('just text'))).toEqual({
      ok: false,
      error: 'The subtitle file has no subtitles in it',
    });
  });

  it('names the file after the book, then appends the book id', () => {
    const id = '0f8e4a62-7c1d-4b0e-9a55-2f1c3d4e5f60';
    const names = subtitleNameCandidates('羊と鋼の森: 上/下?', id, 3);
    expect(names).toEqual([
      '羊と鋼の森_ 上_下_.srt',
      `羊と鋼の森_ 上_下_ ${id}.srt`,
      `羊と鋼の森_ 上_下_ ${id} 2.srt`,
      `羊と鋼の森_ 上_下_ ${id} 3.srt`,
    ]);
    for (const n of subtitleNameCandidates('あ'.repeat(200), id)) {
      expect(Buffer.byteLength(n)).toBeLessThanOrEqual(250);
    }
  });
});

describe('worker token (R7)', () => {
  it('keeps the worker token to /worker/* and user tokens out of it', async () => {
    const t = await jobEnv();
    for (const p of ['/api/v1/me', '/api/v1/books', '/api/v1/gpu-worker', '/api/v1/audio/status']) {
      const res = await request(t.app).get(p).set(t.worker);
      expect(res.status, p).toBe(403);
      expect(res.body.error.code).toBe('wrong_token');
    }
    // Nor the audio stream (Bearer path) or a book's EPUB.
    const stream = await request(t.app).get('/api/v1/audio/files/1/0').set(t.worker);
    expect(stream.status).toBe(403);
    const epub = await request(t.app)
      .get(`/api/v1/books/${t.bookId(HITSUJI)}/file`)
      .set(t.worker);
    expect(epub.status).toBe(403);

    for (const [method, p] of [
      ['post', '/api/v1/worker/heartbeat'],
      ['post', '/api/v1/worker/claim'],
      ['get', '/api/v1/worker/jobs/1/epub'],
    ] as const) {
      const res = await request(t.app)[method](p).set(t.auth).send({});
      expect(res.status, p).toBe(403);
      expect(res.body.error.code).toBe('wrong_token');
      expect((await request(t.app)[method](p).send({})).status, p).toBe(401);
    }
    expect((await request(t.app).get('/api/v1/worker/other').set(t.worker)).status).toBe(404);
  });
});

describe('queuing', () => {
  it('needs a linked single audio file, a subtitle folder, and checks the archive first', async () => {
    const t = await jobEnv();
    // No link.
    let res = await t.queue(HITSUJI);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_audiobook');
    // A folder of several files that is not linked to one file.
    expect((await t.linkAudio(GUIN, 'japanese/_Unknown/グイン・サーガ')).status).toBe(200);
    res = await t.queue(GUIN);
    expect(res.body.error.code).toBe('not_playable');

    // The archive already has this volume's subtitles: offered first.
    const spyFolder = 'japanese/_Unknown/スパイ教室/Vol 2 - スパイ教室02 《愛娘》のグレーテ';
    expect((await t.linkAudio(SPY, spyFolder)).status).toBe(200);
    res = await t.queue(SPY);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('archive_match');
    expect(res.body.error.candidates[0].name).toBe('[2巻] スパイ教室02 《愛娘》のグレーテ.srt');
    expect(await t.latest(SPY)).toBeNull();
    // "Make new subtitles anyway".
    res = await t.queue(SPY, { force: true });
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ state: 'queued', kind: 'sync_subtitles', bookTitle: SPY });
    expect(res.body.job.userId).toBeUndefined();
    // One job per book at a time.
    res = await t.queue(SPY, { force: true });
    expect(res.body.error.code).toBe('busy');

    // No subtitle folder for the library.
    expect((await t.linkAudio(HITSUJI, HITSUJI_FOLDER)).status).toBe(200);
    updateLibrary(t.e.db, t.libId, { subtitleDir: null });
    res = await t.queue(HITSUJI);
    expect(res.body.error.code).toBe('no_subtitle_dir');
    // Unknown book.
    res = await request(t.app).post('/api/v1/books/nope/subtitle-job').set(t.auth).send({});
    expect(res.status).toBe(404);
  });
});

describe('a job from start to finish', () => {
  it('hands the job to the worker, serves only its files, saves and links the result', async () => {
    const t = await jobEnv();
    const before = t.tree();
    const id = await linkedAndQueued(t);
    expect((await t.status()).jobs.map((j: { id: number }) => j.id)).toEqual([id]);
    expect((await t.status()).online).toBe(false);

    expect((await t.heartbeat()).body).toEqual({ paused: false, pollSeconds: 30 });
    const job = await t.claim();
    expect(job).toMatchObject({
      id,
      kind: 'sync_subtitles',
      bookTitle: HITSUJI,
      audioFileName: '羊と鋼の森.m4b',
      leaseSeconds: 120,
    });
    expect(job.audioSize).toBeGreaterThan(0);
    expect(await t.claim()).toBeNull(); // one at a time
    const s = await t.status();
    expect(s.online).toBe(true);
    expect(s.version).toBe('1.0.0');

    // The job's own files only.
    const epub = await request(t.app).get(`/api/v1/worker/jobs/${id}/epub`).set(t.worker);
    expect(epub.status).toBe(200);
    expect(epub.headers['content-type']).toBe('application/epub+zip');
    const audio = await request(t.app)
      .get(`/api/v1/worker/jobs/${id}/audio`)
      .set(t.worker)
      .set('Range', 'bytes=0-7');
    expect(audio.status).toBe(206);
    expect(audio.headers['content-range']).toMatch(/^bytes 0-7\//);
    expect((await request(t.app).get(`/api/v1/worker/jobs/999/epub`).set(t.worker)).status).toBe(
      404,
    );

    expect(
      (await t.progress(id, { stage: 'syncing', progress: 0.4, message: 'SubPlz' })).body,
    ).toEqual({
      cancel: false,
    });
    expect(await t.latest(HITSUJI)).toMatchObject({
      state: 'running',
      stage: 'syncing',
      progress: 0.4,
      message: 'SubPlz',
      attempts: 1,
    });

    const res = await t.upload(id, `\uFEFF${SRT}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ state: 'done', outputName: `${HITSUJI}.srt`, linked: true });

    // Only the new file was added; it holds the SRT (without the BOM).
    const rel = `japanese-srt/_generated/${HITSUJI}.srt`;
    expect(treeDiff(before, t.tree())).toEqual({ added: [rel], removed: [], changed: [] });
    expect(fs.readFileSync(path.join(t.root, rel), 'utf8')).toBe(SRT);
    expect(getSubtitleFileByRelPath(t.e.db, rel)).toMatchObject({ name: `${HITSUJI}.srt` });
    const l = await t.link(HITSUJI);
    expect(l).toMatchObject({
      subtitleState: 'linked',
      subtitleRelPath: rel,
      subtitleStatus: 'ok',
    });
    expect(await t.latest(HITSUJI)).toMatchObject({
      state: 'done',
      linked: true,
      outputName: `${HITSUJI}.srt`,
      outputRelPath: rel,
    });
    // The finished job's files are closed to the worker; a second upload is refused.
    expect(
      (await request(t.app).get(`/api/v1/worker/jobs/${id}/epub`).set(t.worker)).body.error.code,
    ).toBe('not_running');
    expect((await t.upload(id, SRT)).status).toBe(409);
    expect((await t.status()).jobs).toEqual([]);

    // Again for the same book: the archive now has our file, so it is offered first;
    // anyway → a second file named with the book id, the first one untouched.
    const again = await t.queue(HITSUJI);
    expect(again.body.error.code).toBe('archive_match');
    expect(again.body.error.candidates[0].relPath).toBe(rel);
    const id2 = (await t.queue(HITSUJI, { force: true })).body.job.id;
    expect((await t.claim()).id).toBe(id2);
    const firstHash = t.tree()[rel];
    const res2 = await t.upload(id2, SRT.replace('テスト', '二回目'));
    expect(res2.body).toMatchObject({
      state: 'done',
      outputName: `${HITSUJI} ${t.bookId(HITSUJI)}.srt`,
      linked: true,
    });
    expect(t.tree()[rel]).toBe(firstHash);
  });

  it('saves but does not link when the link changed meanwhile', async () => {
    const t = await jobEnv();
    const id = await linkedAndQueued(t);
    expect((await t.claim()).id).toBe(id);
    // The user picks "No subtitles" while the job runs.
    await request(t.app)
      .put(`/api/v1/books/${t.bookId(HITSUJI)}/audio-link`)
      .set(t.auth)
      .send({ subtitle: { state: 'none' } });
    const res = await t.upload(id, SRT);
    expect(res.body).toMatchObject({ state: 'done', linked: false });
    expect((await t.link(HITSUJI)).subtitleState).toBe('none');
    expect(fs.existsSync(path.join(t.root, `japanese-srt/_generated/${HITSUJI}.srt`))).toBe(true);
  });
});

describe('the PC going away', () => {
  it('waits while the worker is off, re-queues an expired lease and fails after the attempts', async () => {
    const t = await jobEnv({ leaseSeconds: 60, maxAttempts: 2, offlineSeconds: 120 });
    const id = await linkedAndQueued(t);
    t.tick(3_600_000); // an hour with the PC off: the job just waits
    expect((await t.latest(HITSUJI)).state).toBe('queued');
    expect((await t.status()).online).toBe(false);

    expect((await t.claim()).id).toBe(id);
    t.tick(30_000);
    expect((await t.progress(id, { stage: 'syncing' })).body.cancel).toBe(false); // extends
    t.tick(50_000);
    expect((await t.latest(HITSUJI)).state).toBe('running');
    t.tick(20_000); // 70 s without a report
    const back = await t.latest(HITSUJI);
    expect(back).toMatchObject({ state: 'queued', stage: null, attempts: 1 });
    expect(back.message).toMatch(/stopped responding/);
    // A report from the lost run is told to stop.
    expect((await t.progress(id, { stage: 'syncing' })).body.cancel).toBe(true);

    expect((await t.claim()).id).toBe(id);
    t.tick(61_000);
    const failed = await t.latest(HITSUJI);
    expect(failed).toMatchObject({ state: 'failed', attempts: 2 });
    expect(failed.error).toMatch(/stopped responding during the job \(2 times\)/);
  });

  it('puts a job back when the worker says it is idle (it restarted)', async () => {
    const t = await jobEnv();
    const id = await linkedAndQueued(t);
    expect((await t.claim()).id).toBe(id);
    await t.heartbeat({ currentJobId: id }); // still on it
    expect((await t.latest(HITSUJI)).state).toBe('running');
    await t.heartbeat({ currentJobId: null });
    expect((await t.latest(HITSUJI)).state).toBe('queued');
    expect((await t.claim()).id).toBe(id);
    expect((await t.latest(HITSUJI)).attempts).toBe(2);
  });

  it('keeps a running job across a server restart (the lease is in the database)', async () => {
    const t = await jobEnv();
    const id = await linkedAndQueued(t);
    expect((await t.claim()).id).toBe(id);
    const restarted = new SubtitleJobService({
      db: t.e.db,
      scan: t.service,
      writer: new AudioWriter({ db: t.e.db, root: t.root, log: () => undefined }),
      config: DEFAULT_WORKER,
      log: () => undefined,
      logError: () => undefined,
    });
    t.audio.jobs = restarted;
    expect((await t.progress(id, { stage: 'syncing' })).body.cancel).toBe(false);
    expect((await t.upload(id, SRT)).body.state).toBe('done');
  });
});

describe('pause and stop', () => {
  it('hands out nothing while paused', async () => {
    const t = await jobEnv();
    const id = await linkedAndQueued(t);
    const paused = await request(t.app)
      .put('/api/v1/gpu-worker/paused')
      .set(t.auth)
      .send({ paused: true });
    expect(paused.body).toEqual({ paused: true });
    expect((await t.heartbeat()).body.paused).toBe(true);
    expect(await t.claim()).toBeNull();
    expect((await t.status()).paused).toBe(true);
    expect(
      (await request(t.app).put('/api/v1/gpu-worker/paused').set(t.auth).send({ paused: 'no' }))
        .status,
    ).toBe(400);
    await request(t.app).put('/api/v1/gpu-worker/paused').set(t.auth).send({ paused: false });
    expect((await t.claim()).id).toBe(id);
  });

  it('stops a waiting job at once and a running one through the worker, saving nothing', async () => {
    const t = await jobEnv();
    const before = t.tree();
    const id = await linkedAndQueued(t);
    let res = await request(t.app).post(`/api/v1/audio/subtitle-jobs/${id}/cancel`).set(t.auth);
    expect(res.body.job.state).toBe('cancelled');
    expect(await t.claim()).toBeNull();

    const id2 = (await t.queue(HITSUJI)).body.job.id;
    expect((await t.claim()).id).toBe(id2);
    res = await request(t.app).post(`/api/v1/audio/subtitle-jobs/${id2}/cancel`).set(t.auth);
    expect(res.body.job).toMatchObject({ state: 'running', cancelRequested: true });
    expect((await t.progress(id2, { stage: 'syncing' })).body.cancel).toBe(true);
    expect(
      (await request(t.app).get(`/api/v1/worker/jobs/${id2}/audio`).set(t.worker)).body.error.code,
    ).toBe('cancelled');
    // A result that arrives anyway is refused and not written.
    expect((await t.upload(id2, SRT)).body.error.code).toBe('cancelled');
    expect((await t.latest(HITSUJI)).state).toBe('cancelled');
    expect(treeDiff(before, t.tree())).toEqual({ added: [], removed: [], changed: [] });

    // Another user can't stop it.
    const id3 = (await t.queue(HITSUJI)).body.job.id;
    t.e.db
      .prepare("INSERT OR IGNORE INTO users (id, name, created_at) VALUES ('other-user', 'b', 0)")
      .run();
    const other = { Authorization: `Bearer ${createToken(t.e.db, 'other-user', 'B').token}` };
    expect(
      (await request(t.app).post(`/api/v1/audio/subtitle-jobs/${id3}/cancel`).set(other)).status,
    ).toBe(404);
  });
});

describe('results and failures', () => {
  it('refuses a broken or too large result and keeps server folders out of errors', async () => {
    const t = await jobEnv({ resultMaxMb: 0.001 });
    const before = t.tree();
    const id = await linkedAndQueued(t);
    expect((await t.claim()).id).toBe(id);
    let res = await t.upload(id, Buffer.alloc(5000, 0x41));
    expect(res.status).toBe(413);
    expect((await t.latest(HITSUJI)).state).toBe('running');
    res = await t.upload(id, 'no cues here');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_result');
    expect(await t.latest(HITSUJI)).toMatchObject({
      state: 'failed',
      error: 'The subtitle file has no subtitles in it',
    });

    const id2 = (await t.queue(HITSUJI)).body.job.id;
    expect((await t.claim()).id).toBe(id2);
    res = await request(t.app)
      .post(`/api/v1/worker/jobs/${id2}/fail`)
      .set(t.worker)
      .send({
        error: `SubPlz failed reading ${path.join(t.root, 'japanese', 'x.m4b')}: out of memory`,
        logTail: 'line 1\nline 2',
      });
    expect(res.body.state).toBe('failed');
    const failed = await t.latest(HITSUJI);
    expect(failed.error).toBe('SubPlz failed reading x.m4b: out of memory');
    expect(failed.logTail).toBe('line 1\nline 2');
    expect(treeDiff(before, t.tree())).toEqual({ added: [], removed: [], changed: [] });
  });

  it('fails a waiting job whose audio file is gone and moves on', async () => {
    const t = await jobEnv();
    const id = await linkedAndQueued(t);
    t.e.db
      .prepare('UPDATE audio_folders SET missing_at = 1 WHERE rel_path = ?')
      .run(HITSUJI_FOLDER);
    expect(await t.claim()).toBeNull();
    expect(await t.latest(HITSUJI)).toMatchObject({
      id,
      state: 'failed',
      error: 'The audiobook is no longer in the audiobooks folder',
    });
  });
});
