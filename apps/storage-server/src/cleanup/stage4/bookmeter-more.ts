/**
 * More Bookmeter coverage, step 2 (design `bookmeter-coverage.md`, "Decided after the measuring";
 * plan approved by the user 2026-11-23): one pass over stage 4's stored Bookmeter answers for the
 * books without a match, with its own Off / Preview / On (bookmeter_more_state, cleanup.db v30).
 *
 * Phases, in the design's order, each resumable (cursors and rows in cleanup.db):
 *   match   the stored search answer read again from the fetch cache (whole titles from the
 *           cover's alt text) and decided by acceptBookmeter (today's checks, then the chosen
 *           rules); a book whose closest result fails one check waits for the AI check, a book
 *           with no results for the second search (bonus stories and omnibus editions left out).
 *           Today's matches are kept: books with one are never looked at.
 *   ai      Haiku AND Luna asked whether the closest result is the same book (step 1's prompt
 *           bm-near-1, through the shared AI runner and the monthly limit); both yes = a match.
 *   second  Q1 (the title without its subtitle) when it differs from the first query, then Q2
 *           (Q1 with the first author in Bookmeter's author field) when Q1 found no match;
 *           decided by acceptBookmeter only (user: no AI check for these).
 *   stores  every new match's store list (the shared stores:<id> key: one fetched before is free).
 *   propose one identifiers proposal per book: stage 4's own add-only keys (bookmeter, isbn,
 *           rakuten, honto, ebookjapan, unext, bookwalker when none, natively by ISBN) under this
 *           pass's analysis id, so stage 4's own On never plans them.
 *   spot    50 books drawn in proportion to what each source adds; the user marks each one.
 *   write   On only, after the spot check passed (at most 1 wrong): the proposals made again from
 *           the reader's current snapshot, then written through stage 4's batches (Undo per batch).
 *
 * The pass's requests go in at priority -1 (the daily new arrivals' searches never wait behind
 * them) and at Bookmeter's own pace (the queue's site settings). Its waiters are its own
 * (bookmeter_more_waiters; stage 4's lookups take every ready row of fetch_waiters). Work is done
 * in slices of about 25 ms, so the server is never held.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import type { AiCounts, AiItem, AiRunner } from '../../ai/runner';
import { runSpend } from '../../ai/spend';
import type { AiStageSpec } from '../../ai/types';
import { waitIsNote, waitNeedsUser, waitText, type AiWait } from '../../ai/waits';
import { getSettings } from '../settings';
import { loadGold, mapLabeledIds } from '../stage2-gate';
import type { Stage2Batches } from '../stage2-batches';
import { getStage } from '../stages';
import { nfkc } from '../title-rules';
import { oneTimePassesDone, type BookmeterFacts, type Stage4Analysis } from './analysis';
import { chosenDecision, judge, mainTitle, type Check, type Gold } from './bookmeter-rules';
import type { FetchQueue } from './queue';
import {
  BOOKMETER_AUTHOR_LIST_KEY,
  BOOKMETER_PAGE_SIZE,
  BOOKMETER_SEARCH_KEY,
  acceptBookmeter,
  bookmeterAuthorPage,
  bookmeterSearchUrl,
  bookmeterStoresUrl,
  editionNotes,
  parseBookmeterSearch,
  parseBookmeterStores,
  type BookmeterHit,
  type StoreIds,
} from './store-links';

export const BM_PHASES = [
  'match',
  'ai',
  'second',
  'stores',
  'propose',
  'spot',
  'write',
  'done',
] as const;
export type BmPhase = (typeof BM_PHASES)[number];
export type BmMode = 'off' | 'analyse' | 'on';
export type BmSource = 'rules' | 'ai' | 'second';

/** The spot check's size and its bar (design: 50 books, at most 1 wrong). */
export const SPOT_SIZE = 50;
export const SPOT_MAX_WRONG = 1;
/**
 * The pass's requests wait behind everything else in the queue (the daily new arrivals' first):
 * labeled books' at -1, the others' at -2.
 */
export const BM_PRIORITY = -1;
/** Work per slice before the server gets the event loop back (lesson 3: never hold it). */
const SLICE_MS = 25;
const STAGE_KEY = 'bookmeter-near';

/** The analysis id of the pass's proposals (stage 4's planner takes them by it). */
export function bookmeterAnalysisId(run: number): string {
  return `bookmeter-more:${run}`;
}

// ---------------------------------------------------------------- the AI check (step 1's)

export interface NearEvidence {
  book: {
    title: string;
    fileTitle: string | null;
    calibreTitle: string;
    authors: string[];
    series: string | null;
    number: number | null;
  };
  result: { title: string; authors: string[]; pages: number | null };
  failedCheck: Check;
}

const NEAR_SYSTEM = `You compare a Japanese e-book in a personal library with one search result from Bookmeter (読書メーター), a Japanese book-cataloguing site, and decide whether the result is the same book: the same work AND the same volume AND the same edition (a different volume, a different book in the same series, a collection or omnibus, a different translation, a manga adaptation of a novel, or a special edition such as 大活字/新装版 that the library book is not, are all "no").
Bookmeter's titles usually end with the publisher's label in brackets, e.g. "(電撃文庫 す 9-5)" or "(GAノベル)"; the letters and numbers inside a label are a catalogue code, not a volume number. Bookmeter may list the illustrator or translator as authors, write a name with a space where the book has ・, or use an older kanji form of a name (國/国).
"failedCheck" says which of the automatic checks the result failed: title (the titles differ after cleaning), author (no author name in common), volume (the numbers in the titles differ) or edition (the result names an edition the book does not).
Answer "yes" only when you are confident it is the same book, "no" when it is not, and "unsure" otherwise. Give a short reason.`;

/**
 * The near-miss check exactly as measured in step 1 (scripts/bookmeter-coverage-ai.ts, prompt
 * bm-near-1): stage 4's two models; accepted only when both say yes.
 */
export const NEAR_SPEC: AiStageSpec<NearEvidence, 'primary' | 'secondary'> = {
  stage: STAGE_KEY,
  promptVersion: 'bm-near-1',
  tasks: { primary: 'stage4.primary', secondary: 'stage4.secondary' },
  system: NEAR_SYSTEM,
  userText: (e) => JSON.stringify(e),
  schema: {
    type: 'object',
    properties: {
      same_book: { type: 'string', enum: ['yes', 'no', 'unsure'] },
      reason: { type: 'string' },
    },
    required: ['same_book', 'reason'],
    additionalProperties: false,
  },
  schemaName: 'same_book',
  parseAnswer: (raw) => {
    const r = raw as { same_book?: unknown; reason?: unknown } | null;
    if (!r || !['yes', 'no', 'unsure'].includes(String(r.same_book))) return null;
    return { same_book: r.same_book, reason: typeof r.reason === 'string' ? r.reason : '' };
  },
  evidenceText: (e) => JSON.stringify(e),
};

/**
 * Near misses with several results that each fail only one check (user, 2026-11-23, after the
 * live Preview: shown only the closest, both models took 富士見ミステリー文庫's print edition of
 * Dクラッカーズ・ショートII for the 富士見ファンタジア文庫 e-book whose own entry was among the
 * results). Every such result is shown, with the book's own store titles (they name its label);
 * a match only when both models choose the same result.
 */
export interface NearMultiEvidence {
  book: NearEvidence['book'] & { storeTitles: string[] };
  results: {
    id: string;
    title: string;
    authors: string[];
    pages: number | null;
    failedCheck: Check;
  }[];
}

const NEAR_MULTI_SYSTEM = `You compare a Japanese e-book in a personal library with several search results from Bookmeter (読書メーター), a Japanese book-cataloguing site, and decide which result, if any, is the same book: the same work AND the same volume AND the same edition (a different volume, a different book in the same series, a collection or omnibus, a different translation, a manga adaptation of a novel, or a special edition such as 大活字/新装版 that the library book is not, are all not the same book).
"storeTitles" are the library book's own titles at e-book stores (Amazon, BOOK☆WALKER) when they were found; they usually name its label. A result in another label is another edition of the work (for example a print edition in 富士見ミステリー文庫 when the library book is the 富士見ファンタジア文庫 edition), so it is not the same book; prefer the result whose label agrees with the store titles.
Bookmeter's titles usually end with the publisher's label in brackets, e.g. "(電撃文庫 す 9-5)" or "(GAノベル)"; the letters and numbers inside a label are a catalogue code, not a volume number. Bookmeter may add the series name after the title, list the illustrator or translator as authors, write a name with a space where the book has ・, or use an older kanji form of a name (國/国).
Each result's "failedCheck" says which automatic check it failed: title (the titles differ after cleaning), author (no author name in common), volume (the numbers in the titles differ) or edition (the result names an edition the book does not).
Answer with the "id" of the one result that is the same book only when you are confident; "none" when no result is the same book; "unsure" otherwise. Give a short reason.`;

/** The candidates' check (prompt bm-near-2, its own queue key): both models choose one id. */
export const NEAR_MULTI_SPEC: AiStageSpec<NearMultiEvidence, 'primary' | 'secondary'> = {
  stage: 'bookmeter-near2',
  promptVersion: 'bm-near-2',
  tasks: { primary: 'stage4.primary', secondary: 'stage4.secondary' },
  system: NEAR_MULTI_SYSTEM,
  userText: (e) => JSON.stringify(e),
  schema: {
    type: 'object',
    properties: { match: { type: 'string' }, reason: { type: 'string' } },
    required: ['match', 'reason'],
    additionalProperties: false,
  },
  schemaName: 'bookmeter_match',
  parseAnswer: (raw) => {
    const r = raw as { match?: unknown; reason?: unknown } | null;
    if (!r || typeof r.match !== 'string' || r.match.trim() === '') return null;
    return { match: r.match.trim(), reason: typeof r.reason === 'string' ? r.reason : '' };
  },
  evidenceText: (e) => JSON.stringify(e),
};

/**
 * The near-miss rules' version: 2 = several one-check results go to NEAR_MULTI_SPEC. A Preview
 * finished before it asks those books again once (reaskStep).
 */
export const NEAR_VERSION = 2;
const MULTI = 'several';
/** Phases after the AI check and before any write: a finished Preview there is asked again. */
const REASK_PHASES = new Set<string>(['second', 'stores', 'propose', 'spot']);

// ---------------------------------------------------------------- state

/** What a book's row remembers of its Bookmeter result. */
export interface BmHit {
  id: string;
  title: string;
  listTitle?: string;
  authors: string[];
  pages: number | null;
  /** acceptBookmeter's reason (a match) or the check the closest result failed (near). */
  reason?: string;
  /** The search it came from (second search: q1 / q2). */
  query?: 'stored' | 'q1' | 'q2';
  /** The ASIN stage 4 identified (Natively's lookup at proposing). */
  asin?: string | null;
  /** Several results failing only one check: all of them (NEAR_MULTI_SPEC). */
  candidates?: (BookmeterHit & { failed: Check })[];
}

interface Rate {
  /** When the phase's measuring started and how much was done then. */
  at: number;
  done: number;
}

export interface BmProgress {
  run: number;
  libraryId: string | null;
  phase: BmPhase;
  cursor: string;
  startedAt: number | null;
  phaseStartedAt: number | null;
  /** The books stage 4 proposed (the match phase's total). */
  books: number;
  counts: {
    looked: number;
    /** Books with a match before (kept), the user's store links, a bookmeter id already. */
    before: number;
    yours: number;
    hasId: number;
    notSearched: number;
    /** Books without results left out of the second search (bonus stories, omnibus editions). */
    leftOut: number;
    rules: number;
    near: number;
    second: number;
    none: number;
  };
  ai: {
    askKey: string | null;
    items: number;
    accepted: number;
    notAccepted: number;
    wait: string | null;
    costUsd: number;
    rate: Rate | null;
  };
  second: { books: number; asked: number; found: number; rate: Rate | null; enqueued: boolean };
  stores: { asked: number; answered: number; failed: number; rate: Rate | null; enqueued: boolean };
  propose: { proposed: number; held: number; nothing: number; yours: number };
  spot: { drawnAt: number | null; size: number; notified: boolean };
  write: { rebuilt: boolean; batches: string[]; waiting: string | null; finishedAt: number | null };
  labeled: { matches: number; flagged: { calibreId: number; why: string[] }[] } | null;
  /** Milliseconds of work per phase (the NAS timing). */
  times: Record<string, number>;
  finishedAt: number | null;
  /** NEAR_VERSION the near misses were decided with (missing = 1). */
  nearVersion?: number;
  /** The one-time re-ask of a finished Preview's near misses (reaskStep). */
  reask?: { cursor: string; asked: number } | null;
}

export function emptyBmProgress(run = 1, libraryId: string | null = null): BmProgress {
  return {
    run,
    libraryId,
    phase: 'match',
    cursor: '',
    startedAt: null,
    phaseStartedAt: null,
    books: 0,
    counts: {
      looked: 0,
      before: 0,
      yours: 0,
      hasId: 0,
      notSearched: 0,
      leftOut: 0,
      rules: 0,
      near: 0,
      second: 0,
      none: 0,
    },
    ai: {
      askKey: null,
      items: 0,
      accepted: 0,
      notAccepted: 0,
      wait: null,
      costUsd: 0,
      rate: null,
    },
    second: { books: 0, asked: 0, found: 0, rate: null, enqueued: false },
    stores: { asked: 0, answered: 0, failed: 0, rate: null, enqueued: false },
    propose: { proposed: 0, held: 0, nothing: 0, yours: 0 },
    spot: { drawnAt: null, size: 0, notified: false },
    write: { rebuilt: false, batches: [], waiting: null, finishedAt: null },
    labeled: null,
    times: {},
    finishedAt: null,
    nearVersion: NEAR_VERSION,
    reask: null,
  };
}

export interface BmState {
  libraryId: string | null;
  mode: BmMode;
  progress: BmProgress;
  pausedReason: string | null;
  pausedDetail: string | null;
  updatedAt: number;
}

export function getBmState(db: Database.Database, libraryId: string): BmState {
  db.prepare(
    `INSERT OR IGNORE INTO bookmeter_more_state (library_id, updated_at) VALUES (?, 0)`,
  ).run(libraryId);
  const r = db
    .prepare('SELECT * FROM bookmeter_more_state WHERE library_id = ?')
    .get(libraryId) as {
    library_id: string | null;
    mode: BmMode;
    progress_json: string;
    paused_reason: string | null;
    paused_detail: string | null;
    updated_at: number;
  };
  const stored = JSON.parse(r.progress_json) as Partial<BmProgress>;
  const base = emptyBmProgress();
  return {
    libraryId: r.library_id,
    mode: r.mode,
    // A run saved before NEAR_VERSION existed was decided with version 1 (not the default).
    progress: stored.phase ? { ...base, ...stored, nearVersion: stored.nearVersion ?? 1 } : base,
    pausedReason: r.paused_reason,
    pausedDetail: r.paused_detail,
    updatedAt: r.updated_at,
  };
}

function saveProgress(db: Database.Database, libraryId: string, p: BmProgress): void {
  db.prepare(
    `INSERT OR IGNORE INTO bookmeter_more_state (library_id, updated_at) VALUES (?, 0)`,
  ).run(libraryId);
  db.prepare(
    'UPDATE bookmeter_more_state SET progress_json = ?, updated_at = ? WHERE library_id = ?',
  ).run(JSON.stringify(p), Date.now(), libraryId);
}

function setPause(
  db: Database.Database,
  libraryId: string,
  reason: string | null,
  detail: string | null,
): void {
  db.prepare(
    'UPDATE bookmeter_more_state SET paused_reason = ?, paused_detail = ?, updated_at = ? WHERE library_id = ?',
  ).run(reason, detail, Date.now(), libraryId);
}

// ---------------------------------------------------------------- the spot check's draw

/**
 * How many of the spot check's books each source gets: in proportion to what it adds (largest
 * remainder), at least one from every source that added any. Pure.
 */
export function spotShares(
  adds: Partial<Record<BmSource, number>>,
  size = SPOT_SIZE,
): Record<BmSource, number> {
  const sources: BmSource[] = ['rules', 'ai', 'second'];
  const total = sources.reduce((a, s) => a + (adds[s] ?? 0), 0);
  const out: Record<BmSource, number> = { rules: 0, ai: 0, second: 0 };
  if (total === 0) return out;
  const n = Math.min(size, total);
  const exact = sources.map((s) => ({ s, x: ((adds[s] ?? 0) * n) / total }));
  for (const e of exact) out[e.s] = Math.floor(e.x);
  let left = n - sources.reduce((a, s) => a + out[s], 0);
  for (const e of [...exact].sort((a, b) => b.x - Math.floor(b.x) - (a.x - Math.floor(a.x)))) {
    if (left <= 0) break;
    if ((adds[e.s] ?? 0) > out[e.s]) {
      out[e.s]++;
      left--;
    }
  }
  // At least one from every source that added any (taken from the largest share).
  for (const s of sources) {
    if ((adds[s] ?? 0) > 0 && out[s] === 0) {
      const from = sources.filter((x) => x !== s).sort((a, b) => out[b] - out[a])[0];
      if (out[from] > 1) {
        out[from]--;
        out[s]++;
      }
    }
  }
  return out;
}

/** The draw's order: a fixed hash of the run and the book (the same 50 on every server). */
export function spotOrderKey(run: number, uuid: string): string {
  return createHash('sha256').update(`bookmeter-spot:${run}:${uuid}`).digest('hex');
}

// ---------------------------------------------------------------- the pass

export interface BookmeterMoreDeps {
  db: Database.Database;
  analysis: Stage4Analysis;
  queue: FetchQueue;
  runner: AiRunner;
  batches: Stage2Batches;
  /** The library the cleanup works on (null = none chosen). */
  targetLibrary: () => string | null;
  /** Stage 4's AI check is done (the pass reads its decisions' inputs only after it). */
  stage4Done: () => boolean;
  /** Why a write must wait now (a batch open, stages 1-3 writing, the safety checks), else null. */
  writeWait: (libraryId: string) => string | null;
  /** The labeled books' file (stage 4's gate), for the labeled line on the card. */
  referenceFile: () => string | null;
  log?: (m: string) => void;
}

export type BmStep = 'more' | 'wait' | 'idle';

export class BookmeterMore {
  /** Manga part B: the library this pass works on (one instance per library). */
  private lib(): string {
    return this.deps.targetLibrary() ?? '';
  }

  private readonly db: Database.Database;
  constructor(private readonly deps: BookmeterMoreDeps) {
    this.db = deps.db;
  }

  state(): BmState {
    return getBmState(this.db, this.lib());
  }

  /** Off / Preview / On. On only after the spot check passed. */
  setMode(mode: BmMode): void {
    if (mode === 'on' && !this.spotPassed()) {
      throw new Error(
        `On needs the spot check first: every one of the ${SPOT_SIZE} books marked, at most ${SPOT_MAX_WRONG} wrong`,
      );
    }
    this.db
      .prepare(`INSERT OR IGNORE INTO bookmeter_more_state (library_id, updated_at) VALUES (?, 0)`)
      .run(this.lib());
    this.db
      .prepare('UPDATE bookmeter_more_state SET mode = ?, updated_at = ? WHERE library_id = ?')
      .run(mode, Date.now(), this.lib());
    this.deps.log?.(`More Bookmeter matches: ${mode === 'analyse' ? 'Preview' : mode}`);
  }

  /** One step of the pass; 'idle' when there is nothing to do now. Never throws. */
  async step(shouldStop: () => boolean = () => false): Promise<BmStep> {
    const st = this.state();
    if (st.mode === 'off') return 'idle';
    const lib = this.deps.targetLibrary();
    if (!lib || !this.deps.stage4Done()) return 'idle';
    const p = st.progress;
    if (p.libraryId !== lib) {
      // Another library: start over for it (its own books).
      const fresh = emptyBmProgress(p.run + (p.libraryId ? 1 : 0), lib);
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM bookmeter_more_books WHERE library_id = ?').run(lib);
        this.db.prepare('DELETE FROM bookmeter_more_waiters WHERE library_id = ?').run(lib);
        this.db.prepare('DELETE FROM bookmeter_more_spot WHERE library_id = ?').run(lib);
        saveProgress(this.db, this.lib(), fresh);
      })();
      return 'more';
    }
    if (p.phase === 'done') return 'idle';
    p.startedAt ??= Date.now();
    p.phaseStartedAt ??= Date.now();
    const t = performance.now();
    let r: BmStep;
    try {
      r =
        (p.nearVersion ?? 1) < NEAR_VERSION && REASK_PHASES.has(p.phase)
          ? this.reaskStep(p, lib)
          : await this.phaseStep(st, p, lib, shouldStop);
    } finally {
      p.times[p.phase] = (p.times[p.phase] ?? 0) + (performance.now() - t);
      saveProgress(this.db, this.lib(), p);
    }
    return r;
  }

  private next(p: BmProgress, phase: BmPhase): void {
    this.deps.log?.(`More Bookmeter matches: ${p.phase} done; ${phase} next`);
    p.phase = phase;
    p.cursor = '';
    p.phaseStartedAt = Date.now();
    if (phase === 'done') p.finishedAt = Date.now();
  }

  private async phaseStep(
    st: BmState,
    p: BmProgress,
    lib: string,
    shouldStop: () => boolean,
  ): Promise<BmStep> {
    switch (p.phase) {
      case 'match':
        return this.matchStep(p, lib);
      case 'ai':
        return this.aiStep(p, lib, shouldStop);
      case 'second':
        return this.secondStep(p, lib);
      case 'stores':
        return this.storesStep(p, lib);
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

  // ------------------------------------------------------------ match

  private matchStep(p: BmProgress, lib: string): BmStep {
    const db = this.db;
    const a = this.deps.analysis;
    if (p.cursor === '' && p.counts.looked === 0)
      p.books = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM stage4_books WHERE library_id = ? AND state = 'proposed'`,
          )
          .get(lib) as { n: number }
      ).n;
    a.loadSnapshot(lib);
    const rows = db
      .prepare(
        `SELECT calibre_uuid, calibre_id, labeled FROM stage4_books
         WHERE library_id = ? AND state = 'proposed' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(lib, p.cursor) as { calibre_uuid: string; calibre_id: number; labeled: number }[];
    if (!rows.length) {
      this.next(p, 'ai');
      return 'more';
    }
    const yours = db.prepare(
      `SELECT 1 FROM user_fields WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers'`,
    );
    const put = db.prepare(
      `INSERT INTO bookmeter_more_books (library_id, calibre_uuid, calibre_id, labeled, state, source, hit_json, failed_check, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, calibre_uuid) DO UPDATE SET state = excluded.state, source = excluded.source,
         hit_json = excluded.hit_json, failed_check = excluded.failed_check, updated_at = excluded.updated_at`,
    );
    const t0 = performance.now();
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      p.cursor = r.calibre_uuid;
      p.counts.looked++;
      const f = a.bookmeterFacts(lib, r.calibre_uuid);
      if (!f) continue;
      if (f.bookmeter.accepted) {
        p.counts.before++;
        continue;
      }
      if (!f.bookmeter.hits) {
        p.counts.notSearched++;
        continue;
      }
      if (f.book.identifiers.bookmeter) {
        p.counts.hasId++;
        continue;
      }
      if (yours.get(lib, r.calibre_uuid)) {
        p.counts.yours++;
        continue;
      }
      const d = decideStored(f, this.deps.queue);
      const now = Date.now();
      if (d.state === 'left-out') {
        p.counts.leftOut++;
        continue;
      }
      put.run(
        lib,
        r.calibre_uuid,
        r.calibre_id,
        r.labeled,
        d.state,
        d.state === 'matched' ? 'rules' : null,
        d.hit ? JSON.stringify({ ...d.hit, asin: f.asin }) : null,
        d.failed ?? null,
        now,
      );
      p.counts[d.state === 'matched' ? 'rules' : d.state]++;
    }
    return 'more';
  }

  // ------------------------------------------------------------ the AI check

  private aiKey(): string {
    const s = getSettings(this.db);
    return createHash('sha256')
      .update(
        JSON.stringify([
          NEAR_SPEC.promptVersion,
          NEAR_MULTI_SPEC.promptVersion,
          s.models['stage4.primary'],
          s.models['stage4.secondary'],
          s.ai.labeledOnly,
        ]),
      )
      .digest('hex')
      .slice(0, 16);
  }

  /** Both questions' counts in this run (the card's bar). */
  aiCounts(runId: string): AiCounts {
    const a = this.deps.runner.counts(NEAR_SPEC.stage, runId);
    const b = this.deps.runner.counts(NEAR_MULTI_SPEC.stage, runId);
    return {
      queued: a.queued + b.queued,
      sent: a.sent + b.sent,
      answered: a.answered + b.answered,
      blocked: a.blocked + b.blocked,
      invalid: a.invalid + b.invalid,
      failed: a.failed + b.failed,
    };
  }

  /** The AI check's spending in this run (both questions). */
  aiCost(runId: string): number {
    return (
      runSpend(this.db, NEAR_SPEC.stage, runId).costUsd +
      runSpend(this.db, NEAR_MULTI_SPEC.stage, runId).costUsd
    );
  }

  private async aiStep(p: BmProgress, lib: string, shouldStop: () => boolean): Promise<BmStep> {
    const db = this.db;
    const runner = this.deps.runner;
    const runId = bookmeterAnalysisId(p.run);
    const key = this.aiKey();
    if (p.ai.askKey !== key) {
      // The evidence of every near miss, then the questions (labeled books first): one result
      // with step 1's question, several results with the candidates' question.
      const a = this.deps.analysis;
      a.loadSnapshot(lib);
      const rows = db
        .prepare(
          `SELECT calibre_uuid, labeled, hit_json, failed_check FROM bookmeter_more_books
           WHERE library_id = ? AND state = 'near' ORDER BY labeled DESC, calibre_uuid`,
        )
        .all(lib) as {
        calibre_uuid: string;
        labeled: number;
        hit_json: string;
        failed_check: string;
      }[];
      for (let at = 0; at < rows.length; at += 200) {
        const one: AiItem<NearEvidence>[] = [];
        const several: AiItem<NearMultiEvidence>[] = [];
        for (const r of rows.slice(at, at + 200)) {
          const f = a.bookmeterFacts(lib, r.calibre_uuid);
          if (!f) continue;
          const hit = JSON.parse(r.hit_json) as BmHit;
          const item = { key: `${lib}:${r.calibre_uuid}`, labeled: r.labeled === 1 };
          if (r.failed_check === MULTI)
            several.push({ ...item, evidence: nearMultiEvidence(f, hit) });
          else one.push({ ...item, evidence: nearEvidence(f, hit, r.failed_check as Check) });
        }
        if (one.length) {
          runner.putItems(NEAR_SPEC, one, 1);
          const keys = one.map((i) => i.key);
          runner.enqueue(NEAR_SPEC, 'primary', keys, runId);
          runner.enqueue(NEAR_SPEC, 'secondary', keys, runId);
        }
        if (several.length) {
          runner.putItems(NEAR_MULTI_SPEC, several, 1);
          const keys = several.map((i) => i.key);
          runner.enqueue(NEAR_MULTI_SPEC, 'primary', keys, runId);
          runner.enqueue(NEAR_MULTI_SPEC, 'secondary', keys, runId);
        }
        await new Promise((res) => setImmediate(res));
      }
      // Every near miss of the run (a re-ask asks only some of them again).
      p.ai.items = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM bookmeter_more_books WHERE library_id = ? AND failed_check IS NOT NULL`,
          )
          .get(lib) as { n: number }
      ).n;
      p.ai.askKey = key;
      p.ai.rate = null;
    }
    const done = () => {
      const c = this.aiCounts(runId);
      return c.answered + c.blocked + c.invalid + c.failed;
    };
    p.ai.rate ??= { at: Date.now(), done: done() };
    const open = [NEAR_SPEC, NEAR_MULTI_SPEC].filter((s) => runner.pending(s.stage, runId) > 0);
    // Nothing to ask (no near misses, or every answer in): decide at once.
    if (!open.length) return this.aiDecide(p, lib);
    let moved = false;
    let wait: AiWait | null = null;
    let pending = 0;
    for (const spec of open) {
      const r = await runner.step(spec as AiStageSpec<unknown>, runId, shouldStop);
      pending += r.pending;
      if (r.sent > 0 || r.answered > 0) moved = true;
      if (r.wait && !wait) wait = r.wait;
    }
    p.ai.costUsd = this.aiCost(runId);
    if (wait && waitNeedsUser(wait)) {
      p.ai.wait = waitText(wait);
      const st = this.state();
      if (st.pausedReason !== 'ai' || st.pausedDetail !== p.ai.wait) {
        setPause(db, this.lib(), 'ai', p.ai.wait);
        this.deps.log?.(`More Bookmeter matches: ${p.ai.wait}`);
      }
      return 'wait';
    }
    p.ai.wait = wait ? waitText(wait) : null;
    if (!wait && this.state().pausedReason === 'ai') setPause(db, this.lib(), null, null);
    if (pending > 0) return moved && (!wait || waitIsNote(wait)) ? 'more' : 'wait';
    return this.aiDecide(p, lib);
  }

  /**
   * Every question answered (or given up): both models yes = a match (one result); both models
   * the same result's id = that result (several).
   */
  private aiDecide(p: BmProgress, lib: string): BmStep {
    const db = this.db;
    const runner = this.deps.runner;
    // Every question has its answer: a pause for the AI (the limit, a key) is over.
    if (this.state().pausedReason === 'ai') setPause(db, this.lib(), null, null);
    p.ai.wait = null;
    const near = db
      .prepare(
        `SELECT calibre_uuid, hit_json, failed_check FROM bookmeter_more_books
         WHERE library_id = ? AND state = 'near'`,
      )
      .all(lib) as { calibre_uuid: string; hit_json: string; failed_check: string }[];
    const upd = db.prepare(
      `UPDATE bookmeter_more_books SET state = ?, source = ?, hit_json = ?, updated_at = ?
       WHERE library_id = ? AND calibre_uuid = ?`,
    );
    db.transaction(() => {
      for (const n of near) {
        const k = `${lib}:${n.calibre_uuid}`;
        const hit = JSON.parse(n.hit_json) as BmHit;
        let chosen: BmHit | null = null;
        if (n.failed_check === MULTI) {
          const m1 = runner.answerOf(NEAR_MULTI_SPEC, 'primary', k)?.answer?.match;
          const m2 = runner.answerOf(NEAR_MULTI_SPEC, 'secondary', k)?.answer?.match;
          const c =
            typeof m1 === 'string' && m1 === m2
              ? hit.candidates?.find((x) => x.id === m1)
              : undefined;
          if (c)
            chosen = {
              ...plainHit(c),
              asin: hit.asin,
              candidates: hit.candidates,
              reason: `both models chose this result of ${hit.candidates?.length ?? 0} (it fails the ${c.failed} check)`,
            };
        } else {
          const a1 = runner.answerOf(NEAR_SPEC, 'primary', k);
          const a2 = runner.answerOf(NEAR_SPEC, 'secondary', k);
          if (a1?.answer?.same_book === 'yes' && a2?.answer?.same_book === 'yes')
            chosen = { ...hit, reason: `both models: the same book (${hit.reason ?? ''})` };
        }
        upd.run(
          chosen ? 'matched' : 'none',
          chosen ? 'ai' : null,
          JSON.stringify(chosen ?? hit),
          Date.now(),
          lib,
          n.calibre_uuid,
        );
      }
    })();
    // Counted from the table: a re-ask decides some books again.
    const count = (sql: string) =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM bookmeter_more_books WHERE library_id = ? AND ${sql}`)
          .get(lib) as { n: number }
      ).n;
    p.ai.accepted = count(`source = 'ai'`);
    p.ai.notAccepted = count(`state = 'none' AND failed_check IS NOT NULL`);
    this.next(p, 'second');
    return 'more';
  }

  // ------------------------------------------------------------ the one-time re-ask

  /**
   * NEAR_VERSION 2 on a Preview that finished its AI check with version 1: the near misses with
   * several one-check results (accepted or not) are asked again with every candidate; their open
   * proposals and the spot check are set aside, then the pass goes on from the AI step (store
   * lists of new matches, proposals again, a new spot check). Never once writing has started.
   */
  private reaskStep(p: BmProgress, lib: string): BmStep {
    const db = this.db;
    const a = this.deps.analysis;
    a.loadSnapshot(lib);
    const r0 = (p.reask ??= { cursor: '', asked: 0 });
    const rows = db
      .prepare(
        `SELECT calibre_uuid, hit_json FROM bookmeter_more_books
         WHERE library_id = ? AND failed_check IS NOT NULL AND failed_check <> ?
           AND (source = 'ai' OR state = 'none') AND calibre_uuid > ?
         ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(lib, MULTI, r0.cursor) as { calibre_uuid: string; hit_json: string }[];
    if (!rows.length) {
      const aid = bookmeterAnalysisId(p.run);
      db.transaction(() => {
        db.prepare('DELETE FROM bookmeter_more_spot WHERE library_id = ?').run(this.lib());
        // Open proposals of the books asked again (a match chosen now is proposed again).
        db.prepare(
          `DELETE FROM proposed_changes WHERE stage = 4 AND field = 'identifiers' AND analysis_id = ?
             AND state = 'proposed' AND batch_id IS NULL AND library_id = ? AND calibre_uuid IN (
               SELECT calibre_uuid FROM bookmeter_more_books WHERE library_id = ? AND state = 'near')`,
        ).run(aid, lib, lib);
      })();
      this.deps.log?.(
        `More Bookmeter matches: ${r0.asked} near misses with several close results are asked again with every result`,
      );
      p.nearVersion = NEAR_VERSION;
      p.reask = null;
      p.spot = { drawnAt: null, size: 0, notified: false };
      p.stores.enqueued = false;
      p.stores.rate = null;
      p.ai.askKey = null;
      this.next(p, 'ai');
      return 'more';
    }
    const set = db.prepare(
      `UPDATE bookmeter_more_books SET state = 'near', source = NULL, failed_check = ?, hit_json = ?,
         stores_json = NULL, stores_failed = 0, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
    );
    const t0 = performance.now();
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      r0.cursor = r.calibre_uuid;
      const f = a.bookmeterFacts(lib, r.calibre_uuid);
      if (!f) continue;
      const d = decideStored(f, this.deps.queue);
      if (d.state !== 'near' || d.failed !== MULTI || !d.hit) continue;
      set.run(MULTI, JSON.stringify({ ...d.hit, asin: f.asin }), Date.now(), lib, r.calibre_uuid);
      r0.asked++;
    }
    return 'more';
  }

  // ------------------------------------------------------------ the second search

  private waiter(
    lib: string,
    uuid: string,
    step: 'q1' | 'q2' | 'stores',
    spec: { key: string; url: string; accept: string },
    labeled: boolean,
  ): void {
    const r = this.deps.queue.enqueue(
      {
        site: 'bookmeter',
        key: spec.key,
        url: spec.url,
        accept: spec.accept,
        // Labeled books first among the pass's own (their gate line); both behind the rest.
        priority: labeled ? BM_PRIORITY : BM_PRIORITY - 1,
      },
      null,
    );
    const ready = r.state === 'done' || r.state === 'gone' || r.state === 'failed' ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO bookmeter_more_waiters (request_id, library_id, calibre_uuid, step, ready)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET ready = excluded.ready`,
      )
      .run(r.id, lib, uuid, step, ready);
  }

  private askQuery(
    lib: string,
    uuid: string,
    labeled: boolean,
    f: BookmeterFacts,
    from: 'start' | 'q1',
  ): 'q1' | 'q2' | null {
    const q0 = f.queryTitle;
    const q1 = mainTitle(q0);
    const au = (f.input.authors[0] ?? '').replace(/\s/gu, '');
    if (from === 'start' && q1 && q1 !== q0) {
      this.waiter(
        lib,
        uuid,
        'q1',
        {
          key: `${BOOKMETER_SEARCH_KEY}${q1}`,
          url: bookmeterSearchUrl(q1),
          accept: 'text/html, */*; q=0.01',
        },
        labeled,
      );
      return 'q1';
    }
    // Q2: the first author's listings, page by page (bookmeter-listings.md 8, the user's
    // decision 5: Bookmeter ignores the keyword of a search with the author field, so the search
    // asked before only ever showed the author's 20 most-read books).
    if (au && q1) {
      this.waiter(lib, uuid, 'q2', bookmeterAuthorPage(au, 1), labeled);
      return 'q2';
    }
    return null;
  }

  private secondStep(p: BmProgress, lib: string): BmStep {
    const db = this.db;
    const a = this.deps.analysis;
    a.loadSnapshot(lib);
    const t0 = performance.now();
    if (!p.second.enqueued) {
      const rows = db
        .prepare(
          `SELECT calibre_uuid, labeled FROM bookmeter_more_books
           WHERE library_id = ? AND state = 'second' AND query_step IS NULL AND calibre_uuid > ?
           ORDER BY calibre_uuid LIMIT 100`,
        )
        .all(lib, p.cursor) as { calibre_uuid: string; labeled: number }[];
      if (!rows.length) {
        p.second.enqueued = true;
        p.cursor = '';
        p.second.books = (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM bookmeter_more_books WHERE library_id = ? AND state = 'second'`,
            )
            .get(lib) as { n: number }
        ).n;
        // Answers already in the cache come at once: the pace is measured from the others.
        p.second.rate = { at: Date.now(), done: this.readyWaiters(['q1', 'q2']) };
        return 'more';
      }
      const set = db.prepare(
        `UPDATE bookmeter_more_books SET state = ?, query_step = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ?`,
      );
      for (const r of rows) {
        if (performance.now() - t0 > SLICE_MS) break;
        p.cursor = r.calibre_uuid;
        const f = a.bookmeterFacts(lib, r.calibre_uuid);
        const q = f ? this.askQuery(lib, r.calibre_uuid, r.labeled === 1, f, 'start') : null;
        if (q) p.second.asked++;
        set.run(q ? 'second' : 'none', q ?? 'done', Date.now(), lib, r.calibre_uuid);
      }
      return 'more';
    }
    // The answers that came back.
    const ready = db
      .prepare(
        `SELECT w.request_id, w.calibre_uuid, w.step, b.labeled, r.state AS rstate, r.key AS rkey
         FROM bookmeter_more_waiters w
         JOIN bookmeter_more_books b ON b.library_id = w.library_id AND b.calibre_uuid = w.calibre_uuid
         JOIN fetch_requests r ON r.id = w.request_id
         WHERE w.ready = 1 AND w.step IN ('q1', 'q2') LIMIT 50`,
      )
      .all() as {
      request_id: number;
      calibre_uuid: string;
      step: 'q1' | 'q2';
      labeled: number;
      rstate: string;
      rkey: string;
    }[];
    const del = db.prepare(
      'DELETE FROM bookmeter_more_waiters WHERE request_id = ? AND library_id = ? AND calibre_uuid = ? AND step = ?',
    );
    const upd = db.prepare(
      `UPDATE bookmeter_more_books SET state = ?, source = ?, hit_json = ?, query_step = ?, updated_at = ?
       WHERE library_id = ? AND calibre_uuid = ?`,
    );
    for (const w of ready) {
      if (performance.now() - t0 > SLICE_MS) break;
      del.run(w.request_id, lib, w.calibre_uuid, w.step);
      const f = a.bookmeterFacts(lib, w.calibre_uuid);
      if (!f) {
        upd.run('none', null, null, 'done', Date.now(), lib, w.calibre_uuid);
        continue;
      }
      const body = w.rstate === 'done' ? this.deps.queue.readAnswer(w.request_id) : null;
      const hits = body ? parseBookmeterSearch(body) : [];
      const acc = hits.length ? acceptBookmeter(hits, f.input) : null;
      if (acc?.hit) {
        p.second.found++;
        upd.run(
          'matched',
          'second',
          JSON.stringify({ ...plainHit(acc.hit), reason: acc.reason, query: w.step, asin: f.asin }),
          'done',
          Date.now(),
          lib,
          w.calibre_uuid,
        );
        continue;
      }
      // Q2's next page of the author's listings: while the pages are full, up to the setting.
      const page = Number(w.rkey.slice(w.rkey.lastIndexOf('\n') + 1)) || 1;
      const au = w.rkey.startsWith(BOOKMETER_AUTHOR_LIST_KEY)
        ? w.rkey.slice(BOOKMETER_AUTHOR_LIST_KEY.length, w.rkey.lastIndexOf('\n'))
        : null;
      if (
        w.step === 'q2' &&
        au &&
        hits.length >= BOOKMETER_PAGE_SIZE &&
        page < (getSettings(db).fetch.bookmeterAuthorPages ?? 8)
      ) {
        this.waiter(lib, w.calibre_uuid, 'q2', bookmeterAuthorPage(au, page + 1), w.labeled === 1);
        p.second.asked++;
        upd.run('second', null, null, 'q2', Date.now(), lib, w.calibre_uuid);
        continue;
      }
      const q =
        w.step === 'q1' ? this.askQuery(lib, w.calibre_uuid, w.labeled === 1, f, 'q1') : null;
      if (q) p.second.asked++;
      upd.run(q ? 'second' : 'none', null, null, q ?? 'done', Date.now(), lib, w.calibre_uuid);
    }
    const open = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_more_books WHERE library_id = ? AND state = 'second'`,
        )
        .get(lib) as { n: number }
    ).n;
    if (open === 0) {
      this.next(p, 'stores');
      return 'more';
    }
    return ready.length ? 'more' : 'wait';
  }

  // ------------------------------------------------------------ the store lists

  private storesStep(p: BmProgress, lib: string): BmStep {
    const db = this.db;
    const t0 = performance.now();
    if (!p.stores.enqueued) {
      const rows = db
        .prepare(
          `SELECT calibre_uuid, labeled, hit_json FROM bookmeter_more_books
           WHERE library_id = ? AND state = 'matched' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
        )
        .all(lib, p.cursor) as { calibre_uuid: string; labeled: number; hit_json: string }[];
      if (!rows.length) {
        p.stores.enqueued = true;
        p.cursor = '';
        p.stores.rate = { at: Date.now(), done: this.readyWaiters(['stores']) };
        return 'more';
      }
      db.transaction(() => {
        for (const r of rows) {
          p.cursor = r.calibre_uuid;
          const hit = JSON.parse(r.hit_json) as BmHit;
          this.waiter(
            lib,
            r.calibre_uuid,
            'stores',
            {
              key: `stores:${hit.id}`,
              url: bookmeterStoresUrl(hit.id),
              accept: 'application/json, text/javascript, */*; q=0.01',
            },
            r.labeled === 1,
          );
          p.stores.asked++;
        }
      })();
      return 'more';
    }
    const ready = db
      .prepare(
        `SELECT w.request_id, w.calibre_uuid, r.state AS rstate FROM bookmeter_more_waiters w
         JOIN fetch_requests r ON r.id = w.request_id
         WHERE w.ready = 1 AND w.step = 'stores' LIMIT 200`,
      )
      .all() as { request_id: number; calibre_uuid: string; rstate: string }[];
    const del = db.prepare(
      `DELETE FROM bookmeter_more_waiters WHERE request_id = ? AND library_id = ? AND calibre_uuid = ? AND step = 'stores'`,
    );
    const upd = db.prepare(
      `UPDATE bookmeter_more_books SET state = 'ready', stores_json = ?, stores_failed = ?, updated_at = ?
       WHERE library_id = ? AND calibre_uuid = ?`,
    );
    db.transaction(() => {
      for (const w of ready) {
        if (performance.now() - t0 > SLICE_MS) break;
        del.run(w.request_id, lib, w.calibre_uuid);
        const body = w.rstate === 'done' ? this.deps.queue.readAnswer(w.request_id) : null;
        const stores: StoreIds = body ? parseBookmeterStores(body) : {};
        // A list that failed (or is gone) leaves the bookmeter id alone to propose.
        const failed = w.rstate === 'done' ? 0 : 1;
        p.stores.answered++;
        if (failed) p.stores.failed++;
        upd.run(JSON.stringify(stores), failed, Date.now(), lib, w.calibre_uuid);
      }
    })();
    const open = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_more_books WHERE library_id = ? AND state = 'matched'`,
        )
        .get(lib) as { n: number }
    ).n;
    if (open === 0) {
      this.next(p, 'propose');
      return 'more';
    }
    return ready.length ? 'more' : 'wait';
  }

  // ------------------------------------------------------------ proposals

  /**
   * The book's identifiers proposal under the pass's analysis id, from the reader's current
   * snapshot: stage 4's add-only keys (proposals.ts; never an id Calibre already has). Its earlier
   * open row is replaced. Held when another pass's identifiers change of the book is open.
   */
  proposeOne(
    lib: string,
    run: number,
    uuid: string,
  ): 'proposed' | 'held' | 'nothing' | 'yours' | 'gone' | 'written' {
    const db = this.db;
    const row = db
      .prepare(
        `SELECT calibre_id, source, hit_json, stores_json FROM bookmeter_more_books
         WHERE library_id = ? AND calibre_uuid = ? AND state = 'ready'`,
      )
      .get(lib, uuid) as
      | { calibre_id: number; source: BmSource; hit_json: string; stores_json: string | null }
      | undefined;
    const book = this.deps.analysis.snapshotBook(lib, uuid);
    if (!row || !book) return 'gone';
    const aid = bookmeterAnalysisId(run);
    const mine = db
      .prepare(
        `SELECT id, state FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND field = 'identifiers' AND analysis_id = ?`,
      )
      .all(lib, uuid, aid) as { id: number; state: string }[];
    // Written, being written, or undone by the user (never proposed again).
    if (mine.some((m) => m.state === 'applied' || m.state === 'queued' || m.state === 'undone'))
      return 'written';
    const other = db
      .prepare(
        `SELECT 1 FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers'
           AND state IN ('proposed', 'queued') AND (analysis_id IS NULL OR analysis_id <> ?) LIMIT 1`,
      )
      .get(lib, uuid, aid);
    const yours = db
      .prepare(
        `SELECT 1 FROM user_fields WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers'`,
      )
      .get(lib, uuid);
    const hit = JSON.parse(row.hit_json) as BmHit;
    const stores = (row.stores_json ? JSON.parse(row.stores_json) : {}) as StoreIds;
    const { ids, added } = addedIds(book.identifiers, hit.id, stores, (isbn) =>
      this.deps.analysis.nativelyId(hit.asin ?? null, isbn),
    );
    const now = Date.now();
    let out: 'proposed' | 'held' | 'nothing' | 'yours' = 'proposed';
    db.transaction(() => {
      // The earlier open row is replaced; a set-aside row stays (a batch may point at it).
      for (const m of mine)
        if (m.state === 'proposed')
          db.prepare(
            'DELETE FROM proposed_changes WHERE id = ? AND state = ? AND batch_id IS NULL',
          ).run(m.id, 'proposed');
      if (yours) out = 'yours';
      else if (!Object.keys(added).length) out = 'nothing';
      else if (other) out = 'held';
      if (out !== 'proposed') return;
      db.prepare(
        `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
           evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
         VALUES (4, ?, ?, ?, 'identifiers', ?, ?, ?, ?, 'auto', NULL, 'proposed', ?, ?, ?)`,
      ).run(
        lib,
        book.calibreId,
        uuid,
        JSON.stringify(book.identifiers),
        JSON.stringify(ids),
        Object.keys(added).join(','),
        JSON.stringify({
          added,
          bookmeter: { source: row.source, hit: plainHit(hit), reason: hit.reason ?? null },
        }),
        aid,
        now,
        now,
      );
    })();
    return out;
  }

  private proposeStep(p: BmProgress, lib: string): BmStep {
    const rows = this.db
      .prepare(
        `SELECT calibre_uuid FROM bookmeter_more_books
         WHERE library_id = ? AND state = 'ready' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(lib, p.cursor) as { calibre_uuid: string }[];
    // Counted afresh by each pass (a re-ask proposes every book again).
    if (p.cursor === '') p.propose = { proposed: 0, held: 0, nothing: 0, yours: 0 };
    if (!rows.length) {
      this.labeledLine(p, lib);
      this.next(p, 'spot');
      return 'more';
    }
    this.deps.analysis.loadSnapshot(lib);
    const t0 = performance.now();
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      p.cursor = r.calibre_uuid;
      const o = this.proposeOne(lib, p.run, r.calibre_uuid);
      if (o === 'proposed' || o === 'held' || o === 'nothing' || o === 'yours') p.propose[o]++;
    }
    return 'more';
  }

  /** The labeled books' new matches and the step-1 checker's flags (judged by eye at stop 3). */
  private labeledLine(p: BmProgress, lib: string): void {
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
          `SELECT calibre_id, hit_json FROM bookmeter_more_books
           WHERE library_id = ? AND state = 'ready' AND labeled = 1`,
        )
        .all(lib) as { calibre_id: number; hit_json: string }[];
      const flagged: { calibreId: number; why: string[] }[] = [];
      let matches = 0;
      for (const r of rows) {
        const g = byCid.get(r.calibre_id);
        if (!g) continue;
        matches++;
        const h = JSON.parse(r.hit_json) as BmHit;
        const j = judge(
          {
            ...h,
            title: h.listTitle ?? h.title,
            full: h.listTitle !== undefined ? h.title : null,
            edOk: true,
          },
          g,
        );
        if (!j.ok) flagged.push({ calibreId: r.calibre_id, why: j.why });
      }
      p.labeled = { matches, flagged };
    } catch (err) {
      this.deps.log?.(`More Bookmeter matches: the labeled books' line failed: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------ the spot check

  private spotStep(st: BmState, p: BmProgress, lib: string): BmStep {
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

  /** Draws the 50 (in proportion to what each source adds) from the books proposed. */
  drawSpot(p: BmProgress, lib: string): void {
    const db = this.db;
    const rows = db
      .prepare(
        `SELECT b.calibre_uuid, b.source FROM bookmeter_more_books b
         WHERE b.library_id = ? AND b.state = 'ready' AND EXISTS (
           SELECT 1 FROM proposed_changes c INDEXED BY proposed_changes_book
           WHERE c.library_id = b.library_id AND c.calibre_uuid = b.calibre_uuid AND c.stage = 4
             AND c.field = 'identifiers' AND c.analysis_id = ? AND c.state = 'proposed')`,
      )
      .all(lib, bookmeterAnalysisId(p.run)) as { calibre_uuid: string; source: BmSource }[];
    const by: Record<BmSource, string[]> = { rules: [], ai: [], second: [] };
    for (const r of rows) by[r.source].push(r.calibre_uuid);
    const shares = spotShares({
      rules: by.rules.length,
      ai: by.ai.length,
      second: by.second.length,
    });
    const put = db.prepare(
      `INSERT OR REPLACE INTO bookmeter_more_spot (library_id, calibre_uuid, position, source, verdict, decided_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
    );
    let pos = 0;
    db.transaction(() => {
      db.prepare('DELETE FROM bookmeter_more_spot WHERE library_id = ?').run(this.lib());
      for (const s of ['rules', 'ai', 'second'] as BmSource[]) {
        const pick = by[s]
          .map((u) => ({ u, k: spotOrderKey(p.run, u) }))
          .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
          .slice(0, shares[s]);
        for (const x of pick) put.run(lib, x.u, pos++, s);
      }
    })();
    p.spot.drawnAt = Date.now();
    p.spot.size = pos;
    this.deps.log?.(
      `More Bookmeter matches: the spot check is ready (${shares.rules} from the rules, ${shares.ai} from the AI check, ${shares.second} from the second search)`,
    );
  }

  spotCounts(): { size: number; right: number; wrong: number; open: number } {
    const rows = this.db
      .prepare(
        'SELECT verdict, COUNT(*) AS n FROM bookmeter_more_spot WHERE library_id = ? GROUP BY verdict',
      )
      .all(this.lib()) as { verdict: string | null; n: number }[];
    const n = (v: string | null) => rows.find((r) => r.verdict === v)?.n ?? 0;
    const size = rows.reduce((a, r) => a + r.n, 0);
    return { size, right: n('right'), wrong: n('wrong'), open: n(null) };
  }

  /** Every book of the spot check marked, at most SPOT_MAX_WRONG wrong. */
  spotPassed(): boolean {
    const c = this.spotCounts();
    return c.size > 0 && c.open === 0 && c.wrong <= SPOT_MAX_WRONG;
  }

  setVerdict(uuid: string, verdict: 'right' | 'wrong' | null): void {
    const st = this.state();
    if (st.mode === 'on' && st.progress.phase === 'write')
      throw new Error('The spot check is closed: its matches are being written');
    const r = this.db
      .prepare('UPDATE bookmeter_more_spot SET verdict = ?, decided_at = ? WHERE calibre_uuid = ?')
      .run(verdict, verdict ? Date.now() : null, uuid);
    if (r.changes === 0) throw new Error('Not one of the spot check’s books');
  }

  // ------------------------------------------------------------ writing (On)

  private async writeStep(st: BmState, p: BmProgress, lib: string): Promise<BmStep> {
    if (st.mode !== 'on') return 'idle';
    if (!p.write.rebuilt) {
      // Made again from the reader's current snapshot: a book changed since the Preview gets
      // its old value as Calibre has it now (the planner skips a row whose old differs).
      const rows = this.db
        .prepare(
          `SELECT calibre_uuid FROM bookmeter_more_books
           WHERE library_id = ? AND state = 'ready' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
        )
        .all(lib, p.cursor) as { calibre_uuid: string }[];
      if (!rows.length) {
        p.write.rebuilt = true;
        p.cursor = '';
        return 'more';
      }
      if (p.cursor === '') p.propose = { proposed: 0, held: 0, nothing: 0, yours: 0 };
      this.deps.analysis.loadSnapshot(lib);
      const t0 = performance.now();
      for (const r of rows) {
        if (performance.now() - t0 > SLICE_MS) break;
        p.cursor = r.calibre_uuid;
        const o = this.proposeOne(lib, p.run, r.calibre_uuid);
        if (o === 'proposed' || o === 'held' || o === 'nothing' || o === 'yours') p.propose[o]++;
      }
      return 'more';
    }
    const wait = this.deps.writeWait(lib);
    if (wait) {
      p.write.waiting = wait;
      return 'wait';
    }
    const r = await this.deps.batches.plan(lib, { analysisId: bookmeterAnalysisId(p.run) });
    if (r.batch) {
      p.write.batches.push(r.batch.id);
      p.write.waiting = 'A batch is being applied';
      this.deps.log?.(`More Bookmeter matches: batch ${r.batch.id} planned`);
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

  /** One match with its evidence (the lists and the spot check). */
  matchDetail(lib: string, run: number, uuid: string): BmMatch | null {
    const row = this.db
      .prepare(
        `SELECT calibre_id, labeled, state, source, hit_json, stores_json, stores_failed FROM bookmeter_more_books
         WHERE library_id = ? AND calibre_uuid = ?`,
      )
      .get(lib, uuid) as
      | {
          calibre_id: number;
          labeled: number;
          state: string;
          source: BmSource | null;
          hit_json: string | null;
          stores_json: string | null;
          stores_failed: number;
        }
      | undefined;
    if (!row || !row.hit_json) return null;
    const a = this.deps.analysis;
    a.loadSnapshot(lib);
    const f = a.bookmeterFacts(lib, uuid);
    // Calibre's values as the reader's snapshot has them now.
    const cal = a.snapshotBook(lib, uuid);
    const hit = JSON.parse(row.hit_json) as BmHit;
    const k = `${lib}:${uuid}`;
    const ai =
      row.source === 'ai'
        ? (['primary', 'secondary'] as const).map((role) => {
            // Several candidates: the result each model chose; one: its yes or no.
            if (hit.candidates?.length) {
              const x = this.deps.runner.answerOf(NEAR_MULTI_SPEC, role, k);
              const m = (x?.answer?.match as string | undefined) ?? null;
              return {
                model: x?.model ?? null,
                answer:
                  m === null
                    ? null
                    : m === hit.id
                      ? `chose this result (of ${hit.candidates.length})`
                      : `chose ${m}`,
                reason: (x?.answer?.reason as string | undefined) ?? null,
              };
            }
            const x = this.deps.runner.answerOf(NEAR_SPEC, role, k);
            return {
              model: x?.model ?? null,
              answer: (x?.answer?.same_book as string | undefined) ?? null,
              reason: (x?.answer?.reason as string | undefined) ?? null,
            };
          })
        : null;
    const prop = this.db
      .prepare(
        `SELECT state, new_json, evidence_json, review_reason FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND field = 'identifiers' AND analysis_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(lib, uuid, bookmeterAnalysisId(run)) as
      | {
          state: string;
          new_json: string;
          evidence_json: string | null;
          review_reason: string | null;
        }
      | undefined;
    const added = prop?.evidence_json
      ? ((JSON.parse(prop.evidence_json) as { added?: Record<string, string> }).added ?? {})
      : {};
    return {
      uuid,
      calibreId: row.calibre_id,
      labeled: row.labeled === 1,
      source: row.source,
      book: {
        calibreTitle: (cal ?? f?.book)?.title ?? null,
        calibreAuthors: (cal ?? f?.book)?.authors ?? [],
        title: f?.input.title ?? null,
        authors: f?.input.authors ?? [],
        series: f?.input.chosen?.series ?? null,
        number: f?.input.chosen?.ix ?? null,
        format: f?.input.chosen?.fmt ?? null,
      },
      result: {
        id: hit.id,
        title: hit.title,
        listTitle: hit.listTitle ?? null,
        authors: hit.authors,
        pages: hit.pages,
        url: `https://bookmeter.com/books/${hit.id}`,
        query: hit.query ?? 'stored',
      },
      reason: hit.reason ?? null,
      ai,
      storesFailed: row.stores_failed === 1,
      proposal: prop ? { state: prop.state, added, reason: prop.review_reason } : null,
    };
  }

  /** The new matches, a page at a time (by source), with their evidence. */
  listMatches(
    lib: string,
    run: number,
    source: BmSource | null,
    offset: number,
    limit: number,
  ): { total: number; items: BmMatch[] } {
    const where = `library_id = ? AND state = 'ready' ${source ? 'AND source = ?' : ''}`;
    const args: unknown[] = source ? [lib, source] : [lib];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM bookmeter_more_books WHERE ${where}`)
        .get(...args) as { n: number }
    ).n;
    const uuids = (
      this.db
        .prepare(
          `SELECT calibre_uuid FROM bookmeter_more_books WHERE ${where} ORDER BY calibre_uuid LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset) as { calibre_uuid: string }[]
    ).map((r) => r.calibre_uuid);
    return {
      total,
      items: uuids.flatMap((u) => {
        const m = this.matchDetail(lib, run, u);
        return m ? [m] : [];
      }),
    };
  }

  /** The spot check's books in their order, each with its verdict. */
  listSpot(lib: string, run: number): (BmMatch & { verdict: 'right' | 'wrong' | null })[] {
    const rows = this.db
      .prepare(
        'SELECT calibre_uuid, verdict FROM bookmeter_more_spot WHERE library_id = ? ORDER BY position',
      )
      .all(lib) as { calibre_uuid: string; verdict: 'right' | 'wrong' | null }[];
    return rows.flatMap((r) => {
      const m = this.matchDetail(lib, run, r.calibre_uuid);
      return m ? [{ ...m, verdict: r.verdict }] : [];
    });
  }

  /** The card's counts: the pass's books by state and source (one covering index). */
  bookCounts(lib: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT state, source, COUNT(*) AS n FROM bookmeter_more_books INDEXED BY bookmeter_more_books_state
         WHERE library_id = ? GROUP BY state, source`,
      )
      .all(lib) as { state: string; source: string | null; n: number }[])
      out[r.source ? `${r.state}:${r.source}` : r.state] = r.n;
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
      out[s] = (q.get(lib, s, bookmeterAnalysisId(run)) as { n: number }).n;
    return out;
  }

  /**
   * The write's pace from its last finished batches (at most 5, the waits between them included,
   * so the time left is wall-clock; a restart long ago falls out of the window): the time from
   * the first one's planning to the last one's end, and their items. Null before one finished.
   */
  writePace(batchIds: string[]): { ms: number; items: number } | null {
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

  /** The open requests of a phase (its waiters not answered yet). */
  openRequests(steps: ('q1' | 'q2' | 'stores')[]): number {
    const inList = steps.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_more_waiters WHERE ready = 0 AND step IN (${inList})`,
        )
        .get(...steps) as { n: number }
    ).n;
  }

  private readyWaiters(steps: ('q1' | 'q2' | 'stores')[]): number {
    const inList = steps.map(() => '?').join(', ');
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmeter_more_waiters WHERE ready = 1 AND step IN (${inList})`,
        )
        .get(...steps) as { n: number }
    ).n;
  }

  /** The AI check's batches still at a provider (the card says what it waits for). */
  openAiBatches(): {
    model: string;
    provider: string;
    requests: number;
    submittedAt: number;
    providerStatus: string | null;
    stalled: boolean;
  }[] {
    return (
      this.db
        .prepare(
          `SELECT model, provider, requests, submitted_at, provider_status, error FROM ai_batches
           WHERE state = 'submitted' AND stage IN (?, ?) ORDER BY submitted_at`,
        )
        .all(NEAR_SPEC.stage, NEAR_MULTI_SPEC.stage) as {
        model: string;
        provider: string;
        requests: number;
        submitted_at: number;
        provider_status: string | null;
        error: string | null;
      }[]
    ).map((b) => ({
      model: b.model,
      provider: b.provider,
      requests: b.requests,
      submittedAt: b.submitted_at,
      providerStatus: b.provider_status,
      stalled: (b.error ?? '').startsWith('stalled'),
    }));
  }

  /** Is there work in the queue that only this pass waits on (the fetch helper's alert). */
  hasFetchWork(): boolean {
    return !!this.db.prepare('SELECT 1 FROM bookmeter_more_waiters WHERE ready = 0 LIMIT 1').get();
  }
}

/** A match on the page: the book, Bookmeter's result, why it was accepted, what is added. */
export interface BmMatch {
  uuid: string;
  calibreId: number;
  labeled: boolean;
  source: BmSource | null;
  book: {
    calibreTitle: string | null;
    calibreAuthors: string[];
    title: string | null;
    authors: string[];
    series: string | null;
    number: number | null;
    format: string | null;
  };
  result: {
    id: string;
    title: string;
    listTitle: string | null;
    authors: string[];
    pages: number | null;
    url: string;
    query: string;
  };
  reason: string | null;
  ai: { model: string | null; answer: string | null; reason: string | null }[] | null;
  storesFailed: boolean;
  proposal: { state: string; added: Record<string, string>; reason: string | null } | null;
}

// ---------------------------------------------------------------- pure parts

/** A stored hit without the pass's own keys. */
function plainHit(h: BookmeterHit | BmHit): BookmeterHit {
  return {
    id: h.id,
    title: h.title,
    ...(h.listTitle !== undefined ? { listTitle: h.listTitle } : {}),
    authors: h.authors,
    pages: h.pages,
  };
}

/**
 * One book's stored search answer decided again: the cached page read with today's parser (the
 * whole titles; the stored hits when the page is gone), acceptBookmeter (today's checks, then
 * the chosen rules); else the closest result when it fails exactly one check (the AI check), or
 * the second search when there were no results (bonus stories and omnibus editions left out).
 */
export function decideStored(
  f: BookmeterFacts,
  queue: Pick<FetchQueue, 'readAnswer'>,
): {
  state: 'matched' | 'near' | 'second' | 'none' | 'left-out';
  hit?: BmHit;
  failed?: Check | typeof MULTI;
} {
  const stored = f.bookmeter.hits ?? [];
  if (!stored.length) {
    const k = f.kind ?? '';
    return k === 'bonus' || k === 'omnibus' ? { state: 'left-out' } : { state: 'second' };
  }
  const body = f.searchRequest !== null ? queue.readAnswer(f.searchRequest) : null;
  const parsed = body ? parseBookmeterSearch(body) : [];
  // The page as it was stored (the same results, now with their whole titles).
  const hits =
    parsed.length === stored.length && parsed.every((h, i) => h.id === stored[i].id)
      ? parsed
      : stored;
  const acc = acceptBookmeter(hits, f.input);
  if (acc.hit) return { state: 'matched', hit: { ...plainHit(acc.hit), reason: acc.reason } };
  const own = (f.input.own ?? [])
    .filter((t): t is string => typeof t === 'string')
    .map((t) => nfkc(t));
  const edOk = (title: string) => !editionNotes(title).some((n) => !own.some((t) => t.includes(n)));
  const decided = chosenDecision(
    hits.map((h) => ({
      ...h,
      title: h.listTitle ?? h.title,
      full: h.listTitle !== undefined ? h.title : null,
    })),
    { ...f.input.chosen!, title: f.input.title, authors: f.input.authors },
    edOk,
  );
  const c = decided.closest;
  // Several results that each fail only one check: the AI check sees all of them.
  const candidates = hits.flatMap((h, i) =>
    decided.failed[i].length === 1 ? [{ ...plainHit(h), failed: decided.failed[i][0] }] : [],
  );
  if (c && c.failed.length === 1 && candidates.length > 1) {
    return {
      state: 'near',
      hit: {
        ...plainHit(hits[c.index]),
        reason: `${candidates.length} results fail only one check`,
        candidates,
      },
      failed: MULTI,
    };
  }
  if (c && c.failed.length === 1) {
    const orig = hits[c.index];
    return {
      state: 'near',
      hit: { ...plainHit(orig), reason: `the closest result fails the ${c.failed[0]} check` },
      failed: c.failed[0],
    };
  }
  return { state: 'none' };
}

/** The AI check's evidence (step 1's, field for field). */
export function nearEvidence(f: BookmeterFacts, hit: BmHit, failed: Check): NearEvidence {
  const c = f.input.chosen!;
  return {
    book: {
      title: f.input.title,
      fileTitle: c.opfTitle ?? null,
      calibreTitle: c.calTitle,
      authors: f.input.authors,
      series: c.series,
      number: c.ix ?? null,
    },
    result: { title: hit.title, authors: hit.authors, pages: hit.pages },
    failedCheck: failed,
  };
}

/** The candidates' question evidence: the book with its store titles, every one-check result. */
export function nearMultiEvidence(f: BookmeterFacts, hit: BmHit): NearMultiEvidence {
  return {
    book: { ...nearEvidence(f, hit, 'title').book, storeTitles: f.storeTitles },
    results: (hit.candidates ?? []).map((c) => ({
      id: c.id,
      title: c.title,
      authors: c.authors,
      pages: c.pages,
      failedCheck: c.failed,
    })),
  };
}

/**
 * Stage 4's own identifiers for a Bookmeter match (proposals.ts): add-only, never an id Calibre
 * already has; BOOK☆WALKER's only when the book has none; Natively's by the ISBN (or the ASIN).
 */
export function addedIds(
  current: Record<string, string>,
  bookmeterId: string,
  st: StoreIds,
  natively: (isbn: string | null) => string | null,
): { ids: Record<string, string>; added: Record<string, string> } {
  const ids: Record<string, string> = { ...current };
  const added: Record<string, string> = {};
  const add = (k: string, val: string | null | undefined) => {
    if (!val || ids[k] === val) return;
    if (ids[k] && ids[k] !== val) return;
    ids[k] = val;
    added[k] = val;
  };
  add('bookmeter', bookmeterId);
  add('isbn', st.isbn);
  add('rakuten', st.rakuten);
  add('honto', st.honto);
  add('ebookjapan', st.ebookjapan);
  add('unext', st.unext);
  if (!ids.bookwalker) add('bookwalker', st.bookwalker);
  add('natively', natively(st.isbn ?? null));
  return { ids, added };
}

/** Is stage 4 finished enough for the pass (its analysis, one-time passes and AI check). */
export function stage4Finished(db: Database.Database, libraryId: string, aiDone: boolean): boolean {
  const p = getStage(db, libraryId, 4).progress as { phase?: string } | null;
  return !!p && p.phase === 'done' && oneTimePassesDone(p as never) && aiDone;
}

// ---------------------------------------------------------------- the card's bar

export interface BmBar {
  phase: BmPhase;
  done: number;
  total: number | null;
  /** The time left; null until there is something to measure from. */
  leftMs: number | null;
  /** True once the pace is this run's own (else counted at Bookmeter's interval, at most). */
  measured: boolean;
}

/** Answers a rate is measured from before it is trusted (as stage 4's time left: eta.ts). */
const MIN_MEASURED = 30;

/**
 * The phase's bar and time left, from what is open now at the pace measured in this phase
 * (WP20 lessons 4). A second-search Q1 that finds nothing asks one Q2: counted at most.
 */
export function bookmeterBar(
  p: BmProgress,
  now: number,
  x: {
    ai: {
      queued: number;
      sent: number;
      answered: number;
      blocked: number;
      invalid: number;
      failed: number;
    };
    /** Questions in batches still at a provider (their answers come all at once, or never). */
    aiInBatches?: number;
    openSearches: number;
    openQ1: number;
    openStores: number;
    intervalSeconds: number;
    /** The write: books written or skipped, all of the run's proposals, the recent batches' pace. */
    write?: { done: number; total: number; pace: { ms: number; items: number } | null };
  },
): BmBar | null {
  const since = (at: number | null) => (at === null ? 0 : Math.max(0, now - at));
  const pace = (rate: { at: number; done: number } | null, done: number) => {
    const n = rate ? done - rate.done : 0;
    return rate && n >= MIN_MEASURED
      ? { ms: since(rate.at) / n, measured: true }
      : { ms: x.intervalSeconds * 1000, measured: false };
  };
  switch (p.phase) {
    case 'match': {
      const done = p.counts.looked;
      const ok = done >= 200 && p.phaseStartedAt !== null;
      return {
        phase: 'match',
        done,
        total: p.books || null,
        leftMs: ok ? (since(p.phaseStartedAt) / done) * Math.max(0, p.books - done) : null,
        measured: ok,
      };
    }
    case 'ai': {
      const done = x.ai.answered + x.ai.blocked + x.ai.invalid + x.ai.failed;
      const total = done + x.ai.queued + x.ai.sent;
      const n = p.ai.rate ? done - p.ai.rate.done : 0;
      const ok = !!p.ai.rate && n >= MIN_MEASURED;
      // A batch at a provider answers all at once (or, stalled, is cancelled and asked again
      // one call each): the measured rate says nothing about it, so only the questions outside
      // batches are timed, and none while only batches are left (found live 2026-11-23: "about
      // 1 min left" for 40 min while gpt-6-luna's batch of 500 sat at OpenAI).
      const rest = Math.max(0, total - done - (x.aiInBatches ?? 0));
      return {
        phase: 'ai',
        done,
        total,
        leftMs: ok && rest > 0 ? (since(p.ai.rate!.at) / n) * rest : null,
        measured: ok,
      };
    }
    case 'second': {
      const done = Math.max(0, p.second.asked - x.openSearches);
      const sp = pace(p.second.rate, done);
      return {
        phase: 'second',
        done,
        total: p.second.asked + x.openQ1,
        leftMs: p.second.enqueued ? (x.openSearches + x.openQ1) * sp.ms : null,
        measured: sp.measured,
      };
    }
    case 'stores': {
      const sp = pace(p.stores.rate, p.stores.answered);
      return {
        phase: 'stores',
        done: p.stores.answered,
        total: p.stores.asked,
        leftMs: p.stores.enqueued ? x.openStores * sp.ms : null,
        measured: sp.measured,
      };
    }
    case 'write': {
      const w = x.write;
      if (!w) return null;
      const ok = !!w.pace && w.pace.items >= MIN_MEASURED;
      return {
        phase: 'write',
        done: w.done,
        total: w.total,
        leftMs: ok ? (w.pace!.ms / w.pace!.items) * Math.max(0, w.total - w.done) : null,
        measured: ok,
      };
    }
    case 'propose':
      return {
        phase: 'propose',
        done: p.propose.proposed + p.propose.held + p.propose.nothing + p.propose.yours,
        total: null,
        leftMs: null,
        measured: false,
      };
    default:
      return null;
  }
}
