/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// Whispersync Match on the book page: whispersync's saved subtitles as lines (moved out of
// AudioBookMenu.loadPersistedSubtitles unchanged; the reader and the book page use it).
import { describe, expect, it } from 'vitest';
import type { Subtitle } from './general';
import { persistedSubtitles } from './files';

const saved = (over: Partial<Subtitle> = {}): Subtitle => ({
  id: '1',
  originalStartSeconds: 10,
  startSeconds: 0,
  startTime: '',
  originalEndSeconds: 20,
  endSeconds: 0,
  endTime: '',
  originalText: 'あ',
  text: 'あ',
  subIndex: 0,
  ...over
});

describe('persistedSubtitles', () => {
  it('keeps id, order and text; times from the paddings, or the adjusted times', () => {
    const lines = persistedSubtitles(
      [saved(), saved({ id: '2', text: 'い', adjustedStartSeconds: 30, adjustedEndSeconds: 35 })],
      500,
      -1000,
      0
    );
    expect([...lines.keys()]).toEqual(['1', '2']);
    expect(lines.get('1')).toMatchObject({ text: 'あ', startSeconds: 10.5, endSeconds: 19 });
    expect(lines.get('1')?.startTime).toMatch(/00:00:10/);
    expect(lines.get('2')).toMatchObject({ text: 'い', startSeconds: 30, endSeconds: 35 });
  });

  it('keeps the end inside the audio when its length is known', () => {
    expect(persistedSubtitles([saved()], 0, 0, 15).get('1')?.endSeconds).toBe(15);
  });
});
