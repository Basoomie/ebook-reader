/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { isTextEntry, keyboardInset, nextReaderSize } from './on-screen-keyboard';

const full = { width: 412, height: 860 };

describe('nextReaderSize', () => {
  it('takes the first size', () => {
    expect(nextReaderSize(undefined, full, true)).toEqual(full);
  });

  it('ignores a shorter area while the keyboard may be up', () => {
    expect(nextReaderSize(full, { width: 412, height: 520 }, true)).toBe(full);
  });

  it('takes a taller area while the keyboard may be up (keyboard closed, field still focused)', () => {
    const short = { width: 412, height: 520 };
    expect(nextReaderSize(short, full, true)).toEqual(full);
  });

  it('takes a new width (the device turned) even with the keyboard up', () => {
    const turned = { width: 860, height: 200 };
    expect(nextReaderSize(full, turned, true)).toEqual(turned);
  });

  it('takes every size when no text box is focused or on desktop', () => {
    const short = { width: 412, height: 520 };
    expect(nextReaderSize(full, short, false)).toEqual(short);
  });

  it('comes back to the same size after the keyboard closes', () => {
    let size = nextReaderSize(undefined, full, false);
    size = nextReaderSize(size, { width: 412, height: 500 }, true);
    size = nextReaderSize(size, { width: 412, height: 450 }, true);
    size = nextReaderSize(size, { width: 412, height: 860 }, false);
    expect(size).toEqual(full);
  });
});

describe('keyboardInset', () => {
  it('is the covered part without a pan', () => {
    expect(keyboardInset(860, { height: 520, offsetTop: 0 })).toEqual({ inset: 340, top: 0 });
  });

  it('subtracts the pan', () => {
    expect(keyboardInset(860, { height: 520, offsetTop: 200 })).toEqual({ inset: 140, top: 200 });
  });

  it('is zero without a keyboard', () => {
    expect(keyboardInset(860, { height: 860, offsetTop: 0 })).toEqual({ inset: 0, top: 0 });
  });
});

function el(tag: string, props: Record<string, unknown> = {}, attrs: Record<string, string> = {}) {
  return {
    tagName: tag,
    readOnly: false,
    disabled: false,
    isContentEditable: false,
    getAttribute: (name: string) => attrs[name] ?? null,
    ...props
  } as unknown as Element;
}

describe('isTextEntry', () => {
  it('knows text-like inputs', () => {
    expect(isTextEntry(el('INPUT'))).toBe(true);
    expect(isTextEntry(el('INPUT', {}, { type: 'number' }))).toBe(true);
    expect(isTextEntry(el('INPUT', {}, { type: 'search' }))).toBe(true);
    expect(isTextEntry(el('TEXTAREA'))).toBe(true);
    expect(isTextEntry(el('DIV', { isContentEditable: true }))).toBe(true);
  });

  it('ignores controls without a keyboard', () => {
    expect(isTextEntry(el('INPUT', {}, { type: 'checkbox' }))).toBe(false);
    expect(isTextEntry(el('INPUT', {}, { type: 'range' }))).toBe(false);
    expect(isTextEntry(el('INPUT', { readOnly: true }))).toBe(false);
    expect(isTextEntry(el('BUTTON'))).toBe(false);
    expect(isTextEntry(el('SELECT'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
