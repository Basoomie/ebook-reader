/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  listingsBar,
  listingsLines,
  listingsSpotLine,
  registeredText,
  type ListingsStatus
} from './listings-text';

function status(over: Partial<ListingsStatus> = {}): ListingsStatus {
  return {
    mode: 'analyse',
    pausedReason: null,
    pausedDetail: null,
    stage4Done: true,
    progress: {
      run: 1,
      phase: 'search',
      books: 40775,
      search: { looked: 0, asked: 0, answered: 0, enqueued: false, failed: 0 },
      propose: { total: 0, done: 0, proposed: 0, held: 0, yours: 0, gone: 0 },
      spot: { drawnAt: null, size: 0 },
      write: { rebuilt: false, batches: [], waiting: null },
      labeled: null,
      finishedAt: null
    },
    bar: { phase: 'search', done: 0, total: 40775, leftMs: null },
    books: {},
    proposals: {},
    spot: { size: 0, right: 0, wrong: 0, open: 0 },
    spotPassed: false,
    spotSize: 50,
    siteWait: null,
    ...over
  };
}

describe('Bookmeter links: the card', () => {
  it('names the step: queuing first, then the searches with the time left', () => {
    expect(listingsBar(status())?.label).toBe('Step 1 of 2: Queuing the searches (0 of 40,775)');
    const s = status();
    const b = listingsBar({
      ...s,
      progress: { ...s.progress, search: { ...s.progress.search, enqueued: true } },
      bar: { phase: 'search', done: 1200, total: 36000, leftMs: 3_600_000 }
    });
    expect(b?.label).toBe('Step 1 of 2: Searching 読書メーター again (1,200 of 36,000)');
    expect(b?.eta).toBeTruthy();
    expect(listingsBar(status({ mode: 'off' }))).toBeNull();
  });

  it('says what was decided and what is left alone', () => {
    const s = status({
      books: { change: 1700, keep: 30000, adaptation: 3, unseen: 12, ai: 4150, yours: 2 },
      proposals: { proposed: 1690, applied: 0 }
    });
    const lines = listingsLines({
      ...s,
      progress: {
        ...s.progress,
        search: { looked: 40775, asked: 36000, answered: 36000, enqueued: true, failed: 4 }
      }
    });
    expect(lines).toContain(
      'Looked at 40,775 of 40,775 books with a saved link; 36,000 searched again, 36,000 answered (4 failed: decided from the earlier searches).'
    );
    expect(lines).toContain(
      'Decided: 1,700 to change, 30,000 already the listing most readers registered, 3 saved to a comic or an adaptation, 12 whose saved listing the searches did not show.'
    );
    expect(lines).toContain(
      'Left alone: 4,150 the AI check matched, 2 with store links you edited.'
    );
    expect(lines).toContain('Links: 1,690 to write, 0 written.');
  });

  it('says what the spot check needs', () => {
    expect(listingsSpotLine(status())).toBe('');
    expect(listingsSpotLine(status({ spot: { size: 50, right: 49, wrong: 1, open: 0 } }))).toMatch(
      /A wrong change was found/
    );
    expect(listingsSpotLine(status({ spot: { size: 50, right: 50, wrong: 0, open: 0 } }))).toMatch(
      /Passed: On can be switched on/
    );
  });

  it('shows a listing’s reader count', () => {
    expect(registeredText({ id: '1', url: '', registrations: 1234 })).toBe('1,234 registered');
    expect(registeredText({ id: '1', url: '', registrations: null })).toBe(
      'registered count not shown'
    );
  });
});
