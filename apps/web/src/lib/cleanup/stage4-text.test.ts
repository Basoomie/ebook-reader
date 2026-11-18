/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import type { Stage4Gate, Stage4Site, Stage4Status } from './cleanup-api';
import {
  booksLine,
  duration,
  gateRows,
  readingLine,
  readingsLine,
  siteLine,
  timeLeftLine,
  sourceName,
  valueText
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
        basis: 'reference'
      }
    } as unknown as Stage4Status;
    expect(booksLine(reading)).toBe(
      '1,600 of 52,164 books looked up · 400 waiting for the sites · 2 couldn’t be read'
    );
    expect(readingLine(reading)).toBe(
      'Reading the files: 2,002 of 52,164 · 9.3 books a second · about 1 h 30 min left'
    );
    expect(timeLeftLine(reading)).toBe(
      'Time left for the whole Preview: about 7 days 23 h · the slowest site is BOOK☆WALKER, about 7 days 23 h · then the final pass, about 15 min · requests per book from the reference run until the labeled books are done; shared series pages make it an upper bound'
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
