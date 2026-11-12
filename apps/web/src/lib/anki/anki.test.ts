/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { buildBookTextIndex, parseBookHtml } from '$lib/components/book-reader/book-search';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { AnkiConnect, type NoteInfo } from './anki-connect';
import { cuesById, findCues, normalizeForMatch, similarity, type Cue } from './cue-match';
import { describeResult, EnrichError, enrichLastCard, type EnrichInput } from './enrich';
import { isEmptyField, mergeField } from './field-merge';
import { hasMapping, parseMapping, withTarget } from './mapping';
import { parseReaderLink, readerLinkPath, titleTag } from './reader-link';
import { sentenceAt, sentenceFromText } from './sentence';
import { cuesFromFile, cuesFromSaved, parseVtt } from './subtitle-cues';
import { coverFileName } from './cover';

beforeAll(() => {
  installNodeDom();
});

// ---------------------------------------------------------------- fields

describe('field merge', () => {
  it('counts fields with only markup, spaces or zero-width characters as empty', () => {
    expect(isEmptyField('')).toBe(true);
    expect(isEmptyField('<br>')).toBe(true);
    expect(isEmptyField('&nbsp; <div></div>')).toBe(true);
    expect(isEmptyField('&#8203;')).toBe(true);
    expect(isEmptyField('<img src="a.jpg">')).toBe(false);
    expect(isEmptyField('[sound:a.mp3]')).toBe(false);
    expect(isEmptyField('猫')).toBe(false);
  });

  it('fills an empty field and never overwrites a filled one', () => {
    expect(mergeField('', 'new', 'fill-if-empty')).toBe('new');
    expect(mergeField('<br>', 'new', 'fill-if-empty')).toBe('new');
    expect(mergeField('old', 'new', 'fill-if-empty')).toBeNull();
    expect(mergeField('old', '', 'append')).toBeNull();
  });

  it('appends after a line break, and never twice', () => {
    expect(mergeField('old', 'new', 'append')).toBe('old<br>new');
    expect(mergeField('', 'new', 'append')).toBe('new');
    expect(mergeField('old<br>new', 'new', 'append')).toBeNull();
  });
});

// ---------------------------------------------------------------- mapping, link, tag

describe('mapping', () => {
  it('keeps only well-formed entries and defaults the mode', () => {
    expect(
      parseMapping({
        'JP Mining Note': {
          sentence: { field: 'Sentence' },
          sentenceAudio: { field: 'SentenceAudio', mode: 'append' },
          cover: { field: '' },
          bogus: { field: 'X' },
          link: { field: 'ReaderLink', mode: 'overwrite' }
        },
        broken: 'x',
        list: []
      })
    ).toEqual({
      'JP Mining Note': {
        sentence: { field: 'Sentence', mode: 'fill-if-empty' },
        sentenceAudio: { field: 'SentenceAudio', mode: 'append' },
        link: { field: 'ReaderLink', mode: 'fill-if-empty' }
      }
    });
    expect(parseMapping(null)).toEqual({});
    expect(parseMapping([1])).toEqual({});
  });

  it('sets and removes one role without touching the others', () => {
    let m = withTarget({}, 'A', 'cover', { field: 'Picture', mode: 'fill-if-empty' });
    m = withTarget(m, 'B', 'link', { field: 'L', mode: 'append' });
    expect(hasMapping(m, 'A')).toBe(true);
    m = withTarget(m, 'A', 'cover', null);
    expect(m).toEqual({ A: {}, B: { link: { field: 'L', mode: 'append' } } });
    expect(hasMapping(m, 'A')).toBe(false);
  });
});

describe('link and tag', () => {
  it('stores only the book and position, and reads them back', () => {
    const path = readerLinkPath('a1b2-c3', 1234.6);
    expect(path).toBe('/open?book=a1b2-c3&pos=1235');
    expect(parseReaderLink(path.slice(path.indexOf('?')))).toEqual({
      bookId: 'a1b2-c3',
      position: 1235
    });
    expect(parseReaderLink('?pos=4')).toBeNull();
    expect(parseReaderLink('?book=x&pos=-3')).toEqual({ bookId: 'x', position: 0 });
    expect(parseReaderLink('?book=x&pos=abc')).toEqual({ bookId: 'x', position: 0 });
    expect(readerLinkPath('id with space', NaN)).toBe('/open?book=id%20with%20space&pos=0');
  });

  it('makes the title tag without spaces or quotes, with an optional prefix', () => {
    expect(titleTag('かくりよの宿飯 あやかしお宿に嫁入りします。')).toBe(
      'かくりよの宿飯_あやかしお宿に嫁入りします。'
    );
    expect(titleTag('Say "hi"  there ')).toBe('Say_hi_there');
    expect(titleTag('本　全角スペース')).toBe('本_全角スペース');
    expect(titleTag('本', 'book::')).toBe('book::本');
    expect(titleTag('   ')).toBeNull();
  });

  it('names a cover file per book', () => {
    expect(coverFileName('6efee4ba-c851-4f7b')).toBe('ttsu-cover-6efee4ba-c851-4f7b.jpg');
    expect(coverFileName('../x')).toBe('ttsu-cover-x.jpg');
  });
});

// ---------------------------------------------------------------- sentence

function indexOf(html: string) {
  return buildBookTextIndex(parseBookHtml(html));
}

function at(index: ReturnType<typeof indexOf>, text: string) {
  const i = index.display.join('').indexOf(text);
  if (i < 0) throw new Error(`not found: ${text}`);
  return [i, i + text.length] as const;
}

describe('sentence around a lookup', () => {
  it('cuts at sentence ends and paragraphs, leaving ruby readings out', () => {
    const index = indexOf(
      '<p>前の文。<ruby>猫<rt>ねこ</rt></ruby>が好きだ。次の文。</p><p>別の段落。</p>'
    );
    const [s, e] = at(index, '好き');
    const sentence = sentenceAt(index, s, e)!;
    expect(sentence.text).toBe('猫が好きだ。');
    expect(sentence.html).toBe('猫が好きだ。');
    expect(sentence.position).toBe(index.countBefore[at(index, '猫')[0]]);
    expect(sentenceAt(index, ...at(index, '別'))!.text).toBe('別の段落。');
  });

  it('bolds the looked-up word when its length is known, and escapes HTML', () => {
    const index = indexOf('<p>a&lt;b は猫だ。</p>');
    const [s, e] = at(index, '猫');
    expect(sentenceAt(index, s, e, { boldWord: true })!.html).toBe('a&lt;b は<b>猫</b>だ。');
    expect(sentenceAt(index, s, e, { base: 100 })!.position).toBe(100);
  });

  it('keeps closing brackets with their sentence and balances quotes', () => {
    const index = indexOf('<p>「行くよ。」と彼は言った。「待って！」</p>');
    expect(sentenceAt(index, ...at(index, '行く'))!.text).toBe('「行くよ。」');
    expect(sentenceAt(index, ...at(index, '彼'))!.text).toBe('と彼は言った。');
    expect(sentenceAt(index, ...at(index, '待'))!.text).toBe('「待って！」');

    const inner = indexOf('<p>「一つ目。二つ目だ。」</p>');
    expect(sentenceAt(inner, ...at(inner, '二つ'))!.text).toBe('二つ目だ。');
    expect(sentenceAt(inner, ...at(inner, '一つ'))!.text).toBe('一つ目。');
  });

  it('caps very long sentences', () => {
    const index = indexOf(`<p>${'あ'.repeat(500)}猫${'い'.repeat(500)}。</p>`);
    const sentence = sentenceAt(index, ...at(index, '猫'))!;
    expect(sentence.text.length).toBeLessThanOrEqual(401);
    expect(sentence.text).toContain('猫');
  });

  it('takes a selection as it is', () => {
    expect(sentenceFromText('  猫が\n好き  ', 7)).toEqual({
      text: '猫が\n好き',
      html: '猫が<br>好き',
      position: 7
    });
    expect(sentenceFromText('  ', 0)).toBeNull();
  });
});

// ---------------------------------------------------------------- cues

const CUES: Cue[] = [
  { id: '1', start: 0, end: 2, text: '前の文。' },
  { id: '2', start: 2, end: 4, text: '猫が' },
  { id: '3', start: 4, end: 6, text: '好きだ。' },
  { id: '4', start: 6, end: 8, text: '関係ない話。' },
  { id: '5', start: 100, end: 102, text: '猫が好きだ。' }
];

describe('subtitle lines for a sentence', () => {
  it('normalizes width, spaces and punctuation', () => {
    expect(normalizeForMatch('「ＡＢＣ」　猫、だ！')).toBe('abc猫だ');
    expect(similarity('猫が好き', '猫が好き')).toBe(1);
    expect(similarity('猫が好き', '犬が嫌い')).toBeLessThan(0.3);
  });

  it('uses the lines of a matched book exactly', () => {
    expect(cuesById(CUES, ['3', '2', 'x'])).toMatchObject({
      start: 2,
      end: 6,
      how: 'matched-book'
    });
    expect(cuesById(CUES, ['x'])).toBeNull();
  });

  it('finds the sentence across lines, nearest the expected time when repeated', () => {
    expect(findCues(CUES, '猫が好きだ。', { threshold: 0.6 })).toMatchObject({
      start: 2,
      end: 6,
      how: 'exact'
    });
    expect(findCues(CUES, '猫が好きだ', { threshold: 0.6, expectedSeconds: 95 })).toMatchObject({
      start: 100,
      end: 102
    });
    expect(findCues(CUES, '猫が好きだ', { threshold: 0.6, expectedSeconds: 3 })).toMatchObject({
      start: 2,
      end: 6
    });
  });

  it('falls back to similar lines above the threshold, else nothing', () => {
    const lines: Cue[] = [
      { id: '1', start: 10, end: 12, text: 'その日、私は駅で彼女に会った。' },
      { id: '2', start: 12, end: 14, text: '全然違う内容です。' }
    ];
    expect(findCues(lines, 'その日、わたしは駅で彼女に会った。', { threshold: 0.6 })).toMatchObject(
      { start: 10, end: 12, how: 'similar' }
    );
    expect(findCues(lines, '宇宙の果てまで行こう。', { threshold: 0.6 })).toBeNull();
    expect(findCues(lines, '猫', { threshold: 0.1 })).toBeNull();
    expect(findCues([], '猫が好き', { threshold: 0.1 })).toBeNull();
  });

  it('reads saved lines, srt and vtt with whispersync padding', () => {
    expect(
      cuesFromSaved(
        [
          { id: '1', originalStartSeconds: 1, originalEndSeconds: 2, text: 'a' },
          {
            id: '2',
            originalStartSeconds: 3,
            originalEndSeconds: 4,
            adjustedStartSeconds: 2.5,
            text: 'b'
          }
        ],
        { startMs: -2000, endMs: 500 }
      )
    ).toEqual([
      { id: '1', start: 0, end: 2.5, text: 'a' },
      { id: '2', start: 2.5, end: 4.5, text: 'b' }
    ]);
    expect(
      cuesFromFile(
        'x.srt',
        '1\n00:00:01,000 --> 00:00:02,500\n猫が\n\n2\n00:00:03,000 --> 00:00:04,000\n好き\n',
        {
          startMs: 0,
          endMs: 0
        }
      )
    ).toEqual([
      { id: '1', start: 1, end: 2.5, text: '猫が' },
      { id: '2', start: 3, end: 4, text: '好き' }
    ]);
    expect(
      parseVtt(
        'WEBVTT\n\n00:01.000 --> 00:02.000 align:start\n<v A>猫</v>\n\n1:00:00.000 --> 1:00:01.500\n犬\n'
      )
    ).toEqual([
      { id: '1', originalStartSeconds: 1, originalEndSeconds: 2, text: '猫' },
      { id: '2', originalStartSeconds: 3600, originalEndSeconds: 3601.5, text: '犬' }
    ]);
  });
});

// ---------------------------------------------------------------- AnkiConnect + enrich

interface Call {
  action: string;
  params?: Record<string, unknown>;
}

function fakeAnki({
  notes = [] as NoteInfo[],
  android = false,
  failOn = new Set<string>()
}: { notes?: NoteInfo[]; android?: boolean; failOn?: Set<string> } = {}) {
  const calls: Call[] = [];
  const media: Record<string, string> = {};
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Call;
    calls.push(body);
    const ok = (result: unknown) => new Response(JSON.stringify({ result, error: null }));
    const err = (error: string) => new Response(JSON.stringify({ result: null, error }));

    if (failOn.has(body.action)) return err(`${body.action} failed`);

    switch (body.action) {
      case 'requestPermission':
        return android
          ? err('com.google.gson.stream.MalformedJsonException: bad')
          : ok({ permission: 'granted' });
      case 'findNotes':
        return ok(notes.map((n) => n.noteId));
      case 'notesInfo':
        return ok(notes.filter((n) => (body.params!.notes as number[]).includes(n.noteId)));
      case 'storeMediaFile':
        media[body.params!.filename as string] = body.params!.data as string;
        return ok(body.params!.filename);
      case 'updateNoteFields': {
        const note = body.params!.note as { id: number; fields: Record<string, string> };
        const n = notes.find((x) => x.noteId === note.id)!;
        for (const [k, v] of Object.entries(note.fields)) n.fields[k].value = v;
        return ok(null);
      }
      case 'addTags': {
        if (android) return err('unsupported action');
        const n = notes.find((x) => (body.params!.notes as number[]).includes(x.noteId))!;
        n.tags.push(body.params!.tags as string);
        return ok(null);
      }
      case 'guiSelectedNotes':
        return ok([]);
      default:
        return err(`unknown action ${body.action}`);
    }
  };
  const anki = new AnkiConnect({ url: 'http://anki.test:8765/', timeoutSeconds: 5, fetchImpl });
  return { anki, calls, media };
}

function note(id: number, fields: Record<string, string>, modelName = 'JP Mining Note'): NoteInfo {
  return {
    noteId: id,
    modelName,
    tags: [],
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v], order) => [k, { value: v, order }])
    )
  };
}

const MAPPING = {
  'JP Mining Note': {
    sentence: { field: 'Sentence', mode: 'fill-if-empty' as const },
    sentenceAudio: { field: 'SentenceAudio', mode: 'fill-if-empty' as const },
    cover: { field: 'Picture', mode: 'fill-if-empty' as const },
    link: { field: 'ReaderLink', mode: 'fill-if-empty' as const }
  }
};

function input(over: Partial<EnrichInput> = {}): EnrichInput {
  return {
    title: '猫の本',
    tagPrefix: '',
    sentence: { text: '猫が好きだ。', html: '<b>猫</b>が好きだ。', position: 42 },
    link: '/open?book=b1&pos=42',
    cover: async () => ({ fileName: 'ttsu-cover-b1.jpg', load: async () => 'Q09WRVI=' }),
    audio: async () => ({ fileName: 'ttsu-b1-2000-6000.mp3', load: async () => 'QVVESU8=' }),
    days: 1,
    mapping: MAPPING,
    titleTag,
    ...over
  };
}

describe('enrich last card', () => {
  it('fills the newest note: tag, sentence, audio, cover, link', async () => {
    const older = note(100, {
      Key: '犬',
      Sentence: '',
      SentenceAudio: '',
      Picture: '',
      ReaderLink: ''
    });
    const newest = note(200, {
      Key: '猫',
      Sentence: '',
      SentenceAudio: '',
      Picture: '',
      ReaderLink: ''
    });
    const { anki, calls, media } = fakeAnki({ notes: [newest, older] });
    const result = await enrichLastCard(anki, input());

    expect(calls.find((c) => c.action === 'findNotes')!.params).toEqual({ query: 'added:1' });
    expect(result).toMatchObject({ noteId: 200, word: '猫', unmapped: false, android: false });
    expect(result.added).toEqual([
      'tag',
      'sentence',
      'sentence audio',
      'cover',
      'link to the passage'
    ]);
    expect(newest.fields.Sentence.value).toBe('<b>猫</b>が好きだ。');
    expect(newest.fields.SentenceAudio.value).toBe('[sound:ttsu-b1-2000-6000.mp3]');
    expect(newest.fields.Picture.value).toBe('<img src="ttsu-cover-b1.jpg">');
    expect(newest.fields.ReaderLink.value).toBe('/open?book=b1&pos=42');
    expect(newest.tags).toEqual(['猫の本']);
    expect(Object.keys(media).sort()).toEqual(['ttsu-b1-2000-6000.mp3', 'ttsu-cover-b1.jpg']);
    expect(older.fields.Sentence.value).toBe('');
    expect(describeResult(result)).toContain('「猫」');
  });

  it('never overwrites, appends once, and fetches no media for unchanged fields', async () => {
    const n = note(1, {
      Key: '猫',
      Sentence: 'Yomitan の文',
      SentenceAudio: '[sound:old.mp3]',
      Picture: '',
      ReaderLink: ''
    });
    let audioLoads = 0;
    const { anki, media } = fakeAnki({ notes: [n] });
    const mapping = {
      'JP Mining Note': {
        ...MAPPING['JP Mining Note'],
        sentenceAudio: { field: 'SentenceAudio', mode: 'fill-if-empty' as const },
        link: { field: 'ReaderLink', mode: 'append' as const }
      }
    };
    const run = () =>
      enrichLastCard(
        anki,
        input({
          mapping,
          audio: async () => ({
            fileName: 'new.mp3',
            load: async () => {
              audioLoads += 1;
              return 'eA==';
            }
          })
        })
      );

    const first = await run();
    expect(n.fields.Sentence.value).toBe('Yomitan の文');
    expect(n.fields.SentenceAudio.value).toBe('[sound:old.mp3]');
    expect(audioLoads).toBe(0);
    expect(media['new.mp3']).toBeUndefined();
    expect(first.kept).toEqual(expect.arrayContaining(['sentence', 'sentence audio']));

    const second = await run();
    expect(n.fields.ReaderLink.value).toBe('/open?book=b1&pos=42');
    expect(second.added).toEqual([]);
    expect(second.kept).toEqual(expect.arrayContaining(['tag', 'link to the passage', 'cover']));
    expect(n.tags).toEqual(['猫の本']);
  });

  it('adds only the tag for a note type without fields set up', async () => {
    const n = note(1, { Front: 'x', Back: '' }, 'Basic');
    const { anki, calls } = fakeAnki({ notes: [n] });
    const result = await enrichLastCard(anki, input());
    expect(result).toMatchObject({ unmapped: true, added: ['tag'] });
    expect(calls.some((c) => c.action === 'updateNoteFields')).toBe(false);
    expect(describeResult(result)).toContain('No fields are set up for the note type "Basic"');
  });

  it('reports what it could not add', async () => {
    const n = note(1, { Key: '猫', Sentence: '', SentenceAudio: '', Picture: '' });
    const { anki } = fakeAnki({ notes: [n], failOn: new Set(['storeMediaFile']) });
    const result = await enrichLastCard(
      anki,
      input({
        sentence: null,
        noSentenceReason: 'look up a word first',
        link: { skip: 'the book is not in the library' }
      })
    );
    expect(n.fields.Picture.value).toBe('');
    expect(result.added).toEqual(['tag']);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { what: 'sentence', reason: 'look up a word first' },
        { what: 'sentence audio', reason: 'look up a word first' },
        { what: 'link to the passage', reason: 'the book is not in the library' },
        { what: 'cover', reason: 'storeMediaFile failed' }
      ])
    );
    expect(result.skipped.find((s) => s.what === 'link to the passage')).toBeTruthy();
  });

  it('says the field is missing from the note type', async () => {
    const n = note(1, { Key: '猫', Sentence: '' });
    const { anki } = fakeAnki({ notes: [n] });
    const result = await enrichLastCard(anki, input());
    expect(result.skipped).toContainEqual({
      what: 'link to the passage',
      reason: 'the note type has no field "ReaderLink"'
    });
    expect(n.fields.Sentence.value).toBe('<b>猫</b>が好きだ。');
  });

  it('works with AnkiConnect Android, which may not add tags', async () => {
    const n = note(1, { Key: '猫', Sentence: '', SentenceAudio: '', Picture: '', ReaderLink: '' });
    const { anki, calls } = fakeAnki({ notes: [n], android: true });
    const result = await enrichLastCard(anki, input());
    expect(result.android).toBe(true);
    expect(n.fields.Sentence.value).not.toBe('');
    expect(calls.some((c) => c.action.startsWith('gui'))).toBe(false);
    expect(result.skipped).toContainEqual({
      what: 'tag',
      reason: 'AnkiConnect Android did not add it'
    });
  });

  it('fails clearly without a note or without Anki', async () => {
    await expect(enrichLastCard(fakeAnki().anki, input({ days: 3 }))).rejects.toThrow(
      'No note was added to Anki in the last 3 days.'
    );
    const down = new AnkiConnect({
      url: 'http://127.0.0.1:8765',
      timeoutSeconds: 1,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      }
    });
    const error = await enrichLastCard(down, input()).catch((e) => e);
    expect(error).toBeInstanceOf(EnrichError);
    expect(error.message).toBe(
      "Anki didn't answer at http://127.0.0.1:8765. Is Anki open with AnkiConnect?"
    );
  });

  it('times out a request that hangs', async () => {
    const hung = new AnkiConnect({
      url: 'http://127.0.0.1:8765',
      timeoutSeconds: 1,
      fetchImpl: (_u, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        )
    });
    await expect(hung.invoke('version')).rejects.toThrow("Anki didn't answer in time");
  });
});
