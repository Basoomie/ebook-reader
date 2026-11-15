/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteInfo } from './anki-connect';
import { AutoEnricher, LOOKBACK_DAYS, RECHECK_MS, type NewCard } from './auto-enrich';
import type { LookupRecord, LookupSentence } from './lookup-capture';

const T0 = 1_800_000_000_000;

function sentence(text: string): LookupSentence {
  return { text, html: text, position: 0, at: 0, cueIds: [] } as unknown as LookupSentence;
}

/** A fake Anki (note ids are the time a note was added) and the enricher wired to it. */
function setup({ enabled = true, failing = false } = {}) {
  const notes: NoteInfo[] = [];
  const calls: string[] = [];
  const enriched: { id: number; sentence: string | undefined }[][] = [];
  const logs: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  let enrichDelay = 0;
  const state = { enabled };

  const enricher = new AutoEnricher({
    enabled: () => state.enabled,
    isMapped: (type) => type === 'JP Mining Note',
    recentNoteIds: async (days) => {
      calls.push(`findNotes added:${days}`);
      if (failing) throw new Error("Anki didn't answer");
      return notes.map((n) => n.noteId);
    },
    notesInfo: async (ids) => {
      calls.push(`notesInfo ${ids.join(',')}`);
      return notes.filter((n) => ids.includes(n.noteId));
    },
    enrich: async (cards: NewCard[]) => {
      if (enrichDelay) await new Promise((r) => setTimeout(r, enrichDelay));
      enriched.push(cards.map((c) => ({ id: c.note.noteId, sentence: c.lookup.sentence?.text })));
    },
    exclusive: (task) => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    },
    log: (m) => logs.push(m)
  });

  let nextLookup = 1;
  const lookups: LookupRecord[] = [];

  /** The popup shows a word (its sentence is worked out 30 ms later, as LookupCapture does). */
  const start = (text: string | null = 'その本を読んだ。') => {
    const lookup: LookupRecord = {
      id: nextLookup++,
      startedAt: Date.now(),
      endedAt: null,
      sentence: null
    };
    lookups.push(lookup);
    enricher.onLookup(lookup, 'start');
    lookup.sentence = text === null ? null : sentence(text);
    return lookup;
  };
  const end = (lookup: LookupRecord) => {
    lookup.endedAt = Date.now();
    enricher.onLookup(lookup, 'end');
  };
  /** The popup moves on to another word. */
  const move = (text: string) => {
    const current = lookups.find((l) => l.endedAt === null);
    if (current) end(current);
    return start(text);
  };
  /** Yomitan adds a note now (its id is the time). */
  const addNote = (modelName = 'JP Mining Note') => {
    const note: NoteInfo = { noteId: Date.now(), modelName, tags: [], fields: {} };
    notes.push(note);
    return note;
  };
  const wait = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    // Let the promise chains of a check finish (they wait on no timer).
    for (let i = 0; i < 20; i += 1) await vi.advanceTimersByTimeAsync(0);
  };

  return {
    enricher,
    notes,
    calls,
    enriched,
    logs,
    state,
    start,
    end,
    move,
    addNote,
    wait,
    setEnrichDelay: (ms: number) => (enrichDelay = ms),
    run: (task: () => Promise<void>) => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    }
  };
}

describe('automatic enrichment of a card made with Yomitan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a lookup without a card changes nothing: one check at its end and the re-check', async () => {
    const a = setup();
    a.notes.push({ noteId: T0 - 60_000, modelName: 'JP Mining Note', tags: [], fields: {} });
    const lookup = a.start();
    await a.wait(1500);
    a.end(lookup);
    await a.wait(0);
    expect(a.calls).toEqual([`findNotes added:${LOOKBACK_DAYS}`]);
    await a.wait(RECHECK_MS);
    expect(a.calls).toEqual([
      `findNotes added:${LOOKBACK_DAYS}`,
      `findNotes added:${LOOKBACK_DAYS}`
    ]);
    expect(a.enriched).toEqual([]);
    // Nothing is checked again later.
    await a.wait(60_000);
    expect(a.calls).toHaveLength(2);
  });

  it('a card made during the lookup is enriched once, with that lookup’s sentence', async () => {
    const a = setup();
    const lookup = a.start('魔法を使った。');
    await a.wait(800);
    const card = a.addNote();
    await a.wait(700);
    a.end(lookup);
    await a.wait(0);
    expect(a.enriched).toEqual([[{ id: card.noteId, sentence: '魔法を使った。' }]]);
    expect(a.calls).toEqual([`findNotes added:${LOOKBACK_DAYS}`, `notesInfo ${card.noteId}`]);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toHaveLength(1);
    expect(a.calls).toHaveLength(3); // the re-check asks, and finds nothing new
    expect(a.logs.some((l) => l.includes('while its lookup was shown'))).toBe(true);
  });

  it('a card added before the lookup started is not enriched', async () => {
    const a = setup();
    a.addNote();
    await a.wait(1000);
    const lookup = a.start();
    await a.wait(1000);
    a.end(lookup);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([]);
    expect(a.calls.filter((c) => c.startsWith('notesInfo'))).toEqual([]);
  });

  it('a card of an unmapped note type is asked about once and left alone', async () => {
    const a = setup();
    const lookup = a.start();
    await a.wait(500);
    const kanji = a.addNote('Kanji');
    await a.wait(500);
    a.end(lookup);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([]);
    expect(a.calls.filter((c) => c.startsWith('notesInfo'))).toEqual([`notesInfo ${kanji.noteId}`]);
  });

  it('a card still being saved when the popup closed is found by the re-check', async () => {
    const a = setup();
    const lookup = a.start('猫が鳴いた。');
    await a.wait(1000);
    a.end(lookup); // + tapped, then the popup closed at once
    await a.wait(1000);
    const card = a.addNote(); // Yomitan has its media and adds the note now
    expect(a.enriched).toEqual([]);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([[{ id: card.noteId, sentence: '猫が鳴いた。' }]]);
    expect(a.logs.some((l) => l.includes('1000 ms after its lookup ended'))).toBe(true);
  });

  it('a card saved after the re-check is not enriched', async () => {
    const a = setup();
    const lookup = a.start();
    await a.wait(500);
    a.end(lookup);
    await a.wait(RECHECK_MS + 500);
    a.addNote();
    await a.wait(100);
    // A later lookup that ends doesn't pick it up either: it was added before that lookup.
    const next = a.start();
    await a.wait(300);
    a.end(next);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([]);
  });

  it('two cards in a row (the popup moves on): each gets its own lookup’s sentence', async () => {
    const a = setup();
    a.start('一つ目の文。');
    await a.wait(600);
    const first = a.addNote();
    await a.wait(400);
    a.move('二つ目の文。');
    await a.wait(0);
    await a.wait(700);
    const second = a.addNote();
    await a.wait(300);
    a.end(a.move('関係ない文。'));
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([
      [{ id: first.noteId, sentence: '一つ目の文。' }],
      [{ id: second.noteId, sentence: '二つ目の文。' }]
    ]);
  });

  it('a card added after the popup moved on goes with the next lookup (the known limit)', async () => {
    // The known limit, measured in the live tests: Yomitan adds the note when its media
    // are ready; added after the next lookup started, it goes with that lookup.
    const a = setup();
    a.start('一つ目の文。');
    await a.wait(500);
    const later = a.move('二つ目の文。');
    await a.wait(300);
    const card = a.addNote();
    await a.wait(200);
    a.end(later);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([[{ id: card.noteId, sentence: '二つ目の文。' }]]);
  });

  it('two cards from one lookup: both, oldest first, in one run', async () => {
    const a = setup();
    const lookup = a.start('魔法を使った。');
    await a.wait(500);
    const one = a.addNote();
    await a.wait(500);
    const two = a.addNote();
    await a.wait(500);
    a.end(lookup);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([
      [
        { id: one.noteId, sentence: '魔法を使った。' },
        { id: two.noteId, sentence: '魔法を使った。' }
      ]
    ]);
  });

  it('a lookup whose sentence could not be worked out still counts (no sentence)', async () => {
    const a = setup();
    const lookup = a.start(null);
    await a.wait(500);
    const card = a.addNote();
    await a.wait(500);
    a.end(lookup);
    await a.wait(0);
    expect(a.enriched).toEqual([[{ id: card.noteId, sentence: undefined }]]);
  });

  it('a card enriched by hand is never enriched by itself afterwards', async () => {
    const a = setup();
    const lookup = a.start();
    await a.wait(500);
    const card = a.addNote();
    a.enricher.markHandled(card.noteId); // the Enrich button, before the popup closed
    await a.wait(500);
    a.end(lookup);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([]);
  });

  it('a manual Enrich that runs first (queued before the check) wins', async () => {
    const a = setup();
    const lookup = a.start();
    await a.wait(500);
    const card = a.addNote();
    await a.wait(500);
    // The tap on the Enrich button also closes the popup: the manual run is queued first.
    const manual = a.run(async () => {
      await new Promise((r) => setTimeout(r, 300));
      a.enricher.markHandled(card.noteId);
    });
    a.end(lookup);
    await a.wait(400);
    await manual;
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([]);
  });

  it('checks never overlap, and fast lookups (desktop hovering) make few calls', async () => {
    const a = setup();
    a.setEnrichDelay(0);
    let lookup = a.start('一。');
    for (let i = 0; i < 10; i += 1) {
      await a.wait(100);
      lookup = a.move(`文${i}。`);
    }
    await a.wait(100);
    a.end(lookup);
    await a.wait(RECHECK_MS);
    const finds = a.calls.filter((c) => c.startsWith('findNotes'));
    expect(finds.length).toBeLessThanOrEqual(12); // one per lookup end, plus the re-check
    expect(finds.length).toBeGreaterThanOrEqual(2);
  });

  it('a lookup ending while a check runs gets one more check afterwards', async () => {
    const a = setup();
    a.setEnrichDelay(1000);
    const first = a.start('一つ目の文。');
    await a.wait(300);
    const one = a.addNote();
    await a.wait(200);
    const second = a.move('二つ目の文。'); // check 1 starts and enriches slowly
    await a.wait(300);
    const two = a.addNote();
    await a.wait(100);
    a.end(second); // during check 1
    await a.wait(RECHECK_MS + 1000);
    expect(a.enriched.flat().map((c) => c.id)).toEqual([one.noteId, two.noteId]);
    expect(first.endedAt).not.toBeNull();
  });

  it('switched off (or nothing mapped): no calls at all', async () => {
    const a = setup({ enabled: false });
    const lookup = a.start();
    await a.wait(500);
    a.addNote();
    a.end(lookup);
    await a.wait(RECHECK_MS);
    expect(a.calls).toEqual([]);
    expect(a.enriched).toEqual([]);
  });

  it('switched off while a lookup is open: nothing is checked', async () => {
    const a = setup();
    const lookup = a.start();
    await a.wait(500);
    a.addNote();
    a.state.enabled = false;
    a.end(lookup);
    await a.wait(RECHECK_MS);
    expect(a.calls).toEqual([]);
  });

  it('Anki not answering a check: nothing enriched, nothing thrown, only logged', async () => {
    const a = setup({ failing: true });
    const lookup = a.start();
    await a.wait(500);
    a.end(lookup);
    await a.wait(RECHECK_MS);
    expect(a.enriched).toEqual([]);
    expect(a.logs.filter((l) => l.includes("no check: Anki didn't answer"))).toHaveLength(2);
  });

  it('stopped (the reader closed): the re-check doesn’t run', async () => {
    const a = setup();
    const lookup = a.start();
    await a.wait(500);
    a.end(lookup);
    await a.wait(0);
    a.enricher.stop();
    a.addNote();
    await a.wait(RECHECK_MS);
    expect(a.calls).toHaveLength(1);
    expect(a.enriched).toEqual([]);
  });
});
