/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { installNodeDom } from '$lib/server/epub/node-dom';
import { remapPlace, storedTextIndex } from './place-remap';

beforeAll(() => {
  installNodeDom();
});

const para = (text: string) => `<p>${text}</p>`;
const BODY = [
  para('第一章。物語はここから始まる。'),
  para('彼女は窓の外を見た。雨が降っていた。'),
  para('それから長い沈黙が続いた。誰も何も言わなかった。'),
  para('やがて扉が開き、知らない男が入ってきた。')
];
const OLD = `<div>${BODY.join('')}</div>`;

type Index = ReturnType<typeof storedTextIndex>;
/** The reader position of the first character of `text`. */
const positionOf = (index: Index, text: string) =>
  index.countBefore[index.display.join('').indexOf(text)];
/** The text starting at a reader position (its first counted character). */
const textAt = (index: Index, position: number) => {
  // Uncounted characters (。, line breaks) share the position of the next counted one.
  const i = index.countBefore.findIndex(
    (c, k) => c === position && (index.countBefore[k + 1] ?? index.total) > position
  );
  return index.display.slice(i).join('');
};

describe('the saved place in a replaced copy', () => {
  it('is found again by its text when a paragraph was added before it', () => {
    const before = storedTextIndex(OLD);
    const position = positionOf(before, 'それから');
    const NEW = `<div>${para('新しい序文がここに加わった。とても長い序文である。')}${BODY.join('')}</div>`;
    const after = storedTextIndex(NEW);
    const moved = remapPlace(OLD, NEW, position, 2000);
    expect(moved.how).toBe('found');
    expect(textAt(after, moved.position).slice(0, 8)).toBe('それから長い沈黙');
    expect(moved.position).toBeGreaterThan(position);
  });

  it('keeps its fraction when the text is gone', () => {
    const before = storedTextIndex(OLD);
    const position = positionOf(before, 'それから');
    const NEW = `<div>${para('まったく別の本文。'.repeat(20))}</div>`;
    const after = storedTextIndex(NEW);
    const moved = remapPlace(OLD, NEW, position, 2000);
    expect(moved.how).toBe('fraction');
    expect(moved.position).toBe(Math.round((position / before.total) * after.total));
  });

  it('stays at the start when nothing was read', () => {
    expect(remapPlace(OLD, OLD, 0, 2000)).toEqual({ position: 0, how: 'start' });
  });

  it("counts like the reader: whispersync's spans and placeholder breaks add nothing", () => {
    const matched = OLD.replace(
      '雨が降っていた。',
      '<span class="ttu-whispersync-line-1">雨が降っていた。</span>'
    );
    const withBreak = OLD.replace('</p>', '<span class="placeholder-br">x</span></p>');
    expect(storedTextIndex(matched).total).toBe(storedTextIndex(OLD).total);
    expect(storedTextIndex(withBreak).total).toBe(storedTextIndex(OLD).total);
  });
});
