/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  completeBookCopy,
  deleteCollectionCopy,
  endGoalCopy,
  removeFromCollectionCopy,
  removeFromDeviceCopy,
  noAudiobookCopy,
  removeSubtitlesCopy,
  replaceAudiobookCopy,
  replaceSubtitlesCopy,
  restoreSubtitlesCopy,
  unlinkAudiobookCopy
} from './confirm-copy';
import * as copies from './confirm-copy';
import { IRREVERSIBLE_NOTE, answerOnce, confirmParagraphs, nextFocusIndex } from './confirm-state';

describe('answerOnce', () => {
  it('passes on only the first answer', () => {
    const answers: boolean[] = [];
    const once = answerOnce((c) => answers.push(c));
    expect(once.answered).toBe(false);
    expect(once.answer(true)).toBe(true);
    // A double tap, then the dialog going away (onDestroy answers false).
    expect(once.answer(true)).toBe(false);
    expect(once.answer(false)).toBe(false);
    expect(answers).toEqual([true]);
    expect(once.answered).toBe(true);
  });

  it('turns a dialog closed from outside into "no"', () => {
    const answers: boolean[] = [];
    const once = answerOnce((c) => answers.push(c));
    once.answer(false);
    expect(answers).toEqual([false]);
  });
});

describe('nextFocusIndex', () => {
  it('wraps at both ends and starts at an end when focus is outside', () => {
    expect(nextFocusIndex(0, 2, false)).toBe(1);
    expect(nextFocusIndex(1, 2, false)).toBe(0);
    expect(nextFocusIndex(0, 2, true)).toBe(1);
    expect(nextFocusIndex(-1, 2, false)).toBe(0);
    expect(nextFocusIndex(-1, 2, true)).toBe(1);
    expect(nextFocusIndex(5, 2, false)).toBe(0);
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
  });
});

describe('confirmParagraphs', () => {
  it('drops empty paragraphs and ends with the "can\'t be undone" note when it applies', () => {
    expect(confirmParagraphs({ message: ['A', ' '], irreversible: true })).toEqual([
      'A',
      IRREVERSIBLE_NOTE
    ]);
    expect(confirmParagraphs({ message: ['A'] })).toEqual(['A']);
  });
});

describe('confirmation words', () => {
  it('names the book removed from this device and says what stays (WP15e)', () => {
    const copy = removeFromDeviceCopy('月と灯台');
    expect(copy.title).toBe('Remove “月と灯台” from this device?');
    expect(copy.confirmLabel).toBe('Remove from this device');
    expect(copy.message[0]).toContain('on this device is removed');
    expect(copy.message[1]).toContain('saved with the library server stay');
    // It can be downloaded again, so it does not say "can't be undone".
    expect(copy.irreversible).toBeFalsy();
  });

  it('words collections, goals, completion and subtitles', () => {
    expect(removeFromCollectionCopy({ count: 3, collection: 'Planned' }).title).toBe(
      'Remove 3 books from “Planned”?'
    );
    expect(
      removeFromCollectionCopy({ count: 1, title: '本', collection: 'Planned' }).confirmLabel
    ).toBe('Remove');
    expect(deleteCollectionCopy('Planned').confirmLabel).toBe('Delete collection');
    expect(endGoalCopy('Daily time: 1 h 00 min', true).message[0]).toContain('removed completely');
    expect(endGoalCopy('Daily time: 1 h 00 min', false).message[0]).toContain('Earlier periods');
    expect(completeBookCopy(0).message[0]).toBe(
      'Your place moves to the end of the book and it counts as read.'
    );
    expect(completeBookCopy(1500).message[0]).toContain('The 1,500 characters');
    expect(completeBookCopy(0).danger).toBe(false);
    expect(restoreSubtitlesCopy(true).title).toBe('Restore the selected subtitles?');
  });

  it('words audiobook links: every device, files untouched', () => {
    const unlink = unlinkAudiobookCopy('Vol 2 - スパイ教室02');
    expect(unlink.title).toBe('Unlink the audiobook?');
    expect(unlink.confirmLabel).toBe('Unlink audiobook');
    expect(unlink.message[0]).toContain('“Vol 2 - スパイ教室02”');
    expect(unlink.message[1]).toContain('every device');
    expect(unlink.message[1]).toContain('not touched');
    expect(unlink.irreversible).toBeFalsy();
    expect(replaceAudiobookCopy('A', 'B').message[0]).toBe(
      '“B” is linked instead of “A”. You choose the subtitles again.'
    );
    expect(noAudiobookCopy('A').confirmLabel).toBe('No audiobook');
    expect(replaceSubtitlesCopy('a.srt', 'b.srt').confirmLabel).toBe('Replace subtitles');
    expect(removeSubtitlesCopy('a.srt').title).toBe('Remove the subtitles?');
  });

  it('never uses "OK" or "Confirm" and always asks a question', () => {
    const builders = Object.values(copies).filter((v) => typeof v === 'function') as ((
      ...args: never[]
    ) => { title: string; confirmLabel: string })[];
    const samples = builders.map((build) =>
      // Every builder takes plain arguments; sample ones are enough for the wording rules.
      (build as unknown as (...a: unknown[]) => { title: string; confirmLabel: string })(
        { count: 2, source: 'browser', keepStatistics: true, collection: 'C', books: true },
        true
      )
    );
    expect(samples.length).toBeGreaterThan(20);
    for (const copy of samples) {
      expect(copy.title.endsWith('?')).toBe(true);
      expect(['OK', 'Confirm', 'Yes']).not.toContain(copy.confirmLabel);
    }
  });
});
