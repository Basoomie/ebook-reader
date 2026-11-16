/**
 * Season 2 Phase 12: Enrich's sentence audio read by the PC (sentence-audio.ts), the PC
 * voice choices (tts-voice-choice.ts), and the queue's order for them (subtitle-jobs.ts):
 * clips first, a running audiobook makes way after its chapter.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../src/db/migrations';
import { treeDiff } from './helpers/audio-fixtures';
import { HITSUJI, HITSUJI_FOLDER, SPY, type Track } from './helpers/worker-env';
import { flac, HAS_FFMPEG, probe, ttsEnv as makeTtsEnv } from './helpers/tts-env';

const track: Track = { envs: [], services: [] };
afterEach(async () => {
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

type Env = Awaited<ReturnType<typeof makeTtsEnv>>;
const ttsEnv = (opts: Parameters<typeof makeTtsEnv>[1] = {}) => makeTtsEnv(track, opts);

const LOOKUP = '善なるものは畢竟、遠い。';
const DEFAULT_MODEL = 1;

async function setup(opts: Parameters<typeof makeTtsEnv>[1] = {}) {
  const t = await ttsEnv(opts);
  const voice = await t.addVoice();
  const choose = (body: Record<string, unknown>) =>
    request(t.app).put('/api/v1/tts/voice-choice').set(t.auth).send(body);
  const queue = (book: string, body: Record<string, unknown>) =>
    request(t.app)
      .post(`/api/v1/books/${t.bookId(book)}/sentence-audio`)
      .set(t.auth)
      .send(body);
  const clipStatus = (id: string) => request(t.app).get(`/api/v1/sentence-audio/${id}`).set(t.auth);
  const script = async (jobId: number) =>
    (await request(t.app).get(`/api/v1/worker/jobs/${jobId}/script`).set(t.worker)).body
      .chapters as { index: number; sentences: { text: string; reading: string }[] }[];
  const jobOf = (clipId: string) =>
    t.e.db.prepare('SELECT job_id, idx FROM tts_sentence_clips WHERE id = ?').get(clipId) as {
      job_id: number;
      idx: number | null;
    };
  return { ...t, voice, choose, queue, clipStatus, script, jobOf };
}

describe('migration 21', () => {
  it('rebuilds worker_jobs for sentence audio and keeps every job and finished chapter', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.filter((m) => m.version <= 20)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u1', 'me', 1)").run();
    db.prepare(
      `INSERT INTO worker_jobs (id, user_id, book_id, kind, state, params, version, chapters_total,
         chapters_done, claim_chapters, created_at, updated_at)
       VALUES (7, 'u1', 'b1', 'generate_audiobook', 'running', '{"mapVersion":1}', 2, 3, 1, 1, 10, 20)`,
    ).run();
    db.prepare(
      `INSERT INTO tts_job_chapters (job_id, idx, title, duration_ms, cues, part_file, bytes, done_at)
       VALUES (7, 0, '第一章', 5000, '{"cues":[[0,4000]]}', 'part-0000.flac', 1234, 30)`,
    ).run();
    db.prepare(
      'INSERT INTO worker_status (id, paused, last_seen_at, updated_at) VALUES (1, 1, 5, 5)',
    ).run();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM worker_jobs').get()).toMatchObject({
      id: 7,
      kind: 'generate_audiobook',
      state: 'running',
      version: 2,
      chapters_total: 3,
      chapters_done: 1,
      claim_chapters: 1,
    });
    expect(db.prepare('SELECT * FROM tts_job_chapters').all()).toEqual([
      {
        job_id: 7,
        idx: 0,
        title: '第一章',
        duration_ms: 5000,
        cues: '{"cues":[[0,4000]]}',
        part_file: 'part-0000.flac',
        bytes: 1234,
        done_at: 30,
      },
    ]);
    expect(db.prepare('SELECT paused, kinds FROM worker_status').get()).toEqual({
      paused: 1,
      kinds: null,
    });
    db.prepare(
      `INSERT INTO worker_jobs (user_id, book_id, kind, state, created_at, updated_at)
       VALUES ('u1', 'b1', 'sentence_audio', 'queued', 1, 1)`,
    ).run();
    // The chapters still belong to their job (deleting it deletes them).
    db.prepare('DELETE FROM worker_jobs WHERE id = 7').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM tts_job_chapters').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

const readClip = async (t: Env, jobId: number, idx: number, seconds = 2, cueEnd = 1500) => {
  await t.uploadChapter(jobId, idx, flac(`clip${seconds}`, seconds));
  return t.doneChapter(jobId, idx, { durationMs: seconds * 1000, cues: [[0, cueEnd]] });
};

describe.skipIf(!HAS_FFMPEG)('sentence audio from the PC (Season 2 Phase 12)', () => {
  it('is off until a voice is chosen, then queues the Enrich sentence with its furigana', async () => {
    const t = await setup();
    const off = await t.queue(HITSUJI, { text: LOOKUP, position: 0 });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('voice_choice_off');
    expect((await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL })).status).toBe(200);
    expect(
      (await request(t.app).get('/api/v1/tts/voice-choice').set(t.auth)).body.choice,
    ).toMatchObject({
      voiceId: t.voice.id,
      modelId: DEFAULT_MODEL,
      voiceName: 'Narrator',
      problem: null,
    });

    const res = await t.queue(HITSUJI, { text: LOOKUP, position: 0 });
    expect(res.status).toBe(202);
    expect(res.body.clip).toMatchObject({ state: 'queued', found: true, durationMs: null });
    const id = res.body.clip.id as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const st = (await t.clipStatus(id)).body;
    expect(st.clip.state).toBe('queued');
    expect(st.pc).toMatchObject({ online: false, readsClips: null, ahead: null });

    const claimed = await t.claim();
    expect(claimed).toMatchObject({ kind: 'sentence_audio' });
    expect(claimed.tts).toMatchObject({
      kind: 'sentence_audio',
      whole: false,
      caption: null,
      voice: { sha256: expect.any(String) },
      pauses: { sentenceMs: 300, paragraphMs: 700, chapterMs: 0 },
      chaptersTotal: 1,
    });
    expect(await t.script(claimed.id)).toEqual([
      {
        index: 0,
        title: `Sentence ${id.slice(0, 8)}`,
        sentences: [
          { text: LOOKUP, reading: '善なるものはひっきょう、遠い。', paragraphEnd: true },
        ],
      },
    ]);
    expect((await t.clipStatus(id)).body.clip.state).toBe('running');
    expect(t.before).toBeDefined();
    expect(treeDiff(t.before, t.tree())).toEqual({ added: [], removed: [], changed: [] });
  });

  it('cuts the read clip where its sentence ends, serves it as MP3, and deletes it once fetched', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const id = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    const job = (await t.claim()).id as number;
    expect((await readClip(t, job, 0, 2, 1500)).body.state).toBe('done');
    const st = (await t.clipStatus(id)).body;
    expect(st.clip).toMatchObject({ state: 'done', durationMs: 1500 });
    expect(st.clip.bytes).toBeGreaterThan(1000);
    const audio = await request(t.app)
      .get(`/api/v1/sentence-audio/${id}/audio`)
      .set(t.auth)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    const file = path.join(t.cacheDir, 'tts', String(job), `clip-${id}.mp3`);
    expect(fs.existsSync(file)).toBe(true);
    expect((audio.body as Buffer).equals(fs.readFileSync(file))).toBe(true);
    const p = probe(file);
    expect(p.streams[0].codec_name).toBe('mp3');
    expect(Math.abs(Number(p.format.duration) - 1.5)).toBeLessThan(0.1);
    // The FLAC the PC sent is not kept.
    expect(fs.existsSync(path.join(t.cacheDir, 'tts', String(job), 'part-0000.flac'))).toBe(false);
    // Somebody else's device can't see it.
    expect(
      (
        await request(t.app)
          .get(`/api/v1/sentence-audio/${'0'.repeat(32)}`)
          .set(t.auth)
      ).status,
    ).toBe(404);

    expect((await request(t.app).delete(`/api/v1/sentence-audio/${id}`).set(t.auth)).status).toBe(
      204,
    );
    expect(fs.existsSync(file)).toBe(false);
    expect((await t.clipStatus(id)).status).toBe(404);
    expect(
      (await request(t.app).get(`/api/v1/sentence-audio/${id}/audio`).set(t.auth)).status,
    ).toBe(404);
  });

  it('lets clips join the waiting job, so the PC loads the model once for all of them', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const a = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    const b = (await t.queue(HITSUJI, { text: 'けれども悪は近い！', position: 11 })).body.clip
      .id as string;
    // Other pauses, or another book: a job of their own.
    const c = (
      await t.queue(HITSUJI, {
        text: '最後の文。',
        position: 20,
        pauses: { sentenceMs: 100, paragraphMs: 700, chapterMs: 2000 },
      })
    ).body.clip.id as string;
    const d = (await t.queue(SPY, { text: '最後の文。', position: 20 })).body.clip.id as string;
    expect(t.jobOf(a).job_id).toBe(t.jobOf(b).job_id);
    expect([t.jobOf(a).idx, t.jobOf(b).idx]).toEqual([0, 1]);
    expect(t.jobOf(c).job_id).not.toBe(t.jobOf(a).job_id);
    expect(t.jobOf(d).job_id).not.toBe(t.jobOf(a).job_id);
    const job = (await t.claim()).id as number;
    expect(job).toBe(t.jobOf(a).job_id);
    expect((await t.script(job)).map((ch) => ch.sentences[0].text)).toEqual([
      LOOKUP,
      'けれども悪は近い！',
    ]);
    // A running job takes no more clips.
    const e = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    expect(t.jobOf(e).job_id).not.toBe(job);
    expect((await readClip(t, job, 0)).body.state).toBe('running');
    expect((await readClip(t, job, 1)).body.state).toBe('done');
    expect((await t.clipStatus(a)).body.clip.state).toBe('done');
    expect((await t.clipStatus(b)).body.clip.state).toBe('done');
  });

  it('goes before waiting jobs, and a running audiobook makes way after its chapter', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    // Older audiobook waiting: the clip still goes first.
    const book = (await t.startBook(SPY, { voiceId: t.voice.id })).body.job.id as number;
    const clip1 = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    const first = (await t.claim()).id as number;
    expect(first).toBe(t.jobOf(clip1).job_id);
    await readClip(t, first, 0);
    // Now the audiobook runs; a clip comes in.
    expect((await t.claim()).id).toBe(book);
    expect((await t.progress(book, { stage: 'generating' })).body).toEqual({
      cancel: false,
      pause: false,
      yield: false,
    });
    const clip2 = (await t.queue(HITSUJI, { text: 'けれども悪は近い！', position: 11 })).body.clip
      .id as string;
    const st = (await t.clipStatus(clip2)).body;
    expect(st.clip.state).toBe('queued');
    expect(st.pc.ahead).toMatchObject({ kind: 'generate_audiobook', makesWay: true });
    expect((await t.progress(book, { stage: 'generating' })).body).toEqual({
      cancel: false,
      pause: true,
      yield: false,
    });
    // The PC finishes its chapter and gives the job back (WP17's pause path).
    await t.uploadChapter(book, 0, flac('ch0', 2));
    await t.doneChapter(book, 0, {
      durationMs: 2000,
      cues: [
        [0, 800],
        [900, 1800],
      ],
    });
    const released = (
      await request(t.app).post(`/api/v1/worker/jobs/${book}/release`).set(t.worker).send({})
    ).body;
    expect(released).toEqual({ state: 'queued' });
    expect(t.jobs.get(book)).toMatchObject({
      state: 'queued',
      message: 'Paused for sentence audio for Anki; it continues next.',
      chaptersDone: 1,
    });
    const second = (await t.claim()).id as number;
    expect(second).toBe(t.jobOf(clip2).job_id);
    await readClip(t, second, 0);
    // Then the audiobook again, with its next chapter, and no more making way.
    const again = await t.claim();
    expect(again.id).toBe(book);
    expect(again.tts.chaptersDone).toBe(1);
    expect((await t.progress(book, { stage: 'generating' })).body.pause).toBe(false);
  });

  it("doesn't stop an audiobook for a PC whose program can't read sentence audio", async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const book = (await t.startBook(SPY, { voiceId: t.voice.id })).body.job.id as number;
    const old = ['sync_subtitles', 'generate_audiobook', 'preview_audiobook', 'voice_sample'];
    const claimed = (
      await request(t.app).post('/api/v1/worker/claim').set(t.worker).send({ kinds: old })
    ).body.job;
    expect(claimed.id).toBe(book);
    const clip = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    expect((await t.progress(book, { stage: 'generating' })).body.pause).toBe(false);
    const st = (await t.clipStatus(clip)).body;
    expect(st.pc).toMatchObject({ readsClips: false, ahead: { makesWay: false } });
  });

  it('refuses a book with an audiobook, too long a sentence, and an unusable choice', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    expect((await t.queue(HITSUJI, { text: '   ' })).body.error.code).toBe('no_text');
    const long = await t.queue(HITSUJI, { text: 'あ'.repeat(501) });
    expect(long.body.error).toMatchObject({
      code: 'too_long',
      message: 'the sentence is longer than 500 characters',
    });
    // The global choice names a voice that is then deleted.
    expect((await request(t.app).delete(`/api/v1/voices/${t.voice.id}`).set(t.auth)).status).toBe(
      204,
    );
    const gone = await t.queue(HITSUJI, { text: LOOKUP });
    expect(gone.body.error).toMatchObject({
      code: 'bad_choice',
      message: 'The chosen voice was deleted: choose again in Settings > Anki',
    });
    expect((await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL })).body.error.code).toBe(
      'no_voice',
    );
    const v2 = await t.addVoice('Second');
    expect((await t.choose({ voiceId: v2.id, modelId: 999 })).body.error.code).toBe('no_model');
    expect((await t.choose({ voiceId: v2.id, modelId: DEFAULT_MODEL })).status).toBe(200);
    // A linked audiobook: its sentence audio comes from it.
    await t.linkAudio(HITSUJI, HITSUJI_FOLDER);
    const linked = await t.queue(HITSUJI, { text: LOOKUP });
    expect(linked.status).toBe(409);
    expect(linked.body.error.code).toBe('has_audiobook');
    // Off again.
    expect((await request(t.app).delete('/api/v1/tts/voice-choice').set(t.auth)).status).toBe(204);
    expect((await t.queue(SPY, { text: LOOKUP })).body.error.code).toBe('voice_choice_off');
  });

  it("uses the book's own choice over the one for every book", async () => {
    const t = await setup();
    const other = await t.addVoice('Book voice');
    const bookUrl = `/api/v1/books/${t.bookId(HITSUJI)}/tts-voice-choice`;
    expect((await request(t.app).get(bookUrl).set(t.auth)).body).toEqual({
      book: null,
      global: null,
      effective: null,
    });
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const set = await request(t.app)
      .put(bookUrl)
      .set(t.auth)
      .send({ voiceId: other.id, modelId: 2 });
    expect(set.body.effective).toMatchObject({ voiceId: other.id, modelId: 2, from: 'book' });
    expect(set.body.global).toMatchObject({ voiceId: t.voice.id });
    const id = (await t.queue(HITSUJI, { text: LOOKUP })).body.clip.id as string;
    const claimed = await t.claim();
    expect(claimed.id).toBe(t.jobOf(id).job_id);
    const params = t.jobs.get(claimed.id)!.params as {
      voices: { narration: { voiceId: string } };
      model: { id: number };
    };
    expect([params.voices.narration.voiceId, params.model.id]).toEqual([other.id, 2]);
    // Another book uses the global one.
    const cleared = await request(t.app).delete(bookUrl).set(t.auth);
    expect(cleared.body.effective).toMatchObject({ voiceId: t.voice.id, from: 'global' });
  });

  it('applies the pronunciation fixes, the book keeping its furigana', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    for (const [match, reading] of [
      ['悪', 'あく'],
      ['畢竟', 'つまり'],
    ]) {
      const r = await request(t.app)
        .post('/api/v1/pronunciation-fixes')
        .set(t.auth)
        .send({ kind: 'word', match, reading });
      expect(r.status).toBe(201);
    }
    await t.queue(HITSUJI, { text: 'ものは畢竟、遠い。けれども悪は', position: 3 });
    const job = (await t.claim()).id as number;
    expect((await t.script(job))[0].sentences).toEqual([
      { text: 'ものは畢竟、遠い。', reading: 'ものはひっきょう、遠い。', paragraphEnd: false },
      { text: 'けれども悪は', reading: 'けれどもあくは', paragraphEnd: true },
    ]);
  });

  it('reads the text as it is when it is not in the book', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const res = await t.queue(HITSUJI, { text: '本にない文。', position: 3 });
    expect(res.body.clip.found).toBe(false);
    const job = (await t.claim()).id as number;
    expect((await t.script(job))[0].sentences).toEqual([
      { text: '本にない文。', reading: '本にない文。', paragraphEnd: true },
    ]);
  });

  it('takes a cancelled clip out of its waiting job, and stops the job when none is left', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const a = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    const b = (await t.queue(HITSUJI, { text: 'けれども悪は近い！', position: 11 })).body.clip
      .id as string;
    const job = t.jobOf(a).job_id;
    expect((await request(t.app).delete(`/api/v1/sentence-audio/${a}`).set(t.auth)).status).toBe(
      204,
    );
    expect(t.jobOf(b)).toEqual({ job_id: job, idx: 0 });
    expect(t.jobs.get(job)).toMatchObject({ state: 'queued', chaptersTotal: 1 });
    expect((await t.clipStatus(a)).body.clip.state).toBe('cancelled');
    await request(t.app).delete(`/api/v1/sentence-audio/${b}`).set(t.auth);
    expect(t.jobs.get(job)!.state).toBe('cancelled');
    expect(await t.claim()).toBeNull();
  });

  it('keeps the numbering of a job the PC already read part of', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const a = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    const b = (await t.queue(HITSUJI, { text: 'けれども悪は近い！', position: 11 })).body.clip
      .id as string;
    const job = (await t.claim()).id as number;
    expect((await readClip(t, job, 0)).body.state).toBe('running');
    // The PC restarts: the job goes back to the queue with one clip read.
    await t.heartbeat({ currentJobId: null });
    expect(t.jobs.get(job)).toMatchObject({ state: 'queued', chaptersDone: 1 });
    await request(t.app).delete(`/api/v1/sentence-audio/${b}`).set(t.auth);
    expect(t.jobOf(b)).toEqual({ job_id: job, idx: 1 });
    expect(t.jobs.get(job)!.chaptersTotal).toBe(2);
    expect((await t.claim()).id).toBe(job);
    expect((await t.script(job)).map((c) => c.index)).toEqual([1]);
    expect((await readClip(t, job, 1)).body.state).toBe('done');
    expect((await t.clipStatus(a)).body.clip.state).toBe('done');
    expect((await t.clipStatus(b)).body.clip.state).toBe('cancelled');
  });

  it('throws away a clip cancelled while the PC reads it', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const a = (await t.queue(HITSUJI, { text: LOOKUP, position: 0 })).body.clip.id as string;
    const job = (await t.claim()).id as number;
    await request(t.app).delete(`/api/v1/sentence-audio/${a}`).set(t.auth);
    expect((await readClip(t, job, 0)).body.state).toBe('done');
    expect((await t.clipStatus(a)).body.clip.state).toBe('cancelled');
    // Nothing kept: the read clip and the job's folder are gone.
    const dir = path.join(t.cacheDir, 'tts', String(job));
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('says why when the job failed or was stopped on the PC', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const a = (await t.queue(HITSUJI, { text: LOOKUP })).body.clip.id as string;
    const job = (await t.claim()).id as number;
    await request(t.app)
      .post(`/api/v1/worker/jobs/${job}/fail`)
      .set(t.worker)
      .send({ error: 'CUDA out of memory' });
    expect((await t.clipStatus(a)).body.clip).toMatchObject({
      state: 'failed',
      error: 'CUDA out of memory',
    });
    const b = (await t.queue(HITSUJI, { text: LOOKUP })).body.clip.id as string;
    await request(t.app)
      .post(`/api/v1/audio/subtitle-jobs/${t.jobOf(b).job_id}/cancel`)
      .set(t.auth);
    expect((await t.clipStatus(b)).body.clip).toMatchObject({
      state: 'failed',
      error: 'it was stopped in Settings > Audiobooks',
    });
  });

  it('keeps a clip nobody fetched until TTS_CLIP_KEEP_DAYS, then forgets it', async () => {
    const t = await setup({ clipKeepDays: 2 });
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    const a = (await t.queue(HITSUJI, { text: LOOKUP })).body.clip.id as string;
    const job = (await t.claim()).id as number;
    await readClip(t, job, 0);
    const dir = path.join(t.cacheDir, 'tts', String(job));
    await t.tts.sweep();
    expect(fs.existsSync(path.join(dir, `clip-${a}.mp3`))).toBe(true);
    t.tickAll(86_400_000);
    await t.tts.sweep();
    expect((await t.clipStatus(a)).status).toBe(200);
    t.tickAll(2 * 86_400_000);
    expect((await t.clipStatus(a)).status).toBe(404);
    await t.tts.sweep();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('shows clip jobs with the other jobs in Settings > Audiobooks', async () => {
    const t = await setup();
    await t.choose({ voiceId: t.voice.id, modelId: DEFAULT_MODEL });
    await t.queue(HITSUJI, { text: LOOKUP });
    const status = await t.status();
    expect(status.jobs.map((j: { kind: string }) => j.kind)).toEqual(['sentence_audio']);
  });
});
