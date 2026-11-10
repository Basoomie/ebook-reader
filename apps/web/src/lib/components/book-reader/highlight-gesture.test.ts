/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { HighlightGesture } from './highlight-gesture';

const down = (pointerType: string, inReader = true, inBar = false) =>
  ({ type: 'pointerdown', pointerType, inReader, inBar }) as const;

describe('HighlightGesture', () => {
  it('a touch long-press (contextmenu) on the text arms it', () => {
    const g = new HighlightGesture();
    g.note(down('touch'));
    expect(g.note({ type: 'contextmenu', inReader: true })).toBe(true);
    expect(g.shows(false)).toBe(true);
  });

  it('a tap never arms it, so a programmatic selection after it shows nothing', () => {
    const g = new HighlightGesture();
    g.note(down('touch'));
    g.note({ type: 'pointerup', pointerType: 'touch', selectionInReader: true });
    g.note({ type: 'click', inReader: true, detail: 1, pointerType: 'touch' });
    expect(g.shows(false)).toBe(false);
  });

  it('a touch double tap does not arm it', () => {
    const g = new HighlightGesture();
    g.note({ type: 'click', inReader: true, detail: 2, pointerType: 'touch' });
    expect(g.shows(false)).toBe(false);
  });

  it('a mouse drag that left a selection on the text arms it', () => {
    const g = new HighlightGesture();
    g.note(down('mouse'));
    expect(g.note({ type: 'pointerup', pointerType: 'mouse', selectionInReader: true })).toBe(true);
    expect(g.shows(false)).toBe(true);
  });

  it('a mouse press outside the book, or without a selection, does not', () => {
    const g = new HighlightGesture();
    g.note(down('mouse', false));
    g.note({ type: 'pointerup', pointerType: 'mouse', selectionInReader: true });
    expect(g.shows(false)).toBe(false);
    g.note(down('mouse'));
    g.note({ type: 'pointerup', pointerType: 'mouse', selectionInReader: false });
    expect(g.shows(false)).toBe(false);
  });

  it('a mouse double click arms it', () => {
    const g = new HighlightGesture();
    g.note(down('mouse'));
    g.note({ type: 'click', inReader: true, detail: 2, pointerType: 'mouse' });
    expect(g.shows(false)).toBe(true);
  });

  it('the next press elsewhere disarms it, a press on the bar does not', () => {
    const g = new HighlightGesture();
    g.note({ type: 'contextmenu', inReader: true });
    g.note(down('touch', false, true));
    expect(g.pressOnBar).toBe(true);
    expect(g.shows(false)).toBe(true);
    g.note(down('touch'));
    expect(g.pressOnBar).toBe(false);
    expect(g.shows(false)).toBe(false);
  });

  it('a contextmenu outside the book does nothing; done disarms', () => {
    const g = new HighlightGesture();
    expect(g.note({ type: 'contextmenu', inReader: false })).toBe(false);
    g.note({ type: 'contextmenu', inReader: true });
    g.note({ type: 'done' });
    expect(g.shows(false)).toBe(false);
  });

  it('"any selection" shows it without a gesture', () => {
    expect(new HighlightGesture().shows(true)).toBe(true);
  });
});
