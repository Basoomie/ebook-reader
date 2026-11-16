/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteInfo } from './anki-connect';
import {
  AutoEnricher,
  fieldText,
  LOOKBACK_DAYS,
  MIN_INTERVAL_MS,
  type NewCard
} from './auto-enrich';
import type { LookupSentence } from './lookup-capture';

const T0 = 1_800_000_000_000;
const INTERVAL = 3000;
const BOOK = ['その本を読んだ。', '雨が降った。', 'はい。'];

function note(noteId: number, sentence: string, modelName = 'JP Mining Note'): NoteInfo {
  return {
    noteId,
    modelName,
    tags: [],
    fields: {
      Word: { value: '本', order: 0 },
      Sentence: { value: sentence, order: 1 }
    }
  } as NoteInfo;
}

/** A fake Anki (note ids are the time a note was added), a fake book and the enricher. */
function setup({ failing = false } = {}) {
  const notes: NoteInfo[] = [];
  const calls: string[] = [];
  const enriched: { id: number; sentence: string }[][] = [];
  const logs: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const state = { enabled: true, visible: true, failing, book: [...BOOK], enrichDelay: 0 };

  const enricher = new AutoEnricher({
    enabled: () => state.enabled,
    sentenceField: (type) => (type === 'JP Mining Note' ? 'Sentence' : null),
    intervalMs: () => INTERVAL,
    visible: () => state.visible,
    place: (text) =>
      state.book.includes(text)
        ? ({
            text,
            html: text,
            position: state.book.indexOf(text),
            at: 0,
            cueIds: []
          } as LookupSentence)
        : null,
    recentNoteIds: async (days) => {
      calls.push(`findNotes added:${days}`);
      if (state.failing) throw new Error("Anki didn't answer");
      return notes.map((n) => n.noteId);
    },
    notesInfo: async (ids) => {
      calls.push(`notesInfo ${ids.join(',')}`);
      return notes.filter((n) => ids.includes(n.noteId));
    },
    enrich: async (cards: NewCard[]) => {
      if (state.enrichDelay) await new Promise((r) => setTimeout(r, state.enrichDelay));
      enriched.push(cards.map((c) => ({ id: c.note.noteId, sentence: c.sentence.text })));
    },
    exclusive: (task) => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    },
    log: (m) => logs.push(m)
  });

  /** A card made now (as Yomitan adds it: every field at once). */
  const add = (sentence: string, modelName?: string) => {
    const n = note(Date.now(), sentence, modelName);
    notes.push(n);
    return n.noteId;
  };

  return { enricher, notes, calls, enriched, logs, state, add };
}

describe('AutoEnricher (asks Anki every few seconds)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('enriches a card made while reading at the next check, with its own sentence', async () => {
    const { enricher, enriched, calls, add } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(1000);
    const id = add('<b>その</b>本を読んだ。');
    expect(enriched).toEqual([]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(enriched).toEqual([[{ id, sentence: 'その本を読んだ。' }]]);
    expect(calls[0]).toBe(`findNotes added:${LOOKBACK_DAYS}`);
    // Handled: not enriched again.
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(enriched).toHaveLength(1);
  });

  it('asks nothing more of Anki when there is no new card', async () => {
    const { enricher, calls } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(calls).toEqual(Array(3).fill(`findNotes added:${LOOKBACK_DAYS}`));
  });

  it('leaves cards added before it started alone', async () => {
    const { enricher, enriched, add } = setup();
    add('その本を読んだ。');
    await vi.advanceTimersByTimeAsync(10);
    enricher.start();
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(enriched).toEqual([]);
  });

  it('enriches several new cards oldest first, in one go', async () => {
    const { enricher, enriched, add } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    const a = add('その本を読んだ。');
    await vi.advanceTimersByTimeAsync(100);
    const b = add('雨が降った。');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(enriched).toEqual([
      [
        { id: a, sentence: 'その本を読んだ。' },
        { id: b, sentence: '雨が降った。' }
      ]
    ]);
  });

  it('leaves alone a card whose note type maps no Sentence field, or that has no sentence', async () => {
    const { enricher, enriched, calls, add } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    add('その本を読んだ。', 'Basic');
    add('');
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(enriched).toEqual([]);
    // Asked about once only.
    expect(calls.filter((c) => c.startsWith('notesInfo'))).toHaveLength(1);
  });

  it("leaves alone a card whose sentence isn't in the open book, and tries it again on later checks", async () => {
    const { enricher, enriched, calls, add, state } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    const id = add('別の本の文。');
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(enriched).toEqual([]);
    // The page changed (e.g. the next section loaded): placed without asking Anki again.
    state.book.push('別の本の文。');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(enriched).toEqual([[{ id, sentence: '別の本の文。' }]]);
    expect(calls.filter((c) => c.startsWith('notesInfo'))).toHaveLength(1);
  });

  it('forgets unplaced cards and earlier ones when another book is opened', async () => {
    const { enricher, enriched, add, state } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    add('別の本の文。');
    await vi.advanceTimersByTimeAsync(INTERVAL);
    enricher.reset();
    state.book.push('別の本の文。');
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(enriched).toEqual([]);
  });

  it('a card enriched by hand is never enriched by itself', async () => {
    const { enricher, enriched, add } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    const id = add('その本を読んだ。');
    enricher.markHandled(id);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(enriched).toEqual([]);
  });

  it('checks nothing while the setting is off or the page is hidden', async () => {
    const { enricher, enriched, calls, add, state } = setup();
    state.enabled = false;
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    const id = add('その本を読んだ。');
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    state.enabled = true;
    state.visible = false;
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(calls).toEqual([]);
    state.visible = true;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(enriched).toEqual([[{ id, sentence: 'その本を読んだ。' }]]);
  });

  it('Anki not answering shows nothing, logs once, and the next check works', async () => {
    const { enricher, enriched, logs, add, state } = setup({ failing: true });
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    const id = add('その本を読んだ。');
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(enriched).toEqual([]);
    expect(logs.filter((l) => l.includes('no check'))).toHaveLength(1);
    state.failing = false;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(enriched).toEqual([[{ id, sentence: 'その本を読んだ。' }]]);
  });

  it('checks never overlap (a slow Enrich holds the next check)', async () => {
    const { enricher, enriched, calls, add, state } = setup();
    state.enrichDelay = INTERVAL * 3;
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    add('その本を読んだ。');
    await vi.advanceTimersByTimeAsync(INTERVAL + 10);
    const during = calls.length;
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(calls.length).toBe(during);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(enriched).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(during);
  });

  it('an explicit check (page shown again) runs at once', async () => {
    const { enricher, enriched, add } = setup();
    enricher.start();
    await vi.advanceTimersByTimeAsync(100);
    const id = add('その本を読んだ。');
    await enricher.check();
    expect(enriched).toEqual([[{ id, sentence: 'その本を読んだ。' }]]);
  });

  it('never checks more often than once a second; stop ends the checks', async () => {
    const { enricher, calls } = setup();
    const fast = new AutoEnricher({
      enabled: () => true,
      sentenceField: () => 'Sentence',
      intervalMs: () => 0,
      visible: () => true,
      place: () => null,
      recentNoteIds: async () => {
        calls.push('fast');
        return [];
      },
      notesInfo: async () => [],
      enrich: async () => undefined,
      exclusive: (task) => task(),
      log: () => undefined
    });
    fast.start();
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS * 3);
    expect(calls.filter((c) => c === 'fast')).toHaveLength(3);
    fast.stop();
    enricher.stop();
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS * 5);
    expect(calls.filter((c) => c === 'fast')).toHaveLength(3);
  });
});

describe('fieldText', () => {
  it("turns a field's HTML into the sentence's text", () => {
    expect(fieldText('<b>その</b>本を&nbsp;読んだ。<br>[sound:a.mp3]')).toBe('その本を 読んだ。');
    expect(fieldText('A &amp; B &lt;c&gt; &quot;d&quot;')).toBe('A & B <c> "d"');
  });
});
