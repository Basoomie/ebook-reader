/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  DictionaryPopupWatch,
  sharedPopupWatch,
  type PopupChange
} from '$lib/dictionary/popup-watch';

const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * The event sequences below are the ones recorded in the user's Chrome with Yomitan 26.7.29
 * (2026-11-15/16): Shift-hover lookups, taps in phone mode, a mouse drag and long-presses.
 */
describe('DictionaryPopupWatch', () => {
  let watch: DictionaryPopupWatch | null = null;
  let changes: string[] = [];

  afterEach(() => {
    watch?.stop();
    watch = null;
    changes = [];
    getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  });

  function setup() {
    const content = document.createElement('div');
    content.textContent = 'その本を読んだ。あの街を見た。';
    document.body.appendChild(content);
    watch = new DictionaryPopupWatch(document);
    watch.subscribe((c: PopupChange) => changes.push(`${c.kind}:${c.source}`));
    watch.start();
    return content.firstChild as Text;
  }

  const fire = (type: string, init: Record<string, unknown> = {}) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, init);
    document.dispatchEvent(event);
  };
  const press = (pointerId = 1) => fire('pointerdown', { pointerId });
  const release = (pointerId = 1) => fire('pointerup', { pointerId });
  const key = (k: string, extra: Record<string, unknown> = {}) =>
    fire('keydown', { key: k, shiftKey: false, ctrlKey: false, metaKey: false, ...extra });

  /** Sets the selection (as Yomitan's removeAllRanges + addRange) and its selectionchange. */
  function select(text: Text, start: number, end: number) {
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, end);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    fire('selectionchange');
  }

  function collapse() {
    getSelection()!.removeAllRanges();
    fire('selectionchange');
  }

  it("Yomitan's word selection with nothing pressed (Shift-hover) opens, moves and closes", () => {
    const text = setup();
    key('Shift', { shiftKey: true });
    select(text, 2, 3); // 本
    expect(watch!.shown).toBe(true);
    select(text, 4, 7); // 読んだ: the next word
    select(text, 4, 7); // the same word again: nothing new
    collapse(); // the popup closed
    expect(watch!.shown).toBe(false);
    expect(changes).toEqual(['open:selection', 'move:selection', 'close:selection']);
  });

  it('a tap: the browser selection after the tap, then Yomitan selects the word', () => {
    const text = setup();
    press(7);
    release(7);
    fire('mousedown');
    fire('selectstart'); // from the compatibility mousedown
    collapse(); // the caret
    select(text, 9, 10); // Yomitan's word, after the tap ended
    expect(changes).toEqual(['open:selection']);
    // A tap elsewhere closes it.
    press(8);
    release(8);
    collapse();
    expect(changes).toEqual(['open:selection', 'close:selection']);
  });

  it("the user's mouse drag and long-press are not lookups, nor changes to them", () => {
    const text = setup();
    press();
    select(text, 0, 1);
    select(text, 0, 4); // growing while pressed
    release();
    select(text, 0, 5); // a selection handle moved: still the user's
    expect(changes).toEqual([]);
    collapse();
    // Long-press: the selection appears while the finger is down.
    press(3);
    select(text, 9, 11);
    release(3);
    fire('contextmenu');
    expect(changes).toEqual([]);
    expect(watch!.shown).toBe(false);
  });

  it('a keyboard selection is the user’s; Shift alone is not', () => {
    const text = setup();
    key('ArrowRight', { shiftKey: true });
    select(text, 0, 2);
    expect(changes).toEqual([]);
    collapse();
    key('Shift', { shiftKey: true });
    select(text, 2, 3);
    expect(changes).toEqual(['open:selection']);
  });

  it('the user selecting during a lookup ends it', () => {
    const text = setup();
    select(text, 2, 3);
    press();
    select(text, 0, 6);
    expect(changes).toEqual(['open:selection', 'close:selection']);
    expect(watch!.shown).toBe(false);
  });

  it('a lost release (window blur) does not hide later lookups', () => {
    const text = setup();
    press();
    window.dispatchEvent(new Event('blur'));
    select(text, 2, 3);
    expect(changes).toEqual(['open:selection']);
  });

  it('an element losing focus during a drag (the reader moves focus on a press) keeps the press', () => {
    const text = setup();
    const button = document.createElement('button');
    document.body.appendChild(button);
    press();
    button.dispatchEvent(new FocusEvent('blur')); // reaches the capturing window listener
    select(text, 0, 4);
    release();
    expect(changes).toEqual([]);
  });

  describe('selectionByUser (Enrich: whose selection the page has)', () => {
    it('a mouse drag is the user’s, also once released and while a handle extends it', () => {
      const text = setup();
      expect(watch!.selectionByUser).toBe(false);
      press();
      fire('selectstart');
      select(text, 0, 1);
      select(text, 0, 4); // growing while the button is held
      expect(watch!.selectionByUser).toBe(true);
      release();
      select(text, 0, 6);
      expect(watch!.selectionByUser).toBe(true);
      collapse();
      expect(watch!.selectionByUser).toBe(false);
    });

    it('a long-press is the user’s (the selection appears while the finger is down)', () => {
      const text = setup();
      fire('pointerdown', { pointerId: 3, pointerType: 'touch' });
      select(text, 9, 11);
      fire('pointerup', { pointerId: 3, pointerType: 'touch' });
      fire('contextmenu');
      expect(watch!.selectionByUser).toBe(true);
    });

    it('a tap and then Yomitan’s word is not the user’s (recorded order on a phone)', () => {
      const text = setup();
      fire('pointerdown', { pointerId: 7, pointerType: 'touch' });
      fire('pointerup', { pointerId: 7, pointerType: 'touch' });
      fire('mousedown');
      fire('selectstart'); // the browser's, from the compatibility mousedown
      collapse(); // the caret
      select(text, 9, 10); // Yomitan's word, 10-60 ms after the tap ended
      expect(watch!.selectionByUser).toBe(false);
    });

    it('a tap and then Yomitan’s word is not the user’s with the popup element shown first', async () => {
      const text = setup();
      const popup = document.createElement('iframe');
      popup.className = 'yomitan-popup';
      popup.style.visibility = 'hidden';
      document.body.appendChild(popup);
      await settle();
      popup.style.visibility = 'visible';
      await settle(40);
      fire('pointerdown', { pointerId: 7, pointerType: 'touch' });
      fire('pointerup', { pointerId: 7, pointerType: 'touch' });
      fire('mousedown');
      fire('selectstart');
      collapse();
      select(text, 9, 10);
      expect(watch!.selectionByUser).toBe(false);
    });

    it('Yomitan’s word on Shift-hover is not the user’s, also after a click elsewhere', () => {
      const text = setup();
      press();
      fire('selectstart'); // a plain click: the caret only
      collapse();
      release();
      key('Shift', { shiftKey: true });
      select(text, 2, 3);
      expect(watch!.selectionByUser).toBe(false);
      select(text, 4, 7); // the next word
      expect(watch!.selectionByUser).toBe(false);
    });

    it('a keyboard selection is the user’s; Shift alone is not', () => {
      const text = setup();
      key('ArrowLeft', { shiftKey: true });
      select(text, 0, 2);
      expect(watch!.selectionByUser).toBe(true);
      collapse();
      key('a', { ctrlKey: true });
      select(text, 0, 15);
      expect(watch!.selectionByUser).toBe(true);
      collapse();
      key('Shift', { shiftKey: true });
      select(text, 2, 3);
      expect(watch!.selectionByUser).toBe(false);
    });

    it('the user’s own selection replacing Yomitan’s word is the user’s', () => {
      const text = setup();
      select(text, 2, 3); // Yomitan's
      expect(watch!.selectionByUser).toBe(false);
      press();
      select(text, 0, 8);
      release();
      expect(watch!.selectionByUser).toBe(true);
    });
  });

  it('the popup element: shown, moved, hidden; jpdb by opacity', async () => {
    setup();
    const popup = document.createElement('iframe');
    popup.className = 'yomitan-popup';
    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);
    await settle();
    popup.style.visibility = 'visible';
    await settle();
    popup.style.left = '10px';
    await settle();
    popup.style.visibility = 'hidden';
    await settle();
    const jpdb = document.createElement('div');
    jpdb.id = 'jpdb-popup';
    jpdb.style.opacity = '0';
    document.body.appendChild(jpdb);
    await settle();
    jpdb.style.opacity = '1';
    await settle();
    expect(changes).toEqual(['open:element', 'move:element', 'close:element', 'open:element']);
  });

  it('container off: the element takes over the lookup the selection opened, never twice', async () => {
    const text = setup();
    select(text, 2, 3); // Yomitan selects before it inserts and shows its frame
    const popup = document.createElement('iframe');
    popup.className = 'yomitan-popup';
    popup.style.visibility = 'hidden';
    document.body.appendChild(popup);
    await settle();
    popup.style.visibility = 'visible';
    await settle();
    expect(changes).toEqual(['open:selection']);
    // From now on only the element counts.
    select(text, 4, 7);
    popup.style.left = '20px';
    await settle();
    collapse();
    popup.style.visibility = 'hidden';
    await settle();
    select(text, 9, 10);
    popup.style.visibility = 'visible';
    await settle();
    expect(changes).toEqual(['open:selection', 'move:element', 'close:element', 'open:element']);
  });

  it('stop reports an open popup closed and stops listening', () => {
    const text = setup();
    select(text, 2, 3);
    watch!.stop();
    select(text, 4, 7);
    expect(changes).toEqual(['open:selection', 'close:selection']);
    expect(watch!.shown).toBe(false);
  });

  it('one shared watch per document; the last release stops it', () => {
    const content = document.createElement('div');
    content.textContent = 'その本を読んだ。';
    document.body.appendChild(content);
    const text = content.firstChild as Text;
    const a = sharedPopupWatch(document);
    const b = sharedPopupWatch(document);
    expect(a.watch).toBe(b.watch);
    const seen: string[] = [];
    a.watch.subscribe((c) => seen.push(c.kind));
    select(text, 2, 3);
    a.release();
    a.release(); // twice is once
    expect(b.watch.shown).toBe(true);
    b.release();
    expect(seen).toEqual(['open', 'close']);
    const c = sharedPopupWatch(document);
    expect(c.watch).not.toBe(a.watch);
    c.release();
  });
});
