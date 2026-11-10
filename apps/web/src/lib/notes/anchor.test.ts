/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { countEpubFile } from '$lib/server/epub/count-epub-node';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import {
  buildBookTextIndex,
  matchRange,
  parseBookHtml
} from '$lib/components/book-reader/book-search';
import {
  anchorOfRange,
  anchorOfSpan,
  locateExact,
  placeAnchor,
  spanOfRange,
  type TextAnchor
} from './anchor';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/fixtures'
);

let doc: Document;

beforeAll(() => {
  doc = installNodeDom();
});

function live(html: string) {
  const root = parseBookHtml(html);
  return { root, index: buildBookTextIndex(root, true), owner: root.ownerDocument as Document };
}

/** A range over the first occurrence of `text` in the root's text nodes (one node). */
function rangeOver(root: Node, text: string) {
  const walker = (root.ownerDocument as Document).createTreeWalker(root, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = (n.textContent ?? '').indexOf(text);
    if (at >= 0) {
      const range = (root.ownerDocument as Document).createRange();
      range.setStart(n, at);
      range.setEnd(n, at + text.length);
      return range;
    }
  }
  throw new Error(`no ${text}`);
}

const BOOK =
  '<p>一章</p><p>吾輩は猫である。名前はまだ無い。</p><p>どこで生れたかとんと見当がつかぬ。</p>';

describe('anchorOfRange', () => {
  it('gives the reader positions, the text and its context', () => {
    const { root, index } = live(BOOK);
    const anchor = anchorOfRange(index, rangeOver(root, '名前はまだ'));
    // 一章 (2) + 吾輩は猫である (7) before it; 。 is not counted.
    expect(anchor).toEqual({
      start: 9,
      end: 14,
      text: '名前はまだ',
      before: '一章\n吾輩は猫である。',
      after: '無い。\nどこで生れたかとんと見当がつかぬ。'
    });
  });

  it('adds the base of a paginated section', () => {
    const { root, index } = live(BOOK);
    expect(anchorOfRange(index, rangeOver(root, '名前'), 1000)?.start).toBe(1009);
  });

  it('keeps leading brackets and spans paragraphs with a line break', () => {
    const { root, index, owner } = live('<p>「こんにちは」と言った。</p><p>次の行。</p>');
    const range = owner.createRange();
    const first = rangeOver(root, '「こん');
    const second = rangeOver(root, '次の');
    range.setStart(first.startContainer, first.startOffset);
    range.setEnd(second.endContainer, second.endOffset);
    const anchor = anchorOfRange(index, range);
    expect(anchor?.text).toBe('「こんにちは」と言った。\n次の');
    expect(anchor?.start).toBe(0);
    // こんにちは (5) + と言った (4) + 次の (2); brackets and 。 are not counted.
    expect(anchor?.end).toBe(11);
  });

  it('handles element boundaries and trims whitespace', () => {
    const { root, index, owner } = live('<p>  前の文。</p><p>後の文。 </p>');
    const range = owner.createRange();
    range.setStart(root, 0);
    range.setEnd(root, root.childNodes.length);
    expect(anchorOfRange(index, range)?.text).toBe('前の文。\n後の文。');
  });

  it('takes ruby base text, never the reading, and refuses a reading-only selection', () => {
    const { root, index, owner } = live(
      '<p><ruby>改札<rp>（</rp><rt>かいさつ</rt><rp>）</rp></ruby>を抜けた。</p>'
    );
    const range = owner.createRange();
    const base = rangeOver(root, '改札');
    const after = rangeOver(root, 'を抜け');
    range.setStart(base.startContainer, base.startOffset);
    range.setEnd(after.endContainer, after.endOffset);
    const anchor = anchorOfRange(index, range);
    expect(anchor?.text).toBe('改札を抜け');
    expect(anchor?.start).toBe(0);
    // （ and ） are counted? No: not Japanese characters, so 改札を抜け = 5.
    expect(anchor?.end).toBe(5);

    expect(anchorOfRange(index, rangeOver(root, 'かいさつ'))).toBeUndefined();
  });

  it('refuses punctuation-only and collapsed selections', () => {
    const { root, index, owner } = live(BOOK);
    expect(anchorOfRange(index, rangeOver(root, '。'))).toBeUndefined();
    const range = owner.createRange();
    range.setStart(rangeOver(root, '名').startContainer, 3);
    expect(spanOfRange(index, range)).toBeUndefined();
  });

  it('counts gaiji as one character', () => {
    const { root, index, owner } = live('<p>前<img class="gaiji" src="x.png"/>後ろ</p>');
    const range = owner.createRange();
    range.setStart(root.querySelector('p') as Node, 0);
    range.setEnd(root.querySelector('p') as Node, 3);
    const anchor = anchorOfRange(index, range);
    expect(anchor?.text).toBe('前〓後ろ');
    expect(anchor?.end).toBe(4);
  });
});

describe('locateExact', () => {
  it('finds an anchor at its position, also one starting on an uncounted character', () => {
    const { root, index } = live('<p>「こんにちは」と言った。</p>');
    const anchor = anchorOfRange(index, rangeOver(root, '「こんにちは」'))!;
    expect(anchor.start).toBe(0);
    const span = locateExact(index, anchor)!;
    expect(index.display.slice(span.displayStart, span.displayEnd).join('')).toBe('「こんにちは」');
    expect(locateExact(index, { ...anchor, start: 1 })).toBeUndefined();
  });

  it('works on a section index with its base', () => {
    const { root, index } = live(BOOK);
    const anchor = anchorOfRange(index, rangeOver(root, '猫'), 500)!;
    expect(locateExact(index, anchor, 500)).toBeDefined();
    expect(locateExact(index, anchor, 0)).toBeUndefined();
  });
});

describe('placeAnchor', () => {
  const made = (html: string, text: string): TextAnchor => {
    const { root, index } = live(html);
    return anchorOfRange(index, rangeOver(root, text))!;
  };
  const textAt = (html: string, anchor: TextAnchor, maxDistance = 2000) => {
    const index = buildBookTextIndex(parseBookHtml(html));
    const placed = placeAnchor(index, anchor, maxDistance);
    return placed.status === 'unplaced'
      ? { status: placed.status }
      : {
          status: placed.status,
          start: placed.start,
          text: index.display.slice(placed.displayStart, placed.displayEnd).join('')
        };
  };

  it('is exact in the same file', () => {
    const anchor = made(BOOK, '名前はまだ');
    expect(textAt(BOOK, anchor)).toEqual({ status: 'exact', start: 9, text: '名前はまだ' });
  });

  it('finds the text again after text was added before it', () => {
    const anchor = made(BOOK, '名前はまだ');
    const changed = '<p>序文がここに入った。とても長い序文。</p>' + BOOK;
    expect(textAt(changed, anchor)).toEqual({ status: 'moved', start: 25, text: '名前はまだ' });
  });

  it('takes the occurrence whose context agrees, even far away', () => {
    const filler = '<p>' + 'あ'.repeat(5000) + '</p>';
    const html = '<p>猫がいる。</p>' + filler + BOOK;
    const anchor = made(html, '猫である');
    const changed = '<p>猫である。別の猫である。</p>' + filler + filler + BOOK;
    const placed = textAt(changed, anchor, 10);
    expect(placed.status).toBe('moved');
    expect(placed.start).toBeGreaterThan(10_000);
  });

  it('accepts a nearby occurrence when the context changed, within the distance', () => {
    const anchor = made(BOOK, '名前');
    const changed = '<p>一章</p><p>吾輩は犬だ。名前は知らない。</p>';
    expect(textAt(changed, anchor).status).toBe('moved');
    expect(textAt(changed, anchor, 0).status).toBe('unplaced');
  });

  it('refuses a short text far away without matching context', () => {
    const anchor = made(BOOK, '猫');
    const changed = '<p>一章</p><p>' + 'い'.repeat(3000) + '猫</p>';
    expect(textAt(changed, anchor, 2000)).toEqual({ status: 'unplaced' });
  });

  it('keeps it unplaced when the text is gone', () => {
    const anchor = made(BOOK, '名前はまだ');
    expect(textAt('<p>一章</p><p>全く別の本。</p>', anchor)).toEqual({ status: 'unplaced' });
  });

  it('ignores spacing differences', () => {
    const anchor = made(BOOK, '名前はまだ');
    const changed = BOOK.replace('名前はまだ', '名前は まだ');
    expect(textAt(changed, anchor)).toMatchObject({ status: 'exact', start: 9 });
  });
});

describe('fixture books', () => {
  it('round-trips spans: live range -> anchor -> exact place', async () => {
    const books = [
      '<p><ruby>漢字<rt>かんじ</rt></ruby>の「テスト」。</p><p>二段落目、<img class="gaiji" src="g.png"/>あり。</p>'
    ];
    for (const file of [
      'synthetic-epub3.epub',
      'synthetic-epub3-navonly.epub',
      'synthetic-epub2-ncx.epub'
    ]) {
      const result = await countEpubFile(path.join(fixturesDir, file), {
        importHTMLFixMode: ImportHTMLFixMode.OFF,
        restrictImportFixToAnchor: true
      });
      books.push(result.elementHtml);
    }

    for (const html of books) {
      const root = parseBookHtml(html);
      const index = buildBookTextIndex(root, true);
      const n = index.display.length;
      let checked = 0;

      for (let start = 0; start < n && checked < 300; start += Math.max(1, Math.floor(n / 97))) {
        const end = Math.min(n, start + 1 + ((start * 7) % 40));
        const expected = anchorOfSpan(index, { displayStart: start, displayEnd: end });
        if (!expected) continue;
        const range = matchRange(index, { position: 0, displayStart: start, displayEnd: end }, doc);
        if (!range) continue;
        expect(anchorOfRange(index, range)).toEqual(expected);
        const span = locateExact(index, expected)!;
        expect(index.display.slice(span.displayStart, span.displayEnd).join('')).toBe(
          expected.text
        );
        checked += 1;
      }

      expect(checked).toBeGreaterThan(10);
    }
  });
});
