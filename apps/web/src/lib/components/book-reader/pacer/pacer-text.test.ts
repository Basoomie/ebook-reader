/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { getParagraphNodes } from '$lib/components/book-reader/get-paragraph-nodes';
import { parseBookHtml } from '$lib/components/book-reader/book-search';
import { getCharacterCount } from '$lib/functions/get-character-count';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { countEpubFile } from '$lib/server/epub/count-epub-node';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
import { charsRange, PacerText } from './pacer-text';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../tests/fixtures'
);

let doc: Document;

beforeAll(() => {
  doc = installNodeDom();
});

const text = (chars: { node: Node; offset: number; len: number; gaiji: boolean }[]) =>
  chars
    .map((c) => (c.gaiji ? '〓' : (c.node.textContent ?? '').slice(c.offset, c.offset + c.len)))
    .join('');

describe('PacerText', () => {
  it('counts like the reader on the fixture books, node by node and character by character', async () => {
    for (const book of [
      'synthetic-epub3.epub',
      'synthetic-epub2-ncx.epub',
      'synthetic-epub3-navonly.epub'
    ]) {
      const result = await countEpubFile(path.join(fixturesDir, book), {
        importHTMLFixMode: ImportHTMLFixMode.OFF,
        restrictImportFixToAnchor: true
      });
      const root = parseBookHtml(result.elementHtml);
      const pacerText = new PacerText(root);
      const nodes = getParagraphNodes(root);
      expect(pacerText.nodes.length, book).toBe(nodes.length);
      expect(pacerText.total, book).toBe(nodes.reduce((acc, n) => acc + getCharacterCount(n), 0));

      const chars = pacerText.chars(0, pacerText.nodes.length, 100);
      const counted = chars.filter((c) => c.counted);
      expect(counted.length, book).toBe(pacerText.total);
      counted.forEach((c, k) => {
        expect(c.start).toBe(100 + k);
        expect(c.end).toBe(101 + k);
      });
    }
  });

  it('leaves ruby readings out, keeps rp brackets uncounted and counts gaiji as one', () => {
    const root = parseBookHtml(
      '<p>「<ruby>漢字<rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby>を読む。」</p><p><img class="gaiji" src="x.png">だ</p>'
    );
    const t = new PacerText(root);
    const chars = t.chars(0, t.nodes.length, 0);
    expect(text(chars)).toBe('「漢字（）を読む。」〓だ');
    expect(chars.filter((c) => c.counted).length).toBe(t.total);
    expect(t.total).toBe(7);
    const gaiji = chars.find((c) => c.gaiji)!;
    expect([gaiji.start, gaiji.end, gaiji.counted]).toEqual([5, 6, true]);
  });

  it('gives uncounted characters the time of the counted one before them in the paragraph', () => {
    const root = parseBookHtml('<p>「あい。」</p><p>「う」</p>');
    const t = new PacerText(root);
    const chars = t.chars(0, t.nodes.length, 10);
    const times = chars.map((c) => [text([c]), c.start, c.end]);
    expect(times).toEqual([
      ['「', 10, 10],
      ['あ', 10, 11],
      ['い', 11, 12],
      ['。', 11, 12],
      ['」', 11, 12],
      // A new paragraph: the opening bracket waits for its word.
      ['「', 12, 12],
      ['う', 12, 13],
      ['」', 12, 13]
    ]);
  });

  it('lists only the asked nodes, with absolute times', () => {
    const root = parseBookHtml('<p>あいう</p><p>えお</p><p>か</p>');
    const t = new PacerText(root);
    const chars = t.chars(1, 2, 50);
    expect(text(chars)).toBe('えお');
    expect(chars[0].start).toBe(53);
    expect(t.nodeAtCount(0)).toBe(0);
    expect(t.nodeAtCount(3)).toBe(1);
    expect(t.nodeAtCount(4)).toBe(1);
    expect(t.nodeAtCount(5)).toBe(2);
  });

  it('builds ranges whose end takes a ruby reading with the text before it', () => {
    const root = parseBookHtml('<p><ruby>漢字<rt>かんじ</rt></ruby>を読む。</p>');
    doc.body.replaceChildren(root);
    const t = new PacerText(root);
    const chars = t.chars(0, t.nodes.length, 0);
    // 漢字 alone: ends where を starts, so the reading is inside.
    const r = charsRange(chars, 0, 2, doc)!;
    expect(r.toString()).toBe('漢字かんじ');
    // From を to the end.
    expect(charsRange(chars, 2, chars.length, doc)!.toString()).toBe('を読む。');
    expect(charsRange(chars, 2, 2, doc)).toBeUndefined();
  });
});
