/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// Whispersync Match on the book page: whispersync's matcher moved out of Match.svelte
// (match.ts). Byte-for-byte equality with the reader's own results is proven on real books in
// the browser (.tmp-e2e/scripts/wsmb-capture.mjs + wsmb-compare.mjs); these tests pin the
// matcher's behaviour on small books.
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Subtitle } from './general';
import {
  matchSubtitles,
  matchedRow,
  resetRow,
  unmatchedListName,
  unmatchedListText,
  type MatchInput
} from './match';

const GLOBALS = ['DOMParser', 'Node', 'NodeFilter', 'HTMLElement', 'HTMLSpanElement'] as const;
const saved: Record<string, unknown> = {};
let doc: Document;

beforeAll(() => {
  const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const target = globalThis as Record<string, unknown>;
  for (const name of GLOBALS) {
    saved[name] = target[name];
    target[name] = (window as unknown as Record<string, unknown>)[name];
  }
  doc = window.document;
});

afterAll(() => {
  const target = globalThis as Record<string, unknown>;
  for (const name of GLOBALS) target[name] = saved[name];
});

function line(id: number, text: string): Subtitle {
  return {
    id: `${id}`,
    originalStartSeconds: id,
    startSeconds: id,
    startTime: `00:00:0${id},000`,
    originalEndSeconds: id + 1,
    endSeconds: id + 1,
    endTime: `00:00:0${id + 1},000`,
    originalText: text,
    text,
    subIndex: id - 1
  };
}

const book = (...paragraphs: string[]) =>
  `<div id="ttu-1"><div>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</div></div>`;

function input(elementHtml: string, subtitles: Subtitle[], extra: Partial<MatchInput> = {}): MatchInput {
  return {
    elementHtml,
    subtitles,
    subtitleFileName: () => 'book.srt',
    settings: { ignoreRp: () => false, similarityThreshold: () => 0.9, maxAttempts: () => 50 },
    signal: new AbortController().signal,
    doc,
    ...extra
  };
}

/** The matched text without the run's time stamp. */
const html = (el: HTMLElement) => el.innerHTML.replace(/data-ttu-whispersync-matched-on="\d+"/, '');

describe('matchSubtitles (whispersync onMatchSubtitles, moved unchanged)', () => {
  it('matches every line, wraps each in its line span and stamps the book', async () => {
    const result = await matchSubtitles(
      input(book('今日は晴れでした。', '明日は雨が降ります。'), [
        line(1, '今日は晴れでした。'),
        line(2, '明日は雨が降ります。')
      ])
    );
    expect(result.matchedSubtitles).toBe(2);
    expect(result.lineMatchRate).toBe('2 / 2 (100%)');
    expect(result.bookSubtitleDiffRate).toBe('0 / 2 (0%)');
    expect(result.unmatchedSubtitles).toEqual([]);
    const out = result.bookHTML.innerHTML;
    expect(out).toContain('<span class="ttu-whispersync-line-highlight-1">今日は晴れでした。</span>');
    expect(out).toContain('<span class="ttu-whispersync-line-highlight-2">明日は雨が降ります。</span>');
    expect(out).toMatch(/data-ttu-whispersync-matched-by="book.srt"/);
    expect(out).toMatch(/data-ttu-whispersync-matched-source="default"/);
  });

  it("lists a line it can't place and leaves the book text as it was", async () => {
    // whispersync's own behaviour on a tiny book, pinned as it is (the real books' results are
    // compared byte for byte in the browser).
    const paragraphs = ['今日は晴れでした。', '明日は雨が降ります。', '週末は雪になるそうです。', '来週はまた晴れます。'];
    const lines = [
      line(1, paragraphs[0]),
      line(2, 'これは本に無い台詞です。'),
      line(3, paragraphs[1]),
      line(4, paragraphs[2]),
      line(5, paragraphs[3])
    ];
    const result = await matchSubtitles(input(book(...paragraphs), lines));
    expect(result.unmatchedSubtitles.map((s) => s.id)).toEqual(['5']);
    expect(result.lineMatchRate.startsWith(`${result.matchedSubtitles} / 5 (`)).toBe(true);
    expect(result.bookHTML.textContent).toBe(paragraphs.join(''));
    expect(unmatchedListText(result.unmatchedSubtitles)).toBe('5\n来週はまた晴れます。\n\n');
    // Lines after the end of the text are not listed (whispersync's own behaviour).
    const short = await matchSubtitles(
      input(book(paragraphs[0]), [line(1, paragraphs[0]), line(2, 'これは本に無い台詞です。')])
    );
    expect(short.lineMatchRate).toBe('1 / 2 (50%)');
    expect(short.unmatchedSubtitles).toEqual([]);
    expect(unmatchedListName('[01] 本 [B0].srt')).toBe('[01] 本 [B0]_unmatched.txt');
  });

  it('counts a line that passed the check but differs from the book', async () => {
    const result = await matchSubtitles(
      input(book('今日はとても良い天気でした。'), [line(1, '今日はとても良い天気だした。')], {
        settings: { ignoreRp: () => false, similarityThreshold: () => 0.5, maxAttempts: () => 50 }
      })
    );
    expect(result.matchedSubtitles).toBe(1);
    expect(result.subtitleDiffDetails).toEqual([
      { id: '1', original: '今日はとても良い天気だした。', adjusted: '今日はとても良い天気でした。' }
    ]);
    expect(result.bookSubtitleDiffRate).toBe('1 / 1 (100%)');
  });

  it('reads ruby as the setting says (rp ignored or not) without changing the text', async () => {
    const ruby = book('<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>を読みました。');
    for (const ignoreRp of [true, false]) {
      const result = await matchSubtitles(
        input(ruby, [line(1, '漢字を読みました。')], {
          settings: { ignoreRp: () => ignoreRp, similarityThreshold: () => 0.8, maxAttempts: () => 50 }
        })
      );
      expect(result.bookHTML.textContent).toBe('漢字(かんじ)を読みました。');
      expect(result.matchedSubtitles).toBe(1);
    }
  });

  it('starts at the start point when one is given (the reader only)', async () => {
    const text = book('前書きの文章です。', '本編の始まりです。');
    const lines = [line(1, '本編の始まりです。')];
    const hinted = await matchSubtitles(
      input(text, lines, { hint: () => ({ nodeContent: '本編の始まりです。', parentId: 'ttu-1' }) })
    );
    expect(hinted.matchedSubtitles).toBe(1);
    expect(hinted.bookHTML.innerHTML).toContain('data-ttu-whispersync-start-node=""');
    expect(hinted.bookHTML.innerHTML).toContain('<p>前書きの文章です。</p>');
    const plain = await matchSubtitles(input(text, lines));
    expect(plain.bookHTML.innerHTML).not.toContain('data-ttu-whispersync-start-node');
  });

  it('stops when cancelled', async () => {
    const controller = new AbortController();
    controller.abort('user aborted');
    await expect(
      matchSubtitles(input(book('今日は晴れでした。'), [line(1, '今日は晴れでした。')], { signal: controller.signal }))
    ).rejects.toBeDefined();
  });

  it('reports progress in % and yields to the page between steps', async () => {
    const seen: number[] = [];
    await matchSubtitles(
      input(book('今日は晴れでした。', '明日は雨が降ります。'), [line(1, '今日は晴れでした。'), line(2, '明日は雨が降ります。')], {
        onProgress: (p) => seen.push(p)
      })
    );
    expect(seen).toEqual([50, 100]);
  });

  it('matching again from the backup gives the first match again', async () => {
    const original = book('今日は晴れでした。', '明日は雨が降ります。');
    const lines = [line(1, '今日は晴れでした。'), line(2, '明日は雨が降ります。')];
    const first = await matchSubtitles(input(original, lines));
    const row = matchedRow({ id: 3, extra: 'kept' }, { id: 3, title: '本', elementHtml: original, lastBookModified: 1 }, first.bookHTML.innerHTML, 5);
    const again = await matchSubtitles(input(resetRow(row, 9).elementHtml, lines));
    expect(html(again.bookHTML)).toBe(html(first.bookHTML));
  });
});

describe('the saved rows (onSaveMatch, onResetBook)', () => {
  it('matchedRow is what onSaveMatch stored', () => {
    const current = { id: 3, title: '本', elementHtml: 'old', lastBookModified: 1, unknownField: 'kept' };
    const bookData = { id: 3, title: '本', elementHtml: '<p>original</p>', lastBookModified: 1 };
    // The inline write it replaced: {...currentData, ...$bookData$, htmlBackup, elementHtml, lastBookModified}
    expect(matchedRow(current, bookData, '<p>matched</p>', 42)).toEqual({
      ...current,
      ...bookData,
      htmlBackup: '<p>original</p>',
      elementHtml: '<p>matched</p>',
      lastBookModified: 42
    });
  });

  it('resetRow is what onResetBook stored', () => {
    const row = { id: 3, title: '本', elementHtml: '<p>matched</p>', htmlBackup: '<p>original</p>', lastBookModified: 1 };
    const next = resetRow(row, 42);
    expect(next).toEqual({ id: 3, title: '本', elementHtml: '<p>original</p>', lastBookModified: 42 });
    expect('htmlBackup' in next).toBe(false);
    expect(row.htmlBackup).toBe('<p>original</p>');
  });
});
