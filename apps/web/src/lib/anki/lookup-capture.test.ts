/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { LookupCapture, type LookupRecord } from './lookup-capture';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Phase 8: when a lookup starts and ends, for automatic enrichment. */
describe('LookupCapture lookup start and end', () => {
  let capture: LookupCapture | null = null;

  afterEach(() => {
    capture?.stop();
    capture = null;
    document.body.innerHTML = '';
  });

  function setup() {
    const content = document.createElement('div');
    content.className = 'book-content';
    content.textContent = 'その本を読んだ。';
    document.body.appendChild(content);
    capture = new LookupCapture(document, { root: () => content, base: () => 0 });
    const events: { change: 'start' | 'end'; id: number; lookup: LookupRecord }[] = [];
    capture.onLookup((lookup, change) => events.push({ change, id: lookup.id, lookup }));
    capture.start();
    const popup = document.createElement('iframe');
    popup.className = 'yomitan-popup';
    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);
    return { content, popup, events };
  }

  it('shown starts a lookup, hidden ends it', async () => {
    const { popup, events } = setup();
    await settle();
    expect(events).toEqual([]);
    popup.style.visibility = 'visible';
    await settle();
    expect(events.map((e) => [e.change, e.id])).toEqual([['start', 1]]);
    expect(events[0].lookup.endedAt).toBeNull();
    popup.style.visibility = 'hidden';
    await settle();
    expect(events.map((e) => [e.change, e.id])).toEqual([
      ['start', 1],
      ['end', 1]
    ]);
    expect(events[1].lookup.endedAt).toBeGreaterThanOrEqual(events[1].lookup.startedAt);
  });

  it('moving on to another word ends one lookup and starts the next', async () => {
    const { popup, events } = setup();
    popup.style.visibility = 'visible';
    await settle();
    popup.style.left = '40px';
    await settle();
    popup.style.top = '90px';
    await settle();
    popup.style.visibility = 'hidden';
    await settle();
    expect(events.map((e) => [e.change, e.id])).toEqual([
      ['start', 1],
      ['end', 1],
      ['start', 2],
      ['end', 2],
      ['start', 3],
      ['end', 3]
    ]);
  });

  it('the lookup gets the sentence of the selected word once it is worked out', async () => {
    const { content, popup, events } = setup();
    const text = content.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    popup.style.visibility = 'visible';
    await settle(60);
    const lookup = events[0].lookup;
    expect(lookup.sentence?.text).toBe('その本を読んだ。');
    expect(capture!.lastLookup?.text).toBe('その本を読んだ。');
  });

  it("Yomitan's word selection alone (secure container) starts and ends a lookup with its sentence", async () => {
    const { content, popup, events } = setup();
    popup.remove();
    const text = content.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    await settle(60);
    expect(events.map((e) => [e.change, e.id])).toEqual([['start', 1]]);
    expect(events[0].lookup.sentence?.text).toBe('その本を読んだ。');
    getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    expect(events.map((e) => [e.change, e.id])).toEqual([
      ['start', 1],
      ['end', 1]
    ]);
  });

  it('a lookup outside the book has no sentence, and the last lookup is kept', async () => {
    const { popup, events } = setup();
    getSelection()!.removeAllRanges();
    popup.style.visibility = 'visible';
    await settle(60);
    expect(events[0].lookup.sentence).toBeNull();
    expect(capture!.lastLookup).toBeNull();
  });

  it('a hidden popup that is not the current one ends nothing; stop ends the current lookup', async () => {
    const { popup, events } = setup();
    const other = document.createElement('div');
    other.className = 'yomitan-float';
    other.style.visibility = 'hidden';
    document.body.appendChild(other);
    await settle();
    popup.style.visibility = 'visible';
    await settle();
    other.style.visibility = 'visible';
    await settle();
    popup.style.visibility = 'hidden'; // not the current popup any more
    await settle();
    expect(events.map((e) => [e.change, e.id])).toEqual([
      ['start', 1],
      ['end', 1],
      ['start', 2]
    ]);
    capture!.stop();
    expect(events.map((e) => [e.change, e.id]).at(-1)).toEqual(['end', 2]);
  });
});

/** Fix of 2026-11-15: a card's own sentence placed in the book (Yomitan's popup can't be seen). */
describe('LookupCapture.findSentence', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function setup(html: string, base = 0) {
    const content = document.createElement('div');
    content.className = 'book-content';
    content.innerHTML = html;
    document.body.appendChild(content);
    return new LookupCapture(document, { root: () => content, base: () => base });
  }

  it('finds the sentence and its position', () => {
    const capture = setup('<p>前の文。その本を読んだ。後の文。</p>');
    const found = capture.findSentence('その本を読んだ。', 0);
    expect(found?.text).toBe('その本を読んだ。');
    expect(found?.position).toBe(3); // 前の文 (the 。 isn't counted)
    expect(found?.cueIds).toEqual([]);
  });

  it('matches across ruby readings and spaces, as in-book search does', () => {
    const capture = setup('<p>前。<ruby>漢字<rt>かんじ</rt></ruby>を 読む。</p>');
    // Positions count letters only (no punctuation): 前 is 1.
    expect(capture.findSentence('漢字を読む。', 0)?.position).toBe(1);
  });

  it('picks the occurrence nearest the reading position, with the section start added', () => {
    const capture = setup('<p>はい。</p><p>いいえ。</p><p>はい。</p>', 1000);
    expect(capture.findSentence('はい。', 1000)?.position).toBe(1000);
    // はい + いいえ = 5 letters before the second はい.
    expect(capture.findSentence('はい。', 1009)?.position).toBe(1005);
  });

  it("gives the sentence's whispersync lines", () => {
    const capture = setup(
      '<p><span class="ttu-whispersync-line-highlight-7">前。</span><span class="ttu-whispersync-line-highlight-8">その本を</span><span class="ttu-whispersync-line-highlight-9">読んだ。</span></p>'
    );
    expect(capture.findSentence('その本を読んだ。', 0)?.cueIds).toEqual(['8', '9']);
  });

  it('is null when the sentence is not in the loaded text', () => {
    const capture = setup('<p>その本を読んだ。</p>');
    expect(capture.findSentence('別の文。', 0)).toBeNull();
    expect(capture.findSentence('', 0)).toBeNull();
  });
});
