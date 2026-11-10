/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { getParagraphNodes } from '$lib/components/book-reader/get-paragraph-nodes';
import { getCharacterCount } from '$lib/functions/get-character-count';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { countEpubFile } from '$lib/server/epub/count-epub-node';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import {
  buildBookTextIndex,
  findMatches,
  matchRange,
  normalizeForSearch,
  parseBookHtml,
  searchBook
} from './book-search';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures'
);

let doc: Document;

beforeAll(() => {
  doc = installNodeDom();
});

function body(html: string) {
  return parseBookHtml(html);
}

function readerCount(root: Node) {
  return getParagraphNodes(root).reduce((acc, n) => acc + getCharacterCount(n), 0);
}

describe('buildBookTextIndex', () => {
  it('counts exactly like the reader on the fixture books (every node and in total)', async () => {
    const expected = JSON.parse(
      readFileSync(path.join(fixturesDir, 'synthetic.expected.json'), 'utf8')
    ) as { books: Record<string, Record<string, { readerCount?: number }>> };

    for (const book of Object.keys(expected.books)) {
      const truth = expected.books[book]['Off|restrictToAnchor=true'];
      if (!truth?.readerCount) continue;
      const result = await countEpubFile(path.join(fixturesDir, book), {
        importHTMLFixMode: ImportHTMLFixMode.OFF,
        restrictImportFixToAnchor: true
      });
      const root = parseBookHtml(result.elementHtml);
      const index = buildBookTextIndex(root);
      expect(index.total, book).toBe(truth.readerCount);
      expect(index.total, book).toBe(readerCount(root));

      // Node by node: the position of each node's first character is the reader's count
      // of everything before it.
      let before = 0;
      for (const node of getParagraphNodes(root)) {
        const single = buildBookTextIndex(node.parentNode as Node);
        expect(single.total).toBe(readerCount(node.parentNode as Node));
        before += getCharacterCount(node);
      }
      expect(before).toBe(index.total);
    }
  });

  it('skips ruby readings and brackets, so words with ruby match as written', () => {
    const root = body(
      '<p><ruby>改札<rp>（</rp><rt>かいさつ</rt><rp>）</rp></ruby>を抜けると、<ruby><rb>冷</rb><rt>つめ</rt></ruby>たい風が吹いた。</p>'
    );
    const index = buildBookTextIndex(root);
    expect(index.display.join('')).toBe('改札を抜けると、冷たい風が吹いた。');
    expect(index.total).toBe(readerCount(root));
    expect(findMatches(index, '改札を').matches).toHaveLength(1);
    expect(findMatches(index, '冷たい').matches).toHaveLength(1);
    expect(findMatches(index, 'かいさつ').matches).toHaveLength(0);
  });

  it('gives each match the reader position of its first character', () => {
    const root = body('<p>「あいう」、えお。</p><p>かきくけこ</p>');
    const index = buildBookTextIndex(root);
    // Punctuation does not count: あいう えお = 5 before か.
    expect(findMatches(index, 'か').matches[0].position).toBe(5);
    expect(findMatches(index, 'えお').matches[0].position).toBe(3);
    expect(findMatches(index, 'あ').matches[0].position).toBe(0);
  });

  it('never matches across paragraphs', () => {
    const index = buildBookTextIndex(body('<p>終わり</p><p>始まり</p>'));
    expect(findMatches(index, 'り始').matches).toHaveLength(0);
  });

  it('ignores whitespace and matches full-width, half-width and case alike', () => {
    const index = buildBookTextIndex(body('<p>ＡＢＣ  def\n ghi　ｶﾀｶﾅ</p>'));
    expect(findMatches(index, 'abc').matches).toHaveLength(1);
    expect(findMatches(index, 'DEF GHI').matches).toHaveLength(1);
    expect(findMatches(index, 'カタカナ').matches).toHaveLength(1);
    expect(findMatches(index, 'かたかな').matches).toHaveLength(0);
  });

  it('counts gaiji as one character and shows them as 〓', () => {
    const root = body('<p>この文字<img class="gaiji" src="x.png" alt="">は外字です。</p>');
    const index = buildBookTextIndex(root);
    expect(index.total).toBe(readerCount(root));
    expect(index.display.join('')).toBe('この文字〓は外字です。');
    expect(findMatches(index, 'は外字').matches[0].position).toBe(5);
  });
});

describe('normalizeForSearch', () => {
  it('drops whitespace and folds width and case', () => {
    expect(normalizeForSearch(' Ａb c ')).toBe('abc');
  });
});

describe('searchBook', () => {
  it('shows the surrounding sentence with the match', () => {
    const index = buildBookTextIndex(body('<p>前の文です。彼は駅で切符を買った。次の文です。</p>'));
    const { results } = searchBook(index, '切符');
    expect(results[0]).toMatchObject({ before: '彼は駅で', match: '切符', after: 'を買った。' });
  });

  it('keeps closing brackets after the sentence end and stops at the paragraph', () => {
    const index = buildBookTextIndex(body('<p>「本当に行くの？」と聞いた</p><p>次</p>'));
    const { results } = searchBook(index, '本当');
    expect(results[0]).toMatchObject({ before: '「', match: '本当', after: 'に行くの？」' });
    const second = searchBook(index, 'と聞').results[0];
    expect(second.after).toBe('いた');
  });

  it('cuts long sentences with an ellipsis', () => {
    const long = 'あ'.repeat(100);
    const index = buildBookTextIndex(body(`<p>${long}探す${long}</p>`));
    const [r] = searchBook(index, '探す').results;
    expect(r.before).toBe(`…${'あ'.repeat(60)}`);
    expect(r.after).toBe(`${'あ'.repeat(60)}…`);
  });

  it('stops at the limit and says there are more', () => {
    const index = buildBookTextIndex(body(`<p>${'猫。'.repeat(12)}</p>`));
    const { results, more } = searchBook(index, '猫', 10);
    expect(results).toHaveLength(10);
    expect(more).toBe(true);
    expect(searchBook(index, '猫', 12).more).toBe(false);
    expect(searchBook(index, '   ').results).toHaveLength(0);
  });
});

describe('matchRange', () => {
  it('maps a match on a live page to a DOM range', () => {
    const root = doc.createElement('div');
    root.innerHTML = '<p>猫が<b>好き</b>です。<ruby>犬<rt>いぬ</rt></ruby>も好き。</p>';
    const index = buildBookTextIndex(root, true);
    const [first, second] = findMatches(index, '好き').matches;
    expect(matchRange(index, first, doc)?.toString()).toBe('好き');
    expect(matchRange(index, second, doc)?.toString()).toBe('好き');
    const across = findMatches(index, 'が好').matches[0];
    expect(matchRange(index, across, doc)?.toString()).toBe('が好');
    expect(findMatches(index, '犬も').matches).toHaveLength(1);
  });
});
