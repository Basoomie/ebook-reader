/**
 * Bookmeter links to the listing readers use (design `bookmeter-listings.md`; asked by the user
 * 2026-11-25, plan approved the same day): Bookmeter keeps a listing per edition (paperback,
 * Kindle版, sometimes two), and many saved `bookmeter` ids were the first listing the search
 * showed, not the one readers log. One pass over the saved ids, with its own Off / Preview / On
 * (bookmeter_listing_state, cleanup.db v35).
 *
 * Phases, each resumable (cursors and rows in cleanup.db), in slices of about 25 ms:
 *   search  every book with a saved id (the reader's snapshot) queued under its first author;
 *           each author's listings read page by page ("recommended": by registrations) through
 *           the fetch queue at Bookmeter's own pace, behind everything else, until the counts
 *           fall under the lowest saved listing among the author's books (at most
 *           `bookmeterAuthorPages` pages). Second look (bookmeter-listings.md 8): this replaces the
 *           author-field search, whose keyword Bookmeter ignores; the AI check's ids are looked at
 *           like the others (user's decision 2). Books whose identifiers are the user's are never
 *           looked at.
 *   pick    once the author's walk ends: the book's listings from every stored search (stage
 *           4's, More Bookmeter's Q1/Q2) and the author's pages, judged as acceptBookmeter judges
 *           a match (judgeBookmeter: today's checks, the chosen rules, the comic and adaptation
 *           guards) plus every other listing of the same book (bookmeter-same.ts, once the book's
 *           own listing is known), and the most registered of them. The saved id changes only to
 *           a listing with more registrations, or when the saved one is a comic or an adaptation
 *           of a text book and this book's own listing was found. An adaptation with nothing
 *           better is listed.
 *   propose one identifiers proposal per changed book under this pass's analysis id: the reader's
 *           current identifiers with only `bookmeter` replaced (every other id byte for byte;
 *           stage 2's write path writes the set only while Calibre still holds the old one).
 *   spot    50 changes drawn by hash; the user marks each one. On needs every one marked and
 *           none wrong.
 *   write   On only: the proposals made again from the reader's current snapshot, then written
 *           through stage 4's field batches (Undo per batch).
 *
 * Never: a book whose identifiers are the user's is touched, a change the user undid is proposed
 * again, an identifier other than `bookmeter` is added, changed or removed.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { loadGold, mapLabeledIds } from '../stage2-gate';
import type { Stage2Batches } from '../stage2-batches';
import { getSettings } from '../settings';
import { bookmeterAnswers, type BookmeterFacts, type Stage4Analysis } from './analysis';
import { judge, mainTitle, type Gold } from './bookmeter-rules';
import type { FetchQueue } from './queue';
import {
  BOOKMETER_AUTHOR_SEARCH_KEY,
  BOOKMETER_SEARCH_KEY,
  authorWalkGoesOn,
  walkPagesLeft,
  bookListings,
  bookmeterAuthor,
  bookmeterAuthorPage,
  bookmeterListingSearch,
  judgeBookmeter,
  mostRegistered,
  parseBookmeterSearch,
  type BookListing,
  type BookmeterBook,
  type BookmeterGuard,
  type BookmeterHit,
} from './store-links';

export const BL_PHASES = ['search', 'propose', 'spot', 'write', 'done'] as const;
export type BlPhase = (typeof BL_PHASES)[number];
export type BlMode = 'off' | 'analyse' | 'on';
/**
 * A book's outcome: search (its new search is open), keep (the saved id is the most registered
 * listing that is the book), change (a listing with more registrations, or the saved one is not
 * the book), adaptation (the saved id is a comic or an adaptation and no listing of the book was
 * found: listed, never changed), unseen (the saved listing was in none of the answers: its count
 * is unknown, so nothing is changed), unsearched (Bookmeter answered the book's search "not
 * found" (404/410): listed, nothing changed, asked again by "Look again from the start"), ai (the
 * AI check chose the saved id: kept), nofacts (stage 4's answers for the book are gone), yours
 * (the user's identifiers). A search Bookmeter refuses (busy, blocked, errors) never decides a
 * book: it is asked again until it is answered (user, 2026-11-25: a book quietly left with its
 * wrong link is a wrong link).
 */
export type BlState =
  | 'search'
  | 'keep'
  | 'change'
  | 'adaptation'
  | 'unseen'
  | 'unsearched'
  | 'ai'
  | 'nofacts'
  | 'yours';

/** The spot check: this many changes, and On only with none of them wrong (as More direct links). */
export const BL_SPOT_SIZE = 50;
export const BL_SPOT_MAX_WRONG = 0;
/** The pass's requests wait behind everything else (labeled books' at -3, the others' at -4). */
export const BL_PRIORITY = -3;

const SLICE_MS = 25;
/**
 * The search step's rules. 2: a refused search is asked again, never decided from the stored
 * answers (a run of version 1 starts again by itself). 3 (bookmeter-listings.md 8, second look):
 * the author's listings page by page instead of the author-field search (Bookmeter ignores its
 * keyword), every listing of the same book (bookmeter-same.ts), and the AI check's ids looked at
 * like the others (user's decision 2).
 */
export const BL_SEARCH_VERSION = 3;
/** The waiter of an author walk's page (bookmeter_listing_waiters.calibre_uuid): '@' + author. */
export const AUTHOR_WAITER = '@';
/** The wait before a refused search is put back in line: 10 min, doubled each time, at most 2 h. */
export function refusedWaitMs(retries: number): number {
  return Math.min(2 * 3600_000, 10 * 60_000 * 2 ** Math.max(0, retries - 1));
}
const ANALYSIS_PREFIX = 'bookmeter-listing:';
export const listingAnalysisId = (run: number): string => `${ANALYSIS_PREFIX}${run}`;

export const bookmeterUrl = (id: string): string => `https://bookmeter.com/books/${id}`;

// ---------------------------------------------------------------- the pick (pure)

/** A listing as the pass keeps it (evidence and the page). */
export interface BlListing {
  id: string;
  title: string;
  authors: string[];
  registrations: number | null;
}

export interface BlDecision {
  state: 'keep' | 'change' | 'adaptation' | 'unseen';
  /** The saved listing as the answers show it (null: in none of them). */
  saved: BlListing | null;
  /** The listing the book's link goes to (change), or the best one found (keep). */
  pick: BlListing | null;
  /** Why the saved listing is not this book's (a guard), when that decided it. */
  savedGuard: BookmeterGuard | null;
  /** How many listings were judged to be this book. */
  listings: number;
  /** How the pick was found to be this book: the checks' tier or the same-book form. */
  via?: BookListing['via'] | null;
}

const listingOf = (h: BookmeterHit): BlListing => ({
  id: h.id,
  title: h.title,
  authors: h.authors,
  registrations: typeof h.registrations === 'number' ? h.registrations : null,
});

const regOf = (h: { registrations?: number | null }): number =>
  typeof h.registrations === 'number' && h.registrations >= 0 ? h.registrations : -1;

/**
 * One book's saved Bookmeter id against its listings (the answers merged: the first appearance
 * keeps Bookmeter's order, the last answer that shows a listing gives its count). The rule
 * (user, 2026-11-25): among the listings that are this book, the one with the most registrations.
 */
export function decideListing(
  saved: string,
  hits: BookmeterHit[],
  book: BookmeterBook,
): BlDecision {
  const j = judgeBookmeter(hits, book);
  // Second look (bookmeter-listings.md 8): today's checks, plus every other listing of the same
  // book once the book's own listing is known (a listing the checks take, or the saved one).
  const listings = bookListings(hits, book, j, saved);
  const taken = listings.map((l) => l.hit);
  const best = mostRegistered(taken);
  const si = hits.findIndex((h) => h.id === saved);
  const savedHit = si >= 0 ? hits[si] : null;
  const savedGuard = si >= 0 ? j.guard[si] : null;
  const out = (state: BlDecision['state'], pick: BookmeterHit | null): BlDecision => ({
    state,
    saved: savedHit ? listingOf(savedHit) : null,
    pick: pick ? listingOf(pick) : null,
    savedGuard,
    listings: taken.length,
    via: pick ? (listings.find((l) => l.hit === pick)?.via ?? null) : null,
  });
  if (!best) return out(savedGuard ? 'adaptation' : 'keep', null);
  if (best.id === saved) return out('keep', best);
  // The saved listing is a comic or an adaptation of this text book: the book's own listing.
  if (savedGuard) return out('change', best);
  if (!savedHit || regOf(savedHit) < 0 || regOf(best) < 0) return out('unseen', best);
  return out(regOf(best) > regOf(savedHit) ? 'change' : 'keep', best);
}

/** The answers merged in order, each listing once (see decideListing). */
export function mergeAnswers(answers: BookmeterHit[][]): BookmeterHit[] {
  const out = new Map<string, BookmeterHit>();
  for (const hits of answers)
    for (const h of hits) {
      const had = out.get(h.id);
      if (!had) out.set(h.id, h);
      else if (typeof h.registrations === 'number')
        out.set(h.id, { ...had, registrations: h.registrations });
    }
  return [...out.values()];
}

/** The proposal's new identifiers: the current ones with only `bookmeter` replaced. */
export function replaceBookmeter(
  current: Record<string, string>,
  id: string,
): Record<string, string> {
  return { ...current, bookmeter: id };
}

// ---------------------------------------------------------------- progress and state

export interface BlProgress {
  run: number;
  /** BL_SEARCH_VERSION the run's search step follows (missing = 1). */
  searchVersion?: number;
  libraryId: string | null;
  phase: BlPhase;
  cursor: string;
  startedAt: number | null;
  phaseStartedAt: number | null;
  /** Books with a saved id in the snapshot (the search phase's total). */
  books: number;
  search: {
    looked: number;
    asked: number;
    answered: number;
    enqueued: boolean;
    /**
     * Searches Bookmeter refused (busy, blocked, errors after the queue's own tries): each one
     * put back in line, its book still open. Counted each time.
     */
    failed: number;
    /** Books whose search is waiting to be asked again now. */
    refusedOpen?: number;
    /** Books Bookmeter answered "not found" for (state unsearched). */
    gone?: number;
    /** Books without an author to search with: decided from the stored searches. */
    noAuthor?: number;
    /** Version 3: authors to walk, walks ended, pages read, books decided after their walk. */
    authors?: number;
    walked?: number;
    pages?: number;
    decided?: number;
    /**
     * When every search was queued, with the answers handled and ready then: the pace is
     * measured from there (answers already in the cache come at once).
     */
    since: { at: number; answered: number } | null;
    /** Pages read by time (every 5 minutes, the last hour and a bit): the card's pace. */
    paceMarks?: [number, number][];
  };
  propose: {
    total: number;
    done: number;
    proposed: number;
    held: number;
    yours: number;
    gone: number;
    /** Books no longer in Calibre (removed since the search, e.g. a better copy arrived). */
    removed?: number;
  };
  spot: { drawnAt: number | null; size: number };
  write: {
    rebuilt: boolean;
    batches: string[];
    waiting: string | null;
    finishedAt: number | null;
    /** The card's counts of unwritten books were taken from the database (see recountUnwritten). */
    recounted?: boolean;
  };
  labeled: {
    changes: number;
    flagged: { calibreId: number; why: string[] }[];
  } | null;
  times: Record<string, number>;
  longestStepMs: number;
  finishedAt: number | null;
}

export function emptyBlProgress(run = 1, libraryId: string | null = null): BlProgress {
  return {
    run,
    searchVersion: BL_SEARCH_VERSION,
    libraryId,
    phase: 'search',
    cursor: '',
    startedAt: null,
    phaseStartedAt: null,
    books: 0,
    search: { looked: 0, asked: 0, answered: 0, enqueued: false, failed: 0, since: null },
    propose: { total: 0, done: 0, proposed: 0, held: 0, yours: 0, gone: 0 },
    spot: { drawnAt: null, size: 0 },
    write: { rebuilt: false, batches: [], waiting: null, finishedAt: null },
    labeled: null,
    times: {},
    longestStepMs: 0,
    finishedAt: null,
  };
}

export interface BlState0 {
  libraryId: string | null;
  mode: BlMode;
  progress: BlProgress;
  pausedReason: string | null;
  pausedDetail: string | null;
  updatedAt: number;
}

export function getBlState(db: Database.Database, libraryId: string): BlState0 {
  db.prepare(
    `INSERT OR IGNORE INTO bookmeter_listing_state (library_id, updated_at) VALUES (?, 0)`,
  ).run(libraryId);
  const r = db
    .prepare('SELECT * FROM bookmeter_listing_state WHERE library_id = ?')
    .get(libraryId) as {
    library_id: string | null;
    mode: BlMode;
    progress_json: string;
    paused_reason: string | null;
    paused_detail: string | null;
    updated_at: number;
  };
  const stored = JSON.parse(r.progress_json) as Partial<BlProgress>;
  return {
    libraryId: r.library_id,
    mode: r.mode,
    // A run saved before BL_SEARCH_VERSION existed is version 1 (never the default's number).
    progress: stored.phase
      ? { ...emptyBlProgress(), ...stored, searchVersion: stored.searchVersion ?? 1 }
      : emptyBlProgress(),
    pausedReason: r.paused_reason,
    pausedDetail: r.paused_detail,
    updatedAt: r.updated_at,
  };
}

function saveProgress(db: Database.Database, libraryId: string, p: BlProgress): void {
  db.prepare(
    `INSERT OR IGNORE INTO bookmeter_listing_state (library_id, updated_at) VALUES (?, 0)`,
  ).run(libraryId);
  db.prepare(
    'UPDATE bookmeter_listing_state SET progress_json = ?, updated_at = ? WHERE library_id = ?',
  ).run(JSON.stringify(p), Date.now(), libraryId);
}

/** The draw's order: a fixed hash of the run and the book. */
export function listingSpotOrderKey(run: number, uuid: string): string {
  return createHash('sha256').update(`bookmeter-listing-spot:${run}:${uuid}`).digest('hex');
}

export interface BookmeterListingDeps {
  db: Database.Database;
  analysis: Stage4Analysis;
  queue: FetchQueue;
  batches: Stage2Batches;
  targetLibrary: () => string | null;
  /** Stage 4's analysis, one-time passes and AI check are done. */
  stage4Done: () => boolean;
  /** Why a write must wait now, else null. */
  writeWait: (libraryId: string) => string | null;
  /** The labeled books' file (stage 4's gate), for the labeled line on the card. */
  referenceFile: () => string | null;
  log?: (m: string) => void;
}

export type BlStep = 'more' | 'wait' | 'idle';

interface BookRow {
  calibre_uuid: string;
  calibre_id: number;
  labeled: number;
  saved_id: string;
  state: BlState;
  decision_json: string | null;
  proposed: number;
}

/** A book on the page: its title, the saved listing and the one the link goes to. */
export interface BlBook {
  uuid: string;
  calibreId: number;
  labeled: boolean;
  state: BlState;
  book: { title: string | null; authors: string[]; decidedTitle: string | null };
  saved: (BlListing & { url: string }) | { id: string; url: string };
  pick: (BlListing & { url: string }) | null;
  savedGuard: BookmeterGuard | null;
  proposal: string | null;
}

export class BookmeterListings {
  /** Manga part B: the library this pass works on (one instance per library). */
  private lib(): string {
    return this.deps.targetLibrary() ?? '';
  }

  private readonly db: Database.Database;
  private saved: {
    lib: string;
    stamp: number;
    list: { uuid: string; calibreId: number; saved: string }[];
  } | null = null;

  constructor(private readonly deps: BookmeterListingDeps) {
    this.db = deps.db;
  }

  state(): BlState0 {
    return getBlState(this.db, this.lib());
  }

  /** Off / Preview / On. On only after the spot check passed. */
  setMode(mode: BlMode): void {
    if (mode === 'on' && !this.spotPassed())
      throw new Error('On needs the spot check first: every one of its books marked, none wrong');
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bookmeter_listing_state (library_id, updated_at) VALUES (?, 0)`,
      )
      .run(this.lib());
    this.db
      .prepare('UPDATE bookmeter_listing_state SET mode = ?, updated_at = ? WHERE library_id = ?')
      .run(mode, Date.now(), this.lib());
    this.deps.log?.(`Bookmeter links: ${mode === 'analyse' ? 'Preview' : mode}`);
  }

  /**
   * Starts a new run (books added or matched since the last one). Refused while a run's changes
   * are being written. What was written stays; open proposals never written are removed.
   */
  again(): void {
    const p = this.state().progress;
    if (p.phase === 'write') throw new Error('The links are being written: wait for that to end');
    this.startRun(emptyBlProgress(p.run + 1, null));
    this.deps.log?.('Bookmeter links: looking again from the start');
  }

  private startRun(fresh: BlProgress): void {
    const db = this.db;
    db.transaction(() => {
      db.prepare(
        `DELETE FROM proposed_changes WHERE stage = 4 AND field = 'identifiers' AND library_id = ?
           AND analysis_id LIKE '${ANALYSIS_PREFIX}%' AND state = 'proposed' AND batch_id IS NULL`,
      ).run(this.lib());
      db.prepare('DELETE FROM bookmeter_listing_books WHERE library_id = ?').run(this.lib());
      db.prepare('DELETE FROM bookmeter_listing_waiters WHERE library_id = ?').run(this.lib());
      db.prepare('DELETE FROM bookmeter_author_walks WHERE library_id = ?').run(this.lib());
      db.prepare('DELETE FROM bookmeter_listing_spot WHERE library_id = ?').run(this.lib());
      saveProgress(db, this.lib(), fresh);
    })();
  }

  /** One step of the pass; 'idle' when there is nothing to do now. */
  async step(): Promise<BlStep> {
    const st = this.state();
    if (st.mode === 'off') return 'idle';
    const lib = this.deps.targetLibrary();
    if (!lib || !this.deps.stage4Done()) return 'idle';
    const p = st.progress;
    if (p.libraryId !== lib) {
      this.startRun(emptyBlProgress(p.run + (p.libraryId ? 1 : 0), lib));
      return 'more';
    }
    // A run whose searches followed older rules (a refused search decided from the stored answers)
    // starts again; answers fetched before come from the cache, refused ones are asked again.
    if (
      (p.searchVersion ?? 1) < BL_SEARCH_VERSION &&
      (p.phase === 'search' || p.phase === 'propose' || p.phase === 'spot')
    ) {
      this.deps.log?.(
        `Bookmeter links: run ${p.run} searched by older rules; starting again (run ${p.run + 1})`,
      );
      this.startRun(emptyBlProgress(p.run + 1, lib));
      return 'more';
    }
    if (p.phase === 'done') return 'idle';
    p.startedAt ??= Date.now();
    p.phaseStartedAt ??= Date.now();
    const phase = p.phase;
    const t = performance.now();
    let r: BlStep;
    try {
      r = await this.phaseStep(st, p, lib);
    } finally {
      const ms = performance.now() - t;
      p.times[phase] = (p.times[phase] ?? 0) + ms;
      if (phase !== 'write' && ms > p.longestStepMs) p.longestStepMs = Math.round(ms);
      saveProgress(this.db, this.lib(), p);
    }
    return r;
  }

  private next(p: BlProgress, phase: BlPhase): void {
    this.deps.log?.(`Bookmeter links: ${p.phase} done; ${phase} next`);
    p.phase = phase;
    p.cursor = '';
    p.phaseStartedAt = Date.now();
    if (phase === 'done') p.finishedAt = Date.now();
  }

  private async phaseStep(st: BlState0, p: BlProgress, lib: string): Promise<BlStep> {
    switch (p.phase) {
      case 'search':
        return this.searchStep(p, lib);
      case 'propose':
        return this.proposeStep(p, lib);
      case 'spot':
        return this.spotStep(st, p, lib);
      case 'write':
        return this.writeStep(st, p, lib);
      default:
        return 'idle';
    }
  }

  // ------------------------------------------------------------ the books and their searches

  private isYours(lib: string, uuid: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM user_fields WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers'`,
      )
      .get(lib, uuid);
  }

  /** A stored Bookmeter answer by its queue key (null when never fetched or gone). */
  private stored(key: string): BookmeterHit[] | null {
    const r = this.db
      .prepare(
        `SELECT id FROM fetch_requests WHERE site = 'bookmeter' AND key = ? AND state = 'done'`,
      )
      .get(key) as { id: number } | undefined;
    const body = r ? this.deps.queue.readAnswer(r.id) : null;
    return body ? parseBookmeterSearch(body) : null;
  }

  /**
   * Every Bookmeter answer the book has, in order: stage 4's search (read again from the cache:
   * the stored hits have no counts) and its author-field search, More Bookmeter coverage's Q1 and
   * Q2, then `fresh` (more listings: the author's pages). Stage 4's stored hits when its page is
   * gone.
   */
  answersOf(f: BookmeterFacts, fresh: BookmeterHit[] | null): BookmeterHit[] {
    const lists: BookmeterHit[][] = [];
    const s4 = f.searchRequest !== null ? this.deps.queue.readAnswer(f.searchRequest) : null;
    lists.push(s4 ? parseBookmeterSearch(s4) : bookmeterAnswers({ bookmeter: f.bookmeter }));
    if (s4) lists.push(f.bookmeter.listing?.hits ?? []);
    const q1 = mainTitle(f.queryTitle);
    const au = (f.input.authors[0] ?? '').replace(/\s/gu, '');
    if (q1 && q1 !== f.queryTitle) lists.push(this.stored(`${BOOKMETER_SEARCH_KEY}${q1}`) ?? []);
    if (au && q1) lists.push(this.stored(`${BOOKMETER_AUTHOR_SEARCH_KEY}${au}\n${q1}`) ?? []);
    // The earlier runs' own author-field search (version 2, by the decided title): it showed the
    // saved listing of many books (its count is what a better listing must beat).
    const v2 = bookmeterListingSearch(f.input.title, f.input.authors);
    if (v2 && v2.key !== `${BOOKMETER_AUTHOR_SEARCH_KEY}${au}\n${q1}`)
      lists.push(this.stored(v2.key) ?? []);
    if (fresh) lists.push(fresh);
    return mergeAnswers(lists);
  }

  private putBook(
    lib: string,
    uuid: string,
    calibreId: number,
    labeled: boolean,
    saved: string,
    state: BlState,
    decision: BlDecision | null,
    author: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO bookmeter_listing_books
           (library_id, calibre_uuid, calibre_id, labeled, saved_id, state, decision_json, proposed, updated_at, author)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(library_id, calibre_uuid) DO UPDATE SET calibre_id = excluded.calibre_id,
           labeled = excluded.labeled, saved_id = excluded.saved_id, state = excluded.state,
           decision_json = excluded.decision_json, proposed = 0, updated_at = excluded.updated_at,
           author = COALESCE(excluded.author, author)`,
      )
      .run(
        lib,
        uuid,
        calibreId,
        labeled ? 1 : 0,
        saved,
        state,
        decision ? JSON.stringify(decision) : null,
        Date.now(),
        author,
      );
  }

  /** The books with a saved id, by UUID (the reader's snapshot; kept while it is unchanged). */
  private savedBooks(lib: string): { uuid: string; calibreId: number; saved: string }[] {
    const stamp = this.deps.analysis.snapshotStamp(lib);
    if (!this.saved || this.saved.lib !== lib || this.saved.stamp !== stamp)
      this.saved = { lib, stamp, list: this.deps.analysis.bookmeterSaved(lib) };
    return this.saved.list;
  }

  /**
   * Search, version 3 (bookmeter-listings.md 8): each book is queued under its first author; each
   * author's listings are read page by page ("recommended": by registrations) until the counts
   * fall under the lowest saved listing among the author's books, at most `authorPages` pages;
   * then the author's books are decided from their stored answers and the author's pages. A
   * page Bookmeter refuses is asked again (10 min, doubling, at most 2 h); no book is decided
   * before its author's walk ends.
   */
  private searchStep(p: BlProgress, lib: string): BlStep {
    const db = this.db;
    const a = this.deps.analysis;
    a.loadSnapshot(lib);
    const t0 = performance.now();
    if (!p.search.enqueued) {
      const all = this.savedBooks(lib);
      p.books = all.length;
      let i = 0;
      if (p.cursor) {
        let lo = 0;
        let hi = all.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (all[mid].uuid <= p.cursor) lo = mid + 1;
          else hi = mid;
        }
        i = lo;
      }
      if (i >= all.length) {
        p.search.enqueued = true;
        p.cursor = '';
        p.search.authors = this.walkCount(lib);
        p.search.since = { at: Date.now(), answered: 0 };
        return 'more';
      }
      const labeledOf = db.prepare(
        'SELECT labeled FROM stage4_books WHERE library_id = ? AND calibre_uuid = ?',
      );
      const walk = db.prepare(
        `INSERT INTO bookmeter_author_walks (library_id, author, stop, pages, state, retries, updated_at)
         VALUES (?, ?, ?, 0, 'wait', 0, ?)
         ON CONFLICT (library_id, author) DO UPDATE SET stop = MIN(stop, excluded.stop)`,
      );
      db.transaction(() => {
        for (; i < all.length; i++) {
          if (performance.now() - t0 > SLICE_MS) break;
          const b = all[i];
          p.cursor = b.uuid;
          p.search.looked++;
          const labeled =
            (labeledOf.get(lib, b.uuid) as { labeled: number } | undefined)?.labeled === 1;
          if (this.isYours(lib, b.uuid)) {
            this.putBook(lib, b.uuid, b.calibreId, labeled, b.saved, 'yours', null);
            continue;
          }
          const f = a.bookmeterFacts(lib, b.uuid);
          if (!f) {
            this.putBook(lib, b.uuid, b.calibreId, labeled, b.saved, 'nofacts', null);
            continue;
          }
          const stored = this.answersOf(f, null);
          const author = bookmeterAuthor(f.input.authors);
          if (!author) {
            // No author to walk: the stored searches are all there is (counted on the card).
            p.search.noAuthor = (p.search.noAuthor ?? 0) + 1;
            const d = decideListing(b.saved, stored, f.input);
            this.putBook(lib, b.uuid, b.calibreId, labeled, b.saved, d.state, d);
            continue;
          }
          // What a better listing must beat: the saved listing's count (unknown: walk to the cap).
          const savedHit = stored.find((h) => h.id === b.saved);
          const stop =
            typeof savedHit?.registrations === 'number' && savedHit.registrations >= 0
              ? savedHit.registrations
              : 0;
          this.putBook(lib, b.uuid, b.calibreId, labeled, b.saved, 'search', null, author);
          walk.run(lib, author, stop, Date.now());
          p.search.asked++;
        }
      })();
      return 'more';
    }
    // Every author's first page, queued in slices once every book is listed (stops are final).
    const waiting = db
      .prepare(
        `SELECT author FROM bookmeter_author_walks INDEXED BY bookmeter_author_walks_state
         WHERE library_id = ? AND state = 'wait' LIMIT 200`,
      )
      .all(lib) as { author: string }[];
    if (waiting.length) {
      db.transaction(() => {
        for (const w of waiting) {
          if (performance.now() - t0 > SLICE_MS) break;
          this.askPage(lib, w.author, 1);
        }
      })();
      return 'more';
    }
    // The pages that came back.
    const ready = db
      .prepare(
        `SELECT w.request_id, w.calibre_uuid AS waiter, r.state AS rstate, r.key AS rkey
         FROM bookmeter_listing_waiters w JOIN fetch_requests r ON r.id = w.request_id
         WHERE w.ready = 1 AND w.library_id = ? LIMIT 100`,
      )
      .all(lib) as { request_id: number; waiter: string; rstate: string; rkey: string }[];
    const cap = Math.max(1, getSettings(db).fetch.bookmeterAuthorPages ?? 8);
    for (const w of ready) {
      if (performance.now() - t0 > SLICE_MS) break;
      if (!w.waiter.startsWith(AUTHOR_WAITER)) {
        // A book's own search from a run of version 2: nothing waits on it now.
        db.prepare(
          'DELETE FROM bookmeter_listing_waiters WHERE request_id = ? AND library_id = ? AND calibre_uuid = ?',
        ).run(w.request_id, lib, w.waiter);
        continue;
      }
      const author = w.waiter.slice(AUTHOR_WAITER.length);
      const walk = db
        .prepare(
          'SELECT stop, pages, retries, first_reg FROM bookmeter_author_walks WHERE library_id = ? AND author = ?',
        )
        .get(lib, author) as
        | { stop: number; pages: number; retries: number; first_reg: number | null }
        | undefined;
      const page = Number(w.rkey.slice(w.rkey.lastIndexOf('\n') + 1)) || 1;
      db.transaction(() => {
        if (walk && w.rstate === 'failed') {
          // Refused: asked again after a growing wait; the author's books stay open.
          const retries = walk.retries + 1;
          p.search.failed++;
          this.deps.queue.requeue(w.request_id, BL_PRIORITY - 1);
          db.prepare('UPDATE fetch_requests SET next_at = ? WHERE id = ? AND state = ?').run(
            Date.now() + refusedWaitMs(retries),
            w.request_id,
            'queued',
          );
          db.prepare(
            'UPDATE bookmeter_listing_waiters SET ready = 0 WHERE request_id = ? AND library_id = ? AND calibre_uuid = ?',
          ).run(w.request_id, lib, w.waiter);
          db.prepare(
            'UPDATE bookmeter_author_walks SET retries = ?, updated_at = ? WHERE library_id = ? AND author = ?',
          ).run(retries, Date.now(), lib, author);
          return;
        }
        db.prepare(
          'DELETE FROM bookmeter_listing_waiters WHERE request_id = ? AND library_id = ? AND calibre_uuid = ?',
        ).run(w.request_id, lib, w.waiter);
        if (!walk) return;
        p.search.answered++;
        if (w.rstate === 'gone') {
          // Bookmeter knows no such page: the walk ends with the pages read.
          this.endWalk(p, lib, author, walk.pages);
          return;
        }
        const body = this.deps.queue.readAnswer(w.request_id);
        if (!body) {
          // Answered, but the answer can't be read (its cached file is gone): asked again.
          p.search.failed++;
          this.deps.queue.requeue(w.request_id, BL_PRIORITY - 1);
          db.prepare(
            'INSERT OR REPLACE INTO bookmeter_listing_waiters (request_id, library_id, calibre_uuid, ready) VALUES (?, ?, ?, 0)',
          ).run(w.request_id, lib, w.waiter);
          return;
        }
        const hits = parseBookmeterSearch(body);
        p.search.pages = (p.search.pages ?? 0) + 1;
        if (authorWalkGoesOn(hits, page, walk.stop, cap)) {
          const firstReg = page === 1 ? countOf(hits[0]) : walk.first_reg;
          const left = walkPagesLeft(
            firstReg,
            countOf(hits[hits.length - 1]),
            page,
            walk.stop,
            cap,
          );
          db.prepare(
            'UPDATE bookmeter_author_walks SET pages = ?, retries = 0, first_reg = ?, left_pages = ?, updated_at = ? WHERE library_id = ? AND author = ?',
          ).run(page, firstReg, left, Date.now(), lib, author);
          this.askPage(lib, author, page + 1);
        } else this.endWalk(p, lib, author, page);
      })();
    }
    this.estimateOpenWalks(lib, cap, t0);
    markPace(p, Date.now());
    // The books of the authors whose walk ended.
    const decided = this.decideWalked(p, lib, t0);
    const open = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_listing_books INDEXED BY bookmeter_listing_books_state
           WHERE library_id = ? AND state = 'search'`,
        )
        .get(lib) as { n: number }
    ).n;
    if (open === 0) {
      p.propose.total = this.countState(lib, 'change');
      this.next(p, 'propose');
      return 'more';
    }
    return ready.length || decided ? 'more' : 'wait';
  }

  /** Authors with a walk in this run. */
  private walkCount(lib: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM bookmeter_author_walks WHERE library_id = ?')
        .get(lib) as { n: number }
    ).n;
  }

  /** One page of an author's listings, through the queue at the pass's priority. */
  private askPage(lib: string, author: string, page: number): void {
    const spec = bookmeterAuthorPage(author, page);
    const r = this.deps.queue.enqueue(
      { site: 'bookmeter', ...spec, priority: BL_PRIORITY - 1 },
      null,
    );
    const ready = r.state === 'done' || r.state === 'gone' || r.state === 'failed' ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO bookmeter_listing_waiters (request_id, library_id, calibre_uuid, ready)
         VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET ready = excluded.ready`,
      )
      .run(r.id, lib, `${AUTHOR_WAITER}${author}`, ready);
    this.db
      .prepare(
        `UPDATE bookmeter_author_walks SET state = 'walk', updated_at = ? WHERE library_id = ? AND author = ?`,
      )
      .run(Date.now(), lib, author);
  }

  private endWalk(p: BlProgress, lib: string, author: string, pages: number): void {
    this.db
      .prepare(
        `UPDATE bookmeter_author_walks SET state = 'done', pages = ?, updated_at = ? WHERE library_id = ? AND author = ?`,
      )
      .run(pages, Date.now(), lib, author);
    p.search.walked = (p.search.walked ?? 0) + 1;
  }

  /** The listings on an author's pages read in this walk (from the cache, by their keys). */
  authorHits(author: string, pages: number): BookmeterHit[] {
    const lists: BookmeterHit[][] = [];
    for (let n = 1; n <= pages; n++)
      lists.push(this.stored(bookmeterAuthorPage(author, n).key) ?? []);
    return mergeAnswers(lists);
  }

  /** Decides, in a slice, the open books whose author's walk ended. Returns how many. */
  private decideWalked(p: BlProgress, lib: string, t0: number): number {
    const db = this.db;
    const rows = db
      .prepare(
        `SELECT b.calibre_uuid, b.calibre_id, b.labeled, b.saved_id, b.author, w.pages
         FROM bookmeter_author_walks w INDEXED BY bookmeter_author_walks_state
         JOIN bookmeter_listing_books b INDEXED BY bookmeter_listing_books_author
           ON b.library_id = w.library_id AND b.author = w.author AND b.state = 'search'
         WHERE w.library_id = ? AND w.state = 'done' LIMIT 50`,
      )
      .all(lib) as {
      calibre_uuid: string;
      calibre_id: number;
      labeled: number;
      saved_id: string;
      author: string;
      pages: number;
    }[];
    const pages = new Map<string, BookmeterHit[]>();
    let n = 0;
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS * 2) break;
      n++;
      const f = this.deps.analysis.bookmeterFacts(lib, r.calibre_uuid);
      if (!f) {
        this.putBook(
          lib,
          r.calibre_uuid,
          r.calibre_id,
          r.labeled === 1,
          r.saved_id,
          'nofacts',
          null,
        );
        continue;
      }
      let ah = pages.get(r.author);
      if (!ah) {
        ah = this.authorHits(r.author, r.pages);
        pages.set(r.author, ah);
      }
      const d = decideListing(r.saved_id, mergeAnswers([this.answersOf(f, null), ah]), f.input);
      this.putBook(lib, r.calibre_uuid, r.calibre_id, r.labeled === 1, r.saved_id, d.state, d);
      p.search.decided = (p.search.decided ?? 0) + 1;
    }
    return n;
  }

  private countState(lib: string, state: BlState): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_listing_books INDEXED BY bookmeter_listing_books_state
           WHERE library_id = ? AND state = ?`,
        )
        .get(lib, state) as { n: number }
    ).n;
  }

  // ------------------------------------------------------------ proposals

  /**
   * The book's identifiers proposal under the pass's analysis id, from the reader's current
   * snapshot: the same identifiers with only `bookmeter` replaced. Its earlier open row is
   * replaced. Never made when the saved id changed since the search, for a book whose
   * identifiers are the user's, nor after an Undo; held while another identifiers change of the
   * book is open.
   */
  proposeOne(
    lib: string,
    run: number,
    uuid: string,
  ): 'proposed' | 'held' | 'yours' | 'gone' | 'removed' | 'written' {
    const db = this.db;
    const row = db
      .prepare(
        `SELECT saved_id, decision_json FROM bookmeter_listing_books
         WHERE library_id = ? AND calibre_uuid = ? AND state = 'change'`,
      )
      .get(lib, uuid) as { saved_id: string; decision_json: string } | undefined;
    const book = this.deps.analysis.snapshotBook(lib, uuid);
    if (!row || !book) {
      // Nothing to write: an open proposal made before (the Preview's) goes too, or the planner
      // would count the book as changed in Calibre and pause stage 4.
      this.dropOpen(lib, listingAnalysisId(run), uuid);
      return book ? 'gone' : 'removed';
    }
    const d = JSON.parse(row.decision_json) as BlDecision;
    const aid = listingAnalysisId(run);
    const rows = db
      .prepare(
        `SELECT id, state, analysis_id FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers'`,
      )
      .all(lib, uuid) as { id: number; state: string; analysis_id: string | null }[];
    const ours = (r: { analysis_id: string | null }) =>
      (r.analysis_id ?? '').startsWith(ANALYSIS_PREFIX);
    // Undone by the user in any run of this pass: never proposed again.
    if (rows.some((r) => ours(r) && r.state === 'undone')) return 'written';
    const mine = rows.filter((r) => r.analysis_id === aid);
    if (mine.some((m) => m.state === 'applied' || m.state === 'queued')) return 'written';
    const other = rows.some(
      (r) => r.analysis_id !== aid && (r.state === 'proposed' || r.state === 'queued'),
    );
    const yours = this.isYours(lib, uuid);
    // The saved id changed since the search (by you or another pass): nothing to replace.
    const gone = !d.pick || book.identifiers.bookmeter !== row.saved_id;
    const now = Date.now();
    let out: 'proposed' | 'held' | 'yours' | 'gone' = 'proposed';
    db.transaction(() => {
      for (const m of mine)
        if (m.state === 'proposed')
          db.prepare(
            'DELETE FROM proposed_changes WHERE id = ? AND state = ? AND batch_id IS NULL',
          ).run(m.id, 'proposed');
      db.prepare(
        'UPDATE bookmeter_listing_books SET proposed = 0 WHERE library_id = ? AND calibre_uuid = ?',
      ).run(lib, uuid);
      if (yours) out = 'yours';
      else if (gone) out = 'gone';
      else if (other) out = 'held';
      if (out !== 'proposed') return;
      db.prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
           evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
         VALUES (4, ?, ?, ?, 'identifiers', ?, ?, 'bookmeter', ?, 'auto', NULL, 'proposed', ?, ?, ?)`,
      ).run(
        lib,
        book.calibreId,
        uuid,
        JSON.stringify(book.identifiers),
        JSON.stringify(replaceBookmeter(book.identifiers, d.pick!.id)),
        JSON.stringify({
          replaced: { bookmeter: { from: row.saved_id, to: d.pick!.id } },
          listing: { saved: d.saved, pick: d.pick, savedGuard: d.savedGuard },
        }),
        aid,
        now,
        now,
      );
      db.prepare(
        'UPDATE bookmeter_listing_books SET proposed = 1 WHERE library_id = ? AND calibre_uuid = ?',
      ).run(lib, uuid);
    })();
    return out;
  }

  /** Deletes this run's open (unbatched) proposal of one book and marks the book unproposed. */
  private dropOpen(lib: string, aid: string, uuid: string): number {
    const db = this.db;
    return db.transaction(() => {
      const n = db
        .prepare(
          `DELETE FROM proposed_changes WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers'
             AND analysis_id = ? AND state = 'proposed' AND batch_id IS NULL`,
        )
        .run(lib, uuid, aid).changes;
      db.prepare(
        'UPDATE bookmeter_listing_books SET proposed = 0 WHERE library_id = ? AND calibre_uuid = ?',
      ).run(lib, uuid);
      return n;
    })();
  }

  /**
   * Before each batch: this run's open proposals of books no longer in Calibre (removed while
   * the pass waited or wrote, e.g. by a new-arrivals run's better copy) are dropped. Stage 4's
   * planner counts a book that is gone as changed in Calibre and pauses the stage when enough of
   * the next books are; these have nothing to write, so they never reach it.
   */
  dropRemoved(p: BlProgress, lib: string): number {
    const aid = listingAnalysisId(p.run);
    // Run on every tick of the write step, also while a batch is applied: without stage = 4 it
    // walked every change of the library (686,674 rows, 6.8 s, the server unreachable for an
    // hour on 2026-11-26); the counts index reads only this run's open changes.
    const rows = this.db
      .prepare(
        `SELECT calibre_uuid FROM proposed_changes INDEXED BY proposed_changes_counts
         WHERE stage = 4 AND library_id = ? AND state = 'proposed' AND field = 'identifiers'
           AND analysis_id = ? AND batch_id IS NULL`,
      )
      .all(lib, aid) as { calibre_uuid: string }[];
    if (!rows.length) return 0;
    this.deps.analysis.loadSnapshot(lib);
    let dropped = 0;
    for (const r of rows) {
      if (this.deps.analysis.snapshotBook(lib, r.calibre_uuid)) continue;
      if (this.dropOpen(lib, aid, r.calibre_uuid) > 0) dropped++;
    }
    if (dropped)
      this.deps.log?.(
        `Bookmeter links: ${dropped} books no longer in Calibre, their changes dropped`,
      );
    return dropped;
  }

  /**
   * The card's counts of the books to change, from the database as it is now: proposed, the
   * user's, no longer in Calibre, saved link changed since the search, held by another open
   * change. Counting each drop on top of the counts the rebuild made would count a book twice
   * (the rebuild may already have set it aside).
   */
  recountUnwritten(p: BlProgress, lib: string): void {
    const rows = this.db
      .prepare(
        `SELECT calibre_uuid, saved_id, decision_json, proposed FROM bookmeter_listing_books
         WHERE library_id = ? AND state = 'change'`,
      )
      .all(lib) as {
      calibre_uuid: string;
      saved_id: string;
      decision_json: string;
      proposed: number;
    }[];
    this.deps.analysis.loadSnapshot(lib);
    const c = { proposed: 0, held: 0, yours: 0, gone: 0, removed: 0 };
    for (const r of rows) {
      if (r.proposed) {
        c.proposed++;
        continue;
      }
      if (this.isYours(lib, r.calibre_uuid)) {
        c.yours++;
        continue;
      }
      const book = this.deps.analysis.snapshotBook(lib, r.calibre_uuid);
      const d = JSON.parse(r.decision_json) as BlDecision;
      if (!book) c.removed++;
      else if (!d.pick || book.identifiers.bookmeter !== r.saved_id) c.gone++;
      else c.held++;
    }
    p.propose = { ...p.propose, ...c };
    p.write.recounted = true;
  }

  private proposeChunk(p: BlProgress, lib: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT calibre_uuid FROM bookmeter_listing_books
         WHERE library_id = ? AND state = 'change' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(lib, p.cursor) as { calibre_uuid: string }[];
    if (p.cursor === '')
      p.propose = { ...p.propose, done: 0, proposed: 0, held: 0, yours: 0, gone: 0, removed: 0 };
    if (!rows.length) return false;
    this.deps.analysis.loadSnapshot(lib);
    const t0 = performance.now();
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      p.cursor = r.calibre_uuid;
      p.propose.done++;
      const o = this.proposeOne(lib, p.run, r.calibre_uuid);
      if (o !== 'written') p.propose[o] = (p.propose[o] ?? 0) + 1;
    }
    return true;
  }

  private proposeStep(p: BlProgress, lib: string): BlStep {
    if (this.proposeChunk(p, lib)) return 'more';
    this.labeledLine(p, lib);
    this.next(p, p.propose.proposed > 0 ? 'spot' : 'done');
    return 'more';
  }

  /** The labeled books' changes and the checker's flags (the new listing against the label). */
  private labeledLine(p: BlProgress, lib: string): void {
    const file = this.deps.referenceFile();
    if (!file) return;
    try {
      const { gold } = loadGold(file);
      if (!gold) return;
      const byCid = new Map<number, Gold>();
      for (const [gid, cid] of mapLabeledIds(this.db, lib, Object.keys(gold)))
        byCid.set(cid, gold[gid] as unknown as Gold);
      const rows = this.db
        .prepare(
          `SELECT calibre_id, decision_json FROM bookmeter_listing_books
           WHERE library_id = ? AND state = 'change' AND labeled = 1 AND proposed = 1`,
        )
        .all(lib) as { calibre_id: number; decision_json: string }[];
      const flagged: { calibreId: number; why: string[] }[] = [];
      let changes = 0;
      for (const r of rows) {
        const g = byCid.get(r.calibre_id);
        const pick = (JSON.parse(r.decision_json) as BlDecision).pick;
        if (!g || !pick) continue;
        changes++;
        const why = judge({ ...pick, pages: null, edOk: true }, g).why;
        if (why.length) flagged.push({ calibreId: r.calibre_id, why });
      }
      p.labeled = { changes, flagged };
    } catch (err) {
      this.deps.log?.(`Bookmeter links: the labeled books' line failed: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------ the spot check

  private spotStep(st: BlState0, p: BlProgress, lib: string): BlStep {
    if (p.spot.drawnAt === null) {
      this.drawSpot(p, lib);
      return 'more';
    }
    if (st.mode === 'on' && this.spotPassed()) {
      this.next(p, 'write');
      return 'more';
    }
    return 'idle';
  }

  /** Draws the spot check's books from those proposed (a fixed hash order). */
  drawSpot(p: BlProgress, lib: string): void {
    const db = this.db;
    const rows = db
      .prepare(
        `SELECT calibre_uuid FROM bookmeter_listing_books
         WHERE library_id = ? AND state = 'change' AND proposed = 1`,
      )
      .all(lib) as { calibre_uuid: string }[];
    const pick = rows
      .map((r) => ({ uuid: r.calibre_uuid, k: listingSpotOrderKey(p.run, r.calibre_uuid) }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .slice(0, BL_SPOT_SIZE);
    const put = db.prepare(
      `INSERT OR REPLACE INTO bookmeter_listing_spot (library_id, calibre_uuid, position, verdict, decided_at)
       VALUES (?, ?, ?, NULL, NULL)`,
    );
    db.transaction(() => {
      db.prepare('DELETE FROM bookmeter_listing_spot WHERE library_id = ?').run(this.lib());
      pick.forEach((x, i) => put.run(lib, x.uuid, i));
    })();
    p.spot.drawnAt = Date.now();
    p.spot.size = pick.length;
    this.deps.log?.(`Bookmeter links: the spot check is ready (${pick.length} books)`);
  }

  spotCounts(): { size: number; right: number; wrong: number; open: number } {
    const rows = this.db
      .prepare(
        'SELECT verdict, COUNT(*) AS n FROM bookmeter_listing_spot WHERE library_id = ? GROUP BY verdict',
      )
      .all(this.lib()) as { verdict: string | null; n: number }[];
    const n = (v: string | null) => rows.find((r) => r.verdict === v)?.n ?? 0;
    const size = rows.reduce((a, r) => a + r.n, 0);
    return { size, right: n('right'), wrong: n('wrong'), open: n(null) };
  }

  /** Every book of the spot check marked and none wrong. */
  spotPassed(): boolean {
    const c = this.spotCounts();
    return c.size > 0 && c.open === 0 && c.wrong <= BL_SPOT_MAX_WRONG;
  }

  setVerdict(uuid: string, verdict: 'right' | 'wrong' | null): void {
    const st = this.state();
    if (st.progress.phase === 'write' || st.progress.phase === 'done')
      throw new Error('The spot check is closed: its links are being written or were written');
    const r = this.db
      .prepare(
        'UPDATE bookmeter_listing_spot SET verdict = ?, decided_at = ? WHERE calibre_uuid = ?',
      )
      .run(verdict, verdict ? Date.now() : null, uuid);
    if (r.changes === 0) throw new Error('Not one of the spot check’s books');
    if (st.mode === 'on' && !this.spotPassed()) this.setMode('analyse');
  }

  // ------------------------------------------------------------ writing (On)

  private async writeStep(st: BlState0, p: BlProgress, lib: string): Promise<BlStep> {
    if (st.mode !== 'on') return 'idle';
    if (!p.write.rebuilt) {
      // Made again from the reader's current snapshot (a book changed since the Preview gets
      // its identifiers as Calibre has them now; the planner skips a row whose old differs).
      if (this.proposeChunk(p, lib)) return 'more';
      p.write.rebuilt = true;
      p.cursor = '';
      this.recountUnwritten(p, lib);
      return 'more';
    }
    // Also while stage 4 is paused: a pause these books caused clears with Resume once they're gone.
    if (this.dropRemoved(p, lib) > 0 || !p.write.recounted) this.recountUnwritten(p, lib);
    const wait = this.deps.writeWait(lib);
    if (wait) {
      p.write.waiting = wait;
      return 'wait';
    }
    const r = await this.deps.batches.plan(lib, { analysisId: listingAnalysisId(p.run) });
    if (r.batch) {
      p.write.batches.push(r.batch.id);
      p.write.waiting = 'A batch is being applied';
      this.deps.log?.(`Bookmeter links: batch ${r.batch.id} planned`);
      return 'wait';
    }
    if (r.reason && !/nothing/i.test(r.reason)) {
      p.write.waiting = r.reason;
      return 'wait';
    }
    p.write.waiting = null;
    p.write.finishedAt = Date.now();
    this.next(p, 'done');
    return 'more';
  }

  // ------------------------------------------------------------ the page

  private bookOf(lib: string, run: number, row: BookRow): BlBook {
    const a = this.deps.analysis;
    const snap = a.snapshotBook(lib, row.calibre_uuid);
    const d = row.decision_json ? (JSON.parse(row.decision_json) as BlDecision) : null;
    const f = a.bookmeterFacts(lib, row.calibre_uuid);
    const prop = this.db
      .prepare(
        `SELECT state FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND field = 'identifiers' AND analysis_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(lib, row.calibre_uuid, listingAnalysisId(run)) as { state: string } | undefined;
    const withUrl = (l: BlListing) => ({ ...l, url: bookmeterUrl(l.id) });
    return {
      uuid: row.calibre_uuid,
      calibreId: row.calibre_id,
      labeled: row.labeled === 1,
      state: row.state,
      book: {
        title: snap?.title ?? null,
        authors: snap?.authors ?? [],
        decidedTitle: f && snap && f.input.title !== snap.title ? f.input.title : null,
      },
      saved: d?.saved ? withUrl(d.saved) : { id: row.saved_id, url: bookmeterUrl(row.saved_id) },
      pick: d?.pick ? withUrl(d.pick) : null,
      savedGuard: d?.savedGuard ?? null,
      proposal: row.state === 'change' && row.proposed === 1 ? (prop?.state ?? null) : null,
    };
  }

  /** The books, a page at a time, by state. */
  listBooks(
    lib: string,
    run: number,
    state: BlState,
    offset: number,
    limit: number,
  ): { total: number; items: BlBook[] } {
    const total = this.countState(lib, state);
    const rows = this.db
      .prepare(
        `SELECT * FROM bookmeter_listing_books INDEXED BY bookmeter_listing_books_state
         WHERE library_id = ? AND state = ? ORDER BY calibre_uuid LIMIT ? OFFSET ?`,
      )
      .all(lib, state, limit, offset) as BookRow[];
    this.deps.analysis.loadSnapshot(lib);
    return { total, items: rows.map((r) => this.bookOf(lib, run, r)) };
  }

  /** The spot check's books in their order, each with its verdict. */
  listSpot(lib: string, run: number): (BlBook & { verdict: 'right' | 'wrong' | null })[] {
    const rows = this.db
      .prepare(
        `SELECT b.*, s.verdict FROM bookmeter_listing_spot s
         JOIN bookmeter_listing_books b ON b.library_id = s.library_id AND b.calibre_uuid = s.calibre_uuid
         WHERE s.library_id = ? ORDER BY s.position`,
      )
      .all(lib) as (BookRow & { verdict: 'right' | 'wrong' | null })[];
    this.deps.analysis.loadSnapshot(lib);
    return rows.map((r) => ({ ...this.bookOf(lib, run, r), verdict: r.verdict }));
  }

  /** The card's counts: the books by state (one covering index). */
  bookCounts(lib: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM bookmeter_listing_books INDEXED BY bookmeter_listing_books_state
         WHERE library_id = ? GROUP BY state`,
      )
      .all(lib) as { state: string; n: number }[])
      out[r.state] = r.n;
    return out;
  }

  /** The pass's proposals by state (written, still to write, set aside). */
  proposalCounts(lib: string, run: number): Record<string, number> {
    const out: Record<string, number> = {};
    const q = this.db.prepare(
      `SELECT COUNT(*) AS n FROM proposed_changes INDEXED BY proposed_changes_counts
       WHERE stage = 4 AND library_id = ? AND state = ? AND field = 'identifiers' AND analysis_id = ?`,
    );
    for (const s of ['proposed', 'queued', 'applied', 'skipped', 'undone'])
      out[s] = (q.get(lib, s, listingAnalysisId(run)) as { n: number }).n;
    return out;
  }

  /** Authors whose page Bookmeter refused and that wait to be asked again. */
  refusedOpen(lib: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_author_walks INDEXED BY bookmeter_author_walks_state
           WHERE library_id = ? AND state = 'walk' AND retries > 0`,
        )
        .get(lib) as { n: number }
    ).n;
  }

  /**
   * Walks open from before their estimate was kept (a deploy mid-run): pages left from the
   * pages already read (the cache), a few per step.
   */
  private estimateOpenWalks(lib: string, cap: number, t0: number): void {
    const rows = this.db
      .prepare(
        `SELECT author, stop, pages FROM bookmeter_author_walks INDEXED BY bookmeter_author_walks_state
         WHERE library_id = ? AND state = 'walk' AND pages > 0 AND left_pages IS NULL LIMIT 50`,
      )
      .all(lib) as { author: string; stop: number; pages: number }[];
    const set = this.db.prepare(
      'UPDATE bookmeter_author_walks SET first_reg = ?, left_pages = ? WHERE library_id = ? AND author = ?',
    );
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      const first = this.stored(bookmeterAuthorPage(r.author, 1).key) ?? [];
      const last =
        r.pages === 1 ? first : (this.stored(bookmeterAuthorPage(r.author, r.pages).key) ?? []);
      const firstReg = countOf(first[0]);
      const left = walkPagesLeft(firstReg, countOf(last[last.length - 1]), r.pages, r.stop, cap);
      set.run(firstReg, left, lib, r.author);
    }
  }

  /**
   * Pages the open walks still read: each walk's estimate, a walk not estimated yet counted as
   * the mean pages of the walks ended in this run (at least one).
   */
  pagesLeft(lib: string): number {
    const open = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN w.left_pages IS NULL THEN 1 ELSE 0 END) AS unknown,
                SUM(COALESCE(w.left_pages, 0)) AS left
         FROM bookmeter_author_walks w INDEXED BY bookmeter_author_walks_state
         WHERE w.library_id = ? AND w.state IN ('wait', 'walk')`,
      )
      .get(lib) as { n: number; unknown: number | null; left: number | null };
    if (!open.n) return 0;
    const ended = this.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(pages) AS pages FROM bookmeter_author_walks INDEXED BY bookmeter_author_walks_state
         WHERE library_id = ? AND state = 'done'`,
      )
      .get(lib) as { n: number; pages: number | null };
    const mean = ended.n ? Math.max(1, (ended.pages ?? 0) / ended.n) : 1;
    // An estimated walk's estimate counts its page in flight; a walk without one has it in mean.
    return Math.round((open.left ?? 0) + (open.unknown ?? 0) * mean);
  }

  /** Authors whose walk has not ended. */
  openSearches(lib: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_author_walks INDEXED BY bookmeter_author_walks_state
           WHERE library_id = ? AND state IN ('wait', 'walk')`,
        )
        .get(lib) as { n: number }
    ).n;
  }

  /** The write's pace from its last finished batches (as More direct links'). */
  private writePace(batchIds: string[]): { ms: number; items: number } | null {
    const recent = batchIds.slice(-12);
    if (!recent.length) return null;
    const rows = this.db
      .prepare(
        `SELECT created_at, finished_at, item_count FROM batches
         WHERE id IN (${recent.map(() => '?').join(', ')}) AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 5`,
      )
      .all(...recent) as { created_at: number; finished_at: number; item_count: number }[];
    if (!rows.length) return null;
    const first = Math.min(...rows.map((r) => r.created_at));
    const items = rows.reduce((a, r) => a + r.item_count, 0);
    return rows[0].finished_at > first && items > 0
      ? { ms: rows[0].finished_at - first, items }
      : null;
  }

  /** The card: mode, phase, the phase's bar with the time left, the counts and the spot check. */
  status(lib: string | null, now = Date.now(), siteWait: string | null = null): unknown {
    const st = this.state();
    const p = st.progress;
    const proposals = lib ? this.proposalCounts(lib, p.run) : {};
    return {
      mode: st.mode,
      pausedReason: st.pausedReason,
      pausedDetail: st.pausedDetail,
      stage4Done: this.deps.stage4Done(),
      progress: p,
      bar: listingBar(p, now, {
        open: p.phase === 'search' && lib ? this.openSearches(lib) : 0,
        pagesLeft: p.phase === 'search' && p.search.enqueued && lib ? this.pagesLeft(lib) : null,
        written: (proposals.applied ?? 0) + (proposals.skipped ?? 0),
        toWrite: (proposals.proposed ?? 0) + (proposals.queued ?? 0),
        pace: p.phase === 'write' ? this.writePace(p.write.batches) : null,
      }),
      books: lib ? this.bookCounts(lib) : {},
      refusedOpen: lib && p.phase === 'search' ? this.refusedOpen(lib) : 0,
      proposals,
      spot: this.spotCounts(),
      spotPassed: this.spotPassed(),
      spotSize: BL_SPOT_SIZE,
      siteWait,
    };
  }
}

// ---------------------------------------------------------------- the card's bar

export interface BlBar {
  phase: BlPhase;
  done: number;
  total: number | null;
  leftMs: number | null;
}

/** A listing's registrations, or null. */
function countOf(h: BookmeterHit | undefined): number | null {
  return h && typeof h.registrations === 'number' ? h.registrations : null;
}

const PACE_MARK_MS = 5 * 60_000;
const PACE_WINDOW_MS = 60 * 60_000;
/** Pages a page pace is measured from before it is trusted. */
const MIN_PAGES = 30;

/** Adds a mark of the pages read every 5 minutes, keeping a little over the last hour. */
export function markPace(p: BlProgress, now: number): void {
  if (!p.search.enqueued) return;
  const marks = (p.search.paceMarks ??= []);
  const last = marks[marks.length - 1];
  if (last && now - last[0] < PACE_MARK_MS) return;
  marks.push([now, p.search.pages ?? 0]);
  while (marks.length > 2 && now - marks[1][0] >= PACE_WINDOW_MS) marks.shift();
}

/** Milliseconds per page over the last hour (the oldest mark kept), or null. */
export function pagePace(marks: [number, number][], pages: number, now: number): number | null {
  const from = marks[0];
  if (!from) return null;
  const read = pages - from[1];
  const ms = now - from[0];
  return read >= MIN_PAGES && ms > 0 ? ms / read : null;
}

/** Answers or steps a rate is measured from before it is trusted. */
const MIN_MEASURED = 100;

/**
 * The phase's bar and time left: what is open, at the pace this phase has had since it started
 * (WP20 lessons 4: from what is open, never a mean over another stretch). The search's pace is
 * the answers since the phase started; the write's its last finished batches'.
 */
export function listingBar(
  p: BlProgress,
  now: number,
  w: {
    open: number;
    /** Pages the open walks still read (estimated), else null. */
    pagesLeft?: number | null;
    written: number;
    toWrite: number;
    pace: { ms: number; items: number } | null;
  },
): BlBar {
  const ms = now - (p.phaseStartedAt ?? now);
  switch (p.phase) {
    case 'search': {
      if (!p.search.enqueued)
        return { phase: p.phase, done: p.search.looked, total: p.books || null, leftMs: null };
      // Version 3: the authors' walks (w.open: walks not ended), paced by walks ended since every
      // book was queued. A run of version 2 is never shown here (it starts again by itself).
      const walked = p.search.walked ?? 0;
      const total = walked + w.open;
      const since = p.search.since;
      const paced = since ? walked - since.answered : 0;
      const pacedMs = since ? now - since.at : 0;
      // Paced by pages over the last hour (walks differ: one page or up to the cap).
      const pace = pagePace(p.search.paceMarks ?? [], p.search.pages ?? 0, now);
      const left =
        w.open === 0
          ? 0
          : typeof w.pagesLeft === 'number' && pace
            ? Math.round(w.pagesLeft * pace)
            : paced >= MIN_MEASURED && pacedMs > 0
              ? Math.round((w.open * pacedMs) / paced)
              : null;
      return { phase: p.phase, done: walked, total: total || null, leftMs: left };
    }
    case 'propose': {
      const t = p.propose.total;
      const left =
        t && p.propose.done >= MIN_MEASURED && ms > 0
          ? Math.round(((t - p.propose.done) * ms) / p.propose.done)
          : null;
      return { phase: p.phase, done: p.propose.done, total: t || null, leftMs: left };
    }
    case 'write': {
      if (!p.write.rebuilt)
        return {
          phase: p.phase,
          done: p.propose.done,
          total: p.propose.total || null,
          leftMs: null,
        };
      const total = w.written + w.toWrite;
      return {
        phase: p.phase,
        done: w.written,
        total: total || null,
        leftMs: w.pace && w.toWrite > 0 ? Math.round((w.toWrite * w.pace.ms) / w.pace.items) : null,
      };
    }
    default:
      return { phase: p.phase, done: 0, total: null, leftMs: null };
  }
}
