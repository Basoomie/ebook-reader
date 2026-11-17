/**
 * Season 2 Phase 12 session 5: per-character voices end to end on the server (speaker-jobs,
 * speaker-store, speaker-book, speaker-voices, speaker-routes, migration 24). The PC is
 * played by the test through the worker routes, with a scripted stand-in model
 * (fixtures/speakers/fake-model.cjs).
 */
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { BookScript } from '../src/audio/book-script';
import { normalizeVoiceMap, workerVoices } from '../src/audio/voice-map';
import { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from '../src/db/migrations';
import { HITSUJI, type Track } from './helpers/worker-env';
import { HAS_FFMPEG, ttsEnv as makeTtsEnv } from './helpers/tts-env';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fake = require('./fixtures/speakers/fake-model.cjs') as {
  answer(r: { prompt: string; grammar?: string; json_schema?: unknown }): {
    content: string;
    completion_probabilities: unknown[];
  };
  setSpeakers(map: Record<string, string>): void;
  SURE: number;
};

const track: Track = { envs: [], services: [] };
afterEach(async () => {
  fake.setSpeakers({ '「北へ」': 'ホロ' });
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

const sentence = (
  text: string,
  position: number,
  quotes: { start: number; end: number; quote: number }[] = [],
) => ({
  text,
  reading: text,
  ruby: [],
  position,
  paragraphEnd: true,
  ...(quotes.length ? { parts: quotes.map((q) => ({ ...q, role: 'dialogue' as const })) } : {}),
});

/** Four quotes, two characters; the third quote ("北へ") names no speaker near it. */
const SCRIPT: BookScript = {
  version: 3,
  characters: 80,
  chapters: [
    {
      index: 0,
      title: '第一章',
      startCharacter: 0,
      characters: 60,
      sentences: [
        sentence('「行こう」とホロは言った。', 0, [{ start: 0, end: 5, quote: 0 }]),
        sentence('「どこへ？」とロレンスは聞いた。', 12, [{ start: 0, end: 6, quote: 1 }]),
        sentence('「北へ」', 28, [{ start: 0, end: 4, quote: 2 }]),
        sentence('二人は歩いた。', 32),
      ],
    },
    {
      index: 1,
      title: '第二章',
      startCharacter: 60,
      characters: 20,
      sentences: [sentence('「最後だ」とロレンスが言った。', 60, [{ start: 0, end: 5, quote: 3 }])],
    },
  ],
};

async function setup(script: BookScript = SCRIPT) {
  const t = await makeTtsEnv(track, { script });
  const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string) =>
    request(t.app)[method](`/api/v1${url}`).set(t.auth);
  const book = t.bookId(HITSUJI);
  const overview = async () => (await api('get', `/books/${book}/speakers`)).body;
  /** Plays the PC: claims the job and answers every request with the stand-in model. */
  const runPc = async (opts: { stopAfter?: number } = {}) => {
    const claimed = await t.claim();
    expect(claimed.kind).toBe('attribute_speakers');
    let answered = 0;
    for (;;) {
      const next = await request(t.app)
        .post(`/api/v1/worker/jobs/${claimed.id}/speakers/next`)
        .set(t.worker);
      expect(next.status).toBe(200);
      if (!next.body.request) return { claimed, answered, done: true };
      const req = next.body.request;
      const prompt = req.messages.map((m: { content: string }) => m.content).join('\n');
      const a = fake.answer({ prompt, grammar: req.grammar, json_schema: req.jsonSchema });
      const res = await request(t.app)
        .post(`/api/v1/worker/jobs/${claimed.id}/speakers/${req.seq}`)
        .set(t.worker)
        .send({ content: a.content, probs: a.completion_probabilities, ms: 5 });
      expect(res.status).toBe(200);
      answered++;
      if (opts.stopAfter && answered >= opts.stopAfter)
        return { claimed, answered, done: false, flags: res.body };
    }
  };
  return { ...t, api, book, overview, runPc };
}

describe('migration 24', () => {
  it('rebuilds worker_jobs for the new kind, keeps jobs and chapters, seeds the picked model', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS.filter((m) => m.version <= 23)) {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    }
    db.prepare("INSERT INTO users (id, name, created_at) VALUES ('u1', 'u', 1)").run();
    db.prepare(
      `INSERT INTO worker_jobs (id, user_id, book_id, kind, state, created_at, updated_at, chapters_done)
       VALUES (7, 'u1', 'b1', 'generate_audiobook', 'running', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tts_job_chapters (job_id, idx, title, duration_ms, cues, part_file, bytes, done_at)
       VALUES (7, 0, 'one', 1000, '[]', 'part-0000.flac', 10, 2)`,
    ).run();
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(24);
    expect(db.prepare('SELECT id, kind, state FROM worker_jobs').all()).toEqual([
      { id: 7, kind: 'generate_audiobook', state: 'running' },
    ]);
    expect(db.prepare('SELECT job_id, idx FROM tts_job_chapters').all()).toEqual([
      { job_id: 7, idx: 0 },
    ]);
    db.prepare(
      `INSERT INTO worker_jobs (user_id, book_id, kind, state, created_at, updated_at)
       VALUES ('u1', 'b1', 'attribute_speakers', 'queued', 1, 1)`,
    ).run();
    expect(
      db.prepare('SELECT repo, file, revision, size, sha256, is_default FROM speaker_models').all(),
    ).toEqual([
      {
        repo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
        file: 'gemma-4-26B-A4B-it-UD-IQ4_XS.gguf',
        revision: 'c099eb48e663fd284577b04978a94ffccb261841',
        size: 13597177568,
        sha256: 'babd1e389d386352f71600765d37390f7dc993fbfad6725caccf996ffe34aecf',
        is_default: 1,
      },
    ]);
    db.close();
  });
});

describe.skipIf(!HAS_FFMPEG)('speaker runs (Season 2 Phase 12 session 5)', () => {
  it('runs a book on the PC: characters, every quote, how sure, saved; the answers go', async () => {
    const t = await setup();
    const started = await t.api('post', `/books/${t.book}/speakers/run`).send({});
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ kind: 'attribute_speakers', state: 'queued' });
    // Another run while one waits: refused.
    expect((await t.api('post', `/books/${t.book}/speakers/run`).send({})).body.error.code).toBe(
      'busy',
    );
    const run = await t.runPc();
    expect(run.claimed.tts.speakers.model).toMatchObject({
      repo: 'unsloth/gemma-4-26B-A4B-it-GGUF',
      file: 'gemma-4-26B-A4B-it-UD-IQ4_XS.gguf',
      sha256: 'babd1e389d386352f71600765d37390f7dc993fbfad6725caccf996ffe34aecf',
    });
    const o = await t.overview();
    expect(o.job).toMatchObject({ state: 'done', progress: 1 });
    expect(o.run).toMatchObject({ model: 'Gemma 4 26B A4B', quotes: 4, renumbered: false });
    const byName = Object.fromEntries(o.characters.map((c: { name: string }) => [c.name, c]));
    expect(byName['ホロ']).toMatchObject({ quotes: 2, aliases: ['賢狼'], firstPerson: ['わっち'] });
    expect(byName['ロレンス']).toMatchObject({ quotes: 2 });
    // Every quote got a speaker, sure at the stand-in's probability.
    const all = (await t.api('get', `/books/${t.book}/speakers/quotes?filter=all`)).body;
    expect(all.total).toBe(4);
    for (const q of all.items) expect(q.p).toBeCloseTo(fake.SURE, 5);
    // "To check" with the bar at 0.5: only the quote whose speaker isn't named nearby.
    const check = (await t.api('get', `/books/${t.book}/speakers/quotes?filter=check&below=0.5`))
      .body;
    expect(check.items.map((q: { text: string }) => q.text)).toEqual(['「北へ」']);
    expect(check.items[0].paragraph).toEqual({ text: '「北へ」', start: 0, end: 4 });
    expect(check.items[0].before).toBe('「どこへ？」とロレンスは聞いた。');
    // At the default bar (0.9) every quote is unsure.
    expect(o.counts).toMatchObject({ quotes: 4, unsure: 4, none: 0, corrected: 0, lost: 0 });
    expect(t.e.db.prepare('SELECT COUNT(*) AS n FROM speaker_steps').get()).toEqual({ n: 0 });
  });

  it('keeps corrections, renames and voices through a re-run; merges and hides', async () => {
    const t = await setup();
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.runPc();
    let o = await t.overview();
    const holo = o.characters.find((c: { name: string }) => c.name === 'ホロ');
    const lawrence = o.characters.find((c: { name: string }) => c.name === 'ロレンス');
    const voice = await t.addVoice('Wolf', 6);
    expect(
      (
        await t
          .api('patch', `/books/${t.book}/speakers/characters/${holo.id}`)
          .send({ voiceId: voice.id })
      ).status,
    ).toBe(200);
    expect(
      (
        await t
          .api('patch', `/books/${t.book}/speakers/characters/${holo.id}`)
          .send({ voiceId: 'nope' })
      ).body.error.code,
    ).toBe('bad_voice');
    await t
      .api('patch', `/books/${t.book}/speakers/characters/${lawrence.id}`)
      .send({ name: 'クラフト' });
    // Quote 2 ("北へ") is Lawrence's, says the user.
    const fixed = await t
      .api('patch', `/books/${t.book}/speakers/quotes/2`)
      .send({ character: lawrence.id });
    expect(fixed.body.quote).toMatchObject({
      character: lawrence.id,
      corrected: true,
      modelCharacter: holo.id,
    });
    // A re-run (the model still says Holo for quote 2) keeps all of it.
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.runPc();
    o = await t.overview();
    const after = Object.fromEntries(o.characters.map((c: { id: number }) => [c.id, c]));
    expect(after[holo.id]).toMatchObject({
      name: 'ホロ',
      voiceId: voice.id,
      voiceName: 'Wolf',
      quotes: 1,
    });
    expect(after[lawrence.id]).toMatchObject({ name: 'クラフト', edited: true, quotes: 3 });
    expect(after[lawrence.id].aliases).toContain('ロレンス');
    expect(o.counts.corrected).toBe(1);
    const q2 = (await t.api('get', `/books/${t.book}/speakers/quotes?filter=corrected`)).body
      .items[0];
    expect(q2).toMatchObject({ quote: 2, character: lawrence.id, modelCharacter: holo.id });
    // Back to the model's answer.
    expect(
      (await t.api('patch', `/books/${t.book}/speakers/quotes/2`).send({ reset: true })).body.quote,
    ).toMatchObject({
      character: holo.id,
      corrected: false,
    });
    // An added character; merging it into Holo moves its quotes and names.
    const added = (await t.api('post', `/books/${t.book}/speakers/characters`).send({ name: '狼' }))
      .body.character;
    await t.api('patch', `/books/${t.book}/speakers/quotes/0`).send({ character: added.id });
    const merged = await t
      .api('post', `/books/${t.book}/speakers/characters/${added.id}/merge`)
      .send({ into: holo.id });
    expect(merged.body.character).toMatchObject({ id: holo.id, quotes: 2 });
    expect(merged.body.character.aliases).toContain('狼');
    // Not a character: its quotes count as without a speaker.
    await t.api('patch', `/books/${t.book}/speakers/characters/${holo.id}`).send({ hidden: true });
    expect((await t.overview()).counts.none).toBe(2);
    // Refusals.
    expect(
      (await t.api('post', `/books/${t.book}/speakers/characters`).send({ name: '' })).body.error
        .code,
    ).toBe('invalid_name');
    expect(
      (await t.api('patch', `/books/${t.book}/speakers/quotes/99`).send({ character: null }))
        .status,
    ).toBe(404);
  });

  it('one entry per name: a re-run joins two characters with one name, keeping voice and fixes', async () => {
    const t = await setup();
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.runPc();
    const o = await t.overview();
    const holo = o.characters.find((c: { name: string }) => c.name === 'ホロ');
    // An earlier run left a second ホロ (live run 2026-11-17: ミュラー twice), with a voice and
    // a quote the user gave it.
    const db = t.e.db;
    const row = db
      .prepare('SELECT user_id, no FROM speaker_characters WHERE id = ?')
      .get(holo.id) as { user_id: string; no: number };
    const maxNo = (
      db.prepare('SELECT MAX(no) n FROM speaker_characters WHERE book_id = ?').get(t.book) as {
        n: number;
      }
    ).n;
    const voice = await t.addVoice('Wolf', 6);
    const dup = Number(
      db
        .prepare(
          `INSERT INTO speaker_characters (user_id, book_id, no, name, aliases, first_person, gender,
             narrator, origin, windows, voice_id, created_at, updated_at)
           VALUES (?, ?, ?, 'ホロ', '[]', '[]', '女', 0, 'model', 1, ?, 1, 1)`,
        )
        .run(row.user_id, t.book, maxNo + 1, voice.id).lastInsertRowid,
    );
    await t.api('patch', `/books/${t.book}/speakers/quotes/1`).send({ character: dup });
    expect(
      (await t.overview()).characters.filter((c: { name: string }) => c.name === 'ホロ'),
    ).toHaveLength(2);
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.runPc();
    const after = await t.overview();
    const holos = after.characters.filter((c: { name: string }) => c.name === 'ホロ');
    expect(holos).toHaveLength(1);
    expect(holos[0]).toMatchObject({ id: holo.id, voiceId: voice.id });
    const q1 = (await t.api('get', `/books/${t.book}/speakers/quotes?filter=corrected`)).body
      .items[0];
    expect(q1).toMatchObject({ quote: 1, character: holo.id, corrected: true });
  });

  it('continues after making way (pause), from the answers it has', async () => {
    const t = await setup();
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.api('put', '/gpu-worker/paused').send({ paused: true });
    // Paused while it runs: the answer says so; the PC releases the job, no attempt used.
    await t.api('put', '/gpu-worker/paused').send({ paused: false });
    const first = await t.runPc({ stopAfter: 1 });
    await t.api('put', '/gpu-worker/paused').send({ paused: true });
    const next = await request(t.app)
      .post(`/api/v1/worker/jobs/${first.claimed.id}/speakers/next`)
      .set(t.worker);
    const req = next.body.request;
    const a = fake.answer({
      prompt: req.messages.map((m: { content: string }) => m.content).join('\n'),
      grammar: req.grammar,
      json_schema: req.jsonSchema,
    });
    const flags = await request(t.app)
      .post(`/api/v1/worker/jobs/${first.claimed.id}/speakers/${req.seq}`)
      .set(t.worker)
      .send({ content: a.content, probs: a.completion_probabilities });
    expect(flags.body).toMatchObject({ pause: true, cancel: false });
    const released = await request(t.app)
      .post(`/api/v1/worker/jobs/${first.claimed.id}/speakers/release`)
      .set(t.worker);
    expect(released.body.state).toBe('queued');
    const job = (await t.overview()).job;
    expect(job).toMatchObject({ state: 'queued', attempts: 0 });
    // Resumed: the next request is the third, not the first again.
    await t.api('put', '/gpu-worker/paused').send({ paused: false });
    const again = await t.claim();
    const third = await request(t.app)
      .post(`/api/v1/worker/jobs/${again.id}/speakers/next`)
      .set(t.worker);
    expect(third.body.request.seq).toBe(2);
    // An answer to the wrong request is refused.
    const wrong = await request(t.app)
      .post(`/api/v1/worker/jobs/${again.id}/speakers/0`)
      .set(t.worker)
      .send({ content: '{}' });
    expect(wrong.body.error.code).toBe('wrong_step');
  });

  it('reads quotes in their speaker’s voice: audiobook, preview, read-aloud by text, narrator', async () => {
    const t = await setup();
    const narrator = await t.addVoice('Narrator');
    const dialogue = await t.addVoice('Speaker', 5);
    const wolf = await t.addVoice('Wolf', 6);
    // Before a run: the dialogue voice reads every quote, as in session 4.
    await t.heartbeat({ version: '1.4.0' });
    const before = await t.startBook(HITSUJI, {
      voiceId: narrator.id,
      dialogueVoiceId: dialogue.id,
      modelId: 1,
    });
    expect(normalizeVoiceMap(before.body.job.params)!.speakers).toBeUndefined();
    await t.api('post', `/audio/subtitle-jobs/${before.body.job.id}/cancel`).send({});
    // After a run, with a voice for Holo.
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.runPc();
    const holo = (await t.overview()).characters.find((c: { name: string }) => c.name === 'ホロ');
    await t
      .api('patch', `/books/${t.book}/speakers/characters/${holo.id}`)
      .send({ voiceId: wolf.id });
    const job = (
      await t.startBook(HITSUJI, { voiceId: narrator.id, dialogueVoiceId: dialogue.id, modelId: 1 })
    ).body.job;
    const map = normalizeVoiceMap(job.params)!;
    const key = `character:${holo.no}`;
    expect(map.voices[key]).toMatchObject({ voiceId: wolf.id, name: 'Wolf' });
    expect(map.speakers).toEqual({ characters: 1, quotes: 2, narrator: false });
    expect(Object.keys(workerVoices(map)).sort()).toEqual(['dialogue', key, 'narration'].sort());
    const claimed = await t.claim();
    expect(claimed.id).toBe(job.id);
    const chapters = (
      await request(t.app).get(`/api/v1/worker/jobs/${job.id}/script`).set(t.worker)
    ).body.chapters;
    const voices = chapters.flatMap((c: { sentences: { segments?: { voice: string }[] }[] }) =>
      c.sentences.map((s) => s.segments?.map((g) => g.voice) ?? ['narration']),
    );
    expect(voices).toEqual([
      [key, 'narration'],
      ['dialogue', 'narration'],
      [key],
      ['narration'],
      ['dialogue', 'narration'],
    ]);
    // The PC gets the character's clip by its sha.
    const sha = map.voices[key].sha256!;
    expect(
      (await request(t.app).get(`/api/v1/worker/jobs/${job.id}/voice?sha=${sha}`).set(t.worker))
        .status,
    ).toBe(200);
    // Read-aloud: the device numbered the quotes differently (+5); the text decides.
    const m2 = t.tts.voiceMap(
      t.voices.byId(narrator.id)!,
      t.models.get(1)!,
      t.book,
      { sentenceMs: 0, paragraphMs: 0, chapterMs: 0, dialogueMs: 0 },
      t.voices.byId(dialogue.id)!,
    );
    t.speakerVoices.extend((await t.api('get', '/me')).body.user.id, t.book, m2);
    const shifted = [
      {
        text: '「北へ」',
        parts: [{ start: 0, end: 4, role: 'dialogue' as const, quote: 7 }],
        segments: [{ reading: '「きたへ」', role: 'dialogue' as const, quote: 7 }],
      },
      {
        text: '「別の話」',
        parts: [{ start: 0, end: 5, role: 'dialogue' as const, quote: 2 }],
        segments: [{ reading: '「べつのはなし」', role: 'dialogue' as const, quote: 2 }],
      },
    ];
    t.speakerVoices.assign((await t.api('get', '/me')).body.user.id, t.book, shifted, m2, {
      prune: false,
    });
    expect(shifted[0].segments[0]).toMatchObject({ voice: key });
    // Quote 2's number but another text: not Holo's line; the dialogue voice.
    expect(shifted[1].segments[0]).not.toHaveProperty('voice');
    // The narrator's voice reads the narration when chosen (and the narrator has a voice).
    const lawrence = (await t.overview()).characters.find(
      (c: { name: string }) => c.name === 'ロレンス',
    );
    expect(lawrence.narrator).toBe(false);
    t.e.db
      .prepare('UPDATE speaker_characters SET narrator = 1, voice_id = ? WHERE id = ?')
      .run(narrator.id, lawrence.id);
    await t.api('put', `/books/${t.book}/speakers/narration`).send({ by: 'narrator' });
    const m3 = t.tts.voiceMap(t.voices.byId(narrator.id)!, t.models.get(1)!, t.book, {
      sentenceMs: 0,
      paragraphMs: 0,
      chapterMs: 0,
      dialogueMs: 0,
    });
    t.speakerVoices.extend((await t.api('get', '/me')).body.user.id, t.book, m3);
    expect(m3.roles.narration).toBe(`character:${lawrence.no}`);
  });

  it('renumbers stored quotes by their text when the book changed', async () => {
    const t = await setup();
    await t.api('post', `/books/${t.book}/speakers/run`).send({});
    await t.runPc();
    await t.api('patch', `/books/${t.book}/speakers/quotes/2`).send({ character: null });
    // The book changed: a new quote at the start, the second one gone.
    const changed: BookScript = JSON.parse(JSON.stringify(SCRIPT));
    const s = changed.chapters[0].sentences;
    s.splice(1, 1);
    s.unshift(sentence('「はじめに」', 0, [{ start: 0, end: 6, quote: 0 }]));
    let q = 0;
    for (const c of changed.chapters)
      for (const x of c.sentences) for (const p of x.parts ?? []) p.quote = q++;
    (t.tts as unknown as { readScript: () => Promise<BookScript> }).readScript = async () =>
      changed;
    (t.tts as unknown as { chapterCache: Map<string, unknown> }).chapterCache.clear();
    t.e.db.prepare("UPDATE speaker_books SET file_key = 'old'").run();
    const o = await t.overview();
    expect(o.run.renumbered).toBe(true);
    expect(o.counts).toMatchObject({ lost: 1, corrected: 1 });
    const all = (await t.api('get', `/books/${t.book}/speakers/quotes?filter=all`)).body.items;
    expect(all.map((x: { quote: number; text: string }) => [x.quote, x.text])).toEqual([
      [1, '「行こう」'],
      [2, '「北へ」'],
      [3, '「最後だ」'],
    ]);
    expect(all[1]).toMatchObject({ corrected: true, character: null });
  });

  it('lists, adds and removes speaker models; the PC learns removed folders', async () => {
    const t = await setup();
    const list = (await t.api('get', '/speaker-models')).body.models;
    expect(list).toEqual([expect.objectContaining({ label: 'Gemma 4 26B A4B', isDefault: true })]);
    const added = await t.api('post', '/speaker-models').send({
      repo: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF',
      file: 'Qwen3.5-9B-Q4_K_M.gguf',
    });
    expect(added.status).toBe(201);
    expect(added.body.model).toMatchObject({
      repo: 'unsloth/Qwen3.5-9B-GGUF',
      revision: 'e'.repeat(40),
      size: 1234,
      isDefault: false,
    });
    expect(
      (await t.api('post', '/speaker-models').send({ repo: 'x', file: 'a.gguf' })).body.error.code,
    ).toBe('invalid_model');
    expect(
      (await t.api('post', '/speaker-models').send({ repo: 'a/b', file: '../x.gguf' })).body.error
        .code,
    ).toBe('invalid_file');
    // Run with the added model.
    const run = await t
      .api('post', `/books/${t.book}/speakers/run`)
      .send({ modelId: added.body.model.id });
    expect(run.body.job.params.model.repo).toBe('unsloth/Qwen3.5-9B-GGUF');
    await t.api('post', `/audio/subtitle-jobs/${run.body.job.id}/cancel`).send({});
    await t.api('put', `/speaker-models/${added.body.model.id}/default`).send({});
    expect((await t.api('get', '/speaker-models')).body.models[0].id).toBe(added.body.model.id);
    await t.api('delete', `/speaker-models/${added.body.model.id}`);
    const pc = (await request(t.app).get('/api/v1/worker/speaker-models').set(t.worker)).body;
    expect(pc.removed).toEqual([{ dir: `unsloth--Qwen3.5-9B-GGUF/${'e'.repeat(40)}` }]);
    expect(pc.models[0]).toMatchObject({
      dir: 'unsloth--gemma-4-26B-A4B-it-GGUF/c099eb48e663fd284577b04978a94ffccb261841',
    });
    // A user token can't use the PC's routes, nor the PC's token the user's.
    expect((await request(t.app).get('/api/v1/worker/speaker-models').set(t.auth)).status).toBe(
      403,
    );
  });
});
