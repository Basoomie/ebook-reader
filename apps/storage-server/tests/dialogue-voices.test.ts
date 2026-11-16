/**
 * Season 2 Phase 12 session 4: narration and dialogue voices (voice-map.ts, tts-jobs.ts,
 * sentence-audio.ts, read-aloud.ts, tts-voice-choice.ts, migration 23). The PC is played by
 * the test through the worker routes.
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { BookScript } from '../src/audio/book-script';
import { buildVoiceMap, parsePauses, TWO_VOICES_UPDATE, voiceRef } from '../src/audio/tts-jobs';
import {
  normalizeVoiceMap,
  readingOf,
  sentenceSegments,
  workerSegments,
  workerVoices,
} from '../src/audio/voice-map';
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../src/db/migrations';
import { buildReading } from '../src/pronunciation/fix-rules';
import { HITSUJI, type Track } from './helpers/worker-env';
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

/** A book with narration, a mixed sentence, and a quote with furigana (script v3). */
const SCRIPT: BookScript = {
  version: 3,
  characters: 60,
  chapters: [
    {
      index: 0,
      title: '第一章',
      startCharacter: 0,
      characters: 40,
      sentences: [
        {
          text: '地の文です。',
          reading: '地の文です。',
          ruby: [],
          position: 0,
          paragraphEnd: true,
        },
        {
          text: '「行こう」と彼は言った。',
          reading: '「行こう」と彼は言った。',
          ruby: [],
          position: 6,
          paragraphEnd: true,
          parts: [{ start: 0, end: 5, role: 'dialogue', quote: 0 }],
        },
        {
          text: '「畢竟、そうだ」',
          reading: '「ひっきょう、そうだ」',
          ruby: [{ start: 1, end: 3, rt: 'ひっきょう' }],
          position: 18,
          paragraphEnd: true,
          parts: [{ start: 0, end: 8, role: 'dialogue', quote: 1 }],
        },
      ],
    },
    {
      index: 1,
      title: '第二章',
      startCharacter: 40,
      characters: 20,
      sentences: [
        { text: '最後の文。', reading: '最後の文。', ruby: [], position: 40, paragraphEnd: true },
      ],
    },
  ],
};

async function setup() {
  const t = await makeTtsEnv(track, { script: SCRIPT });
  const narrator = await t.addVoice('Narrator');
  const speaker = await t.addVoice('Speaker', 5);
  const api = (method: 'get' | 'post' | 'put' | 'delete', url: string) =>
    request(t.app)[method](`/api/v1${url}`).set(t.auth);
  const script = async (jobId: number) =>
    (await request(t.app).get(`/api/v1/worker/jobs/${jobId}/script`).set(t.worker)).body
      .chapters as {
      index: number;
      sentences: {
        text: string;
        reading: string;
        segments?: { reading: string; voice: string }[];
      }[];
    }[];
  const sha = (voiceId: string) =>
    (
      t.e.db.prepare('SELECT sha256 FROM tts_voices WHERE id = ?').get(voiceId) as {
        sha256: string;
      }
    ).sha256;
  return { ...t, narrator, speaker, api, script, sha };
}

describe('the voice map (pure)', () => {
  const narration = {
    voiceId: 'n',
    name: 'N',
    kind: 'clip' as const,
    sha256: 'a'.repeat(64),
    description: null,
  };
  const model = { id: 1, source: 'o/m', revision: 'r', label: 'M' };

  it('reads a v1 job as v2 with one voice, its seed and pauses kept', () => {
    const v2 = normalizeVoiceMap({
      mapVersion: 1,
      narrator: narration,
      model,
      seed: 42,
      pauses: { sentenceMs: 1, paragraphMs: 2, chapterMs: 3 },
      fixes: { book: 1, global: 0, places: 2, digest: 'd' },
    })!;
    expect(v2).toMatchObject({
      mapVersion: 2,
      voices: { narration: { ...narration, seed: 42 } },
      roles: { narration: 'narration', dialogue: 'narration' },
      pauses: { sentenceMs: 1, paragraphMs: 2, chapterMs: 3, dialogueMs: 150 },
      fixes: { digest: 'd' },
    });
    expect(normalizeVoiceMap(null)).toBeNull();
    expect(normalizeVoiceMap({ mapVersion: 9 })).toBeNull();
    expect(workerVoices(v2)).toEqual({ narration: { sha256: 'a'.repeat(64), seed: 42 } });
  });

  it('keeps one voice when the dialogue voice is the same clip', () => {
    const n = { ...narration, seed: 1 };
    expect(buildVoiceMap(n, { ...n, seed: 2 }, model, parsePauses({})).roles.dialogue).toBe(
      'narration',
    );
    const two = buildVoiceMap(
      n,
      { ...n, voiceId: 'd', sha256: 'b'.repeat(64), seed: 2 },
      model,
      parsePauses({}),
    );
    expect(two.roles).toEqual({ narration: 'narration', dialogue: 'dialogue' });
    expect(Object.keys(workerVoices(two))).toEqual(['narration', 'dialogue']);
    // Each voice keeps the book's seed for it (a narration voice sounds as in v1).
    const ref = voiceRef(
      { id: 'v', name: 'V', kind: 'clip', sha256: 'c'.repeat(64), description: null },
      'b1',
    );
    expect(ref.seed).toBe(
      voiceRef(
        { id: 'w', name: 'W', kind: 'design', sha256: 'c'.repeat(64), description: 'x' },
        'b1',
      ).seed,
    );
  });

  it('gives each run its reading: furigana and fixes go to the run they start in', () => {
    const s = {
      text: '「畢竟、悪だ」と彼は言った。',
      reading: '',
      ruby: [{ start: 1, end: 3, rt: 'ひっきょう' }],
      parts: [{ start: 0, end: 7, role: 'dialogue' as const, quote: 3 }],
    };
    const hits = [
      { entryId: 1, start: 4, end: 5, reading: 'あく' },
      { entryId: 2, start: 8, end: 9, reading: 'かれ' },
    ];
    const segments = sentenceSegments(s, hits)!;
    expect(segments).toEqual([
      { reading: '「ひっきょう、あくだ」', role: 'dialogue', quote: 3 },
      { reading: 'とかれは言った。', role: 'narration', quote: null },
    ]);
    expect(segments.map((g) => g.reading).join('')).toBe(buildReading(s, hits));
    expect(sentenceSegments({ ...s, parts: undefined }, hits)).toBeUndefined();
    expect(readingOf(s)).toBe('「ひっきょう、悪だ」と彼は言った。');
    // A fix that crosses into the next run is said in the run where it starts.
    const across = sentenceSegments(s, [{ entryId: 3, start: 5, end: 9, reading: 'X' }])!;
    expect(across.map((g) => g.reading)).toEqual(['「ひっきょう、悪X', 'は言った。']);
  });

  it('joins runs of the same voice, so one voice reaches the PC as before', () => {
    const one = normalizeVoiceMap({
      mapVersion: 1,
      narrator: narration,
      model,
      seed: 1,
      pauses: { sentenceMs: 1, paragraphMs: 2, chapterMs: 3 },
    })!;
    const segments = [
      { reading: '「あ」', role: 'dialogue' as const, quote: 0 },
      { reading: 'と言った。', role: 'narration' as const, quote: null },
    ];
    expect(workerSegments(segments, one)).toBeUndefined();
    const two = buildVoiceMap(
      { ...narration, seed: 1 },
      { ...narration, voiceId: 'd', sha256: 'b'.repeat(64), seed: 2 },
      model,
      parsePauses({}),
    );
    expect(workerSegments(segments, two)).toEqual([
      { reading: '「あ」', voice: 'dialogue' },
      { reading: 'と言った。', voice: 'narration' },
    ]);
    expect(workerSegments([segments[0]], two)).toEqual([{ reading: '「あ」', voice: 'dialogue' }]);
  });
});

describe('migration 23', () => {
  it('adds the dialogue voice to the stored choices and keeps them', () => {
    const db = new Database(':memory:');
    for (const m of MIGRATIONS.filter((m) => m.version <= 22)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u1', 'u', 1)").run();
    db.prepare(
      "INSERT INTO tts_voice_choices (user_id, book_id, voice_id, model_id, updated_at) VALUES ('u1', NULL, 'v', 1, 5)",
    ).run();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare('SELECT * FROM tts_voice_choices').all()).toEqual([
      {
        user_id: 'u1',
        book_id: null,
        voice_id: 'v',
        model_id: 1,
        updated_at: 5,
        dialogue_voice_id: null,
      },
    ]);
  });
});

describe.skipIf(!HAS_FFMPEG)('two voices on the PC', () => {
  it('makes an audiobook with a dialogue voice: runs per voice, one cue per sentence', async () => {
    const t = await setup();
    const res = await t.startBook(HITSUJI, {
      voiceId: t.narrator.id,
      dialogueVoiceId: t.speaker.id,
      pauses: { dialogueMs: 120 },
    });
    expect(res.status).toBe(202);
    expect(res.body.job.params).toMatchObject({
      mapVersion: 2,
      voices: { narration: { name: 'Narrator' }, dialogue: { name: 'Speaker' } },
      roles: { narration: 'narration', dialogue: 'dialogue' },
      dialogueRule: 1,
      pauses: { dialogueMs: 120 },
    });
    const id = res.body.job.id as number;

    // An older PC program doesn't get it (it would read everything with one voice).
    await t.heartbeat({ version: '1.2.0' });
    expect(await t.claim()).toBeNull();
    expect((await t.latestBook(HITSUJI)).message).toBe(TWO_VOICES_UPDATE);

    await t.heartbeat({ version: '1.3.0' });
    const claimed = await t.claim();
    expect(claimed.id).toBe(id);
    expect(claimed.tts.voices).toEqual({
      narration: { sha256: t.sha(t.narrator.id), seed: expect.any(Number) },
      dialogue: { sha256: t.sha(t.speaker.id), seed: expect.any(Number) },
    });
    expect(claimed.tts.voice.sha256).toBe(t.sha(t.narrator.id));
    expect(claimed.tts.voices.narration.seed).toBe(claimed.tts.seed);
    expect(claimed.tts.voices.dialogue.seed).not.toBe(claimed.tts.seed);
    expect(claimed.tts.pauses.dialogueMs).toBe(120);

    const [ch0, ch1] = await t.script(id);
    expect(ch0.sentences).toEqual([
      { text: '地の文です。', reading: '地の文です。', paragraphEnd: true },
      {
        text: '「行こう」と彼は言った。',
        reading: '「行こう」と彼は言った。',
        paragraphEnd: true,
        segments: [
          { reading: '「行こう」', voice: 'dialogue' },
          { reading: 'と彼は言った。', voice: 'narration' },
        ],
      },
      {
        text: '「畢竟、そうだ」',
        reading: '「ひっきょう、そうだ」',
        paragraphEnd: true,
        segments: [{ reading: '「ひっきょう、そうだ」', voice: 'dialogue' }],
      },
    ]);
    expect(ch1.sentences[0].segments).toBeUndefined();

    // Both clips can be fetched; an unknown one can't.
    const dialogueClip = await request(t.app)
      .get(`/api/v1/worker/jobs/${id}/voice?sha=${t.sha(t.speaker.id)}`)
      .set(t.worker)
      .buffer(true);
    expect(dialogueClip.status).toBe(200);
    const narrationClip = await request(t.app)
      .get(`/api/v1/worker/jobs/${id}/voice`)
      .set(t.worker)
      .buffer(true);
    expect(narrationClip.status).toBe(200);
    expect(Buffer.compare(dialogueClip.body, narrationClip.body)).not.toBe(0);
    expect(
      (
        await request(t.app)
          .get(`/api/v1/worker/jobs/${id}/voice?sha=${'0'.repeat(64)}`)
          .set(t.worker)
      ).status,
    ).toBe(404);

    // One cue per sentence, as before: the srt has the sentences' text.
    await t.uploadChapter(id, 0, flac('d0', 4));
    await t.doneChapter(id, 0, {
      durationMs: 4000,
      cues: [
        [0, 900],
        [1200, 2400],
        [2700, 3600],
      ],
    });
    await t.uploadChapter(id, 1, flac('d1', 2));
    await t.doneChapter(id, 1, { durationMs: 2000, cues: [[0, 1500]] });
    await t.tts.idle();
    const job = await t.latestBook(HITSUJI);
    expect(job.state).toBe('done');
    const comment = t.logs.join('\n');
    expect(comment).not.toContain('ERROR');
  });

  it('keeps a one-voice job exactly as before (no segments, an older PC reads it)', async () => {
    const t = await setup();
    const res = await t.startBook(HITSUJI, {
      voiceId: t.narrator.id,
      dialogueVoiceId: t.narrator.id,
    });
    const id = res.body.job.id as number;
    expect(res.body.job.params.roles.dialogue).toBe('narration');
    await t.heartbeat({ version: '1.2.0' });
    const claimed = await t.claim();
    expect(claimed.id).toBe(id);
    expect(claimed.tts.voices).toEqual({
      narration: { sha256: t.sha(t.narrator.id), seed: claimed.tts.seed },
    });
    const [ch0] = await t.script(id);
    expect(ch0.sentences.every((s) => s.segments === undefined)).toBe(true);
  });

  it('applies the fixes in each run, the book keeping its furigana', async () => {
    const t = await setup();
    const book = t.bookId(HITSUJI);
    await t
      .api('post', '/pronunciation-fixes')
      .send({ bookId: book, kind: 'word', match: '彼', reading: 'かれ' });
    await t
      .api('post', '/pronunciation-fixes')
      .send({ bookId: book, kind: 'word', match: '畢竟', reading: 'つまり' });
    const res = await t.startBook(HITSUJI, {
      voiceId: t.narrator.id,
      dialogueVoiceId: t.speaker.id,
    });
    await t.heartbeat({ version: '1.3.0' });
    await t.claim();
    const [ch0] = await t.script(res.body.job.id);
    expect(ch0.sentences[1].segments).toEqual([
      { reading: '「行こう」', voice: 'dialogue' },
      { reading: 'とかれは言った。', voice: 'narration' },
    ]);
    expect(ch0.sentences[1].reading).toBe('「行こう」とかれは言った。');
    expect(ch0.sentences[2].segments).toEqual([
      { reading: '「ひっきょう、そうだ」', voice: 'dialogue' },
    ]);
  });

  it('starts a two-voice preview two sentences before the first dialogue', async () => {
    const long: BookScript = {
      ...SCRIPT,
      chapters: [
        {
          ...SCRIPT.chapters[0],
          sentences: [
            ...['一。', '二。', '三。', '四。'].map((text, k) => ({
              text,
              reading: text,
              ruby: [],
              position: k * 2,
              paragraphEnd: true,
            })),
            ...SCRIPT.chapters[0].sentences.slice(1),
          ],
        },
      ],
    };
    const t = await makeTtsEnv(track, { script: long });
    const narrator = await t.addVoice('Narrator');
    const speaker = await t.addVoice('Speaker', 5);
    const url = `/api/v1/books/${t.bookId(HITSUJI)}/audiobook-preview`;
    const two = await request(t.app)
      .post(url)
      .set(t.auth)
      .send({ voiceId: narrator.id, dialogueVoiceId: speaker.id });
    await t.heartbeat({ version: '1.3.0' });
    expect((await t.claim()).id).toBe(two.body.job.id);
    const read = (
      await request(t.app).get(`/api/v1/worker/jobs/${two.body.job.id}/script`).set(t.worker)
    ).body.chapters[0].sentences.map((s: { text: string }) => s.text);
    expect(read.slice(0, 3)).toEqual(['三。', '四。', '「行こう」と彼は言った。']);
  });

  it('stores a dialogue voice with the PC voice, and Enrich clips read with it', async () => {
    const t = await setup();
    const set = await t.api('put', '/tts/voice-choice').send({
      voiceId: t.narrator.id,
      dialogueVoiceId: t.speaker.id,
      modelId: DEFAULT_MODEL,
    });
    expect(set.status).toBe(200);
    const book = await t.api('get', `/books/${t.bookId(HITSUJI)}/tts-voice-choice`);
    expect(book.body.effective).toMatchObject({
      voiceName: 'Narrator',
      dialogueVoiceId: t.speaker.id,
      dialogueVoiceName: 'Speaker',
      from: 'global',
      problem: null,
    });
    expect(
      (
        await t
          .api('put', '/tts/voice-choice')
          .send({ voiceId: t.narrator.id, dialogueVoiceId: 'nope', modelId: 1 })
      ).body.error.code,
    ).toBe('no_dialogue_voice');

    const clip = await t.api('post', `/books/${t.bookId(HITSUJI)}/sentence-audio`).send({
      text: '「行こう」と彼は言った。',
      position: 6,
    });
    expect(clip.status).toBe(202);
    await t.heartbeat({ version: '1.3.0' });
    const claimed = await t.claim();
    expect(Object.keys(claimed.tts.voices)).toEqual(['narration', 'dialogue']);
    const [c0] = await t.script(claimed.id);
    expect(c0.sentences[0].segments).toEqual([
      { reading: '「行こう」', voice: 'dialogue' },
      { reading: 'と彼は言った。', voice: 'narration' },
    ]);

    // A part of the sentence (a selection) keeps the runs it covers.
    const part = await t.api('post', `/books/${t.bookId(HITSUJI)}/sentence-audio`).send({
      text: 'こう」と彼は',
      position: 6,
    });
    expect(part.status).toBe(202);

    // The dialogue voice deleted: the choice says so, and nothing is read with it.
    await t.api('delete', `/voices/${t.speaker.id}`);
    const after = await t.api('get', `/books/${t.bookId(HITSUJI)}/tts-voice-choice`);
    expect(after.body.effective.problem).toBe('the chosen dialogue voice was deleted');
  });

  it('reads aloud with both voices on a 1.3.0 PC, and says an older one needs an update', async () => {
    const t = await setup();
    await t.api('put', '/tts/voice-choice').send({
      voiceId: t.narrator.id,
      dialogueVoiceId: t.speaker.id,
      modelId: DEFAULT_MODEL,
    });
    await t.heartbeat({ version: '1.2.0', engine: ENGINE });
    const open = await t.api('post', '/read-aloud/sessions').send({ bookId: t.bookId(HITSUJI) });
    expect(open.status).toBeLessThan(300);
    expect(open.body.session.voice).toMatchObject({ name: 'Narrator', dialogue: 'Speaker' });
    const id = open.body.session.id as string;
    const sentences = SCRIPT.chapters[0].sentences.slice(1, 3);
    expect(
      (await t.api('post', `/read-aloud/sessions/${id}/batches`).send({ sentences })).status,
    ).toBeLessThan(300);
    const old = await t.api('get', `/read-aloud/sessions/${id}`);
    expect(old.body.session.pc.supportsLive).toBe(false);

    await t.heartbeat({ version: '1.3.0', engine: ENGINE });
    const live = { Authorization: t.worker.Authorization };
    const next = await request(t.app)
      .post('/api/v1/worker/live/next')
      .set(live)
      .send({ engine: ENGINE, take: true });
    expect(next.body.session.voices).toEqual({
      narration: { sha256: t.sha(t.narrator.id), seed: expect.any(Number) },
      dialogue: { sha256: t.sha(t.speaker.id), seed: expect.any(Number) },
    });
    expect(next.body.batch.sentences).toEqual([
      {
        text: '「行こう」と彼は言った。',
        reading: '「行こう」と彼は言った。',
        paragraphEnd: true,
        segments: [
          { reading: '「行こう」', voice: 'dialogue' },
          { reading: 'と彼は言った。', voice: 'narration' },
        ],
      },
      {
        text: '「畢竟、そうだ」',
        reading: '「ひっきょう、そうだ」',
        paragraphEnd: true,
        segments: [{ reading: '「ひっきょう、そうだ」', voice: 'dialogue' }],
      },
    ]);
    const clip = await request(t.app)
      .get(`/api/v1/worker/live/voice/${t.sha(t.speaker.id)}`)
      .set(live)
      .buffer(true);
    expect(clip.status).toBe(200);
    // Runs that don't fit their sentence are refused.
    const bad = await t.api('post', `/read-aloud/sessions/${id}/batches`).send({
      sentences: [{ ...sentences[0], parts: [{ start: 3, end: 99, quote: 0 }] }],
    });
    expect(bad.status).toBe(400);
  });
});
