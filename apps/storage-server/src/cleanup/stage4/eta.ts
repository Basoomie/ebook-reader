/**
 * Stage 4's time left (WP20d): the reading, every site's lookups and the final pass.
 *
 * A book's requests are queued one step at a time (a search, then the book it picked, then its
 * series), so a site's queue never holds the whole run's requests. The requests still to come
 * are estimated from requests per book: the reference run's (measured on the same 800 labeled
 * books, plan section 8) until this run's labeled books are all proposed, then this run's own
 * on them. Shared pages (a series page used by many volumes) are asked once, so at the
 * library's size the estimate is an upper bound. Each site's time is what is left times its
 * measured seconds per request; the sites run side by side, so the lookups take as long as the
 * slowest one. Amazon's two queues count together while they share one slot.
 */
import type { FetchSite } from '../settings';

/** Requests per book in the reference run (source-probe/out3/log.jsonl, 800 books). */
export const REFERENCE_PER_BOOK: Partial<Record<FetchSite, number>> = {
  // Amazon only where needed (bw-standin.ts): measured on the same 800 books, with books whose
  // file cover is small asking Amazon too (was 1.02 product pages and 0.82 searches).
  'amazon-dp': 0.6,
  'amazon-search': 0.33,
  ranobedb: 2.15,
  bookwalker: 2.58,
  // Bookmeter: its search, then the matched book's store list (plan section 8).
  bookmeter: 2,
  // Covers only for books whose own cover is small or missing (~5,000 of 52,000).
  'amazon-img': 0.1,
};

export interface SiteCounts {
  site: FetchSite;
  enabled: boolean;
  /** Requests waiting or in flight now. */
  open: number;
  /** Requests finished (answered, gone or given up). */
  finished: number;
  /** Measured seconds from one request to the next (the interval when nothing is measured yet). */
  secondsPerRequest: number;
  /** This run's labeled requests (counted when the labeled books are all proposed). */
  labeledRequests: number;
}

export interface EtaInput {
  sites: SiteCounts[];
  /** Books with an EPUB (the read's total) and how many are read so far (errors included). */
  booksTotal: number;
  booksRead: number;
  /** Books that couldn't be read: they have no lookups. */
  booksUnreadable: number;
  /** Books read per second, measured (null while not measured yet). */
  readPerSecond: number | null;
  /** The labeled books, and whether they are all proposed (then their own ratios count). */
  labeledBooks: number;
  labeledDone: boolean;
  amazonShared: boolean;
  /** Author names waiting for NDL, its batch size and seconds per query. */
  ndlNames: number;
  ndlBatch: number;
  ndlSecondsPerQuery: number;
  /** Books still to propose in the final pass, and the measured ms per proposed book. */
  finalBooks: number;
  msPerProposal: number | null;
}

export interface EtaResult {
  /** Seconds left reading the files (0 when read; null while not measured). */
  read: number | null;
  /** Seconds left per site (its own queue plus the requests still to come). */
  sites: Partial<Record<FetchSite, number>>;
  /** The slowest site (or Amazon's shared slot) and its seconds. */
  slowest: { site: string; seconds: number } | null;
  /** The final pass (identifiers and readings for every book). */
  final: number | null;
  /** All of it: reading, then the slowest site, then the final pass (null while unknown). */
  total: number | null;
  /** Where the requests per book come from. */
  basis: 'labeled' | 'reference';
}

export function stage4Eta(i: EtaInput): EtaResult {
  const basis = i.labeledDone && i.labeledBooks > 0 ? 'labeled' : 'reference';
  const books = Math.max(0, i.booksTotal - i.booksUnreadable);
  const sites: Partial<Record<FetchSite, number>> = {};
  const left: Partial<Record<FetchSite, number>> = {};
  for (const s of i.sites) {
    if (!s.enabled) continue;
    const perBook =
      basis === 'labeled' ? s.labeledRequests / i.labeledBooks : (REFERENCE_PER_BOOK[s.site] ?? 0);
    const expected = perBook * books;
    // Never less than what is queued now.
    left[s.site] = Math.max(s.open, expected - s.finished);
    sites[s.site] = Math.round(left[s.site]! * s.secondsPerRequest);
  }
  const ndl = Math.ceil(i.ndlNames / Math.max(1, i.ndlBatch)) * i.ndlSecondsPerQuery;
  if (ndl > 0) sites.ndl = Math.round(ndl + (sites.ndl ?? 0));
  const candidates: { site: string; seconds: number }[] = Object.entries(sites).map(
    ([site, seconds]) => ({ site, seconds: seconds! }),
  );
  if (i.amazonShared) {
    const dp = i.sites.find((s) => s.site === 'amazon-dp');
    const search = i.sites.find((s) => s.site === 'amazon-search');
    if (dp?.enabled && search?.enabled) {
      // One slot for both: the slot's pace times both queues' requests.
      const pace = Math.max(dp.secondsPerRequest, search.secondsPerRequest);
      candidates.push({
        site: 'amazon',
        seconds: Math.round(((left['amazon-dp'] ?? 0) + (left['amazon-search'] ?? 0)) * pace),
      });
    }
  }
  const slowest = candidates.length
    ? candidates.reduce((a, b) => (b.seconds > a.seconds ? b : a))
    : null;
  const unread = Math.max(0, i.booksTotal - i.booksRead);
  const read = unread === 0 ? 0 : i.readPerSecond ? Math.round(unread / i.readPerSecond) : null;
  const final =
    i.msPerProposal === null ? null : Math.round((i.finalBooks * i.msPerProposal) / 1000);
  // Lookups start as books are read, so the reading only adds where it outlasts the sites.
  const total =
    read === null || final === null ? null : Math.max(read, slowest?.seconds ?? 0) + final;
  return { read, sites, slowest, final, total, basis };
}
