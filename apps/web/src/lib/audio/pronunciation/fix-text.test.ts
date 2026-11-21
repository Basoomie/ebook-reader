/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { globalHere, jobFixesText, kindText, placesText, versionNote } from './fix-text';
import type { PronunciationCheck, PronunciationFix } from './fix-types';
import { removePronunciationFixCopy } from '$lib/confirm/confirm-copy';

const fix = (id: number, fields: Partial<PronunciationFix> = {}): PronunciationFix => ({
  id,
  bookId: null,
  kind: 'word',
  match: '椎名',
  reading: 'しいな',
  createdAt: id,
  updatedAt: id,
  ...fields
});

describe('pronunciation fix words', () => {
  it('says where an entry matches in the book', () => {
    expect(placesText(undefined)).toBe('');
    expect(placesText({ id: 1, places: 0, skipped: 0, examples: [] })).toBe('Not in this book');
    expect(placesText({ id: 1, places: 1, skipped: 0, examples: [] })).toBe(
      'Found once in this book'
    );
    expect(placesText({ id: 1, places: 1234, skipped: 2, examples: [] })).toBe(
      "Found 1,234 times in this book · 2 skipped: the book's own furigana"
    );
    expect(placesText({ id: 1, places: 0, skipped: 1, examples: [] })).toBe(
      "Not in this book · 1 skipped: the book's own furigana"
    );
  });

  it('names the kind', () => {
    expect(kindText({ kind: 'word' })).toBe('Word');
    expect(kindText({ kind: 'pattern' })).toBe('Pattern');
  });

  it('notes an audiobook made before the current fixes, and nothing otherwise', () => {
    const check = (audiobook: PronunciationCheck['audiobook']): PronunciationCheck => ({
      entries: [],
      audiobook
    });
    expect(versionNote(null)).toBe('');
    expect(versionNote(check(null))).toBe('');
    expect(versionNote(check({ version: 2, madeWithCurrentFixes: true }))).toBe('');
    expect(versionNote(check({ version: 1, madeWithCurrentFixes: false }))).toBe(
      'This audiobook was made before the current pronunciation fixes for this book. Make it again (Text-to-speech > Make an audiobook with this voice) to use them.'
    );
  });

  it("counts a job's fixes for its settings line", () => {
    expect(jobFixesText(undefined)).toBe('');
    expect(jobFixesText({ book: 0, global: 0, places: 0, digest: '' })).toBe('');
    expect(jobFixesText({ book: 1, global: 0, places: 4, digest: 'x' })).toBe(
      '1 pronunciation fix'
    );
    expect(jobFixesText({ book: 2, global: 3, places: 9, digest: 'x' })).toBe(
      '5 pronunciation fixes'
    );
  });

  it('shows on a book page only the global fixes found (or skipped) in it', () => {
    const entries = [fix(1), fix(2, { match: '月' }), fix(3, { match: '畢竟' })];
    expect(globalHere(entries, null)).toEqual([]);
    const check: PronunciationCheck = {
      entries: [
        { id: 1, places: 3, skipped: 0, examples: [] },
        { id: 2, places: 0, skipped: 0, examples: [] },
        { id: 3, places: 0, skipped: 1, examples: [] }
      ],
      audiobook: null
    };
    expect(globalHere(entries, check).map((e) => e.id)).toEqual([1, 3]);
  });

  it('asks before removing a fix, saying what changes', () => {
    expect(removePronunciationFixCopy('椎名', false)).toEqual({
      title: 'Remove the fix for “椎名”?',
      message: [
        'Audio the PC makes for this book from now on reads it as before.',
        'Audiobooks already made stay as they are.'
      ],
      confirmLabel: 'Remove fix'
    });
    expect(removePronunciationFixCopy('月', true).message[0]).toBe(
      'Audio the PC makes from now on reads it as before, in every book.'
    );
  });
});
