/**
 * Season 2 Phase 12: the text the PC reads for an Enrich sentence clip, found in the book's
 * script (sentence-text.ts): the book's furigana kept, cut to the Enrich sentence.
 */
import { describe, expect, it } from 'vitest';
import { clipText, squeeze, type SourceSentence } from '../src/audio/sentence-text';

const BOOK: SourceSentence[] = [
  {
    text: '善なるものは畢竟、遠い。',
    reading: '善なるものはひっきょう、遠い。',
    ruby: [{ start: 6, end: 8, rt: 'ひっきょう' }],
    position: 0,
    paragraphEnd: false,
  },
  { text: 'けれども悪は近い！', reading: 'けれども悪は近い！', position: 11, paragraphEnd: true },
  {
    text: '𠮷野家で畢竟、食べた。',
    reading: '𠮷野家でひっきょう、食べた。',
    ruby: [{ start: 5, end: 7, rt: 'ひっきょう' }],
    position: 20,
    paragraphEnd: true,
  },
  { text: '近い！', reading: '近い！', position: 40, paragraphEnd: true },
];

describe('the text of a sentence clip (Season 2 Phase 12)', () => {
  it('reads a whole sentence exactly as the script has it', () => {
    const r = clipText(BOOK, '善なるものは畢竟、遠い。', 0);
    expect(r.found).toBe(true);
    expect(r.sentences).toEqual([
      {
        text: '善なるものは畢竟、遠い。',
        reading: '善なるものはひっきょう、遠い。',
        ruby: [{ start: 6, end: 8, rt: 'ひっきょう' }],
        position: 0,
        paragraphEnd: true,
      },
    ]);
  });

  it('cuts a selection across two sentences and paragraphs, keeping the furigana inside', () => {
    const r = clipText(BOOK, 'ものは畢竟、遠い。\nけれども悪', 2);
    expect(r.found).toBe(true);
    expect(r.sentences.map((s) => [s.text, s.reading, s.ruby])).toEqual([
      ['ものは畢竟、遠い。', 'ものはひっきょう、遠い。', [{ start: 3, end: 5, rt: 'ひっきょう' }]],
      ['けれども悪', 'けれども悪', []],
    ]);
    expect(r.sentences.map((s) => s.paragraphEnd)).toEqual([false, true]);
  });

  it('drops a furigana run the cut goes through (SudachiPy reads those kanji)', () => {
    const r = clipText(BOOK, '竟、遠い。', 0);
    expect(r.sentences).toEqual([
      { text: '竟、遠い。', reading: '竟、遠い。', ruby: [], position: 0, paragraphEnd: true },
    ]);
  });

  it('keeps characters outside the BMP whole and the furigana after them in place', () => {
    const r = clipText(BOOK, '野家で畢竟', 20);
    expect(r.sentences[0]).toMatchObject({
      text: '野家で畢竟',
      reading: '野家でひっきょう',
      ruby: [{ start: 3, end: 5, rt: 'ひっきょう' }],
    });
    expect(clipText(BOOK, '𠮷野家', 20).sentences[0].text).toBe('𠮷野家');
  });

  it('takes the place nearest the position when the text is in the book twice', () => {
    expect(clipText(BOOK, '近い！', 12).sentences[0].position).toBe(11);
    expect(clipText(BOOK, '近い！', 39).sentences[0].position).toBe(40);
  });

  it('ignores spaces and line breaks on both sides', () => {
    expect(clipText(BOOK, ' けれども 悪は\n近い！ ', 11).sentences[0].text).toBe(
      'けれども悪は近い！',
    );
    expect(squeeze(' a\u3000b\nc ')).toBe('abc');
  });

  it('reads the text as it is when it is not in the book (the file changed)', () => {
    const r = clipText(BOOK, '別の 文。\n次の行', 5);
    expect(r.found).toBe(false);
    expect(r.sentences).toEqual([
      { text: '別の 文。', reading: '別の 文。', ruby: [], position: 5, paragraphEnd: true },
      { text: '次の行', reading: '次の行', ruby: [], position: 5, paragraphEnd: true },
    ]);
    expect(clipText(BOOK, '  ', 0)).toEqual({ sentences: [], found: false });
  });
});
