/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installNodeDom } from './node-dom';
import { bookScriptFromHtml } from './book-script';
import { bookScriptEpubBlob, countEpubBlob } from './count-epub-node';
import { countHtml } from '$lib/functions/file-loaders/epub/count-epub';
import type { Section } from '$lib/data/database/books-db/versions/v3/books-db-v3';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', '..', '..', 'tests', 'fixtures');

let doc: Document;

beforeAll(() => {
  doc = installNodeDom();
});

const wrap = (id: string, body: string) =>
  `<div id="ttu-${id}"><div class="ttu-book-html-wrapper"><div class="ttu-book-body-wrapper">${body}</div></div></div>`;

describe('bookScriptFromHtml', () => {
  const html =
    wrap('c0', '<p>表紙</p>') +
    wrap(
      'c1',
      '<h1>第一章</h1><p>善なるものは<ruby>畢竟<rt>ひっきょう</rt></ruby>、遠い。けれども悪は近い！「そうか。」</p>' +
        '<p>＊＊＊</p><p>二つ目の<ruby><rb>段落</rb><rp>（</rp><rt>だんらく</rt><rp>）</rp></ruby>です</p>'
    ) +
    wrap('c1b', '<p>続きの文。<img class="gaiji" src="x.png"/>外字。</p>') +
    wrap('c2', '<p>　</p>') +
    wrap('c3', '<p>最後の章。</p>');
  const sections: Section[] = [
    { reference: 'ttu-c0', charactersWeight: 1, label: 'Preface', startCharacter: 0 },
    { reference: 'ttu-c1', charactersWeight: 1, label: ' 第一章 ' },
    { reference: 'ttu-c1b', charactersWeight: 1, parentChapter: 'ttu-c1' },
    { reference: 'ttu-c2', charactersWeight: 1, label: '空' },
    { reference: 'ttu-c3', charactersWeight: 1, label: '' }
  ];

  it('makes chapters, sentences, readings and reader positions', () => {
    const total = countHtml(html, doc);
    const script = bookScriptFromHtml(html, sections, total, doc);

    expect(script.chapters.map((c) => c.title)).toEqual(['Preface', '第一章', 'Chapter 3']);
    expect(script.chapters.map((c) => c.index)).toEqual([0, 1, 2]);

    const ch1 = script.chapters[1];

    expect(ch1.sentences.map((s) => s.text)).toEqual([
      '第一章',
      '善なるものは畢竟、遠い。',
      'けれども悪は近い！',
      '「そうか。」',
      '二つ目の段落です',
      '続きの文。',
      '〓外字。'
    ]);
    expect(ch1.sentences[1].reading).toBe('善なるものはひっきょう、遠い。');
    expect(ch1.sentences[4].reading).toBe('二つ目のだんらくです');
    expect(ch1.sentences[6].reading).toBe('外字。');
    expect(ch1.sentences.map((s) => s.paragraphEnd)).toEqual([
      true,
      false,
      false,
      true,
      true,
      false,
      true
    ]);

    // Positions are the reader's counted characters before each sentence.
    const all = script.chapters.flatMap((c) => c.sentences);

    for (let i = 1; i < all.length; i++) {
      expect(all[i].position).toBeGreaterThan(all[i - 1].position);
    }

    expect(script.chapters[0].startCharacter).toBe(0);
    expect(all[0].position).toBe(0);
    // 表紙 (2) + 第一章 (3) = 5 characters before 善.
    expect(ch1.sentences[1].position).toBe(5);
    expect(script.chapters.reduce((n, c) => n + c.characters, 0)).toBe(total);
  });

  it('splits long sentences after a 、 and keeps every character', () => {
    const long = `${'あ'.repeat(50)}、${'い'.repeat(50)}、${'う'.repeat(50)}。`;
    const script = bookScriptFromHtml(
      wrap('x', `<p>${long}</p>`),
      [{ reference: 'ttu-x', charactersWeight: 1, label: 'X' }],
      151,
      doc,
      { maxSentence: 120 }
    );
    const parts = script.chapters[0].sentences;

    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.text.length <= 120)).toBe(true);
    expect(parts.map((p) => p.text).join('')).toBe(long);
    expect(parts[0].text.endsWith('、')).toBe(true);
    expect(parts.map((p) => p.paragraphEnd)).toEqual([false, true]);
  });

  it('treats a book without a table of contents as one chapter', () => {
    const script = bookScriptFromHtml(
      wrap('a', '<p>一。</p>') + wrap('b', '<p>二。</p>'),
      [],
      2,
      doc
    );

    expect(script.chapters.length).toBe(1);
    expect(script.chapters[0].sentences.map((s) => s.text)).toEqual(['一。', '二。']);
  });
});

describe('bookScriptEpubBlob on the fixture books', () => {
  const books = readdirSync(fixturesDir).filter((f) => f.endsWith('.epub'));

  it.each(books)('%s: chapters cover the whole book with the reader positions', async (name) => {
    const bytes = readFileSync(path.join(fixturesDir, name));
    const counted = await countEpubBlob(new Blob([bytes]));
    const script = await bookScriptEpubBlob(new Blob([bytes]));

    expect(script.characters).toBe(counted.characters);
    expect(script.chapters.length).toBeGreaterThan(0);

    const sum = script.chapters.reduce((n, c) => n + c.characters, 0);

    // Chapters without text are left out; they have no counted characters.
    expect(sum).toBe(counted.characters);

    for (const chapter of script.chapters) {
      for (const s of chapter.sentences) {
        expect(s.position).toBeGreaterThanOrEqual(chapter.startCharacter);
        expect(s.position).toBeLessThan(chapter.startCharacter + chapter.characters);
        expect(s.text.trim()).toBe(s.text);
        expect(s.text.length).toBeGreaterThan(0);
      }
    }
  });
});
