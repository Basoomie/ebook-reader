/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { getCharacterCount } from '$lib/functions/get-character-count';
import { getParagraphNodes } from '$lib/components/book-reader/get-paragraph-nodes';

/**
 * Pins the current counting rules; it does not judge them.
 * Every expected value was produced by running the same HTML through the unmodified
 * browser code (Chromium 152, main @ a51f774), using the reader's formula:
 * sum of getCharacterCount over getParagraphNodes(container).
 */
const cases: Array<[name: string, html: string, expected: number]> = [
  ['plain kana and kanji', '<p>駅のホーム</p>', 5],
  [
    'ruby: rt and rp parentheses excluded',
    '<p><ruby>改札<rp>（</rp><rt>かいさつ</rt><rp>）</rp></ruby></p>',
    2
  ],
  ['ruby with rb', '<p><ruby><rb>冷</rb><rt>つめ</rt></ruby>たい</p>', 3],
  ['elements nested in rt excluded', '<p><ruby>字<rt><span>じ</span></rt></ruby></p>', 1],
  [
    'hidden and aria-hidden (any value) excluded',
    '<p><span aria-hidden="true">読</span><span hidden="">隠</span><span aria-hidden="false">偽</span>見</p>',
    1
  ],
  ['hidden block excluded', '<div hidden=""><p>隠れる</p></div><p>見える</p>', 3],
  ['gaiji image counts as one', '<p>字<img class="gaiji" src="x.png">字</p>', 3],
  ['any class containing "gaiji"', '<p><img class="my-gaiji-wide" src="x.png"></p>', 1],
  ['illustration image counts as zero', '<p><img class="illust" src="x.png"></p>', 0],
  [
    'aria-hidden on SVG is not filtered (SVG is not HTMLElement)',
    '<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><text>図の字</text></svg>',
    3
  ],
  ['surrogate pairs count as one', '<p>𠮟られた𩸽</p>', 5],
  [
    'latin letters (case-insensitive) and digits, half and full width',
    '<p>ABCabcＡＢＣａｂｃ123７０</p>',
    17
  ],
  ['punctuation and whitespace dropped', '<p>「おはよう！」……、。　 ?!.</p>', 4],
  ['iteration marks and half-width kana; ヽヾ excluded', '<p>々〆〇ゝゞヽヾー〻ｱｲｳ</p>', 10],
  ['○ and ◯ counted, ● not', '<p>○◯●</p>', 2],
  ['radicals counted', '<p>⺀⼀</p>', 2],
  ['whitespace-only paragraph', '<p>　　　 \n\t</p>', 0],
  ['br does not count', '<p>あ<br>い</p>', 2],
  ['comments do not count', '<p><!--あ-->い</p>', 1],
  ['entities decoded before counting', '<p>&#x3042;&#12354;&amp;&nbsp;</p>', 2],
  ['greek and cyrillic not counted', '<p>αβγабв</p>', 0],
  ['hangul not counted', '<p>한국어</p>', 0],
  ['emoji not counted', '<p>😀👍🏽</p>', 0]
];

describe('getCharacterCount + getParagraphNodes (reader counting rules)', () => {
  let document: Document;

  beforeAll(() => {
    document = installNodeDom();
  });

  it.each(cases)('%s', (_name, html, expected) => {
    const container = document.createElement('div');
    container.innerHTML = html;

    const count = getParagraphNodes(container).reduce(
      (acc, node) => acc + getCharacterCount(node),
      0
    );

    expect(count).toBe(expected);
  });
});
