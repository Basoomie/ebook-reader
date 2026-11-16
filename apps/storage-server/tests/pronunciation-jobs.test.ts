/**
 * Season 2 Phase 12: pronunciation fixes in the PC's jobs. The fixes are applied when a job
 * is queued (the readings in its script.json), the job records which ones it used, editing
 * the lists afterwards doesn't touch it, and the book page's text check and version note.
 * Real ffmpeg (skipped when not installed), like the WP17 tests.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { type BookScript, readBookScript } from '../src/audio/book-script';
import { fixesNote } from '../src/audio/tts-jobs';
import { write } from './helpers/audio-fixtures';
import { makeZip } from './helpers/epub-fixture';
import { makeTempDir } from './helpers/spawn-server';
import { flac, HAS_FFMPEG, SCRIPT, ttsEnv as makeTtsEnv } from './helpers/tts-env';
import { HITSUJI, type Track } from './helpers/worker-env';

const track: Track = { envs: [], services: [] };
afterEach(async () => {
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});
const ttsEnv = (opts: { script?: BookScript } = {}) => makeTtsEnv(track, opts);
type Env = Awaited<ReturnType<typeof ttsEnv>>;

const addFix = async (t: Env, body: Record<string, unknown>) => {
  const res = await request(t.app).post('/api/v1/pronunciation-fixes').set(t.auth).send(body);
  expect(res.status).toBe(201);
  return res.body.entry as { id: number };
};
const jobScript = (t: Env, id: number) =>
  (
    JSON.parse(
      fs.readFileSync(path.join(t.cacheDir, 'tts', String(id), 'script.json'), 'utf8'),
    ) as {
      chapters: { sentences: { text: string; reading: string }[] }[];
    }
  ).chapters;
const readingsOf = (t: Env, id: number) =>
  jobScript(t, id).flatMap((c) => c.sentences.map((s) => s.reading));
const check = async (t: Env) =>
  (
    await request(t.app)
      .get(`/api/v1/books/${t.bookId(HITSUJI)}/pronunciation-check`)
      .set(t.auth)
  ).body;

/** Reads the whole queued book on the "PC" (tones of the right length) and waits for it. */
async function finish(t: Env, id: number) {
  await t.heartbeat();
  expect((await t.claim()).id).toBe(id);
  await t.uploadChapter(id, 0, flac('pf-ch0', 3));
  await t.doneChapter(id, 0, {
    durationMs: 3000,
    cues: [
      [0, 1200],
      [1500, 2600],
    ],
  });
  await t.uploadChapter(id, 1, flac('pf-ch1', 2));
  await t.doneChapter(id, 1, { durationMs: 2000, cues: [[0, 1500]] });
  await t.tts.idle();
  const job = await t.latestBook(HITSUJI);
  expect(job).toMatchObject({ id, state: 'done', linked: true });
  return job as { outputRelPath: string; version: number };
}

describe('pure helpers', () => {
  it('notes the fixes in the m4b comment only when some were used', () => {
    expect(fixesNote(undefined)).toBe('');
    expect(fixesNote({ book: 0, global: 0, places: 0, digest: '' })).toBe('');
    expect(fixesNote({ book: 1, global: 0, places: 1, digest: 'x' })).toBe(
      ' 1 pronunciation fix (1 place).',
    );
    expect(fixesNote({ book: 2, global: 1, places: 7, digest: 'x' })).toBe(
      ' 3 pronunciation fixes (7 places).',
    );
  });
});

describe.skipIf(!HAS_FFMPEG)('fixes in the jobs', () => {
  it('applies both lists when an audiobook is queued and keeps them for that job', async () => {
    const t = await ttsEnv();
    const book = t.bookId(HITSUJI);
    const voice = await t.addVoice();
    // 畢竟 has the book's furigana in sentence 1: the fix is skipped there.
    await addFix(t, { bookId: book, kind: 'word', match: '畢竟', reading: 'つまり' });
    await addFix(t, { bookId: book, kind: 'word', match: '悪', reading: 'わる' });
    const global = await addFix(t, { kind: 'pattern', match: '(?<=の)文', reading: 'ぶん' });
    await addFix(t, { kind: 'word', match: '悪は', reading: 'X' }); // the book's 悪 claims it
    await addFix(t, { kind: 'word', match: '月', reading: 'つき' }); // not in this book

    const res = await t.startBook(HITSUJI, { voiceId: voice.id });
    expect(res.status).toBe(202);
    const id = res.body.job.id as number;
    expect(readingsOf(t, id)).toEqual([
      '善なるものはひっきょう、遠い。',
      'けれどもわるは近い！',
      '最後のぶん。',
    ]);
    // The text as shown (subtitle lines) is unchanged.
    expect(jobScript(t, id).flatMap((c) => c.sentences.map((s) => s.text))).toEqual(
      SCRIPT.chapters.flatMap((c) => c.sentences.map((s) => s.text)),
    );
    expect(res.body.job.params.fixes).toEqual({
      book: 1,
      global: 1,
      places: 2,
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    // What the PC is given: the fixed readings.
    await t.heartbeat();
    await t.claim();
    const worker = (await request(t.app).get(`/api/v1/worker/jobs/${id}/script`).set(t.worker))
      .body;
    expect(worker.chapters[0].sentences[1]).toEqual({
      text: 'けれども悪は近い！',
      reading: 'けれどもわるは近い！',
      paragraphEnd: true,
    });

    // Changing the lists afterwards doesn't touch the queued job.
    await request(t.app).delete(`/api/v1/pronunciation-fixes/${global.id}`).set(t.auth);
    await addFix(t, { bookId: book, kind: 'word', match: '最後', reading: 'さいご' });
    expect(readingsOf(t, id)[2]).toBe('最後のぶん。');
    expect((await t.latestBook(HITSUJI)).params.fixes.global).toBe(1);
  });

  it('applies the fixes to a preview and the global list to a voice sample', async () => {
    const t = await ttsEnv();
    const voice = await t.addVoice();
    await addFix(t, { bookId: t.bookId(HITSUJI), kind: 'word', match: '遠い', reading: 'とおい' });
    await addFix(t, { kind: 'word', match: '今夜', reading: 'こよい' });
    const preview = await request(t.app)
      .post(`/api/v1/books/${t.bookId(HITSUJI)}/audiobook-preview`)
      .set(t.auth)
      .send({ voiceId: voice.id, chapterIndex: 0 });
    expect(preview.status).toBe(202);
    expect(readingsOf(t, preview.body.job.id)).toEqual([
      '善なるものはひっきょう、とおい。',
      'けれども悪は近い！',
    ]);
    expect(preview.body.job.params.fixes).toMatchObject({ book: 1, global: 0, places: 1 });

    const sample = await request(t.app)
      .post('/api/v1/voices/samples')
      .set(t.auth)
      .send({ name: 'Calm', description: '落ち着いた声' });
    expect(sample.status).toBe(202);
    const [reading] = readingsOf(t, sample.body.job.id);
    expect(reading.startsWith('こんばんは。こよいも、')).toBe(true);
    expect(sample.body.job.params.fixes).toMatchObject({ book: 0, global: 1, places: 1 });
  });

  it('jobs without fixes record none and read as before', async () => {
    const t = await ttsEnv();
    const voice = await t.addVoice();
    const res = await t.startBook(HITSUJI, { voiceId: voice.id });
    expect(res.body.job.params.fixes).toEqual({ book: 0, global: 0, places: 0, digest: '' });
    expect(readingsOf(t, res.body.job.id)).toEqual(
      SCRIPT.chapters.flatMap((c) => c.sentences.map((s) => s.reading)),
    );
  });
});

describe.skipIf(!HAS_FFMPEG)("the book page's text check and version note", () => {
  it('counts places, furigana skips and examples for both lists', async () => {
    const t = await ttsEnv();
    const book = t.bookId(HITSUJI);
    const a = await addFix(t, { bookId: book, kind: 'word', match: '畢竟', reading: 'つまり' });
    const b = await addFix(t, { kind: 'pattern', match: '[遠近]い', reading: 'ちかい' });
    const c = await addFix(t, { kind: 'word', match: '月', reading: 'つき' });
    const res = await check(t);
    expect(res.entries).toEqual([
      { id: a.id, places: 0, skipped: 1, examples: [] },
      {
        id: b.id,
        places: 2,
        skipped: 0,
        examples: [
          { text: '善なるものは畢竟、遠い。', reading: '善なるものはひっきょう、ちかい。' },
          { text: 'けれども悪は近い！', reading: 'けれども悪はちかい！' },
        ],
      },
      { id: c.id, places: 0, skipped: 0, examples: [] },
    ]);
    // No generated audiobook linked: no note.
    expect(res.audiobook).toBeNull();
  });

  it('says when the linked generated audiobook was made before the fixes that match the book', async () => {
    const t = await ttsEnv();
    const book = t.bookId(HITSUJI);
    const voice = await t.addVoice();
    const v1 = await t.startBook(HITSUJI, { voiceId: voice.id });
    await finish(t, v1.body.job.id);
    expect((await check(t)).audiobook).toEqual({ version: 1, madeWithCurrentFixes: true });

    // A fix that doesn't match this book changes nothing here.
    await addFix(t, { kind: 'word', match: '月', reading: 'つき' });
    expect((await check(t)).audiobook.madeWithCurrentFixes).toBe(true);
    // One that matches does.
    const fix = await addFix(t, { bookId: book, kind: 'word', match: '悪', reading: 'わる' });
    expect((await check(t)).audiobook).toEqual({ version: 1, madeWithCurrentFixes: false });

    // Version 2 made with it: current again, and its m4b comment says so.
    t.tickAll(1000);
    const v2 = await t.startBook(HITSUJI, { voiceId: voice.id });
    const done = await finish(t, v2.body.job.id);
    expect(done.version).toBe(2);
    expect(done.outputRelPath).toBe('japanese-generated/Unknown/羊と鋼の森 (v2)/羊と鋼の森.m4b');
    expect((await check(t)).audiobook).toEqual({ version: 2, madeWithCurrentFixes: true });
    const comment = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format_tags=comment',
        '-of',
        'default=nw=1:nk=1',
        path.join(t.root, ...done.outputRelPath.split('/')),
      ],
      { windowsHide: true },
    ).toString();
    expect(comment).toContain('Version 2. 1 pronunciation fix (1 place).');

    // Changing that fix's reading makes it out of date again; removing it too.
    await request(t.app)
      .patch(`/api/v1/pronunciation-fixes/${fix.id}`)
      .set(t.auth)
      .send({ reading: 'あく' });
    expect((await check(t)).audiobook.madeWithCurrentFixes).toBe(false);
    await request(t.app).delete(`/api/v1/pronunciation-fixes/${fix.id}`).set(t.auth);
    expect((await check(t)).audiobook.madeWithCurrentFixes).toBe(false);
    // Linking version 1 again (made with no fixes): current.
    await t.linkAudio(HITSUJI, 'japanese-generated/Unknown/羊と鋼の森', {
      fileName: '羊と鋼の森.m4b',
    });
    expect((await check(t)).audiobook).toEqual({ version: 1, madeWithCurrentFixes: true });
  }, 60_000);
});

describe('the real book script with fixes', () => {
  it('keeps furigana places and fixes the rest of an EPUB read by the reader import', async () => {
    const dir = makeTempDir('pf-epub');
    const xhtml = (body: string) =>
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${body}</body></html>`;
    const epub = makeZip([
      { name: 'mimetype', data: 'application/epub+zip' },
      {
        name: 'META-INF/container.xml',
        data: '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      },
      {
        name: 'OEBPS/content.opf',
        data: `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>試験</dc:title><dc:identifier id="id">x</dc:identifier></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
      },
      {
        name: 'OEBPS/nav.xhtml',
        data: xhtml(
          '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="c1.xhtml">一章</a></li></ol></nav>',
        ),
      },
      {
        name: 'OEBPS/c1.xhtml',
        data: xhtml(
          '<p><ruby>椎名<rt>しいな</rt></ruby>は笑った。</p><p>椎名と<ruby>真昼<rt>まひる</rt></ruby>。椎名真昼。</p>',
        ),
      },
    ]);
    const file = write(dir, 'book.epub', epub);
    const script = await readBookScript(file, {
      importOptions: { importHTMLFixMode: 'Off', restrictImportFixToAnchor: true },
      maxSentence: 120,
      timeoutMs: 120_000,
    });
    if (!HAS_FFMPEG) return;
    const t = await ttsEnv({ script });
    const voice = await t.addVoice();
    await addFix(t, { bookId: t.bookId(HITSUJI), kind: 'word', match: '椎名', reading: 'シイナ' });
    await addFix(t, { kind: 'word', match: '真昼', reading: 'まっぴる' });
    const res = await t.startBook(HITSUJI, { voiceId: voice.id });
    expect(res.status).toBe(202);
    expect(readingsOf(t, res.body.job.id)).toEqual([
      'しいなは笑った。', // the book's furigana
      'シイナとまひる。', // 真昼 has furigana here
      'シイナまっぴる。',
    ]);
    expect(res.body.job.params.fixes).toMatchObject({ book: 1, global: 1, places: 3 });
  }, 120_000);
});
