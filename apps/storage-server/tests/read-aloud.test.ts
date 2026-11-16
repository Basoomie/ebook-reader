/**
 * Season 2 Phase 12 session 3: live read-aloud with the PC voice (read-aloud.ts) and what it
 * does to the PC's queue (subtitle-jobs.ts): sessions, batches with the pronunciation fixes,
 * the PC's long-polls, FLAC → MP3, the keep time of the loaded voice, a running audiobook
 * making way at once, and migration 22.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../src/db/migrations';
import { HITSUJI, SPY, type Track } from './helpers/worker-env';
import { flac, HAS_FFMPEG, ttsEnv as makeTtsEnv } from './helpers/tts-env';

const track: Track = { envs: [], services: [] };
afterEach(async () => {
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

const DEFAULT_MODEL = 1;
const ENGINE = {
  state: 'ready',
  source: 'Aratako/Irodori-TTS-v4.1-Small',
  revision: 'f'.repeat(40),
};

/** What the device sends (book-script.ts sentences). */
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

async function setup(opts: Parameters<typeof makeTtsEnv>[1] = {}) {
  const t = await makeTtsEnv(track, opts);
  const voice = await t.addVoice();
  const api = (method: 'get' | 'post' | 'put' | 'delete', url: string) =>
    request(t.app)[method](`/api/v1${url}`).set(t.auth);
  const chooseGlobal = () =>
    api('put', '/tts/voice-choice').send({ voiceId: voice.id, modelId: DEFAULT_MODEL });
  const open = (book: string | null, extra: Record<string, unknown> = {}) =>
    api('post', '/read-aloud/sessions').send({
      bookId: book === null ? null : t.bookId(book),
      ...extra,
    });
  const batch = (id: string, body: Record<string, unknown>) =>
    api('post', `/read-aloud/sessions/${id}/batches`).send(body);
  const poll = (id: string, q = '') => api('get', `/read-aloud/sessions/${id}${q}`);
  const live = { Authorization: t.worker.Authorization };
  const next = (body: Record<string, unknown> = {}) =>
    request(t.app)
      .post('/api/v1/worker/live/next')
      .set(live)
      .send({ engine: ENGINE, ...body });
  const beat = (body: Record<string, unknown> = {}) =>
    t.heartbeat({ version: '1.2.0', engine: ENGINE, ...body });
  const upload = (session: string, seq: number, seconds: number) =>
    request(t.app)
      .put(`/api/v1/worker/live/${session}/${seq}`)
      .set(live)
      .set('Content-Type', 'audio/flac')
      .send(fs.readFileSync(flac(`live${seconds}`, seconds)));
  const done = (session: string, seq: number, body: Record<string, unknown>) =>
    request(t.app).post(`/api/v1/worker/live/${session}/${seq}/done`).set(live).send(body);
  const claimAs = async (kinds?: string[], engine: unknown = ENGINE) =>
    (await request(t.app).post('/api/v1/worker/claim').set(live).send({ kinds, engine })).body.job;
  return { ...t, voice, api, chooseGlobal, open, batch, poll, next, beat, upload, done, claimAs };
}

describe('migration 22', () => {
  it('adds the keep time (10 minutes), the voice process and its last use', () => {
    const db = new Database(':memory:');
    for (const m of MIGRATIONS.filter((m) => m.version <= 21)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare(
      'INSERT INTO worker_status (id, paused, last_seen_at, updated_at, kinds) VALUES (1, 1, 5, 5, \'["sentence_audio"]\')',
    ).run();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(22);
    expect(
      db
        .prepare(
          'SELECT paused, last_seen_at, kinds, keep_loaded_minutes, engine, voice_used_at FROM worker_status',
        )
        .get(),
    ).toEqual({
      paused: 1,
      last_seen_at: 5,
      kinds: '["sentence_audio"]',
      keep_loaded_minutes: 10,
      engine: null,
      voice_used_at: null,
    });
  });
});

describe.skipIf(!HAS_FFMPEG)('live read-aloud (Season 2 Phase 12 session 3)', () => {
  it('needs a PC voice; a book outside the library uses the one for every book', async () => {
    const t = await setup();
    const off = await t.open(HITSUJI);
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('voice_choice_off');
    expect((await t.open(null)).body.error.code).toBe('voice_choice_off');
    expect((await t.api('post', '/read-aloud/sessions').send({ bookId: 'nope' })).status).toBe(404);
    await t.chooseGlobal();
    const outside = await t.open(null);
    expect(outside.status).toBe(201);
    expect(outside.body.session).toMatchObject({
      bookId: null,
      state: 'open',
      voice: { name: 'Narrator', from: 'global' },
      batches: [],
      pc: { online: false, supportsLive: false, answering: false, engine: null, busy: null },
    });
    // The book's own voice wins.
    const other = await t.addVoice('Other');
    await t
      .api('put', `/books/${t.bookId(HITSUJI)}/tts-voice-choice`)
      .send({ voiceId: other.id, modelId: DEFAULT_MODEL });
    const book = await t.open(HITSUJI);
    expect(book.body.session.voice).toMatchObject({ name: 'Other', from: 'book' });
    // That took over: the first session is told why.
    const first = await t.poll(outside.body.session.id);
    expect(first.status).toBe(410);
    expect(first.body.error).toMatchObject({ code: 'ended', why: 'takeover' });
  });

  it('reads a batch with the fixes and the book furigana, as MP3, on a 1.2.0 PC', async () => {
    const t = await setup();
    await t.chooseGlobal();
    // A book fix and a global one; the book's furigana wins over a fix on 畢竟.
    await t.api('post', '/pronunciation-fixes').send({
      bookId: t.bookId(HITSUJI),
      kind: 'word',
      match: '畢竟',
      reading: 'つまり',
    });
    await t
      .api('post', '/pronunciation-fixes')
      .send({ kind: 'word', match: '悪', reading: 'あく' });
    const id = (await t.open(HITSUJI)).body.session.id as string;

    // An older PC program can't read aloud: nothing for it, and the queue is not held.
    expect((await t.heartbeat({ version: '1.1.2' })).body.live).toBe(false);
    expect((await t.poll(id)).body.session.pc).toMatchObject({ supportsLive: false });

    const b1 = await t.batch(id, { sentences: SENTENCES });
    expect(b1.status).toBe(202);
    expect(b1.body).toEqual({ seq: 1 });
    expect((await t.beat()).body).toMatchObject({ live: true, keepLoadedMinutes: 10 });
    // Loading the voice: the settings only, no batch taken.
    const loading = await t.next({ take: false, engine: { ...ENGINE, state: 'loading' } });
    expect(loading.body).toMatchObject({
      session: { id, model: { source: ENGINE.source }, pauses: { chapterMs: 0 } },
      batch: null,
    });
    const seen = (await t.poll(id)).body.session;
    expect(seen.pc).toMatchObject({
      supportsLive: true,
      answering: true,
      engine: { state: 'loading' },
    });
    expect(seen.batches).toEqual([
      { seq: 1, state: 'waiting', durationMs: null, cues: null, error: null },
    ]);

    const got = (await t.next({ wait: 1 })).body;
    expect(got.batch).toEqual({
      seq: 1,
      sentences: [
        { text: SENTENCES[0].text, reading: '善なるものはひっきょう、遠い。', paragraphEnd: false },
        { text: SENTENCES[1].text, reading: 'けれどもあくは近い！', paragraphEnd: true },
      ],
    });
    // The voice clip of the session.
    const voice = await request(t.app)
      .get(`/api/v1/worker/live/voice/${got.session.voice.sha256}`)
      .set(t.worker);
    expect(voice.status).toBe(200);
    expect(voice.headers['content-type']).toBe('audio/wav');

    expect((await t.upload(id, 1, 3)).status).toBe(200);
    const bad = await t.done(id, 1, { durationMs: 3000, cues: [[0, 1200]] });
    expect(bad.status).toBe(400);
    const ok = await t.done(id, 1, {
      durationMs: 3000,
      cues: [
        [0, 1200],
        [1500, 2700],
      ],
    });
    expect(ok.body).toEqual({ state: 'done' });
    const view = (await t.poll(id)).body.session;
    expect(view.batches).toEqual([
      {
        seq: 1,
        state: 'done',
        durationMs: 3000,
        cues: [
          [0, 1200],
          [1500, 2700],
        ],
        error: null,
      },
    ]);
    const mp3 = await t.api('get', `/read-aloud/sessions/${id}/batches/1/audio`).buffer(true);
    expect(mp3.status).toBe(200);
    expect(mp3.headers['content-type']).toBe('audio/mpeg');
    expect(mp3.body.length).toBeGreaterThan(10_000);
    // The device has it: the file goes.
    expect((await t.poll(id, '?after=1')).body.session.batches).toEqual([]);
    expect((await t.api('get', `/read-aloud/sessions/${id}/batches/1/audio`)).status).toBe(404);
    // Only CACHE_DIR/tts-live was written.
    expect(t.tree()).toEqual(t.before);
  });

  it('answers the PC and the device at once when something changes (long-polls)', async () => {
    const t = await setup();
    await t.chooseGlobal();
    await t.beat();
    // An idle PC waits in its check-in; a session wakes it.
    const t0 = Date.now();
    const waiting = t.beat({ wait: 10 });
    setTimeout(() => {
      void t.open(SPY).then((r) => t.batch(r.body.session.id, { sentences: SENTENCES }));
    }, 200);
    const answer = (await waiting).body;
    expect(answer.live).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);

    const id = ((await t.api('get', '/gpu-worker')).body.live as boolean)
      ? ((await t.next({ wait: 1 })).body.session.id as string)
      : '';
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // A device waiting for its batch is answered when the PC is done.
    const t1 = Date.now();
    const devicePoll = t.poll(id, '?wait=10&playing=1');
    setTimeout(() => {
      void t.upload(id, 1, 2).then(() =>
        t.done(id, 1, {
          durationMs: 2000,
          cues: [
            [0, 800],
            [1000, 1800],
          ],
        }),
      );
    }, 200);
    const polled = (await devicePoll).body.session;
    expect(Date.now() - t1).toBeLessThan(8000);
    expect(polled.batches[0].state).toBe('done');
    // Nothing left: the PC waits up to its time and gets the session without a batch.
    const empty = (await t.next({ wait: 0.2 })).body;
    expect(empty.batch).toBeNull();
  });

  it('holds the queue while it reads, makes a running audiobook yield at once, then keeps the voice', async () => {
    const t = await setup();
    await t.chooseGlobal();
    const started = await t.startBook(SPY, { voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    expect(started.status).toBe(202);
    // Nothing loaded on the PC yet: the audiobook is handed out.
    await t.beat({ engine: null });
    const job = await t.claimAs(['generate_audiobook', 'sentence_audio'], null);
    expect(job.kind).toBe('generate_audiobook');
    expect((await t.progress(job.id, { stage: 'generating' })).body).toEqual({
      cancel: false,
      pause: false,
      yield: false,
    });

    const id = (await t.open(HITSUJI)).body.session.id as string;
    // Opened but not playing: nothing yet.
    expect((await t.progress(job.id, { stage: 'generating' })).body.yield).toBe(false);
    await t.batch(id, { sentences: SENTENCES });
    expect((await t.progress(job.id, { stage: 'generating' })).body.yield).toBe(true);
    expect((await t.poll(id)).body.session.pc.busy).toEqual({
      kind: 'generate_audiobook',
      bookTitle: SPY,
      yielding: true,
    });
    // The PC kills it and releases it: back in the queue, no attempt used.
    await request(t.app).post(`/api/v1/worker/jobs/${job.id}/release`).set(t.worker);
    const released = t.jobs.get(job.id)!;
    expect(released).toMatchObject({
      state: 'queued',
      attempts: 0,
      message: 'Paused for read-aloud; it continues afterwards.',
    });
    // While read-aloud plays nothing is handed out.
    expect(await t.claimAs()).toBeNull();
    // A clip for Anki queued meanwhile waits too.
    await t.api('post', `/books/${t.bookId(HITSUJI)}/sentence-audio`).send({ text: '遠い。' });
    expect(await t.claimAs()).toBeNull();

    // Paused on the device (no batch left): the keep time runs from now; only clips are read.
    await t.poll(id, '?playing=0');
    await t.next({ wait: 0 }); // takes the batch
    await t.upload(id, 1, 2);
    await t.done(id, 1, {
      durationMs: 2000,
      cues: [
        [0, 800],
        [1000, 1800],
      ],
    });
    expect((await t.next({ wait: 0 })).body).toEqual({ end: true });
    const beat = (await t.beat()).body;
    expect(beat.live).toBe(false);
    expect(beat.keepVoiceSeconds).toBe(600);
    const clip = await t.claimAs();
    expect(clip.kind).toBe('sentence_audio');
    t.jobs.update(clip.id, { state: 'done' });
    expect(await t.claimAs()).toBeNull();
    const status = (await t.api('get', '/gpu-worker')).body;
    expect(status).toMatchObject({ keepLoadedMinutes: 10, live: false, engine: ENGINE });
    expect(typeof status.keepVoiceUntil).toBe('number');

    // 10 minutes after the last use the PC lets the voice go, and the audiobook goes on.
    t.tickAll(10 * 60_000 + 1000);
    expect((await t.beat()).body.keepVoiceSeconds).toBe(0);
    await t.beat({ engine: null });
    const resumed = await t.claimAs(['generate_audiobook'], null);
    expect(resumed).toMatchObject({ id: job.id, kind: 'generate_audiobook' });
  });

  it('does not interrupt a subtitle job, and Pause stops read-aloud and lets the voice go', async () => {
    const t = await setup();
    await t.chooseGlobal();
    await t.linkAudio(HITSUJI, 'japanese/_Unknown/羊と鋼の森 (文春文庫)');
    expect((await t.queue(HITSUJI, { force: true })).status).toBe(202);
    await t.beat({ engine: null });
    const sub = await t.claimAs(undefined, null);
    expect(sub.kind).toBe('sync_subtitles');
    const id = (await t.open(SPY)).body.session.id as string;
    await t.batch(id, { sentences: SENTENCES });
    expect((await t.progress(sub.id, { stage: 'syncing' })).body.yield).toBe(false);
    expect((await t.poll(id)).body.session.pc.busy).toMatchObject({
      kind: 'sync_subtitles',
      yielding: false,
    });

    await t.api('put', '/gpu-worker/paused').send({ paused: true });
    const beat = (await t.beat()).body;
    expect(beat).toMatchObject({ paused: true, live: false, keepVoiceSeconds: 0 });
    expect((await t.next({ wait: 0 })).body).toEqual({ end: true });
    expect((await t.poll(id)).body.session.pc.paused).toBe(true);
  });

  it('answers a waiting check-in when a running job ends (an audiobook put together)', async () => {
    const t = await setup();
    await t.chooseGlobal();
    await t.startBook(SPY, { voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    await t.beat({ engine: null });
    const job = await t.claimAs(['generate_audiobook'], null);
    // Another job waits; the PC's check-in waits while the first one runs.
    await t.api('post', `/books/${t.bookId(HITSUJI)}/sentence-audio`).send({ text: '遠い。' });
    await t.chooseGlobal();
    const started = Date.now();
    const waiting = t.beat({ engine: null, wait: 10 });
    setTimeout(() => t.jobs.update(job.id, { state: 'done' }), 300);
    await waiting;
    expect(Date.now() - started).toBeLessThan(5000);
    // With the voice to let go (keep time 0) it is answered at once too.
    await t.api('put', '/gpu-worker/keep-loaded').send({ minutes: 0 });
    const t2 = Date.now();
    expect((await t.beat({ wait: 10 })).body.keepVoiceSeconds).toBe(0);
    expect(Date.now() - t2).toBeLessThan(5000);
  });

  it('keeps the voice as long as Settings says; refuses a bad value', async () => {
    const t = await setup();
    const put = (minutes: unknown) => t.api('put', '/gpu-worker/keep-loaded').send({ minutes });
    expect((await put(-1)).status).toBe(400);
    expect((await put(1.5)).status).toBe(400);
    expect((await put(25 * 60)).status).toBe(400);
    expect((await put(30)).body).toEqual({ keepLoadedMinutes: 30 });
    await t.beat();
    expect((await t.beat()).body).toMatchObject({ keepVoiceSeconds: 1800, keepLoadedMinutes: 30 });
    expect((await put(0)).body).toEqual({ keepLoadedMinutes: 0 });
    expect((await t.beat()).body.keepVoiceSeconds).toBe(0);
    // Nothing loaded: nothing to keep.
    expect((await t.beat({ engine: null })).body.keepVoiceSeconds).toBeNull();
  });

  it('ends a quiet session, puts back a batch the PC lost, and checks what the device sends', async () => {
    const t = await setup({ leaseSeconds: 30 });
    await t.chooseGlobal();
    const id = (await t.open(HITSUJI)).body.session.id as string;
    const send = (sentences: unknown, extra: Record<string, unknown> = {}) =>
      t.batch(id, { sentences, ...extra });
    expect((await send([])).status).toBe(400);
    expect((await send([{ text: '' }])).status).toBe(400);
    expect((await send([{ text: 'あ'.repeat(501) }])).status).toBe(400);
    expect((await send([{ text: 'あいう', ruby: [{ start: 2, end: 9, rt: 'x' }] }])).status).toBe(
      400,
    );
    expect((await send(Array(33).fill({ text: 'あ' }))).status).toBe(400);
    for (let i = 1; i <= 4; i++) expect((await send(SENTENCES)).body).toEqual({ seq: i });
    expect((await send(SENTENCES)).status).toBe(429);
    // Skipping: the waiting batches are dropped first.
    expect((await send(SENTENCES, { replace: true })).body).toEqual({ seq: 5 });
    expect((await t.poll(id)).body.session.batches.map((b: { seq: number }) => b.seq)).toEqual([5]);

    await t.beat();
    expect((await t.next()).body.batch.seq).toBe(5);
    t.tickAll(31_000);
    t.readAloud.housekeep();
    expect((await t.poll(id)).body.session.batches[0].state).toBe('waiting');

    t.tickAll(61_000);
    t.readAloud.housekeep();
    const ended = await t.poll(id);
    expect(ended.status).toBe(410);
    expect(ended.body.error.why).toBe('idle');
    // Stop on an ended session changes nothing.
    expect((await t.api('delete', `/read-aloud/sessions/${id}`)).status).toBe(204);
  });

  it('a failed batch says why; Stop ends the session and frees the queue', async () => {
    const t = await setup();
    await t.chooseGlobal();
    const id = (await t.open(HITSUJI)).body.session.id as string;
    await t.batch(id, { sentences: SENTENCES });
    await t.beat();
    await t.next();
    await request(t.app)
      .post(`/api/v1/worker/live/${id}/1/fail`)
      .set(t.worker)
      .send({ error: 'CUDA out of memory' });
    expect((await t.poll(id)).body.session.batches[0]).toMatchObject({
      state: 'failed',
      error: 'CUDA out of memory',
    });
    expect((await t.api('delete', `/read-aloud/sessions/${id}`)).status).toBe(204);
    expect((await t.poll(id)).body.error.why).toBe('stopped');
    expect((await t.beat()).body).toMatchObject({ live: false, keepVoiceSeconds: 600 });
  });
});
