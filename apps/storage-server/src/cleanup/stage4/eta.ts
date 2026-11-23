/**
 * Stage 4's time left (WP20d): the reading, every site's lookups and the final pass.
 *
 * A book's requests are queued one step at a time (a search, then the book it picked, then its
 * series), so a site's queue never holds the whole run's requests. The requests still to come
 * are the open ones, plus what their next steps will ask, plus requests per book for the books
 * whose lookups haven't started yet:
 * - each open lookup (a request waiting or in flight, or an answer not handled yet) leads to
 *   its step's next steps, at the rate measured on this run's answers of that step (new
 *   requests only: a series page another volume already asked costs nothing). Until a step has
 *   MIN_FOLLOW_UP_ANSWERS answers, each possible next step counts once (an upper bound);
 * - a book whose BookWalker or RanobeDB lookup is open still has its Amazon decision to come,
 *   and a book with any core lookup open its Bookmeter store list and cover, each at the rate
 *   measured on this run's decisions;
 * - a book not started yet asks requests per book: the reference run's (measured on the same 800
 *   labeled books, plan section 8) until this run's labeled books are all proposed, then this
 *   run's own on them.
 * Found live 2026-11-20: requests per book applied to every book counted 28,450 BookWalker
 * requests (42 h) with BookWalker's queue empty and every book past it.
 * Each site's time is what is left times its measured seconds per request; the sites run side by
 * side, so the lookups take as long as the slowest one. Amazon's two queues count together while
 * they share one slot.
 */
import type Database from 'better-sqlite3';
import { gunzipSync } from 'zlib';
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

/**
 * Seconds per request from a site's (or Amazon's shared slot's) last requests, newest first:
 * the mean gap, counting only gaps across which a request was already waiting (made before the
 * earlier request and asked at or after the later one, or still open now). A queue that runs
 * dry between requests (cover pictures, asked for a few books) shows how often work arrives,
 * not how fast the site answers: found live 2026-11-18, 216 s per cover picture against a 5 s
 * pace, 13 days. Refusal waits count (work was waiting); gaps over `idleMs` don't (fetcher
 * offline, nightly stop). Null below 20 counted gaps.
 */
export function paceSeconds(
  rows: { at: number; created: number }[],
  openSince: () => number | null,
  idleMs: number,
): number | null {
  const gaps: number[] = [];
  let open: number | null | undefined;
  let waiting = Infinity; // the oldest creation among requests asked at or after rows[k]
  for (let k = 0; k + 1 < rows.length; k++) {
    waiting = Math.min(waiting, rows[k].created);
    const g = rows[k].at - rows[k + 1].at;
    if (g > idleMs) continue;
    let busy = waiting <= rows[k + 1].at;
    if (!busy) {
      if (open === undefined) open = openSince();
      busy = open !== null && open <= rows[k + 1].at;
    }
    if (busy) gaps.push(g);
  }
  return gaps.length >= 20 ? gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000 : null;
}

/**
 * Sites whose requests per book always come from REFERENCE_PER_BOOK: their rules changed while
 * the live run's labeled books were being looked up, so this run's labeled requests mix the old
 * rules' requests in (found live 2026-11-18: 1.28 Amazon requests per labeled book, 632 of them
 * made before "Amazon where needed", against 0.93 measured on the same 800 books with it).
 */
export const MEASURED_POLICY = new Set<FetchSite>(['amazon-dp', 'amazon-search']);

/**
 * Each lookup step's possible next steps (analysis.ts onAnswer; a BookWalker search is asked once
 * more after a "not found"), and the two book events that ask requests of their own: the Amazon
 * decision once BookWalker and RanobeDB have answered ('decide') and the store list and cover
 * once the core sites are through ('after-core').
 */
export const NEXT_STEPS: Record<string, string[]> = {
  'amazon-search': ['amazon-dp'],
  'amazon-dp': [],
  'ranobedb-search': ['ranobedb-book'],
  'ranobedb-book': ['ranobedb-series'],
  'ranobedb-series': [],
  'bookwalker-search': ['bookwalker-search', 'bookwalker-series', 'bookwalker-detail'],
  'bookwalker-series': ['bookwalker-detail'],
  'bookwalker-detail': [],
  'bookmeter-search': [],
  'bookmeter-stores': [],
  cover: [],
  decide: ['amazon-dp', 'amazon-search'],
  'after-core': ['bookmeter-stores', 'cover'],
};

/** The site each lookup step asks. */
export const STEP_SITE: Record<string, FetchSite> = {
  'amazon-search': 'amazon-search',
  'amazon-dp': 'amazon-dp',
  'ranobedb-search': 'ranobedb',
  'ranobedb-book': 'ranobedb',
  'ranobedb-series': 'ranobedb',
  'bookwalker-search': 'bookwalker',
  'bookwalker-series': 'bookwalker',
  'bookwalker-detail': 'bookwalker',
  'bookmeter-search': 'bookmeter',
  'bookmeter-stores': 'bookmeter',
  cover: 'amazon-img',
};

/** Answers of a step (or decisions) before its measured rate replaces the upper bound. */
export const MIN_FOLLOW_UP_ANSWERS = 30;

/**
 * This run's answers handled per step (and the decide / after-core events), and the new requests
 * each led to, per next step (key `from>to`). Kept in the stage's progress.
 */
export interface FollowUps {
  answers: Record<string, number>;
  made: Record<string, number>;
}

/** The lookups open now. */
export interface OpenLookups {
  /** Open lookups per step: waiting or in flight, or answered and not handled yet. */
  steps: Record<string, number>;
  /** Books whose BookWalker or RanobeDB lookup is open (their Amazon decision is still to come). */
  undecided: number;
  /** Books with a core lookup open (Amazon, RanobeDB, BookWalker, Bookmeter's search). */
  coreOpen: number;
}

type PerSite = Partial<Record<FetchSite, number>>;

/** New requests per site that one answer of `step` will still lead to, and whether a bound was used. */
function makeTails(f: FollowUps | null): (step: string) => { sites: PerSite; bound: boolean } {
  const memo = new Map<string, { sites: PerSite; bound: boolean }>();
  const tail = (step: string, skipSelf: boolean): { sites: PerSite; bound: boolean } => {
    const k = `${step}|${skipSelf}`;
    const hit = memo.get(k);
    if (hit) return hit;
    const sites: PerSite = {};
    let bound = false;
    const answers = f?.answers[step] ?? 0;
    for (const next of NEXT_STEPS[step] ?? []) {
      if (skipSelf && next === step) continue;
      let rate = 1;
      if (answers >= MIN_FOLLOW_UP_ANSWERS) rate = (f!.made[`${step}>${next}`] ?? 0) / answers;
      else bound = true;
      if (!rate) continue;
      const site = STEP_SITE[next];
      sites[site] = (sites[site] ?? 0) + rate;
      // A step asked again (BookWalker's second search) is asked once more at most.
      const sub = tail(next, next === step);
      bound ||= sub.bound;
      for (const [s, n] of Object.entries(sub.sites))
        sites[s as FetchSite] = (sites[s as FetchSite] ?? 0) + rate * n!;
    }
    const out = { sites, bound };
    memo.set(k, out);
    return out;
  };
  return (step) => tail(step, false);
}

export interface SiteCounts {
  site: FetchSite;
  enabled: boolean;
  /** Requests waiting or in flight now. */
  open: number;
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
  /** Books whose lookups have started (waiting, ready or proposed). */
  booksStarted: number;
  /** The lookups open now, and this run's measured follow-ups (null before any). */
  open: OpenLookups;
  followUps: FollowUps | null;
  /** Books read per second, measured (null while not measured yet). */
  readPerSecond: number | null;
  /** The labeled books, and whether they are all proposed (then their own ratios count). */
  labeledBooks: number;
  labeledDone: boolean;
  amazonShared: boolean;
  /** Measured seconds per request of Amazon's shared slot (both queues together), when known. */
  amazonSlotSeconds?: number | null;
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
  /** Amazon's shared slot: both queues' requests left at the slot's pace (null when separate). */
  amazonSlot: number | null;
  /** The slowest site (or Amazon's shared slot) and its seconds. */
  slowest: { site: string; seconds: number } | null;
  /** The final pass (identifiers and readings for every book). */
  final: number | null;
  /** All of it: reading, then the slowest site, then the final pass (null while unknown). */
  total: number | null;
  /** Books whose lookups haven't started (requests per book), and where that rate comes from. */
  notStarted: number;
  basis: 'labeled' | 'reference';
  /** The open lookups' next steps: measured on this run's answers, or an upper bound for a step
   * not measured yet ('none' when no lookup is open). */
  followUps: 'measured' | 'bound' | 'none';
}

export function stage4Eta(i: EtaInput): EtaResult {
  const basis = i.labeledDone && i.labeledBooks > 0 ? 'labeled' : 'reference';
  const books = Math.max(0, i.booksTotal - i.booksUnreadable);
  const notStarted = Math.max(0, books - i.booksStarted);
  // The requests the open lookups will still lead to, per site.
  const tailOf = makeTails(i.followUps);
  const coming: PerSite = {};
  let bound = false;
  let anyOpen = false;
  const add = (count: number, step: string) => {
    if (count <= 0) return;
    anyOpen = true;
    const t = tailOf(step);
    if (Object.keys(t.sites).length) bound ||= t.bound;
    for (const [s, n] of Object.entries(t.sites))
      coming[s as FetchSite] = (coming[s as FetchSite] ?? 0) + count * n!;
  };
  for (const [step, n] of Object.entries(i.open.steps)) if (STEP_SITE[step]) add(n, step);
  add(i.open.undecided, 'decide');
  add(i.open.coreOpen, 'after-core');
  const sites: Partial<Record<FetchSite, number>> = {};
  const left: Partial<Record<FetchSite, number>> = {};
  for (const s of i.sites) {
    if (!s.enabled) continue;
    const perBook =
      basis === 'labeled' && !MEASURED_POLICY.has(s.site)
        ? s.labeledRequests / i.labeledBooks
        : (REFERENCE_PER_BOOK[s.site] ?? 0);
    left[s.site] = s.open + (coming[s.site] ?? 0) + perBook * notStarted;
    sites[s.site] = Math.round(left[s.site]! * s.secondsPerRequest);
  }
  const ndl = Math.ceil(i.ndlNames / Math.max(1, i.ndlBatch)) * i.ndlSecondsPerQuery;
  if (ndl > 0) sites.ndl = Math.round(ndl + (sites.ndl ?? 0));
  const candidates: { site: string; seconds: number }[] = Object.entries(sites).map(
    ([site, seconds]) => ({ site, seconds: seconds! }),
  );
  let amazonSlot: number | null = null;
  if (i.amazonShared) {
    const dp = i.sites.find((s) => s.site === 'amazon-dp');
    const search = i.sites.find((s) => s.site === 'amazon-search');
    if (dp?.enabled && search?.enabled) {
      // One slot for both: the slot's pace times both queues' requests. Each queue alone takes
      // every other turn, so its own gap is twice the slot's.
      const pace = i.amazonSlotSeconds ?? Math.min(dp.secondsPerRequest, search.secondsPerRequest);
      // The shared slot replaces the two queues' own figures (each is every other turn).
      for (let k = candidates.length - 1; k >= 0; k--)
        if (candidates[k].site === 'amazon-dp' || candidates[k].site === 'amazon-search')
          candidates.splice(k, 1);
      amazonSlot = Math.round(((left['amazon-dp'] ?? 0) + (left['amazon-search'] ?? 0)) * pace);
      candidates.push({ site: 'amazon', seconds: amazonSlot });
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
  return {
    read,
    sites,
    amazonSlot,
    slowest,
    final,
    total,
    notStarted,
    basis,
    followUps: anyOpen ? (bound ? 'bound' : 'measured') : 'none',
  };
}

/**
 * The lookups open now, from the fetch queue: each waiting book's open step (its request waiting
 * or in flight, by the queue's site/state index, or answered and not handled yet, by the ready
 * index). One row per waiting book and step (~20,000 mid-run).
 */
export function openLookups(db: Database.Database): OpenLookups {
  const sites = [...new Set(Object.values(STEP_SITE))];
  const rows: { lib: string; uuid: string; step: string }[] = [];
  const open = db.prepare(
    `SELECT w.library_id AS lib, w.calibre_uuid AS uuid, w.step FROM fetch_requests r
     JOIN fetch_waiters w ON w.request_id = r.id
     WHERE r.site = ? AND r.state IN ('queued', 'leased')`,
  );
  for (const site of sites)
    rows.push(...(open.all(site) as { lib: string; uuid: string; step: string }[]));
  rows.push(
    ...(db
      .prepare(
        'SELECT library_id AS lib, calibre_uuid AS uuid, step FROM fetch_waiters WHERE ready = 1',
      )
      .all() as { lib: string; uuid: string; step: string }[]),
  );
  const steps: Record<string, number> = {};
  const undecided = new Set<string>();
  const coreOpen = new Set<string>();
  const decided = amazonDecided(db);
  for (const r of rows) {
    if (!STEP_SITE[r.step]) continue;
    steps[r.step] = (steps[r.step] ?? 0) + 1;
    // A book whose Amazon lookup was asked already (or that BookWalker settles in Amazon's
    // place) has no Amazon decision to come (the second pick pass reopened 7,362 books for their
    // BookWalker records: counting each one's Amazon decision made the time left 10 h, 2026-11-22).
    if (/^(bookwalker|ranobedb)-/.test(r.step) && !decided(r.lib, r.uuid)) undecided.add(r.uuid);
    if (CORE_STEP.test(r.step)) coreOpen.add(r.uuid);
  }
  return { steps, undecided: undecided.size, coreOpen: coreOpen.size };
}

/** Books known to have their Amazon decision behind them (it never comes back undecided). */
const amazonDone = new Set<string>();

/** Whether a book's Amazon lookup was asked already or BookWalker settles it (read once per book). */
function amazonDecided(db: Database.Database): (lib: string, uuid: string) => boolean {
  // By the primary key (library, book, kind): one row each.
  const stmt = db.prepare(
    "SELECT data FROM evidence_records WHERE library_id = ? AND calibre_uuid = ? AND kind = 'online'",
  );
  return (lib, uuid) => {
    if (amazonDone.has(uuid)) return true;
    const row = stmt.get(lib, uuid) as { data: Buffer } | undefined;
    if (!row) return false;
    let ev: { amazon?: { asked?: boolean; standin?: string } } | null = null;
    try {
      ev = JSON.parse(gunzipSync(row.data).toString('utf8'));
    } catch {
      try {
        ev = JSON.parse(row.data.toString('utf8'));
      } catch {
        ev = null;
      }
    }
    const done = !!(ev?.amazon?.asked || ev?.amazon?.standin);
    if (done) amazonDone.add(uuid);
    return done;
  };
}

/** The core sites' steps: a book with one open hasn't reached its store list and cover yet. */
const CORE_STEP = /^(amazon-search|amazon-dp|ranobedb-|bookwalker-|bookmeter-search)/;
