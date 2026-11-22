/**
 * WP20d: stage 4's time left (src/cleanup/stage4/eta.ts). The requests still to come: the open
 * ones, their next steps at the rates measured on this run's answers, and requests per book (the
 * reference run's, then this run's labeled books') for the books not started yet; each site at
 * its measured pace, the slowest site sets the lookups, Amazon's shared slot counts both queues.
 */
import { describe, expect, it } from 'vitest';
import { gzipSync } from 'zlib';
import { initCleanupDatabase } from '../src/cleanup/cleanup-db';
import { makeTempDir } from './helpers/spawn-server';
import {
  MIN_FOLLOW_UP_ANSWERS,
  openLookups,
  paceSeconds,
  REFERENCE_PER_BOOK,
  stage4Eta,
  type EtaInput,
  type FollowUps,
  type SiteCounts,
} from '../src/cleanup/stage4/eta';
import type { FetchSite } from '../src/cleanup/settings';

const site = (s: FetchSite, o: Partial<SiteCounts> = {}): SiteCounts => ({
  site: s,
  enabled: true,
  open: 0,
  secondsPerRequest: 5,
  labeledRequests: 0,
  ...o,
});

const base = (o: Partial<EtaInput> = {}): EtaInput => ({
  sites: [
    site('bookwalker', { open: 500, secondsPerRequest: 5 }),
    site('ranobedb', { open: 50, secondsPerRequest: 1 }),
    site('natively', { open: 49000, secondsPerRequest: 5 }),
  ],
  booksTotal: 10_000,
  booksRead: 4_000,
  booksUnreadable: 0,
  booksStarted: 1_000,
  open: { steps: {}, undecided: 0, coreOpen: 0 },
  followUps: null,
  readPerSecond: 10,
  labeledBooks: 800,
  labeledDone: false,
  amazonShared: false,
  ndlNames: 0,
  ndlBatch: 50,
  ndlSecondsPerQuery: 30,
  finalBooks: 10_000,
  msPerProposal: 20,
  ...o,
});

describe('stage 4 time left', () => {
  it('counts the books not started yet at requests per book, the slowest site first', () => {
    const r = stage4Eta(base());
    // BookWalker: 500 queued + 2.58 x 9,000 books not started, x 5 s.
    expect(r.sites.bookwalker).toBe(Math.round((500 + REFERENCE_PER_BOOK.bookwalker! * 9_000) * 5));
    // RanobeDB: 50 + 2.15 x 9,000 = 19,400 x 1 s.
    expect(r.sites.ranobedb).toBe(19_400);
    // Natively has no requests per book: its queued sitemap pages.
    expect(r.sites.natively).toBe(49_000 * 5);
    expect(r.slowest).toEqual({ site: 'natively', seconds: 245_000 });
    expect(r.read).toBe(600);
    expect(r.final).toBe(200);
    expect(r.total).toBe(245_000 + 200);
    expect(r.basis).toBe('reference');
    expect(r.notStarted).toBe(9_000);
    expect(r.followUps).toBe('none');
  });

  it("uses this run's labeled books once they are all proposed", () => {
    const r = stage4Eta(
      base({
        labeledDone: true,
        sites: [site('bookwalker', { open: 3000, labeledRequests: 400 })],
      }),
    );
    // 400 / 800 = 0.5 per book: 3,000 queued + 0.5 x 9,000 not started = 7,500 x 5 s.
    expect(r.sites.bookwalker).toBe(37_500);
    expect(r.basis).toBe('labeled');
    // Amazon's queues keep the measured requests per book (their rules changed mid-run).
    const a = stage4Eta(
      base({
        labeledDone: true,
        amazonShared: false,
        sites: [site('amazon-dp', { labeledRequests: 1600 })],
      }),
    );
    expect(a.sites['amazon-dp']).toBe(Math.round(REFERENCE_PER_BOOK['amazon-dp']! * 9_000 * 5));
  });

  it("counts Amazon's two queues together while they share one slot", () => {
    const sites = [
      site('amazon-dp', { secondsPerRequest: 8 }),
      site('amazon-search', { secondsPerRequest: 8 }),
    ];
    const shared = stage4Eta(base({ sites, amazonShared: true, booksStarted: 0 }));
    expect(shared.slowest?.site).toBe('amazon');
    expect(shared.slowest?.seconds).toBe(
      Math.round(
        (REFERENCE_PER_BOOK['amazon-dp']! + REFERENCE_PER_BOOK['amazon-search']!) * 10_000 * 8,
      ),
    );
    const separate = stage4Eta(base({ sites, amazonShared: false, booksStarted: 0 }));
    expect(separate.slowest).toEqual({
      site: 'amazon-dp',
      seconds: Math.round(REFERENCE_PER_BOOK['amazon-dp']! * 10_000 * 8),
    });
  });

  it("uses the shared slot's measured pace, not one queue's (each takes every other turn)", () => {
    // Found live 2026-11-18: each queue's own gap was 40 s in a 20 s slot; the slot's mean gap
    // over both queues (refusal waits included) is what Amazon really allows.
    const sites = [
      site('amazon-dp', { secondsPerRequest: 40 }),
      site('amazon-search', { secondsPerRequest: 40 }),
    ];
    const r = stage4Eta(
      base({ sites, amazonShared: true, amazonSlotSeconds: 30, booksStarted: 0 }),
    );
    const per = REFERENCE_PER_BOOK['amazon-dp']! + REFERENCE_PER_BOOK['amazon-search']!;
    expect(r.slowest).toEqual({ site: 'amazon', seconds: Math.round(per * 10_000 * 30) });
    // Without a measured slot: the faster queue's gap, never the slower one.
    const s2 = stage4Eta(
      base({
        sites: [sites[0], { ...sites[1], secondsPerRequest: 20 }],
        amazonShared: true,
        booksStarted: 0,
      }),
    );
    expect(s2.slowest?.seconds).toBe(Math.round(per * 10_000 * 20));
  });

  it('waits for a measured reading speed, and adds NDL and a switched-off site correctly', () => {
    const r = stage4Eta(
      base({
        readPerSecond: null,
        ndlNames: 120,
        sites: [site('bookwalker', { enabled: false, open: 9999 })],
      }),
    );
    expect(r.read).toBeNull();
    expect(r.total).toBeNull();
    expect(r.sites.bookwalker).toBeUndefined();
    expect(r.sites.ndl).toBe(3 * 30);
    // All read: no reading left.
    expect(stage4Eta(base({ booksRead: 10_000, readPerSecond: null })).read).toBe(0);
  });
});

describe('the open lookups’ next steps', () => {
  const measured = (answers: Record<string, number>, made: Record<string, number>): FollowUps => ({
    answers,
    made,
  });

  it('counts nothing for a site every book is past (found live 2026-11-20)', () => {
    // Every book started, BookWalker's queue empty: requests per book (2.44) counted 28,450
    // more (42 h at 5.4 s). Only Amazon's open requests and what follows them are left.
    const followUps = measured(
      { 'amazon-search': 1000, 'after-core': 2000, decide: 500 },
      {
        'amazon-search>amazon-dp': 550,
        'after-core>bookmeter-stores': 1200,
        'after-core>cover': 100,
        'decide>amazon-search': 300,
        'decide>amazon-dp': 200,
      },
    );
    const r = stage4Eta(
      base({
        booksTotal: 52_164,
        booksUnreadable: 44,
        booksStarted: 52_120,
        labeledDone: true,
        sites: [
          site('bookwalker', { open: 0, secondsPerRequest: 5.4, labeledRequests: 1925 }),
          site('ranobedb', { open: 0, secondsPerRequest: 1, labeledRequests: 1700 }),
          site('bookmeter', { open: 2, secondsPerRequest: 1.5, labeledRequests: 1600 }),
          site('amazon-dp', { open: 16_421, secondsPerRequest: 2.1 }),
          site('amazon-search', { open: 2_778, secondsPerRequest: 2.1 }),
          site('amazon-img', { open: 0, secondsPerRequest: 2.5 }),
        ],
        open: {
          steps: { 'amazon-dp': 16_421, 'amazon-search': 2_778, 'bookmeter-stores': 2 },
          undecided: 0,
          coreOpen: 19_199,
        },
        followUps,
      }),
    );
    expect(r.sites.bookwalker).toBe(0);
    expect(r.sites.ranobedb).toBe(0);
    // Each open search leads to a product page 55 % of the time.
    expect(r.sites['amazon-search']).toBe(Math.round(2_778 * 2.1));
    expect(r.sites['amazon-dp']).toBe(Math.round((16_421 + 2_778 * 0.55) * 2.1));
    // Every book with a core lookup open still gets its store list (60 %) and cover (5 %).
    expect(r.sites.bookmeter).toBe(Math.round((2 + 19_199 * 0.6) * 1.5));
    expect(r.sites['amazon-img']).toBe(Math.round(19_199 * 0.05 * 2.5));
    expect(r.notStarted).toBe(0);
    expect(r.followUps).toBe('measured');
  });

  it('counts each possible next step once until a step has enough answers (an upper bound)', () => {
    const few = measured({ 'ranobedb-search': MIN_FOLLOW_UP_ANSWERS - 1 }, {});
    const input = {
      booksStarted: 10_000,
      sites: [site('ranobedb', { open: 100, secondsPerRequest: 1 })],
      open: { steps: { 'ranobedb-search': 100 }, undecided: 0, coreOpen: 0 },
    };
    const r = stage4Eta(base({ ...input, followUps: few }));
    // The search, then at most its book, then at most the book's series: 100 + 100 x 2.
    expect(r.sites.ranobedb).toBe(300);
    expect(r.followUps).toBe('bound');
    // Measured: 40 % find a book, 30 % of the books a series.
    const m = stage4Eta(
      base({
        ...input,
        followUps: measured(
          { 'ranobedb-search': 1000, 'ranobedb-book': 400 },
          { 'ranobedb-search>ranobedb-book': 400, 'ranobedb-book>ranobedb-series': 120 },
        ),
      }),
    );
    expect(m.sites.ranobedb).toBe(Math.round(100 + 100 * 0.4 * (1 + 0.3)));
    expect(m.followUps).toBe('measured');
  });

  it("asks BookWalker's search again once at most, and counts the Amazon decision to come", () => {
    const r = stage4Eta(
      base({
        booksStarted: 10_000,
        amazonShared: false,
        sites: [
          site('bookwalker', { open: 10, secondsPerRequest: 1 }),
          site('amazon-dp', { open: 0, secondsPerRequest: 1 }),
          site('amazon-search', { open: 0, secondsPerRequest: 1 }),
        ],
        open: { steps: { 'bookwalker-search': 10 }, undecided: 10, coreOpen: 10 },
        followUps: measured(
          { 'bookwalker-search': 100, 'bookwalker-series': 50, decide: 100, 'amazon-search': 100 },
          {
            'bookwalker-search>bookwalker-search': 10,
            'bookwalker-search>bookwalker-series': 20,
            'bookwalker-search>bookwalker-detail': 50,
            'bookwalker-series>bookwalker-detail': 40,
            'decide>amazon-dp': 30,
            'decide>amazon-search': 50,
            'amazon-search>amazon-dp': 60,
          },
        ),
      }),
    );
    // One search's next steps without the second search: 0.2 x (1 + 0.8) + 0.5 = 0.86; with it
    // once: 0.1 x (1 + 0.86) + 0.86 = 1.046 per open search.
    expect(r.sites.bookwalker).toBe(Math.round(10 + 10 * 1.046));
    // Each undecided book: 0.5 searches, 0.3 + 0.5 x 0.6 product pages.
    expect(r.sites['amazon-search']).toBe(5);
    expect(r.sites['amazon-dp']).toBe(6);
    // The store list and cover after the core sites: not measured yet, an upper bound.
    expect(r.followUps).toBe('bound');
  });
});

describe('a site’s pace', () => {
  const IDLE = 960_000;
  // Newest first: request k asked at at[k], made at created[k].
  const rows = (ats: number[], created: (at: number, k: number) => number) =>
    ats.map((at, k) => ({ at, created: created(at, k) }));

  it('counts only gaps across which a request was waiting', () => {
    // Cover pictures: each made 1 s before it is asked, 200 s apart (live 2026-11-18). No
    // request waited across any gap: not measured (the set pace is used), not 200 s.
    const trickle = rows(
      Array.from({ length: 40 }, (_, k) => 1e9 - k * 200_000),
      (at) => at - 1000,
    );
    expect(paceSeconds(trickle, () => null, IDLE)).toBeNull();
    // A queue with work waiting: 5 s apart, one refusal wait of 300 s counted (work waited).
    const ats = Array.from({ length: 40 }, (_, k) => 1e9 - k * 5000 - (k > 20 ? 295_000 : 0));
    const busy = rows(ats, () => 0);
    expect(paceSeconds(busy, () => null, IDLE)).toBeCloseTo((39 * 5 + 295) / 39, 5);
    // A gap longer than the longest refusal wait (fetcher offline) is left out.
    const off = rows(
      Array.from({ length: 40 }, (_, k) => 1e9 - k * 5000 - (k > 20 ? 2_000_000 : 0)),
      () => 0,
    );
    expect(paceSeconds(off, () => null, IDLE)).toBeCloseTo(5, 5);
  });

  it('counts a gap when an older request is still open, or one asked later was made before', () => {
    // A search's product page is made after the search was asked, but older work waited.
    const ats = Array.from({ length: 30 }, (_, k) => 1e9 - k * 20_000);
    const r = rows(ats, (at) => at - 100);
    expect(paceSeconds(r, () => 0, IDLE)).toBeCloseTo(20, 5);
    // Every second request made long before: each gap is spanned by one of them.
    const mixed = rows(ats, (at, k) => (k % 2 ? 0 : at - 100));
    expect(paceSeconds(mixed, () => null, IDLE)).toBeCloseTo(20, 5);
  });
});

describe('the open lookups', () => {
  it('a book whose Amazon lookup was asked has no Amazon decision to come', () => {
    const s = initCleanupDatabase(makeTempDir('wp20e-eta-open'));
    if (!s.ok) throw new Error(s.error);
    const db = s.db;
    const now = Date.now();
    const req = db
      .prepare(
        `INSERT INTO fetch_requests (site, key, method, url, priority, state, created_at, updated_at)
         VALUES ('bookwalker', ?, 'GET', ?, 0, 'queued', ?, ?)`,
      )
      .run('k', 'https://bookwalker.jp/dex/', now, now).lastInsertRowid;
    for (const [uuid, asked] of [
      ['asked', true],
      ['not-asked', false],
    ] as const) {
      db.prepare(
        `INSERT INTO fetch_waiters (request_id, library_id, calibre_uuid, step, ready) VALUES (?, 'L', ?, 'bookwalker-detail', 0)`,
      ).run(req, uuid);
      db.prepare(
        `INSERT INTO evidence_records (library_id, calibre_uuid, kind, version, data, created_at) VALUES ('L', ?, 'online', 1, ?, ?)`,
      ).run(uuid, gzipSync(Buffer.from(JSON.stringify({ amazon: { asked } }))), now);
    }
    const o = openLookups(db);
    expect(o.steps['bookwalker-detail']).toBe(2);
    expect(o.undecided).toBe(1);
    expect(o.coreOpen).toBe(2);
  });
});
