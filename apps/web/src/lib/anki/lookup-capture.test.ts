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
