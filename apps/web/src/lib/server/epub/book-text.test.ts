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
import { bookTextFromHtml } from './book-text';
import { bookTextEpubBlob } from './count-epub-node';
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

describe('bookTextFromHtml', () => {
  const html =
    wrap('c0', '<p>表紙</p>') +
    wrap(
      'c1',
      '<h1>第一章</h1><p>善なるものは<ruby>畢竟<rt class="x">ひっきょう</rt></ruby>、遠い。</p>' +
        '<p><ruby><rb>段落</rb><rp>（</rp><rt>だんらく</rt><rp>）</rp></ruby>です</p>'
    ) +
    wrap('c1b', '<p>続き<img class="gaiji" src="x.png"/>外字。<span hidden="">隠</span>𠮟る</p>') +
    wrap('c2', '<p>最後の章。</p>');
  const sections: Section[] = [
    { reference: 'ttu-c0', charactersWeight: 1, label: 'Preface', startCharacter: 0 },
    { reference: 'ttu-c1', charactersWeight: 1, label: ' 第一章 ' },
    { reference: 'ttu-c1b', charactersWeight: 1, parentChapter: 'ttu-c1' },
    { reference: 'ttu-c2', charactersWeight: 1, label: '終' }
  ];

  it('keeps exactly the characters the reader counts, furigana and punctuation left out', () => {
    const result = bookTextFromHtml(html, sections, doc);

    expect(result.text).toBe('表紙第一章善なるものは畢竟遠い段落です続き〓外字𠮟る最後の章');
    expect(result.characters).toBe(countHtml(html, doc));
    expect(result.characters).toBe(Array.from(result.text).length);
  });

  it('gives the main chapters with their start in code points', () => {
    const result = bookTextFromHtml(html, sections, doc);

    expect(result.chapters).toEqual([
      { start: 0, label: 'Preface' },
      { start: 2, label: '第一章' },
      { start: 26, label: '終' }
    ]);
    expect(result.ruby).toBe(2);
    expect(result.tocEntries).toBe(3);
  });
});

describe('bookTextEpubBlob on the fixture books', () => {
  const books = readdirSync(fixturesDir).filter((f) => f.endsWith('.epub'));

  it.each(books)('%s: the text length equals the import count', async (name) => {
    const bytes = readFileSync(path.join(fixturesDir, name));
    const result = await bookTextEpubBlob(new Blob([bytes]));

    expect(result.characters).toBe(result.importCharacters);
    expect(Array.from(result.text).length).toBe(result.characters);
    expect(result.characters).toBeGreaterThan(0);
  });
});
