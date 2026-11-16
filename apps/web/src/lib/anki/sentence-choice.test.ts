/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { chooseSentence, type SelectionCandidate } from './sentence-choice';
import { SelectionOrigin } from './selection-origin';

const NOTE = 1000;
const selection = (
  at: number,
  byUser = true,
  sentence: string | null = 'selection'
): SelectionCandidate<string> => ({ at, byUser, sentence: () => sentence });
const card = (value: string | null) => () => value;

describe('sentence choice', () => {
  it("uses the user's own selection made after the card was added", () => {
    expect(
      chooseSentence({ selection: selection(1500), lookup: 'lookup' }, NOTE, card('card'))
    ).toEqual({ sentence: 'selection', source: 'selection' });
  });

  it("ignores Yomitan's selection of the word (set by a script) and uses the card's sentence", () => {
    expect(
      chooseSentence(
        { selection: selection(1500, false, '言葉'), lookup: null },
        NOTE,
        card('card')
      )
    ).toEqual({ sentence: 'card', source: 'card' });
  });

  it("ignores the user's own selection made before the card was added", () => {
    expect(chooseSentence({ selection: selection(900), lookup: null }, NOTE, card('card'))).toEqual(
      { sentence: 'card', source: 'card' }
    );
    expect(
      chooseSentence({ selection: selection(NOTE), lookup: null }, NOTE, card('card'))?.source
    ).toBe('card');
  });

  it("falls back to the card's sentence when the selection isn't in the book", () => {
    expect(
      chooseSentence({ selection: selection(1500, true, null), lookup: null }, NOTE, card('card'))
    ).toEqual({ sentence: 'card', source: 'card' });
  });

  it("prefers the card's sentence to the last lookup", () => {
    expect(chooseSentence({ selection: null, lookup: 'lookup' }, NOTE, card('card'))?.source).toBe(
      'card'
    );
  });

  it('uses the last lookup when the card has no sentence', () => {
    expect(chooseSentence({ selection: null, lookup: 'lookup' }, NOTE, card(null))).toEqual({
      sentence: 'lookup',
      source: 'lookup'
    });
  });

  it('has none without a selection, a card sentence or a lookup', () => {
    expect(chooseSentence({ selection: null, lookup: null }, NOTE, card(null))).toBeNull();
    expect(
      chooseSentence({ selection: selection(1500, false), lookup: null }, NOTE, card(null))
    ).toBeNull();
  });

  it('works out a candidate only when it is needed', () => {
    let selected = 0;
    let carded = 0;
    const result = chooseSentence(
      {
        selection: {
          at: 1500,
          byUser: true,
          sentence: () => {
            selected += 1;
            return 'selection';
          }
        },
        lookup: null
      },
      NOTE,
      () => {
        carded += 1;
        return 'card';
      }
    );
    expect(result?.source).toBe('selection');
    expect([selected, carded]).toEqual([1, 0]);

    chooseSentence({ selection: selection(1500, false), lookup: null }, NOTE, card('card'));
    let notAsked = 0;
    chooseSentence(
      {
        selection: {
          at: 1500,
          byUser: false,
          sentence: () => {
            notAsked += 1;
            return 'x';
          }
        },
        lookup: null
      },
      NOTE,
      card('card')
    );
    expect(notAsked).toBe(0);
  });
});

describe('selection origin', () => {
  it('a drag (press, selectstart, changes) is the user’s', () => {
    const origin = new SelectionOrigin();
    origin.gesture();
    origin.selectStart();
    origin.selectionChange();
    origin.selectionChange();
    expect(origin.byUser).toBe(true);
  });

  it('a script’s selection (no selectstart) is not the user’s', () => {
    const origin = new SelectionOrigin();
    origin.selectionChange();
    expect(origin.byUser).toBe(false);
  });

  it('a script’s selection after the user’s own drag is told apart', () => {
    const origin = new SelectionOrigin();
    origin.gesture();
    origin.selectStart();
    origin.selectionChange();
    // Shift held (a key) for a Yomitan lookup, which then selects the word.
    origin.gesture();
    origin.selectionChange();
    expect(origin.byUser).toBe(false);
  });

  it('a tap on a word (Yomitan on a phone) is not the user’s selection', () => {
    const origin = new SelectionOrigin();
    origin.gesture();
    origin.selectionChange();
    expect(origin.byUser).toBe(false);
  });
});
