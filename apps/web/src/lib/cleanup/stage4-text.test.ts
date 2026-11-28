/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type {
  Stage4AiGateField,
  Stage4AiGateGroup,
  Stage4AiStatus,
  Stage4Gate,
  Stage4Site,
  Stage4Status
} from './cleanup-api';
import { turnOnOnlineSourcesCopy } from '$lib/confirm/confirm-copy';
import {
  aiBar,
  aiBooksLine,
  aiGateRows,
  aiLine,
  booksLine,
  lookupBar,
  duration,
  gateRows,
  readingLine,
  readingsLine,
  siteLine,
  timeLeftLine,
  sourceName,
  valueText,
  writeBar,
  writtenLine
} from './stage4-text';

const site = (o: Partial<Stage4Site>): Stage4Site => ({
  site: 'amazon-dp',
  enabled: true,
  intervalSeconds: 8,
  queued: 0,
  leased: 0,
  done: 0,
  gone: 0,
  failed: 0,
  attempts: 0,
  challenges: 0,
  errors: 0,
  busy: 0,
  recent: null,
  secondsPerRequest: 8,
  secondsLeft: 0,
  pausedReason: null,
  backoffUntil: null,
  backoffReason: null,
  slowFactor: 1,
  ...o
});

describe('stage 4 wording', () => {
  it('says per site what is answered, left and why it waits', () => {
    expect(
      siteLine(site({ done: 1200, gone: 3, queued: 50000, secondsLeft: 400000, challenges: 2 }))
    ).toBe('1,203 answered · 50,000 to ask · 2 refused · 8 s per request · about 4 days 15 h left');
    expect(siteLine(site({ enabled: false }))).toBe('Switched off');
    expect(siteLine(site({ pausedReason: '8 refusals in a row' }))).toContain(
      'paused: 8 refusals in a row'
    );
    expect(siteLine(site({ slowFactor: 1.5 }))).toContain('slowed down ×1.5');
    // Amazon's two queues in one slot: the slot's pace and the time for both, also when this
    // queue has nothing waiting right now.
    expect(
      siteLine(
        site({
          site: 'amazon-dp',
          done: 1701,
          sharedSlot: true,
          secondsPerRequest: 24,
          secondsLeft: 1_100_000
        })
      )
    ).toBe(
      '1,701 answered · 24 s per request in the slot shared with Kindle search · about 12 days 17 h left for both'
    );
  });

  it('times, sources and values in plain words', () => {
    expect(duration(30)).toBe('under a minute');
    expect(duration(3000)).toBe('50 min');
    expect(duration(7200)).toBe('2 h 0 min');
    expect(sourceName('amazon-asin')).toBe('Amazon (the file’s ASIN)');
    expect(sourceName('bookmeter,isbn')).toBe('Bookmeter, isbn');
    expect(valueText({ name: '魔女の旅々', index: 3 })).toBe('魔女の旅々 · 3');
    expect(valueText({ name: null, index: null })).toBe('(no series)');
    expect(valueText(['A', 'B'])).toBe('A, B');
    expect(valueText(null)).toBe('(none)');
  });

  it('counts books and readings', () => {
    const status = {
      books: [
        { state: 'proposed', labeled: 1, n: 600 },
        { state: 'proposed', labeled: 0, n: 1000 },
        { state: 'waiting', labeled: 0, n: 400 },
        { state: 'error', labeled: 0, n: 2 }
      ],
      readings: [
        { state: 'found', n: 90 },
        { state: 'generated', n: 8 },
        { state: 'none', n: 2 },
        { state: 'queued', n: 5 }
      ]
    } as unknown as Stage4Status;
    expect(booksLine(status)).toBe(
      '1,600 of 2,002 books looked up · 400 waiting for the sites · 2 couldn’t be read'
    );
    expect(readingsLine(status)).toBe(
      'Author readings: 90 from Web NDL Authorities · 8 generated (spot check) · 2 without a reading · 5 to look up'
    );
    // Against every book with an EPUB, not only the books read so far.
    const reading = {
      ...status,
      read: { done: 2002, total: 52164, perSecond: 9.3 },
      timeLeft: {
        read: 5394,
        sites: {},
        slowest: { site: 'bookwalker', seconds: 690000 },
        final: 900,
        total: 690900,
        notStarted: 50162,
        basis: 'reference',
        followUps: 'bound'
      }
    } as unknown as Stage4Status;
    expect(booksLine(reading)).toBe(
      '1,600 of 52,164 books looked up · 400 waiting for the sites · 2 couldn’t be read'
    );
    expect(readingLine(reading)).toBe('Reading the files: 2,002 of 52,164 · 9.3 books a second');
    // The lookups' bar: books looked up of every book that can be read, the whole Preview's time.
    expect(lookupBar(reading)).toEqual({
      label: 'Looking up: 1,600 of 52,162 books · 400 waiting for the sites · 2 couldn’t be read',
      fraction: 1600 / 52162,
      eta: expect.stringContaining('(estimate)')
    });
    expect(
      lookupBar({
        ...status,
        books: [{ state: 'proposed', labeled: 0, n: 10 }]
      } as unknown as Stage4Status)
    ).toBeNull();
    expect(timeLeftLine(reading)).toBe(
      'Time left for the whole Preview: about 7 days 23 h · the slowest site is BOOK☆WALKER, about 7 days 23 h · then the final pass, about 15 min · 50,162 books not started yet at requests per book from the reference run until the labeled books are done; shared series pages make it an upper bound · what the open lookups ask next counted at most until measured'
    );
    // Every book started (live 2026-11-20): only the open lookups and what they ask next.
    expect(
      timeLeftLine({
        ...reading,
        timeLeft: {
          ...reading.timeLeft!,
          read: 0,
          slowest: { site: 'amazon', seconds: 41000 },
          final: 150,
          total: 41150,
          notStarted: 0,
          basis: 'labeled',
          followUps: 'measured'
        }
      })
    ).toBe(
      'Time left for the whole Preview: about 11 h 26 min · the slowest site is Amazon (product pages and searches share one slot), about 11 h 23 min · then the final pass, about 3 min · what the open lookups ask next at the rates measured in this run'
    );
    expect(
      readingLine({
        ...reading,
        read: { done: 10, total: 100, perSecond: null },
        timeLeft: { ...reading.timeLeft!, read: null }
      })
    ).toBe('Reading the files: 10 of 100 · measuring the speed');
    const refused = {
      ...reading,
      sites: [
        site({
          site: 'amazon-dp',
          backoffUntil: 2000,
          backoffReason: 'refused (HTTP 503): waiting 900 s'
        }),
        site({
          site: 'amazon-search',
          backoffUntil: 2000,
          backoffReason: 'refused (HTTP 503): waiting 900 s'
        }),
        site({ site: 'ranobedb', backoffUntil: 2000, backoffReason: 'network error: waiting 30 s' })
      ]
    } as unknown as Stage4Status;
    expect(timeLeftLine(refused, 1000)).toMatch(
      / · Amazon is held up by refusals right now; this assumes it answers again at its pace · /
    );
    expect(timeLeftLine(refused, 3000)).not.toMatch(/held up/);
    expect(timeLeftLine({ ...reading, timeLeft: { ...reading.timeLeft!, total: 30 } })).toBe(
      'Time left for the whole Preview: less than a minute'
    );
    expect(timeLeftLine({ ...reading, timeLeft: { ...reading.timeLeft!, total: null } })).toBe(
      'Time left for the whole Preview: measuring…'
    );
  });

  it('shows the gate beside the measured numbers', () => {
    const gate = {
      books: 632,
      at: 0,
      kind: { right: 1, all: 1, percent: 100 },
      fields: {
        title: {
          auto: 500,
          scored: 600,
          right: 490,
          percent: 98,
          bar: 95,
          below: false,
          the600: { auto: 400, right: 393, percent: 98.25, measured: 98.2 },
          checkD: { auto: 100, right: 97, percent: 97, measured: 96.9 }
        }
      }
    } as unknown as Stage4Gate;
    expect(gateRows(gate)[0]).toMatchObject({
      field: 'Title',
      percent: '98.0 % right (bar 95 %)',
      the600: 'the 600: 98.3 % (measured 98.2 %)'
    });
  });
});

describe('the AI check on the stage-4 card (WP20e)', () => {
  const field = (o: Partial<Stage4AiGateField> = {}): Stage4AiGateField => ({
    scored: 200,
    auto: 190,
    autoRight: 188,
    autoPercent: 98.9,
    allRight: 196,
    allPercent: 98,
    wrong: [],
    ...o
  });
  const group = (books: number): Stage4AiGateGroup => ({
    books,
    everyFieldRight: Math.round(books * 0.95),
    everyFieldPercent: 95,
    fields: { t: field(), au: field({ allPercent: 99.5 }) }
  });
  const ai = (o: Partial<Stage4AiStatus> = {}): Stage4AiStatus => ({
    phase: 'models',
    items: 52120,
    labeledItems: 789,
    decided: 0,
    answers: { queued: 300, sent: 3, answered: 1270, failed: 0, blocked: 0, invalid: 0 },
    wait: null,
    costUsd: 0.4123,
    invented: 12,
    flaggedAgainstRules: null,
    gate: null,
    error: null,
    finishedAt: null,
    ...o
  });
  it('says what the AI check is doing, the answers in and the spend', () => {
    expect(aiLine(ai())).toBe(
      'AI check: asking both models · 1,270 of 1,573 answers in · $0.41 spent'
    );
    expect(aiLine(ai({ phase: 'decide', decided: 500 }))).toContain('500 of 52,120 books decided');
  });
  it('shows the gate per field and the books with every field right', () => {
    const g = ai({
      phase: 'done',
      gate: {
        passed: false,
        below: ['authors'],
        books: 789,
        notAsked: 0,
        all: group(789),
        the600: group(589),
        checkD: group(200)
      }
    });
    const rows = aiGateRows(g);
    expect(rows[0]).toMatchObject({ field: 'Title', below: false });
    expect(rows[0].confirmed).toBe('98.9 % of 190 confirmed right');
    expect(rows[1]).toMatchObject({ field: 'Authors', below: true });
    expect(aiBooksLine(g)).toBe(
      'Books with every field right, no review: the 600 95.0 % (589), check D 95.0 % (200)'
    );
  });
  it('asks before stage 4 writes, with the changes and the best guesses', () => {
    const c = turnOnOnlineSourcesCopy({ changes: 120000, unconfirmed: 9000 });
    expect(c.title).toBe('Write 120,000 changes from the online sources into Calibre?');
    expect(c.message.join(' ')).toContain('9,000 values are the best guess');
    expect(c.message.join(' ')).toContain('Format and edition are not written');
    expect(turnOnOnlineSourcesCopy({ changes: null, unconfirmed: null }).title).toBe(
      'Write the changes from the online sources into Calibre?'
    );
  });
});

describe("the AI check's progress bar (WP20e follow-up)", () => {
  const base = {
    phase: 'models' as const,
    items: 52120,
    labeledItems: 789,
    decided: 0,
    answers: null,
    wait: null,
    costUsd: 1,
    invented: 0,
    flaggedAgainstRules: null,
    gate: null,
    error: null,
    finishedAt: null
  };
  it('shows the answers in, the share and the time left', () => {
    const b = aiBar({
      ...base,
      bar: { phase: 'models', done: 26060, total: 104240, secondsLeft: 5400 }
    });
    expect(b).toEqual({
      label: 'Asking both models: 26,060 of 104,240 answers in',
      fraction: 0.25,
      eta: 'about 1 h 30 min left (estimate)'
    });
  });
  it('says nothing about time until a rate is measured, and has no bar when done', () => {
    expect(
      aiBar({ ...base, bar: { phase: 'decide', done: 0, total: 52120, secondsLeft: null } })?.eta
    ).toBeNull();
    expect(aiBar({ ...base, phase: 'done', bar: null })).toBeNull();
  });
  it('counts steps for the series order and the gate, books for deciding', () => {
    expect(
      aiBar({ ...base, bar: { phase: 'series', done: 41810, total: 83620, secondsLeft: null } })
        ?.label
    ).toBe('Putting each series in order: 41,810 of 83,620 steps');
    expect(
      aiBar({ ...base, bar: { phase: 'gate', done: 300, total: 794, secondsLeft: 2 } })?.label
    ).toBe('Checking the labeled books: 300 of 794 steps');
    expect(
      aiBar({ ...base, bar: { phase: 'decide', done: 10, total: 52120, secondsLeft: null } })?.label
    ).toBe('Deciding every field: 10 of 52,120 books');
  });
});

describe("stage 4 On's progress bar (WP20e)", () => {
  const w = (done: number, total: number, secondsLeft: number | null) => ({
    books: { done: Math.round(done / 4) },
    changes: { done, total },
    secondsLeft,
    batches: 3
  });
  it('shows changes written of all, the books written and the time left while On', () => {
    expect(writeBar(w(6000, 206_140, 7200), 'on')).toEqual({
      label: 'Writing to Calibre: 6,000 of 206,140 changes · 1,500 books written',
      fraction: 6000 / 206_140,
      eta: 'about 2 h left (estimate)'
    });
    expect(writeBar(w(0, 206_140, null), 'on')?.eta).toBeNull();
  });
  it('is a plain line when done or stopped, as the other stages show their results', () => {
    // Done: no bar, the totals as a line.
    expect(writeBar(w(206_140, 206_140, 0), 'on')).toBeNull();
    expect(writtenLine(w(206_140, 206_140, 0), 'on')).toBe(
      'Written to Calibre: 206,140 changes in 51,535 books'
    );
    // Stopped part way (Preview): no bar, how far it got.
    expect(writeBar(w(6000, 206_140, 7200), 'analyse')).toBeNull();
    expect(writtenLine(w(6000, 206_140, 7200), 'analyse')).toBe(
      'Written to Calibre: 6,000 of 206,140 changes in 1,500 books'
    );
    // While writing: the bar, no line; nothing written: neither.
    expect(writtenLine(w(6000, 206_140, 7200), 'on')).toBeNull();
    expect(writtenLine(w(0, 206_140, null), 'analyse')).toBeNull();
    expect(writeBar(null, 'on')).toBeNull();
  });
});
