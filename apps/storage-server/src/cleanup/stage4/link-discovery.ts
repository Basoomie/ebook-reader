/**
 * More direct links (design `link-discovery.md`; plan approved by the user 2026-11-24): one pass
 * over stage 4's stored answers for the books without an Amazon, RanobeDB or BOOK☆WALKER id,
 * with its own Off / Preview / On (link_discovery_state, cleanup.db v33). It fetches nothing.
 *
 * Phases, each resumable (cursors and rows in cleanup.db), in slices of about 25 ms:
 *   record  rule A for every book with stage-4 answers: the record stage 4 picked, when it
 *           agrees with the decided values and with Calibre's (link-rules.ts).
 *   series  rule B, one Calibre series at a time: an entry of a list that holds another book's
 *           saved id, with this book's title and volume. Where both rules pick for a book and
 *           disagree, neither is kept. A saved id the series list disagrees with is only listed.
 *   settle  an id two books claim is given to neither.
 *   propose one add-only identifiers proposal per book under this pass's analysis id (stage 4's
 *           own On never plans them), with Natively's id for a new Amazon id as stage 4 finds it.
 *   spot    50 links drawn across the sites and rules (BOOK☆WALKER counted double); the user
 *           marks each one. On needs every link marked and none wrong.
 *   write   On only: the proposals made again from the reader's current snapshot, then written
 *           through stage 4's field batches (Undo per batch).
 *
 * Never: an id Calibre has is replaced or removed, a book whose identifiers are the user's is
 * touched, an id the user undid is proposed again, an id is given to two books.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { loadGold, mapLabeledIds } from '../stage2-gate';
import type { Stage2Batches } from '../stage2-batches';
import type { Stage4Analysis } from './analysis';
import { judge, type Gold } from './bookmeter-rules';
import {
  LINK_KEY,
  LINK_SITES,
  SPOT_SLOTS,
  linkRules,
  linkSpotShares,
  linkUrl,
  recordPick,
  seriesEntries,
  seriesPick,
  spotSlot,
  type LinkFacts,
  type LinkHow,
  type LinkSite,
} from './link-rules';

export const LD_PHASES = [
  'record',
  'series',
  'settle',
  'propose',
  'spot',
  'write',
  'done',
] as const;
export type LdPhase = (typeof LD_PHASES)[number];
export type LdMode = 'off' | 'analyse' | 'on';
export type LdPickState = 'ok' | 'clash' | 'differs' | 'saved';

/** The spot check: this many links, and On only with none of them wrong (the user's bar). */
export const LINK_SPOT_SIZE = 50;
export const LINK_SPOT_MAX_WRONG = 0;

const SLICE_MS = 25;
const ANALYSIS_PREFIX = 'link-discovery:';
export const linkAnalysisId = (run: number): string => `${ANALYSIS_PREFIX}${run}`;

type PerSite = Record<LinkSite, number>;
const perSite = (): PerSite => ({ amazon: 0, ranobedb: 0, bookwalker: 0 });

export interface LdProgress {
  run: number;
  libraryId: string | null;
  phase: LdPhase;
  cursor: string;
  startedAt: number | null;
  phaseStartedAt: number | null;
  /** The books stage 4 has answers for (the record phase's total). */
  books: number;
  record: {
    looked: number;
    /** Books whose identifiers are the user's (never looked at). */
    yours: number;
    /** Books whose stored answers or file facts are gone. */
    noFacts: number;
    picked: PerSite;
    /** A record whose id another book already holds. */
    taken: number;
  };
  series: {
    total: number;
    done: number;
    picked: PerSite;
    /** Both rules picked the same id / different ids (neither kept) for a book and site. */
    agree: number;
    differ: number;
    /** Saved ids the series list disagrees with (listed, never changed). */
    saved: number;
  };
  settle: { clash: number };
  propose: {
    total: number;
    done: number;
    proposed: number;
    held: number;
    nothing: number;
    yours: number;
    natively: number;
  };
  spot: { drawnAt: number | null; size: number };
  write: { rebuilt: boolean; batches: string[]; waiting: string | null; finishedAt: number | null };
  labeled: {
    links: number;
    flagged: { calibreId: number; site: LinkSite; why: string[] }[];
  } | null;
  /**
   * Milliseconds of work per phase, the longest single step, and the longest stretch the series
   * phase worked without giving the server back (the NAS timing).
   */
  times: Record<string, number>;
  longestStepMs: number;
  longestSliceMs: number;
  finishedAt: number | null;
}

export function emptyLdProgress(run = 1, libraryId: string | null = null): LdProgress {
  return {
    run,
    libraryId,
    phase: 'record',
    cursor: '',
    startedAt: null,
    phaseStartedAt: null,
    books: 0,
    record: { looked: 0, yours: 0, noFacts: 0, picked: perSite(), taken: 0 },
    series: { total: 0, done: 0, picked: perSite(), agree: 0, differ: 0, saved: 0 },
    settle: { clash: 0 },
    propose: { total: 0, done: 0, proposed: 0, held: 0, nothing: 0, yours: 0, natively: 0 },
    spot: { drawnAt: null, size: 0 },
    write: { rebuilt: false, batches: [], waiting: null, finishedAt: null },
    labeled: null,
    times: {},
    longestStepMs: 0,
    longestSliceMs: 0,
    finishedAt: null,
  };
}

export interface LdState {
  libraryId: string | null;
  mode: LdMode;
  progress: LdProgress;
  pausedReason: string | null;
  pausedDetail: string | null;
  updatedAt: number;
}

export function getLdState(db: Database.Database): LdState {
  const r = db.prepare('SELECT * FROM link_discovery_state WHERE id = 1').get() as {
    library_id: string | null;
    mode: LdMode;
    progress_json: string;
    paused_reason: string | null;
    paused_detail: string | null;
    updated_at: number;
  };
  const stored = JSON.parse(r.progress_json) as Partial<LdProgress>;
  return {
    libraryId: r.library_id,
    mode: r.mode,
    progress: stored.phase ? { ...emptyLdProgress(), ...stored } : emptyLdProgress(),
    pausedReason: r.paused_reason,
    pausedDetail: r.paused_detail,
    updatedAt: r.updated_at,
  };
}

function saveProgress(db: Database.Database, p: LdProgress): void {
  db.prepare(
    'UPDATE link_discovery_state SET progress_json = ?, library_id = ?, updated_at = ? WHERE id = 1',
  ).run(JSON.stringify(p), p.libraryId, Date.now());
}

/** The draw's order: a fixed hash of the run, the book and the site. */
export function linkSpotOrderKey(run: number, uuid: string, site: string): string {
  return createHash('sha256').update(`link-spot:${run}:${uuid}:${site}`).digest('hex');
}

/**
 * The ids a book's proposal adds: the picks' ids under stage 4's own keys, add-only (never over
 * an id the book has), never an id another book holds, and Natively's id for a new Amazon id.
 */
export function linkAddedIds(
  current: Record<string, string>,
  picks: { site: LinkSite; id: string }[],
  heldByOther: (key: string, id: string) => boolean,
  natively: (asin: string) => string | null,
): { ids: Record<string, string>; added: Record<string, string> } {
  const ids: Record<string, string> = { ...current };
  const added: Record<string, string> = {};
  for (const p of picks) {
    const key = LINK_KEY[p.site];
    if (ids[key] || !p.id || heldByOther(key, p.id)) continue;
    ids[key] = p.id;
    added[key] = p.id;
  }
  if (added.amazon_jp && !ids.natively) {
    const n = natively(added.amazon_jp);
    if (n) {
      ids.natively = n;
      added.natively = n;
    }
  }
  return { ids, added };
}

export interface LinkDiscoveryDeps {
  db: Database.Database;
  analysis: Stage4Analysis;
  batches: Stage2Batches;
  /** The library the cleanup works on (null = none chosen). */
  targetLibrary: () => string | null;
  /** Stage 4's analysis, one-time passes and AI check are done. */
  stage4Done: () => boolean;
  /** Why a write must wait now (a batch open, stages 1-3 writing, the safety checks), else null. */
  writeWait: (libraryId: string) => string | null;
  /** The labeled books' file (stage 4's gate), for the labeled line on the card. */
  referenceFile: () => string | null;
  log?: (m: string) => void;
}

export type LdStep = 'more' | 'wait' | 'idle';

interface PickRow {
  calibre_uuid: string;
  site: LinkSite;
  calibre_id: number;
  labeled: number;
  store_id: string;
  store_title: string;
  how: LinkHow;
  state: LdPickState;
  saved_id: string | null;
  proposed: number;
}

/** A link on the page: the book, the store's page, the rule that found it, what happened. */
export interface LdLink {
  uuid: string;
  calibreId: number;
  labeled: boolean;
  site: LinkSite;
  how: LinkHow;
  state: LdPickState;
  book: {
    title: string | null;
    authors: string[];
    series: string | null;
    number: number | null;
    /** Stage 4's decided title where it differs from Calibre's. */
    decidedTitle: string | null;
  };
  store: { id: string; title: string; url: string };
  /** The id Calibre holds now where the series list disagrees with it (state saved). */
  saved: { id: string; url: string } | null;
  proposal: string | null;
}

export class LinkDiscovery {
  private readonly db: Database.Database;
  /** Every id Calibre holds per key, and the series groups: rebuilt when the snapshot changes. */
  private held: { stamp: number; lib: string; maps: Map<string, Map<string, string>> } | null =
    null;
  private groups: {
    stamp: number;
    lib: string;
    keys: string[];
    map: Map<string, string[]>;
  } | null = null;

  constructor(private readonly deps: LinkDiscoveryDeps) {
    this.db = deps.db;
  }

  state(): LdState {
    return getLdState(this.db);
  }

  /** Off / Preview / On. On only after the spot check passed. */
  setMode(mode: LdMode): void {
    if (mode === 'on' && !this.spotPassed()) {
      throw new Error(`On needs the spot check first: every one of its links marked, none wrong`);
    }
    this.db
      .prepare('UPDATE link_discovery_state SET mode = ?, updated_at = ? WHERE id = 1')
      .run(mode, Date.now());
    this.deps.log?.(`More direct links: ${mode === 'analyse' ? 'Preview' : mode}`);
  }

  /**
   * Starts a new run for the library (books added or changed since the last one). Refused while
   * a run's links are being written. What was written stays; open proposals of the old run that
   * were never written are removed.
   */
  again(): void {
    const st = this.state();
    const p = st.progress;
    if (p.phase === 'write') throw new Error('The links are being written: wait for that to end');
    this.startRun(emptyLdProgress(p.run + 1, null));
    this.deps.log?.('More direct links: looking again from the start');
  }

  private startRun(fresh: LdProgress): void {
    const db = this.db;
    db.transaction(() => {
      db.prepare(
        `DELETE FROM proposed_changes WHERE stage = 4 AND field = 'identifiers'
           AND analysis_id LIKE '${ANALYSIS_PREFIX}%' AND state = 'proposed' AND batch_id IS NULL`,
      ).run();
      db.prepare('DELETE FROM link_discovery_picks').run();
      db.prepare('DELETE FROM link_discovery_spot').run();
      saveProgress(db, fresh);
    })();
  }

  /** One step of the pass; 'idle' when there is nothing to do now. */
  async step(shouldStop: () => boolean = () => false): Promise<LdStep> {
    const st = this.state();
    if (st.mode === 'off') return 'idle';
    const lib = this.deps.targetLibrary();
    if (!lib || !this.deps.stage4Done()) return 'idle';
    const p = st.progress;
    if (p.libraryId !== lib) {
      this.startRun(emptyLdProgress(p.run + (p.libraryId ? 1 : 0), lib));
      return 'more';
    }
    if (p.phase === 'done') return 'idle';
    p.startedAt ??= Date.now();
    p.phaseStartedAt ??= Date.now();
    const phase = p.phase;
    const t = performance.now();
    let r: LdStep;
    try {
      r = await this.phaseStep(st, p, lib, shouldStop);
    } finally {
      const ms = performance.now() - t;
      p.times[phase] = (p.times[phase] ?? 0) + ms;
      // The series phase yields inside a step: its own slices are what the server waits for.
      if (phase !== 'series' && phase !== 'write' && ms > p.longestStepMs) p.longestStepMs = ms;
      saveProgress(this.db, p);
    }
    return r;
  }

  private next(p: LdProgress, phase: LdPhase): void {
    this.deps.log?.(`More direct links: ${p.phase} done; ${phase} next`);
    p.phase = phase;
    p.cursor = '';
    p.phaseStartedAt = Date.now();
    if (phase === 'done') p.finishedAt = Date.now();
  }

  private async phaseStep(
    st: LdState,
    p: LdProgress,
    lib: string,
    shouldStop: () => boolean,
  ): Promise<LdStep> {
    switch (p.phase) {
      case 'record':
        return this.recordStep(p, lib);
      case 'series':
        return this.seriesStep(p, lib, shouldStop);
      case 'settle':
        return this.settleStep(p, lib);
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

  // ------------------------------------------------------------ what Calibre holds

  private heldIds(lib: string): Map<string, Map<string, string>> {
    const a = this.deps.analysis;
    const stamp = a.snapshotStamp(lib);
    if (!this.held || this.held.lib !== lib || this.held.stamp !== stamp) {
      const maps = new Map<string, Map<string, string>>();
      for (const site of LINK_SITES) maps.set(LINK_KEY[site], a.heldIds(lib, LINK_KEY[site]));
      this.held = { stamp, lib, maps };
    }
    return this.held.maps;
  }

  private heldByOther(lib: string, uuid: string): (key: string, id: string) => boolean {
    const maps = this.heldIds(lib);
    return (key, id) => {
      const who = maps.get(key)?.get(id);
      return who !== undefined && who !== uuid;
    };
  }

  private isYours(lib: string, uuid: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM user_fields WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers'`,
      )
      .get(lib, uuid);
  }

  private putPick(
    lib: string,
    f: LinkFacts,
    labeled: boolean,
    site: LinkSite,
    how: LinkHow,
    state: LdPickState,
    id: string,
    title: string,
    savedId: string | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO link_discovery_picks
           (library_id, calibre_uuid, site, calibre_id, labeled, store_id, store_title, how, state, saved_id, proposed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(library_id, calibre_uuid, site) DO UPDATE SET store_id = excluded.store_id,
           store_title = excluded.store_title, how = excluded.how, state = excluded.state,
           saved_id = excluded.saved_id, proposed = 0, updated_at = excluded.updated_at`,
      )
      .run(
        lib,
        f.uuid,
        site,
        f.calibreId,
        labeled ? 1 : 0,
        id,
        title,
        how,
        state,
        savedId,
        Date.now(),
      );
  }

  // ------------------------------------------------------------ rule A

  private recordStep(p: LdProgress, lib: string): LdStep {
    const db = this.db;
    const a = this.deps.analysis;
    if (p.cursor === '' && p.record.looked === 0)
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
        `SELECT calibre_uuid, labeled FROM stage4_books
         WHERE library_id = ? AND state = 'proposed' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(lib, p.cursor) as { calibre_uuid: string; labeled: number }[];
    if (!rows.length) {
      this.next(p, 'series');
      return 'more';
    }
    const held = this.heldIds(lib);
    const t0 = performance.now();
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      p.cursor = r.calibre_uuid;
      p.record.looked++;
      if (this.isYours(lib, r.calibre_uuid)) {
        p.record.yours++;
        continue;
      }
      const f = a.linkFacts(lib, r.calibre_uuid);
      if (!f) {
        p.record.noFacts++;
        continue;
      }
      for (const site of LINK_SITES) {
        const key = LINK_KEY[site];
        if (f.calibre.ids[key]) continue;
        const pick = recordPick(f, site);
        if (!pick) continue;
        if (held.get(key)?.has(pick.id)) {
          p.record.taken++;
          continue;
        }
        this.putPick(lib, f, r.labeled === 1, site, 'record', 'ok', pick.id, pick.title);
        p.record.picked[site]++;
      }
    }
    return 'more';
  }

  // ------------------------------------------------------------ rule B

  private seriesGroups(lib: string): { keys: string[]; map: Map<string, string[]> } {
    const a = this.deps.analysis;
    const stamp = a.snapshotStamp(lib);
    if (!this.groups || this.groups.lib !== lib || this.groups.stamp !== stamp) {
      const map = a.linkSeries(lib);
      this.groups = { stamp, lib, keys: [...map.keys()].sort(), map };
    }
    return this.groups;
  }

  private async seriesStep(p: LdProgress, lib: string, shouldStop: () => boolean): Promise<LdStep> {
    const a = this.deps.analysis;
    const { keys, map } = this.seriesGroups(lib);
    p.series.total = keys.length;
    // The next series after the cursor (the keys are sorted: a binary search).
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid] <= p.cursor && p.cursor !== '') lo = mid + 1;
      else hi = mid;
    }
    if (lo >= keys.length) {
      p.series.done = keys.length;
      this.next(p, 'settle');
      return 'more';
    }
    let t0 = performance.now();
    // The server is given back whenever a slice is used up, also inside a long series; the
    // longest stretch without that is kept (the NAS timing).
    const breathe = async () => {
      const ran = performance.now() - t0;
      if (ran <= SLICE_MS) return;
      if (ran > p.longestSliceMs) p.longestSliceMs = Math.round(ran);
      await new Promise((res) => setImmediate(res));
      t0 = performance.now();
    };
    const labeledOf = this.db.prepare(
      'SELECT labeled FROM stage4_books WHERE library_id = ? AND calibre_uuid = ?',
    );
    const pickOf = this.db.prepare(
      'SELECT store_id, how, state FROM link_discovery_picks WHERE library_id = ? AND calibre_uuid = ? AND site = ?',
    );
    const setState = this.db.prepare(
      'UPDATE link_discovery_picks SET state = ?, updated_at = ? WHERE library_id = ? AND calibre_uuid = ? AND site = ?',
    );
    const started = performance.now();
    for (let i = lo; i < keys.length; i++) {
      // One step works through whole series until its time is used; a long series yields inside.
      if (i > lo && performance.now() - started > SLICE_MS) break;
      if (shouldStop()) return 'more';
      const key = keys[i];
      const uuids = map.get(key) ?? [];
      // Only a series with a saved id at a site can say anything there (ids from the snapshot:
      // the stored answers are read only for those).
      const sites = LINK_SITES.filter((site) =>
        uuids.some((u) => a.snapshotIds(u)?.[LINK_KEY[site]]),
      );
      await breathe();
      if (sites.length) {
        const group: LinkFacts[] = [];
        for (const u of uuids) {
          const f = a.linkFacts(lib, u);
          if (f) group.push(f);
          await breathe();
        }
        const held = this.heldIds(lib);
        const rules = linkRules();
        const count = { picked: perSite(), agree: 0, differ: 0, saved: 0 };
        for (const site of sites) {
          const idKey = LINK_KEY[site];
          const entries = seriesEntries(group, site);
          if (!entries.size) continue;
          const anchors = group.filter((g) => g.calibre.ids[idKey]).length;
          for (const f of group) {
            await breathe();
            const have = f.calibre.ids[idKey];
            if (this.isYours(lib, f.uuid)) continue;
            const labeled =
              (labeledOf.get(lib, f.uuid) as { labeled: number } | undefined)?.labeled === 1;
            if (have) {
              // A saved id the list disagrees with is listed for the user, never changed. Only
              // where another book's id proves the list (the book's own id proves nothing).
              if (anchors < 2) continue;
              const other = seriesPick(
                rules,
                f,
                entries,
                (id) =>
                  held.get(idKey)?.get(id) !== undefined && held.get(idKey)?.get(id) !== f.uuid,
              );
              if (other && other.id !== have) {
                this.putPick(lib, f, labeled, site, 'series', 'saved', other.id, other.title, have);
                count.saved++;
              }
              continue;
            }
            const pick = seriesPick(rules, f, entries, (id) => !!held.get(idKey)?.has(id));
            if (!pick) continue;
            const before = pickOf.get(lib, f.uuid, site) as
              | { store_id: string; how: LinkHow; state: LdPickState }
              | undefined;
            if (before && before.how === 'record') {
              if (before.store_id === pick.id) count.agree++;
              else if (before.state === 'ok') {
                // The two rules disagree: neither id is kept.
                setState.run('differs', Date.now(), lib, f.uuid, site);
                count.differ++;
              }
              continue;
            }
            if (!before) count.picked[site]++;
            this.putPick(lib, f, labeled, site, 'series', 'ok', pick.id, pick.title);
          }
        }
        // Counted once the series is finished (a step stopped inside one does it again).
        for (const site of LINK_SITES) p.series.picked[site] += count.picked[site];
        p.series.agree += count.agree;
        p.series.differ += count.differ;
        p.series.saved += count.saved;
      }
      p.cursor = key;
      p.series.done = i + 1;
    }
    return 'more';
  }

  // ------------------------------------------------------------ one id, one book

  private settleStep(p: LdProgress, lib: string): LdStep {
    const db = this.db;
    const r = db
      .prepare(
        `UPDATE link_discovery_picks SET state = 'clash', updated_at = ?
         WHERE library_id = ? AND state = 'ok' AND (site, store_id) IN (
           SELECT site, store_id FROM link_discovery_picks INDEXED BY link_discovery_picks_id
           WHERE library_id = ? AND state = 'ok' GROUP BY site, store_id HAVING COUNT(*) > 1)`,
      )
      .run(Date.now(), lib, lib);
    p.settle.clash = r.changes;
    p.propose.total = (
      db
        .prepare(
          `SELECT COUNT(DISTINCT calibre_uuid) AS n FROM link_discovery_picks WHERE library_id = ? AND state = 'ok'`,
        )
        .get(lib) as { n: number }
    ).n;
    this.next(p, 'propose');
    return 'more';
  }

  // ------------------------------------------------------------ proposals

  /**
   * The book's identifiers proposal under the pass's analysis id, from the reader's current
   * snapshot. Its earlier open row is replaced. Held while another pass's identifiers change of
   * the book is open; never made for a book whose identifiers are the user's, nor after an Undo.
   */
  proposeOne(
    lib: string,
    run: number,
    uuid: string,
  ): 'proposed' | 'held' | 'nothing' | 'yours' | 'gone' | 'written' {
    const db = this.db;
    const picks = db
      .prepare(
        `SELECT site, store_id, store_title, how FROM link_discovery_picks
         WHERE library_id = ? AND calibre_uuid = ? AND state = 'ok'`,
      )
      .all(lib, uuid) as { site: LinkSite; store_id: string; store_title: string; how: LinkHow }[];
    const book = this.deps.analysis.snapshotBook(lib, uuid);
    if (!picks.length || !book) return 'gone';
    const aid = linkAnalysisId(run);
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
    const { ids, added } = linkAddedIds(
      book.identifiers,
      picks.map((x) => ({ site: x.site, id: x.store_id })),
      this.heldByOther(lib, uuid),
      (asin) => this.deps.analysis.nativelyId(asin, null),
    );
    const now = Date.now();
    let out: 'proposed' | 'held' | 'nothing' | 'yours' = 'proposed';
    db.transaction(() => {
      for (const m of mine)
        if (m.state === 'proposed')
          db.prepare(
            'DELETE FROM proposed_changes WHERE id = ? AND state = ? AND batch_id IS NULL',
          ).run(m.id, 'proposed');
      db.prepare(
        'UPDATE link_discovery_picks SET proposed = 0 WHERE library_id = ? AND calibre_uuid = ?',
      ).run(lib, uuid);
      if (yours) out = 'yours';
      else if (!Object.keys(added).length) out = 'nothing';
      else if (other) out = 'held';
      if (out !== 'proposed') return;
      const links: Record<string, { how: LinkHow; title: string }> = {};
      for (const x of picks)
        if (added[LINK_KEY[x.site]] === x.store_id)
          links[LINK_KEY[x.site]] = { how: x.how, title: x.store_title };
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
        JSON.stringify({ added, links }),
        aid,
        now,
        now,
      );
      const mark = db.prepare(
        'UPDATE link_discovery_picks SET proposed = 1 WHERE library_id = ? AND calibre_uuid = ? AND site = ?',
      );
      for (const x of picks) if (links[LINK_KEY[x.site]]) mark.run(lib, uuid, x.site);
    })();
    return out;
  }

  private proposeChunk(p: LdProgress, lib: string): boolean {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT calibre_uuid FROM link_discovery_picks
         WHERE library_id = ? AND state = 'ok' AND calibre_uuid > ? ORDER BY calibre_uuid LIMIT 200`,
      )
      .all(lib, p.cursor) as { calibre_uuid: string }[];
    if (p.cursor === '')
      p.propose = {
        ...p.propose,
        done: 0,
        proposed: 0,
        held: 0,
        nothing: 0,
        yours: 0,
        natively: 0,
      };
    if (!rows.length) return false;
    this.deps.analysis.loadSnapshot(lib);
    const natively = this.db.prepare(
      `SELECT 1 FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND field = 'identifiers' AND analysis_id = ?
         AND state = 'proposed' AND json_extract(evidence_json, '$.added.natively') IS NOT NULL`,
    );
    const t0 = performance.now();
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      p.cursor = r.calibre_uuid;
      p.propose.done++;
      const o = this.proposeOne(lib, p.run, r.calibre_uuid);
      if (o === 'proposed' || o === 'held' || o === 'nothing' || o === 'yours') p.propose[o]++;
      if (o === 'proposed' && natively.get(lib, r.calibre_uuid, linkAnalysisId(p.run)))
        p.propose.natively++;
    }
    return true;
  }

  private proposeStep(p: LdProgress, lib: string): LdStep {
    if (this.proposeChunk(p, lib)) return 'more';
    this.labeledLine(p, lib);
    // Nothing to check: nothing to write either.
    this.next(p, p.propose.proposed > 0 ? 'spot' : 'done');
    return 'more';
  }

  /** The labeled books' new links and the checker's flags (title and volume against the label). */
  private labeledLine(p: LdProgress, lib: string): void {
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
          `SELECT calibre_id, site, store_id, store_title FROM link_discovery_picks
           WHERE library_id = ? AND state = 'ok' AND labeled = 1 AND proposed = 1`,
        )
        .all(lib) as {
        calibre_id: number;
        site: LinkSite;
        store_id: string;
        store_title: string;
      }[];
      const flagged: { calibreId: number; site: LinkSite; why: string[] }[] = [];
      let links = 0;
      for (const r of rows) {
        const g = byCid.get(r.calibre_id);
        if (!g) continue;
        links++;
        // The rules checked the author; the stored pick keeps the store's title only.
        const why = judge(
          { id: r.store_id, title: r.store_title, authors: [], pages: null, edOk: true },
          g,
        ).why.filter((x) => x !== 'author');
        if (why.length) flagged.push({ calibreId: r.calibre_id, site: r.site, why });
      }
      p.labeled = { links, flagged };
    } catch (err) {
      this.deps.log?.(`More direct links: the labeled books' line failed: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------ the spot check

  private spotStep(st: LdState, p: LdProgress, lib: string): LdStep {
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

  /** Draws the links of the spot check from those proposed, across the sites and rules. */
  drawSpot(p: LdProgress, lib: string): void {
    const db = this.db;
    const rows = db
      .prepare(
        `SELECT calibre_uuid, site, how FROM link_discovery_picks
         WHERE library_id = ? AND state = 'ok' AND proposed = 1`,
      )
      .all(lib) as { calibre_uuid: string; site: LinkSite; how: LinkHow }[];
    const by: Record<string, { uuid: string; site: LinkSite; how: LinkHow }[]> = {};
    for (const s of SPOT_SLOTS) by[s] = [];
    for (const r of rows)
      by[spotSlot(r.site, r.how)].push({ uuid: r.calibre_uuid, site: r.site, how: r.how });
    const shares = linkSpotShares(
      Object.fromEntries(SPOT_SLOTS.map((s) => [s, by[s].length])),
      LINK_SPOT_SIZE,
    );
    const put = db.prepare(
      `INSERT OR REPLACE INTO link_discovery_spot (library_id, calibre_uuid, site, position, how, verdict, decided_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    );
    let pos = 0;
    db.transaction(() => {
      db.prepare('DELETE FROM link_discovery_spot').run();
      for (const s of SPOT_SLOTS) {
        const pick = by[s]
          .map((x) => ({ x, k: linkSpotOrderKey(p.run, x.uuid, x.site) }))
          .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
          .slice(0, shares[s]);
        for (const { x } of pick) put.run(lib, x.uuid, x.site, pos++, x.how);
      }
    })();
    p.spot.drawnAt = Date.now();
    p.spot.size = pos;
    this.deps.log?.(`More direct links: the spot check is ready (${pos} links)`);
  }

  spotCounts(): { size: number; right: number; wrong: number; open: number } {
    const rows = this.db
      .prepare('SELECT verdict, COUNT(*) AS n FROM link_discovery_spot GROUP BY verdict')
      .all() as { verdict: string | null; n: number }[];
    const n = (v: string | null) => rows.find((r) => r.verdict === v)?.n ?? 0;
    const size = rows.reduce((a, r) => a + r.n, 0);
    return { size, right: n('right'), wrong: n('wrong'), open: n(null) };
  }

  /** Every link of the spot check marked and none wrong. */
  spotPassed(): boolean {
    const c = this.spotCounts();
    return c.size > 0 && c.open === 0 && c.wrong <= LINK_SPOT_MAX_WRONG;
  }

  setVerdict(uuid: string, site: LinkSite, verdict: 'right' | 'wrong' | null): void {
    const st = this.state();
    if (st.progress.phase === 'write' || st.progress.phase === 'done')
      throw new Error('The spot check is closed: its links are being written or were written');
    const r = this.db
      .prepare(
        'UPDATE link_discovery_spot SET verdict = ?, decided_at = ? WHERE calibre_uuid = ? AND site = ?',
      )
      .run(verdict, verdict ? Date.now() : null, uuid, site);
    if (r.changes === 0) throw new Error('Not one of the spot check’s links');
    // A wrong link found while On waits: back to Preview (On needs none wrong).
    if (st.mode === 'on' && !this.spotPassed()) this.setMode('analyse');
  }

  // ------------------------------------------------------------ writing (On)

  private async writeStep(st: LdState, p: LdProgress, lib: string): Promise<LdStep> {
    if (st.mode !== 'on') return 'idle';
    if (!p.write.rebuilt) {
      // Made again from the reader's current snapshot: a book changed since the Preview gets
      // its old value as Calibre has it now (the planner skips a row whose old differs).
      if (this.proposeChunk(p, lib)) return 'more';
      p.write.rebuilt = true;
      p.cursor = '';
      return 'more';
    }
    const wait = this.deps.writeWait(lib);
    if (wait) {
      p.write.waiting = wait;
      return 'wait';
    }
    const r = await this.deps.batches.plan(lib, { analysisId: linkAnalysisId(p.run) });
    if (r.batch) {
      p.write.batches.push(r.batch.id);
      p.write.waiting = 'A batch is being applied';
      this.deps.log?.(`More direct links: batch ${r.batch.id} planned`);
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

  private link(lib: string, run: number, row: PickRow): LdLink {
    const a = this.deps.analysis;
    const f = a.linkFacts(lib, row.calibre_uuid);
    const prop = this.db
      .prepare(
        `SELECT state FROM proposed_changes INDEXED BY proposed_changes_book
         WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND field = 'identifiers' AND analysis_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(lib, row.calibre_uuid, linkAnalysisId(run)) as { state: string } | undefined;
    return {
      uuid: row.calibre_uuid,
      calibreId: row.calibre_id,
      labeled: row.labeled === 1,
      site: row.site,
      how: row.how,
      state: row.state,
      book: {
        // Calibre's values from the snapshot when the stored answers are gone.
        title: f?.calibre.title ?? a.snapshotBook(lib, row.calibre_uuid)?.title ?? null,
        authors: f?.calibre.authors ?? a.snapshotBook(lib, row.calibre_uuid)?.authors ?? [],
        series: f?.calibre.series ?? null,
        number: f?.calibre.index ?? null,
        decidedTitle: f && f.decided.t !== f.calibre.title ? f.decided.t : null,
      },
      store: { id: row.store_id, title: row.store_title, url: linkUrl(row.site, row.store_id) },
      saved: row.saved_id ? { id: row.saved_id, url: linkUrl(row.site, row.saved_id) } : null,
      proposal: row.state === 'ok' && row.proposed === 1 ? (prop?.state ?? null) : null,
    };
  }

  /** The picks, a page at a time, by state and (optionally) site and rule. */
  listLinks(
    lib: string,
    run: number,
    filter: { state: LdPickState; site?: LinkSite | null; how?: LinkHow | null },
    offset: number,
    limit: number,
  ): { total: number; items: LdLink[] } {
    const where = ['library_id = ?', 'state = ?'];
    const args: unknown[] = [lib, filter.state];
    if (filter.site) {
      where.push('site = ?');
      args.push(filter.site);
    }
    if (filter.how) {
      where.push('how = ?');
      args.push(filter.how);
    }
    const w = where.join(' AND ');
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM link_discovery_picks WHERE ${w}`).get(...args) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM link_discovery_picks WHERE ${w} ORDER BY calibre_uuid, site LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as PickRow[];
    this.deps.analysis.loadSnapshot(lib);
    return { total, items: rows.map((r) => this.link(lib, run, r)) };
  }

  /** The spot check's links in their order, each with its verdict. */
  listSpot(lib: string, run: number): (LdLink & { verdict: 'right' | 'wrong' | null })[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, s.verdict FROM link_discovery_spot s
         JOIN link_discovery_picks p ON p.library_id = s.library_id
           AND p.calibre_uuid = s.calibre_uuid AND p.site = s.site
         WHERE s.library_id = ? ORDER BY s.position`,
      )
      .all(lib) as (PickRow & { verdict: 'right' | 'wrong' | null })[];
    this.deps.analysis.loadSnapshot(lib);
    return rows.map((r) => ({ ...this.link(lib, run, r), verdict: r.verdict }));
  }

  /** The card's counts: the picks by state, site and rule (one covering index). */
  pickCounts(lib: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT state, site, how, COUNT(*) AS n FROM link_discovery_picks INDEXED BY link_discovery_picks_counts
         WHERE library_id = ? GROUP BY state, site, how`,
      )
      .all(lib) as { state: string; site: string; how: string; n: number }[])
      out[`${r.state}:${r.site}:${r.how}`] = r.n;
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
      out[s] = (q.get(lib, s, linkAnalysisId(run)) as { n: number }).n;
    return out;
  }

  /** The write's pace from its last finished batches (as the Bookmeter pass's). */
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

  /**
   * The card: mode, phase, the phase's bar with the time left (from what is open at the pace
   * measured in this phase), the counts and the spot check's state.
   */
  status(lib: string | null, now = Date.now()): unknown {
    const st = this.state();
    const p = st.progress;
    const proposals = lib ? this.proposalCounts(lib, p.run) : {};
    return {
      mode: st.mode,
      pausedReason: st.pausedReason,
      pausedDetail: st.pausedDetail,
      stage4Done: this.deps.stage4Done(),
      progress: p,
      bar: linkBar(p, now, {
        written: (proposals.applied ?? 0) + (proposals.skipped ?? 0),
        toWrite: (proposals.proposed ?? 0) + (proposals.queued ?? 0),
        pace: p.phase === 'write' ? this.writePace(p.write.batches) : null,
      }),
      picks: lib ? this.pickCounts(lib) : {},
      proposals,
      spot: this.spotCounts(),
      spotPassed: this.spotPassed(),
      spotSize: LINK_SPOT_SIZE,
    };
  }
}

// ---------------------------------------------------------------- the card's bar

export interface LdBar {
  phase: LdPhase;
  done: number;
  total: number | null;
  /** The time left; null until there is something to measure from. */
  leftMs: number | null;
}

/** Steps a rate is measured from before it is trusted. */
const MIN_MEASURED = 200;

/**
 * The phase's bar and time left: what is open, at the pace this phase has had since it started
 * (WP20 lessons 4: from what is open, never a mean over another stretch). The write's pace is its
 * last finished batches'.
 */
export function linkBar(
  p: LdProgress,
  now: number,
  w: { written: number; toWrite: number; pace: { ms: number; items: number } | null },
): LdBar {
  const rate = (done: number, total: number): number | null => {
    const ms = now - (p.phaseStartedAt ?? now);
    if (done < MIN_MEASURED || ms <= 0 || total <= done) return total <= done ? 0 : null;
    return Math.round(((total - done) * ms) / done);
  };
  switch (p.phase) {
    case 'record':
      return {
        phase: p.phase,
        done: p.record.looked,
        total: p.books || null,
        leftMs: p.books ? rate(p.record.looked, p.books) : null,
      };
    case 'series':
      return {
        phase: p.phase,
        done: p.series.done,
        total: p.series.total || null,
        leftMs: p.series.total ? rate(p.series.done, p.series.total) : null,
      };
    case 'settle':
      return { phase: p.phase, done: 0, total: null, leftMs: null };
    case 'propose':
      return {
        phase: p.phase,
        done: p.propose.done,
        total: p.propose.total || null,
        leftMs: p.propose.total ? rate(p.propose.done, p.propose.total) : null,
      };
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
