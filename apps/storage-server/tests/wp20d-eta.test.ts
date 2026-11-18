/**
 * WP20d: stage 4's time left (src/cleanup/stage4/eta.ts). The requests still to come come from
 * requests per book (the reference run's, then this run's labeled books'), each site at its
 * measured pace, the slowest site sets the lookups, Amazon's shared slot counts both queues.
 */
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_PER_BOOK,
  stage4Eta,
  type EtaInput,
  type SiteCounts,
} from '../src/cleanup/stage4/eta';
import type { FetchSite } from '../src/cleanup/settings';

const site = (s: FetchSite, o: Partial<SiteCounts> = {}): SiteCounts => ({
  site: s,
  enabled: true,
  open: 0,
  finished: 0,
  secondsPerRequest: 5,
  labeledRequests: 0,
  ...o,
});

const base = (o: Partial<EtaInput> = {}): EtaInput => ({
  sites: [
    site('bookwalker', { open: 500, finished: 1000, secondsPerRequest: 5 }),
    site('ranobedb', { open: 50, finished: 2000, secondsPerRequest: 1 }),
    site('natively', { open: 49000, finished: 1000, secondsPerRequest: 5 }),
  ],
  booksTotal: 10_000,
  booksRead: 4_000,
  booksUnreadable: 0,
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
  it('counts the requests still to come from requests per book, the slowest site first', () => {
    const r = stage4Eta(base());
    // BookWalker: 2.58 x 10,000 = 25,800 expected, 1,000 finished: 24,800 x 5 s.
    expect(r.sites.bookwalker).toBe(
      Math.round((REFERENCE_PER_BOOK.bookwalker! * 10_000 - 1000) * 5),
    );
    // RanobeDB: 2.15 x 10,000 - 2,000 = 19,500 x 1 s.
    expect(r.sites.ranobedb).toBe(19_500);
    // Natively has no requests per book: its queued sitemap pages.
    expect(r.sites.natively).toBe(49_000 * 5);
    expect(r.slowest).toEqual({ site: 'natively', seconds: 245_000 });
    expect(r.read).toBe(600);
    expect(r.final).toBe(200);
    expect(r.total).toBe(245_000 + 200);
    expect(r.basis).toBe('reference');
  });

  it("uses this run's labeled books once they are all proposed, and never less than the queue", () => {
    const r = stage4Eta(
      base({
        labeledDone: true,
        sites: [site('bookwalker', { open: 3000, finished: 1000, labeledRequests: 400 })],
      }),
    );
    // 400 / 800 = 0.5 per book: 5,000 expected - 1,000 finished = 4,000 (more than the 3,000 queued).
    expect(r.sites.bookwalker).toBe(20_000);
    expect(r.basis).toBe('labeled');
    const q = stage4Eta(
      base({
        labeledDone: true,
        sites: [site('bookwalker', { open: 6000, finished: 1000, labeledRequests: 400 })],
      }),
    );
    expect(q.sites.bookwalker).toBe(30_000);
  });

  it("counts Amazon's two queues together while they share one slot", () => {
    const sites = [
      site('amazon-dp', { finished: 0, secondsPerRequest: 8 }),
      site('amazon-search', { finished: 0, secondsPerRequest: 8 }),
    ];
    const shared = stage4Eta(base({ sites, amazonShared: true }));
    expect(shared.slowest?.site).toBe('amazon');
    expect(shared.slowest?.seconds).toBe(Math.round((1.02 + 0.82) * 10_000 * 8));
    const separate = stage4Eta(base({ sites, amazonShared: false }));
    expect(separate.slowest).toEqual({ site: 'amazon-dp', seconds: 1.02 * 10_000 * 8 });
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
