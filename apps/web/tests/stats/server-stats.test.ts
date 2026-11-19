/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { buildServerStats, serverStatsOutput } from '../../scripts/server-stats/build';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { statEntriesFromRecords } from '$lib/stats/aggregate';
import { changeLine, type SummaryKey } from '$lib/stats/period-compare';
import { buildStatsView, type StatsBookInfo, type StatsSummary } from '$lib/stats/stats-view';
import type { StatsPeriod } from '$lib/stats/periods';
import { bookStatesFrom } from '$lib/sync/book-state';
import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * Notifications N2: the storage server's stats messages use a bundle of this app's Stats
 * code (apps/storage-server/vendor/stats.cjs). These tests prove the bundle is current, that
 * it gives the source's results under plain CommonJS Node, and that the shared parity
 * fixture (also run by the server's own tests against its database) holds the source's
 * results.
 */
const lf = (s: string) => s.replace(/\r\n/g, '\n');

interface Fixture {
  books: { id: string; charCount: number }[];
  records: LocalRecord[];
  cases: { weekStart: number; period: StatsPeriod; summary: StatsSummary }[];
}

const fixturePath = path.resolve(
  serverStatsOutput,
  '..',
  '..',
  'tests',
  'fixtures',
  'stats-parity.json'
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

function sourceSummaries(f: Fixture): StatsSummary[] {
  const entries = statEntriesFromRecords(f.records.filter((r) => r.kind !== 'read-through'));
  const readThroughs = new Map(
    [...bookStatesFrom(f.records.filter((r) => r.kind === 'read-through'))].map(([id, s]) => [
      id,
      s.readThroughs
    ])
  );
  const books = new Map<string, StatsBookInfo>(
    f.books.map((b) => [
      b.id,
      { title: 't', libraryId: 'lib1', missing: false, charCount: b.charCount }
    ])
  );
  return f.cases.map(
    (c) =>
      buildStatsView({
        entries,
        readThroughs,
        books,
        filter: { device: null, library: null, book: null },
        period: c.period
      }).summary
  );
}

describe('server stats bundle', () => {
  it('is up to date with the Stats code (run `pnpm build:server-stats`)', async () => {
    const { code } = await buildServerStats();

    expect(
      lf(readFileSync(serverStatsOutput, 'utf8')) === lf(code),
      'apps/storage-server/vendor/stats.cjs is stale: run `pnpm build:server-stats` in apps/web'
    ).toBe(true);
  });

  it('the parity fixture holds the Stats page source results', () => {
    expect(sourceSummaries(fixture)).toEqual(fixture.cases.map((c) => c.summary));
    // The fixture exercises every rule it is there for.
    const all = fixture.cases.map((c) => c.summary);
    expect(all.some((s) => s.manualChars > 0)).toBe(true);
    expect(all.some((s) => s.chars === 0 && s.seconds === 0 && s.lookups === 0)).toBe(true);
    expect(fixture.records.some((r) => r.kind === 'stat-session-fix')).toBe(true);
    expect(fixture.records.some((r) => r.kind === 'stat-day')).toBe(true);
  });

  it('gives the source results when run by plain Node', () => {
    const script = `
      const s = require(process.argv[1]);
      const f = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
      const entries = s.statEntriesFromRecords(f.records.filter((r) => r.kind !== 'read-through'));
      const rts = new Map([...s.bookStatesFrom(f.records.filter((r) => r.kind === 'read-through'))]
        .map(([id, st]) => [id, st.readThroughs]));
      const books = new Map(f.books.map((b) => [b.id, { title: 't', libraryId: 'lib1', missing: false, charCount: b.charCount }]));
      const out = f.cases.map((c) => s.buildStatsView({ entries, readThroughs: rts, books,
        filter: { device: null, library: null, book: null }, period: c.period }).summary);
      const keys = ['seconds', 'chars', 'speed', 'lookups'];
      const lines = keys.map((k) => s.changeLine(k, out[1], out[0], 'X'));
      const periods = f.cases.map((c) => [s.periodLabel(c.period), s.periodToParam(c.period),
        s.stepPeriod(c.period, -1, c.weekStart)]);
      process.stdout.write(JSON.stringify({ out, lines, periods,
        fmt: [s.formatNumber(1234567), s.formatDuration(3725)] }));
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ['-e', script, serverStatsOutput, fixturePath], {
        encoding: 'utf8'
      })
    );
    const source = sourceSummaries(fixture);

    expect(result.out).toEqual(source);
    expect(result.lines).toEqual(
      (['seconds', 'chars', 'speed', 'lookups'] as SummaryKey[]).map((k) =>
        changeLine(k, source[1], source[0], 'X')
      )
    );
    expect(result.fmt).toEqual(['1,234,567', '1 h 02 min']);
    expect(result.periods.length).toBe(fixture.cases.length);
  });
});
