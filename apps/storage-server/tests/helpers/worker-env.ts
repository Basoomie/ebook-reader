/**
 * WP16 tests: a catalog with three books, the audiobooks root of audio-fixtures plus a
 * single-file audiobook without archive subtitles (羊と鋼の森), a SubtitleJobService with
 * a test clock, and a GPU worker token. Shared by the server and worker tests.
 */
import request from 'supertest';
import { AudioWriter } from '../../src/audio/audio-write';
import type { AudioScanService } from '../../src/audio/scan-service';
import { SubtitleJobService } from '../../src/audio/subtitle-jobs';
import { DEFAULT_WORKER, type WorkerConfig } from '../../src/config';
import { createToken } from '../../src/db/tokens';
import { listUsers } from '../../src/db/users';
import { audioEnv, m4b, makeAudiobooksRoot, treeHashes, write } from './audio-fixtures';
import type { IndexerEnv } from './indexer-env';

export interface Track {
  envs: IndexerEnv[];
  services: AudioScanService[];
}

export const SRT =
  '1\n00:00:01,000 --> 00:00:02,500\n羊と鋼の森\n\n2\n00:00:03,000 --> 00:00:04,000\nテスト\n';
export const HITSUJI = '羊と鋼の森';
export const SPY = 'スパイ教室02 《愛娘》のグレーテ';
export const GUIN = 'グイン・サーガ';
export const HITSUJI_FOLDER = 'japanese/_Unknown/羊と鋼の森 (文春文庫)';

export async function jobEnv(track: Track, config: Partial<WorkerConfig> = {}) {
  const root = makeAudiobooksRoot();
  write(root, `${HITSUJI_FOLDER}/羊と鋼の森.m4b`, m4b(30_000));
  const env = await audioEnv(track, { root, books: [HITSUJI, SPY, GUIN] });
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
    setClock: (ms: number) => {
      clock = ms;
    },
  };
}

export type JobEnv = Awaited<ReturnType<typeof jobEnv>>;
