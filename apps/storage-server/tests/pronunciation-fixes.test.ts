/**
 * Season 2 Phase 12: pronunciation fixes. The rules (pure), the time-limited worker thread,
 * and the list routes.
 */
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyFixes,
  buildReading,
  checkEntry,
  type FixEntry,
  FixRuleError,
  type FixSentence,
} from '../src/pronunciation/fix-rules';
import { FixRunner, FixTimeoutError } from '../src/pronunciation/fix-runner';
import { FixService } from '../src/pronunciation/fix-service';
import { HAS_FFMPEG, ttsEnv as makeTtsEnv } from './helpers/tts-env';
import { HITSUJI, SPY, type Track } from './helpers/worker-env';

let nextId = 1;
const entry = (
  kind: 'word' | 'pattern',
  match: string,
  reading: string,
  bookId: string | null = null,
  createdAt = nextId,
): FixEntry => ({ id: nextId++, bookId, kind, match, reading, createdAt });

const plain = (text: string): FixSentence => ({ text, reading: text, ruby: [] });
const readings = (sentences: FixSentence[], entries: FixEntry[]) =>
  applyFixes(sentences, entries).map((r, i) => r.reading ?? sentences[i].reading);

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as FixRuleError).code;
  }
  return null;
};

describe('checking an entry when it is saved', () => {
  it('trims words and readings and refuses empty or multi-line ones', () => {
    expect(checkEntry({ kind: 'word', match: ' 椎名 ', reading: ' しいな ' })).toEqual({
      kind: 'word',
      match: '椎名',
      reading: 'しいな',
    });
    expect(codeOf(() => checkEntry({ kind: 'x', match: 'a', reading: 'b' }))).toBe('invalid_kind');
    expect(codeOf(() => checkEntry({ kind: 'word', match: '  ', reading: 'b' }))).toBe(
      'invalid_match',
    );
    expect(codeOf(() => checkEntry({ kind: 'word', match: 'a\nb', reading: 'b' }))).toBe(
      'invalid_match',
    );
    expect(codeOf(() => checkEntry({ kind: 'word', match: 'あ'.repeat(101), reading: 'b' }))).toBe(
      'invalid_match',
    );
    expect(codeOf(() => checkEntry({ kind: 'word', match: 'a', reading: '' }))).toBe(
      'invalid_reading',
    );
    expect(codeOf(() => checkEntry({ kind: 'word', match: 'a', reading: 'あ'.repeat(201) }))).toBe(
      'invalid_reading',
    );
    expect(codeOf(() => checkEntry({ kind: 'word', match: 'a', reading: 'x\ny' }))).toBe(
      'invalid_reading',
    );
  });

  it('checks patterns: valid, at most 200 characters, not matching empty text, known groups', () => {
    expect(checkEntry({ kind: 'pattern', match: '日本(?!橋)', reading: 'にっぽん' }).match).toBe(
      '日本(?!橋)',
    );
    expect(() => checkEntry({ kind: 'pattern', match: '(', reading: 'x' })).toThrow(
      /This pattern isn't valid/,
    );
    expect(
      codeOf(() => checkEntry({ kind: 'pattern', match: 'a'.repeat(201), reading: 'x' })),
    ).toBe('invalid_match');
    expect(codeOf(() => checkEntry({ kind: 'pattern', match: 'あ*', reading: 'x' }))).toBe(
      'empty_match',
    );
    expect(codeOf(() => checkEntry({ kind: 'pattern', match: '(?:)', reading: 'x' }))).toBe(
      'empty_match',
    );
    // Groups: $1 needs one, $<name> needs that name; $$ and $& are always fine.
    expect(checkEntry({ kind: 'pattern', match: '(\\d+)円', reading: '$1えん$$' }).reading).toBe(
      '$1えん$$',
    );
    expect(() => checkEntry({ kind: 'pattern', match: '(\\d+)円', reading: '$2えん' })).toThrow(
      /one group; \$2 is not one/,
    );
    expect(() => checkEntry({ kind: 'pattern', match: '円', reading: '$1' })).toThrow(/no groups/);
    expect(
      checkEntry({ kind: 'pattern', match: '(?<n>\\d+)円', reading: '$<n>えん' }).reading,
    ).toBe('$<n>えん');
    expect(() => checkEntry({ kind: 'pattern', match: '(?<n>\\d+)円', reading: '$<m>' })).toThrow(
      /no group named "m"/,
    );
  });
});

describe('applying the lists', () => {
  it('matches a word anywhere, the longer entry winning at the same place', () => {
    const s = [plain('日本橋で日本の話。')];
    expect(readings(s, [entry('word', '日本', 'にっぽん')])).toEqual([
      'にっぽん橋でにっぽんの話。',
    ]);
    expect(
      readings(s, [entry('word', '日本', 'にっぽん'), entry('word', '日本橋', 'にほんばし')]),
    ).toEqual(['にほんばしでにっぽんの話。']);
  });

  it('takes the leftmost match, then the longer, then the older entry', () => {
    const s = [plain('東京都庁')];
    // Leftmost wins over a longer match that starts later.
    expect(
      readings(s, [entry('word', '京都庁', 'X'), entry('word', '東京', 'とうきょう')]),
    ).toEqual(['とうきょう都庁']);
    // Same place and length: the older entry.
    const older = entry('word', '東京', 'A', null, 1);
    const newer = entry('word', '東京', 'B', 'book', 2);
    expect(readings(s, [{ ...newer, bookId: null }, older])).toEqual(['A都庁']);
  });

  it("lets the book's list claim its matches first; the global list fills the rest", () => {
    const s = [plain('日本の日本人')];
    const global = entry('word', '日本人', 'にほんじん');
    const book = entry('word', '日本', 'ひのもと', 'b1');
    // Without the book entry, the global one reads 日本人.
    expect(readings(s, [global])).toEqual(['日本のにほんじん']);
    // The book's 日本 claims both places first, even the one inside the longer global match.
    expect(readings(s, [global, book])).toEqual(['ひのもとのひのもと人']);
  });

  it("skips places read by the book's own furigana and counts them", () => {
    // 畢竟 has furigana (ひっきょう); the fix applies only where it hasn't.
    const s: FixSentence[] = [
      {
        text: '畢竟、遠い。',
        reading: 'ひっきょう、遠い。',
        ruby: [{ start: 0, end: 2, rt: 'ひっきょう' }],
      },
      plain('畢竟、近い。'),
    ];
    const fix = entry('word', '畢竟', 'つまり');
    const results = applyFixes(s, [fix]);
    expect(results[0]).toEqual({ hits: [], skipped: [fix.id] });
    expect(results[1].reading).toBe('つまり、近い。');
    // A match only touching the furigana run is skipped too.
    const partial = entry('word', '竟、', 'X');
    expect(applyFixes([s[0]], [partial])[0].skipped).toEqual([partial.id]);
    // Next to it, a fix keeps the furigana and the rest of the text.
    expect(readings([s[0]], [entry('word', '遠い', 'とおい')])).toEqual(['ひっきょう、とおい。']);
  });

  it('keeps a sentence without a match exactly as it was, gaiji marks included', () => {
    const s: FixSentence = { text: '〓外字。', reading: '外字。', ruby: [] };
    const [r] = applyFixes([s], [entry('word', '漢字', 'かんじ')]);
    expect(r).toEqual({ hits: [], skipped: [] });
    // With a match, the rebuilt reading leaves gaiji marks out like book-script.ts does.
    expect(readings([s], [entry('word', '外字', 'がいじ')])).toEqual(['がいじ。']);
  });

  it('uses lookarounds, groups and sentence ends in patterns; never matches a reading again', () => {
    const s = [plain('日本橋の日本。'), plain('3人と10人')];
    expect(readings(s, [entry('pattern', '日本(?!橋)', 'にっぽん')])[0]).toBe('日本橋のにっぽん。');
    expect(readings(s, [entry('pattern', '(\\d+)人', '$1にん')])[1]).toBe('3にんと10にん');
    expect(readings(s, [entry('pattern', '(?<n>\\d+)人$', '$<n>名$$')])[1]).toBe('3人と10名$');
    expect(readings(s, [entry('pattern', '^日本', '[$&]')])[0]).toBe('[日本]橋の日本。');
    // A fix's reading is not looked at again: ほん → X doesn't touch にほん from a fix.
    expect(readings(s, [entry('word', '日本', 'にほん', 'b'), entry('word', 'ほん', 'X')])[0]).toBe(
      'にほん橋のにほん。',
    );
  });

  it('rebuilds readings with furigana and fixes in UTF-16 offsets (astral characters)', () => {
    const s: FixSentence = {
      text: '𩸽と𠮟る',
      reading: 'ほっけと𠮟る',
      ruby: [{ start: 0, end: 2, rt: 'ほっけ' }],
    };
    expect(readings([s], [entry('word', '𠮟る', 'しかる')])).toEqual(['ほっけとしかる']);
    expect(buildReading(s, [])).toBe(s.reading);
  });
});

describe('the time-limited worker thread', () => {
  const runners: FixRunner[] = [];
  afterEach(async () => {
    for (const r of runners.splice(0)) await r.close();
  });

  it('applies fixes off the main thread and stops a pattern that runs too long, naming it', async () => {
    const runner = new FixRunner({ timeoutSeconds: 1 });
    runners.push(runner);
    const fast = entry('word', '日本', 'にほん');
    expect(await runner.apply([fast], [plain('日本。')])).toEqual([
      {
        reading: 'にほん。',
        hits: [{ entryId: fast.id, start: 0, end: 2, reading: 'にほん' }],
        skipped: [],
      },
    ]);
    const slow = entry('pattern', '^(a+)+$', 'x');
    const started = Date.now();
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 50);
    const err = await runner
      .apply([fast, slow], [plain(`${'a'.repeat(40)}!`)])
      .catch((e: unknown) => e);
    clearInterval(timer);
    expect(err).toBeInstanceOf(FixTimeoutError);
    expect((err as FixTimeoutError).entryId).toBe(slow.id);
    expect(Date.now() - started).toBeLessThan(10_000);
    // The main thread kept running meanwhile.
    expect(ticks).toBeGreaterThan(5);
    // A fresh worker answers the next run.
    expect((await runner.apply([fast], [plain('日本')]))[0].reading).toBe('にほん');
  }, 30_000);
});

const track: Track = { envs: [], services: [] };
afterEach(async () => {
  for (const s of track.services.splice(0)) await s.stop();
  for (const e of track.envs.splice(0)) e.close();
});

describe.skipIf(!HAS_FFMPEG)('the lists (routes)', () => {
  it('adds, lists, edits and removes entries per book and globally, per user', async () => {
    const t = await makeTtsEnv(track);
    const book = t.bookId(HITSUJI);
    const add = (body: Record<string, unknown>) =>
      request(t.app).post('/api/v1/pronunciation-fixes').set(t.auth).send(body);
    const list = async (bookId?: string) =>
      (
        await request(t.app)
          .get(`/api/v1/pronunciation-fixes${bookId ? `?bookId=${bookId}` : ''}`)
          .set(t.auth)
      ).body;

    expect(await list()).toMatchObject({
      available: true,
      entries: [],
      limits: {
        wordMax: 100,
        patternMax: 200,
        readingMax: 200,
        entriesPerList: 1000,
        timeoutSeconds: 30,
      },
    });
    const g = await add({ kind: 'word', match: '椎名', reading: 'しいな' });
    expect(g.status).toBe(201);
    expect(g.body.entry).toMatchObject({
      bookId: null,
      kind: 'word',
      match: '椎名',
      reading: 'しいな',
    });
    const b = await add({ bookId: book, kind: 'word', match: '椎名', reading: 'しいなさん' });
    expect(b.status).toBe(201);
    // The same word twice in one list is refused; in the other list it's fine (above).
    expect((await add({ kind: 'word', match: '椎名', reading: 'x' })).body.error.code).toBe(
      'duplicate',
    );
    expect((await add({ kind: 'word', match: '', reading: 'x' })).body.error).toMatchObject({
      code: 'invalid_match',
      message: 'Type the word to fix',
    });
    expect((await add({ kind: 'pattern', match: 'a*', reading: 'x' })).status).toBe(400);
    expect((await add({ bookId: 'nope', kind: 'word', match: 'a', reading: 'x' })).status).toBe(
      404,
    );

    expect((await list()).entries.map((e: { match: string }) => e.match)).toEqual(['椎名']);
    expect((await list(book)).entries.map((e: { reading: string }) => e.reading)).toEqual([
      'しいなさん',
    ]);
    expect((await list(t.bookId(SPY))).entries).toEqual([]);

    const edited = await request(t.app)
      .patch(`/api/v1/pronunciation-fixes/${b.body.entry.id}`)
      .set(t.auth)
      .send({ reading: 'シイナ' });
    expect(edited.body.entry).toMatchObject({ match: '椎名', reading: 'シイナ' });
    expect(
      (
        await request(t.app)
          .patch(`/api/v1/pronunciation-fixes/${b.body.entry.id}`)
          .set(t.auth)
          .send({ kind: 'pattern', match: '(' })
      ).body.error.code,
    ).toBe('invalid_pattern');
    expect(
      (await request(t.app).delete(`/api/v1/pronunciation-fixes/${g.body.entry.id}`).set(t.auth))
        .status,
    ).toBe(204);
    expect(
      (await request(t.app).delete(`/api/v1/pronunciation-fixes/${g.body.entry.id}`).set(t.auth))
        .status,
    ).toBe(404);
    expect((await list()).entries).toEqual([]);

    // Another user sees none of it and can't change it.
    const fixes = t.fixes as FixService;
    expect(fixes.list('someone-else', book)).toEqual([]);
    expect(() => fixes.remove('someone-else', b.body.entry.id)).toThrow(/No such fix/);
    const owner = (
      t.e.db.prepare('SELECT user_id FROM pronunciation_fixes LIMIT 1').get() as { user_id: string }
    ).user_id;
    expect(fixes.list(owner, book)).toHaveLength(1);
    // Worker tokens are refused.
    expect((await request(t.app).get('/api/v1/pronunciation-fixes').set(t.worker)).status).toBe(
      403,
    );
  });

  it('refuses a book pattern that takes too long on the book when it is saved', async () => {
    const t = await makeTtsEnv(track, {
      fixTimeoutSeconds: 1,
      script: {
        version: 2,
        characters: 41,
        chapters: [
          {
            index: 0,
            title: 'A',
            startCharacter: 0,
            characters: 41,
            sentences: [
              {
                text: `${'a'.repeat(40)}!`,
                reading: `${'a'.repeat(40)}!`,
                ruby: [],
                position: 0,
                paragraphEnd: true,
              },
            ],
          },
        ],
      },
    });
    const res = await request(t.app)
      .post('/api/v1/pronunciation-fixes')
      .set(t.auth)
      .send({ bookId: t.bookId(HITSUJI), kind: 'pattern', match: '^(a+)+$', reading: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'fix_timeout',
      message: 'This pattern takes longer than 1 s on this book; make it simpler',
    });
    expect(
      (
        await request(t.app)
          .get(`/api/v1/pronunciation-fixes?bookId=${t.bookId(HITSUJI)}`)
          .set(t.auth)
      ).body.entries,
    ).toEqual([]);
    // The same pattern in the global list has no book to try it on: saved (a job refuses it).
    const global = await request(t.app)
      .post('/api/v1/pronunciation-fixes')
      .set(t.auth)
      .send({ kind: 'pattern', match: '^(a+)+$', reading: 'x' });
    expect(global.status).toBe(201);
    const voice = await t.addVoice();
    const job = await t.startBook(HITSUJI, { voiceId: voice.id });
    expect(job.status).toBe(422);
    expect(job.body.error.code).toBe('fix_timeout');
    expect(job.body.error.message).toBe(
      'The pronunciation fix pattern "^(a+)+$" took longer than 1 s on this book; change or remove it',
    );
    expect(await t.latestBook(HITSUJI)).toBeNull();
  }, 60_000);
});
