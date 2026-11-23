/**
 * Audiobook stage 8 (WP21g, decided with the user 2026-11-22): the second pass from the Calibre
 * ebooks. Each recording (stage 5's units; AI books, radio clips and drama CDs left out) is
 * paired with its exact Calibre volume (ebook-pair.ts); a pair gives the recording
 *   - genres (the ebook's genres and subjects) and tags (its story tags, adaptations and format)
 *     for Audiobookshelf;
 *   - Calibre's series and number, only where stage 5's series is not from a store, a torrent
 *     folder or you (unknown, none, or the models' guess), and only automatically when the
 *     recording's title names that series (else review); a move it causes waits while anyone
 *     listens (library-plan.ts);
 *   - kept in cleanup.db only: the ebook's author readings (author_sort and each author's sort),
 *     its description and its cover (path, size, mtime, SHA-256).
 * Calibre is only read: the indexer's snapshot copy, and the cover files under the shared disk
 * lock (Calibre first). The values reach Audiobookshelf only through stage 7's own build and
 * library changes (the overlay in build-inputs.ts) when stage 8 is On.
 *
 * It runs as a phase of stage 7's daily run (`ebooks`, before the plan). Noticing a Calibre change
 * costs one stat of the snapshot copy a day when nothing changed: the copy's mtime and size, stage
 * 5's decisions and your choices are compared with what the last pass saw. When the snapshot
 * changed, it is read in pages (every book's fingerprint against the stored one: new, changed
 * and removed ebooks); only the recordings those touch (and the recordings stage 5 decided again,
 * the new arrivals) are paired again.
 */
import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { readSourceFile, resolveInside, statFile } from '../../calibre/source-fs';
import { gunzipSync } from 'zlib';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings } from '../settings';
import { getAudioStage, updateAudioStage } from './audio-stages';
import {
  addToIndex,
  candidatesOf,
  EBOOK_RULES_VERSION,
  ebookTerms,
  pairRecording,
  titleForm,
  type AudioFacts,
  type EbookIndex,
  type PairResult,
} from './ebook-pair';
import { readEbookPage, snapshotIdentity, type EbookBook } from './ebook-snapshot';
import type { SeriesEntry } from './meta-rules';
import type { UnitInputs } from './stage4-online';

export const STAGE8 = 8;
const OWNER = DISK_OWNERS.audio8;
const PAGE = 2000;
/** Recordings whose facts one turn reads (about 0.3 ms each: one evidence record unpacked). */
const FACTS_PER_TURN = 250;
const SLICE = 120;
const COVERS_PER_TURN = 25;
/**
 * A pair whose ebook left Calibre: review, its values kept until you choose (decided at the plan:
 * no automatic change back).
 */
export const LOST =
  'Its Calibre book is not in the library any more: the values stay until you choose';

// ---------------------------------------------------------------------------------------------
// The recordings

/** Stage 5's current analysis id (null: none). */
export function stage5Analysis(db: Database.Database): string | null {
  const r = db
    .prepare(
      `SELECT json_extract(progress_json, '$.analysisId') AS a FROM audio_stages WHERE stage = 5`,
    )
    .get() as { a: string | null } | undefined;
  return r?.a ?? null;
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];

export interface UnitFacts extends AudioFacts {
  /** audible | audiobookjp | kikubon | no_record | ai | radio (the gate's and report's kind). */
  source: string;
  /** sha1 of the facts the pairing reads (a change pairs the recording again). */
  hash: string;
}

export interface MetaUnitRow {
  unit_key: string;
  kind: AudioFacts['kind'];
  name: string;
}

/** Stage 5's recordings of its current analysis. */
export function metaUnits(db: Database.Database, analysisId = stage5Analysis(db)): MetaUnitRow[] {
  if (!analysisId) return [];
  return db
    .prepare(
      'SELECT unit_key, kind, name FROM audio_meta_units WHERE analysis_id = ? ORDER BY unit_key',
    )
    .all(analysisId) as MetaUnitRow[];
}

/** Stage 5's decided values the pairing reads, per recording (one indexed query). */
export function metaValues(db: Database.Database): Map<string, Record<string, unknown>> {
  const values = new Map<string, Record<string, unknown>>();
  for (const r of db
    .prepare(
      `SELECT item_key, field, value_json FROM ai_values WHERE stage = 'audio5'
         AND field IN ('title', 'authors', 'series', 'drama', 'record', 'store_id')`,
    )
    .iterate() as Iterable<{ item_key: string; field: string; value_json: string }>) {
    const v = values.get(r.item_key) ?? {};
    v[r.field] = JSON.parse(r.value_json) as unknown;
    values.set(r.item_key, v);
  }
  return values;
}

/** Each recording's facts from stage 5 (its decided values and the store record's own title). */
export function audioFactsAll(db: Database.Database, analysisId = stage5Analysis(db)): UnitFacts[] {
  return unitFacts(db, metaUnits(db, analysisId), metaValues(db));
}

/**
 * The facts of some recordings: each one's evidence record is unpacked (gzip), about 0.3 ms a
 * recording, so the stage reads them in turns (the `recordings` phase).
 */
export function unitFacts(
  db: Database.Database,
  units: MetaUnitRow[],
  values: Map<string, Record<string, unknown>>,
): UnitFacts[] {
  const ev = db.prepare(`SELECT evidence FROM ai_items WHERE stage = 'audio5' AND item_key = ?`);
  return units.map((u) => {
    const v = values.get(u.unit_key) ?? {};
    const other: string[] = [];
    const row = ev.get(u.unit_key) as { evidence: Buffer } | undefined;
    if (row) {
      try {
        const e = JSON.parse(gunzipSync(row.evidence).toString('utf8')) as {
          record?: { title?: string } | null;
        };
        if (e.record?.title) other.push(e.record.title);
      } catch {
        // An unreadable evidence record: the decided title alone.
      }
    }
    const title = typeof v.title === 'string' && v.title.trim() ? v.title.trim() : u.name;
    const store =
      (typeof v.store_id === 'string' && v.store_id) ||
      (typeof v.record === 'string' && v.record) ||
      '';
    const source =
      u.kind === 'ai' || u.kind === 'radio'
        ? u.kind
        : (/^(audible|audiobookjp|kikubon):/.exec(store)?.[1] ?? 'no_record');
    const f: AudioFacts = {
      unitKey: u.unit_key,
      kind: u.kind,
      title,
      otherTitles: other.filter((t) => t !== title),
      authors: strs(v.authors),
      series: Array.isArray(v.series) ? (v.series as SeriesEntry[]) : null,
      drama: v.drama === true,
    };
    const hash = createHash('sha1')
      .update(
        JSON.stringify([
          EBOOK_RULES_VERSION,
          f.kind,
          f.title,
          f.otherTitles,
          f.authors,
          f.series,
          f.drama,
        ]),
      )
      .digest('hex')
      .slice(0, 16);
    return { ...f, source, hash };
  });
}

// ---------------------------------------------------------------------------------------------
// The series rule

interface SeriesRow {
  value: SeriesEntry[] | null;
  source: string;
  rules: unknown;
}

/**
 * Stage 5's series is not from a store, a torrent folder or you: unknown, none, or decided by the
 * models alone (the rules had no series). Decided 2026-11-22: only then does Calibre's fill in.
 */
export function seriesOpen(r: SeriesRow | undefined): boolean {
  if (!r) return true;
  if (r.source === 'user') return false;
  if (r.value === null || r.value.length === 0) return true;
  const rulesEmpty =
    r.rules === null || r.rules === undefined || (Array.isArray(r.rules) && r.rules.length === 0);
  return rulesEmpty && r.source !== 'rules';
}

/** The recording's title names the series (老後に備えて…7 in 老後に備えて…). */
export function titleNamesSeries(title: string, series: string): boolean {
  const k = titleForm(series.replace(/シリーズ$/u, ''));
  return k.length >= 2 && titleForm(title).includes(k);
}

// ---------------------------------------------------------------------------------------------
// The gate

export interface EbookLabel {
  id: string;
  kind: string;
  torrent: string;
  /** The Calibre ids of the exact volume (copies), or [] / null: no ebook in Calibre. */
  calibre: number[] | null;
  note?: string;
}

export interface EbookGate {
  passed: boolean;
  labels: number;
  notFound: string[];
  /** Per kind: labeled with an ebook, found (paired automatically), right, wrong; and none. */
  kinds: Record<
    string,
    {
      withEbook: number;
      found: number;
      right: number;
      wrong: number;
      none: number;
      noneRight: number;
      review: number;
    }
  >;
  wrong: { id: string; title: string; got: number | null; want: number[] | null }[];
  error: string | null;
}

export function scoreEbookGate(
  labels: EbookLabel[],
  unitOf: (torrent: string) => string | null,
  pairOf: (unit: string) => { cls: string; id: number | null; title: string } | null,
): EbookGate {
  const g: EbookGate = {
    passed: false,
    labels: labels.length,
    notFound: [],
    kinds: {},
    wrong: [],
    error: null,
  };
  for (const l of labels) {
    const k = (g.kinds[l.kind] ??= {
      withEbook: 0,
      found: 0,
      right: 0,
      wrong: 0,
      none: 0,
      noneRight: 0,
      review: 0,
    });
    const u = unitOf(l.torrent);
    const p = u ? pairOf(u) : null;
    if (!p) {
      g.notFound.push(l.id);
      continue;
    }
    const want = l.calibre && l.calibre.length ? l.calibre : null;
    if (want) k.withEbook++;
    else k.none++;
    if (p.cls === 'review') k.review++;
    if (p.cls === 'auto') {
      if (want) k.found++;
      if (want && p.id !== null && want.includes(p.id)) k.right++;
      else {
        k.wrong++;
        g.wrong.push({ id: l.id, title: p.title, got: p.id, want });
      }
    } else if (!want && (p.cls === 'none' || p.cls === 'excluded')) k.noneRight++;
  }
  g.passed = labels.length > 0 && g.wrong.length === 0 && g.notFound.length === 0;
  return g;
}

// ---------------------------------------------------------------------------------------------
// The stage

export type Stage8Phase =
  | 'check'
  | 'read'
  | 'recordings'
  | 'pair'
  | 'values'
  | 'covers'
  | 'gate'
  | 'preview'
  | 'done';

/** Stage 8's part of a stage-7 run's report (`report_json.ebooks`). */
export interface Stage8RunReport {
  mode: 'off' | 'analyse' | 'on';
  reason: string | null;
  counts: Stage8Progress['counts'];
  values: Stage8Progress['values'];
  ebooks: Stage8Progress['ebooks'] | null;
  covers: Stage8Progress['covers'];
  preview: Stage8Progress['preview'];
  gate: { passed: boolean; labels: number; wrong: number } | null;
  newReview: number;
  error: string | null;
}

export interface Stage8Progress {
  runId: number | null;
  phase: Stage8Phase;
  startedAt: number;
  phaseStartedAt: number;
  finishedAt: number | null;
  /** The bar of the phase. */
  done: number;
  total: number;
  /** Why this pass paired (first, rules, Calibre changed, recordings changed, unchanged). */
  reason: string | null;
  snapshot: { mtimeMs: number; size: number } | null;
  ebooks: { total: number; new: number; changed: number; removed: number };
  paired: number;
  counts: Record<'auto' | 'review' | 'none' | 'excluded', number>;
  bySource: Record<string, Record<string, number>>;
  values: {
    genres: number;
    tags: number;
    series: number;
    seriesReview: number;
    seriesDisagree: number;
    noTerms: number;
  };
  covers: { read: number; missing: number; waitMs: number };
  gate: EbookGate | null;
  preview: {
    changes: number;
    metadata: number;
    moves: number;
    held: number;
    reviews: number;
    at: number;
  } | null;
  phaseTimes: Record<string, number>;
  waiting: string | null;
  error: string | null;
}

export interface CalibreTarget {
  libraryId: string;
  /** The indexer's snapshot copy of the library's metadata.db (read only). */
  snapshotFile: string;
  /** The library's folder under CALIBRE_DIR (read only; covers). */
  libraryDir: string;
}

export interface Stage8Deps {
  db: Database.Database;
  lock: DiskLock;
  calibre: () => CalibreTarget | null;
  readLabels?: () => { text: string | null; error: string | null };
  now?: () => number;
  log?: (m: string) => void;
}

function emptyProgress(runId: number | null, now: number): Stage8Progress {
  return {
    runId,
    phase: 'check',
    startedAt: now,
    phaseStartedAt: now,
    finishedAt: null,
    done: 0,
    total: 0,
    reason: null,
    snapshot: null,
    ebooks: { total: 0, new: 0, changed: 0, removed: 0 },
    paired: 0,
    counts: { auto: 0, review: 0, none: 0, excluded: 0 },
    bySource: {},
    values: { genres: 0, tags: 0, series: 0, seriesReview: 0, seriesDisagree: 0, noTerms: 0 },
    covers: { read: 0, missing: 0, waitMs: 0 },
    gate: null,
    preview: null,
    phaseTimes: {},
    waiting: null,
    error: null,
  };
}

/** What a step returns to stage 7: go on, wait (Calibre uses the disk), done, or stop the run. */
export type Stage8Step = 'more' | 'wait' | 'done' | { stop: string };

export class AudioStage8 {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  /** The pass's in-memory work (rebuilt after a restart by reading again). */
  private work: {
    runId: number | null;
    books: Map<number, EbookBook>;
    after: number;
    idx: EbookIndex | null;
    queue: string[];
    facts: Map<string, UnitFacts> | null;
    /** The recordings phase: stage 5's recordings and values, their facts read in turns. */
    loading: {
      units: MetaUnitRow[];
      values: Map<string, Record<string, unknown>>;
      facts: Map<string, UnitFacts>;
    } | null;
    touched: Set<number>;
    removed: Set<number>;
    queued: boolean;
    /** The read phase: the index built page by page; every page read (the next turn compares). */
    building: EbookIndex | null;
    paged: boolean;
  } | null = null;

  constructor(private readonly deps: Stage8Deps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  mode(): 'off' | 'analyse' | 'on' {
    return getAudioStage(this.db, STAGE8).mode;
  }

  progress(): Stage8Progress | null {
    const p = getAudioStage(this.db, STAGE8).progress as Partial<Stage8Progress>;
    return p.phase ? (p as Stage8Progress) : null;
  }

  private save(p: Stage8Progress): void {
    updateAudioStage(this.db, STAGE8, {
      state: p.phase === 'done' ? 'ready' : p.phase,
      progress: p as unknown as Record<string, unknown>,
    });
  }

  private setPhase(p: Stage8Progress, phase: Stage8Phase): void {
    const now = this.now();
    p.phaseTimes[p.phase] = (p.phaseTimes[p.phase] ?? 0) + Math.max(0, now - p.phaseStartedAt);
    p.phase = phase;
    p.phaseStartedAt = now;
    p.done = 0;
    p.total = 0;
    p.waiting = null;
    if (phase === 'done') p.finishedAt = now;
    this.save(p);
    this.log(`Audiobooks stage 8: ${phase}`);
  }

  /**
   * The values stage 7's build and library changes take (the overlay), only when stage 8 is On
   * and its gate passed: unit key -> { genres, ebook_tags, series?, series_from? }.
   */
  overlay(): Map<string, Record<string, unknown>> | null {
    if (this.mode() !== 'on') return null;
    if (!this.progress()?.gate?.passed) return null;
    return this.values();
  }

  /** Every recording's stage-8 values (also for the Preview). */
  values(): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    for (const r of this.db
      .prepare('SELECT unit_key, field, value_json FROM audio_ebook_values')
      .all() as {
      unit_key: string;
      field: string;
      value_json: string;
    }[]) {
      const v = out.get(r.unit_key) ?? {};
      if (r.field === 'genres') v.genres = JSON.parse(r.value_json);
      else if (r.field === 'tags') v.ebook_tags = JSON.parse(r.value_json);
      else if (r.field === 'series') {
        v.series = JSON.parse(r.value_json);
        v.series_from = 'ebook';
      }
      out.set(r.unit_key, v);
    }
    return out;
  }

  /** The key of everything the pass reads besides Calibre (a change pairs again). */
  private audioKey(): string {
    const s5 = getAudioStage(this.db, 5).progress as {
      analysisId?: string;
      rulesKey?: string;
      askKey?: string;
      finishedAt?: number;
    };
    const c = this.db
      .prepare('SELECT COUNT(*) AS n, MAX(chosen_at) AS t FROM audio_ebook_choices')
      .get() as {
      n: number;
      t: number | null;
    };
    const st = getSettings(this.db).audiobooks;
    return createHash('sha1')
      .update(
        JSON.stringify([
          EBOOK_RULES_VERSION,
          s5.analysisId,
          s5.rulesKey,
          s5.askKey,
          s5.finishedAt,
          c.n,
          c.t,
          st.ebookTitleScore,
          st.ebookTitleMinChars,
          st.ebookTitleMinShare,
        ]),
      )
      .digest('hex')
      .slice(0, 16);
  }

  /** Starts a pass for a stage-7 run (the run calls step() until 'done'). */
  begin(runId: number | null): Stage8Progress {
    const p = emptyProgress(runId, this.now());
    const last = this.progress();
    // Keep what the page shows until this pass knows better.
    if (last) {
      p.counts = last.counts;
      p.bySource = last.bySource;
      p.values = last.values;
      p.gate = last.gate;
      p.preview = last.preview;
      p.ebooks.total = last.ebooks?.total ?? 0;
    }
    this.work = null;
    this.save(p);
    return p;
  }

  async step(
    stopped: () => boolean,
    preview: (() => Promise<Stage8Progress['preview']>) | null,
  ): Promise<Stage8Step> {
    let p = this.progress();
    if (!p || p.phase === 'done') p = this.begin(p?.runId ?? null);
    try {
      switch (p.phase) {
        case 'check':
          return this.checkStep(p);
        case 'read':
          return await this.readStep(p);
        case 'recordings':
          return await this.recordingsStep(p);
        case 'pair':
          return await this.pairStep(p);
        case 'values':
          this.valuesStep(p);
          return 'more';
        case 'covers':
          return await this.coversStep(p, stopped);
        case 'gate':
          return this.gateStep(p);
        case 'preview': {
          if (this.mode() === 'analyse' && preview) {
            p.preview = await preview();
            this.save(p);
          }
          this.setPhase(p, 'done');
          return 'done';
        }
        case 'done':
          return 'done';
      }
    } catch (err) {
      p.error = (err as Error).message.slice(0, 500);
      this.save(p);
      this.deps.lock.release(OWNER);
      return { stop: `Stage 8 failed: ${p.error}` };
    }
  }

  /** One stat a day when nothing changed. */
  private checkStep(p: Stage8Progress): Stage8Step {
    const cal = this.deps.calibre();
    if (!cal)
      throw new Error('The Calibre library is not set up (no target library or no snapshot)');
    const id = snapshotIdentity(cal.snapshotFile);
    if (!id) throw new Error(`The Calibre snapshot ${cal.snapshotFile} can't be read yet`);
    p.snapshot = id;
    const st = this.db
      .prepare('SELECT * FROM audio_ebook_state WHERE library_id = ?')
      .get(cal.libraryId) as
      | {
          snapshot_mtime: number | null;
          snapshot_size: number | null;
          audio_key: string | null;
          rules_version: number | null;
        }
      | undefined;
    const key = this.audioKey();
    const pairs = (
      this.db.prepare('SELECT COUNT(*) AS n FROM audio_ebook_pairs').get() as { n: number }
    ).n;
    const sameSnapshot = st?.snapshot_mtime === id.mtimeMs && st?.snapshot_size === id.size;
    if (
      st &&
      pairs > 0 &&
      sameSnapshot &&
      st.audio_key === key &&
      st.rules_version === EBOOK_RULES_VERSION
    ) {
      p.reason = 'Nothing changed in Calibre or in the recordings since the last pass';
      this.setPhase(p, 'gate');
      return 'more';
    }
    p.reason =
      !st || pairs === 0
        ? 'The first pass'
        : st.rules_version !== EBOOK_RULES_VERSION
          ? 'The pairing rules changed'
          : !sameSnapshot
            ? 'Calibre changed'
            : 'The recordings or your choices changed';
    this.work = {
      runId: p.runId,
      books: new Map(),
      after: 0,
      idx: null,
      queue: [],
      facts: null,
      loading: null,
      queued: false,
      building: null,
      paged: false,
      touched: new Set(),
      removed: new Set(),
    };
    this.setPhase(p, 'read');
    return 'more';
  }

  /** The snapshot in pages; then every book's fingerprint against the stored ones. */
  private async readStep(p: Stage8Progress): Promise<Stage8Step> {
    const cal = this.deps.calibre();
    if (!cal) throw new Error('The Calibre library is not set up');
    if (!this.work) {
      // After a restart: read again from the start.
      this.work = {
        runId: p.runId,
        books: new Map(),
        after: 0,
        idx: null,
        queue: [],
        facts: null,
        loading: null,
        queued: false,
        building: null,
        paged: false,
        touched: new Set(),
        removed: new Set(),
      };
      p.done = 0;
    }
    const w = this.work;
    if (p.total === 0) {
      p.total = Math.max(1, Math.ceil(this.countBooks(cal.snapshotFile) / PAGE));
    }
    if (!w.paged) {
      const page = readEbookPage(cal.snapshotFile, w.after, PAGE);
      for (const b of page) w.books.set(b.id, b);
      addToIndex((w.building ??= { byAuthor: new Map(), byTitle: new Map() }), page);
      p.done++;
      this.save(p);
      await new Promise((r) => setImmediate(r));
      if (page.length === PAGE) w.after = page[page.length - 1].id;
      else w.paged = true;
      return 'more';
    }
    // New, changed and removed ebooks (a turn of its own).
    const known = new Map<number, string>();
    for (const r of this.db
      .prepare('SELECT calibre_id, fp FROM audio_ebook_known WHERE library_id = ?')
      .all(cal.libraryId) as {
      calibre_id: number;
      fp: string;
    }[])
      known.set(r.calibre_id, r.fp);
    const touched = new Set<number>();
    let added = 0;
    let changed = 0;
    let removed = 0;
    const put = this.db.prepare(
      'INSERT INTO audio_ebook_known (library_id, calibre_id, fp) VALUES (?, ?, ?) ON CONFLICT (library_id, calibre_id) DO UPDATE SET fp = excluded.fp',
    );
    const del = this.db.prepare(
      'DELETE FROM audio_ebook_known WHERE library_id = ? AND calibre_id = ?',
    );
    this.db.transaction(() => {
      for (const b of w.books.values()) {
        const f = known.get(b.id);
        if (f === b.fp) continue;
        if (f === undefined) added++;
        else changed++;
        touched.add(b.id);
        put.run(cal.libraryId, b.id, b.fp);
      }
      for (const id of known.keys())
        if (!w.books.has(id)) {
          removed++;
          touched.add(id);
          w.removed.add(id);
          del.run(cal.libraryId, id);
        }
    })();
    p.ebooks = { total: w.books.size, new: known.size === 0 ? 0 : added, changed, removed };
    w.touched = touched;
    w.idx = w.building ?? { byAuthor: new Map(), byTitle: new Map() };
    w.building = null;
    this.setPhase(p, 'recordings');
    return 'more';
  }

  private countBooks(file: string): number {
    // The bar's total: one cheap count (read only).
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n;
    } finally {
      db.close();
    }
  }

  /** The recordings to pair again, then each one (a slice per step). */
  /** Stage 5's recordings, their facts read FACTS_PER_TURN at a time (never one long turn). */
  private async recordingsStep(p: Stage8Progress): Promise<Stage8Step> {
    const w = this.work;
    if (!w || !w.idx) {
      this.setPhase(p, 'check');
      return 'more';
    }
    if (!w.loading) {
      w.loading = { units: metaUnits(this.db), values: metaValues(this.db), facts: new Map() };
      p.total = w.loading.units.length;
      p.done = 0;
      this.save(p);
      await new Promise((r) => setImmediate(r));
      return 'more';
    }
    const l = w.loading;
    const slice = l.units.slice(p.done, p.done + FACTS_PER_TURN);
    for (const f of unitFacts(this.db, slice, l.values)) l.facts.set(f.unitKey, f);
    p.done += slice.length;
    this.save(p);
    await new Promise((r) => setImmediate(r));
    if (p.done < l.units.length) return 'more';
    w.facts = l.facts;
    w.loading = null;
    this.setPhase(p, 'pair');
    return 'more';
  }

  private async pairStep(p: Stage8Progress): Promise<Stage8Step> {
    const w = this.work;
    if (!w || !w.idx || !w.facts) {
      this.setPhase(p, 'check');
      return 'more';
    }
    const cal = this.deps.calibre()!;
    if (!w.queued) {
      w.queued = true;
      const stored = new Map<
        string,
        {
          audio_hash: string;
          class: string;
          calibre_id: number | null;
          candidates_json: string;
          rules_version: number;
        }
      >();
      for (const r of this.db
        .prepare(
          'SELECT unit_key, audio_hash, class, calibre_id, candidates_json, rules_version FROM audio_ebook_pairs',
        )
        .all() as {
        unit_key: string;
        audio_hash: string;
        class: string;
        calibre_id: number | null;
        candidates_json: string;
        rules_version: number;
      }[])
        stored.set(r.unit_key, r);
      const chosen = new Set(
        (
          this.db
            .prepare("SELECT unit_key FROM audio_ebook_choices WHERE field = 'pair'")
            .all() as { unit_key: string }[]
        ).map((r) => r.unit_key),
      );
      const queue: string[] = [];
      for (const f of w.facts.values()) {
        const s = stored.get(f.unitKey);
        if (
          !s ||
          s.rules_version !== EBOOK_RULES_VERSION ||
          s.audio_hash !== f.hash ||
          chosen.has(f.unitKey)
        ) {
          queue.push(f.unitKey);
          continue;
        }
        if (s.class === 'excluded') continue;
        // An ebook of its pair or its candidates changed, or a new ebook could be it.
        const cands = (JSON.parse(s.candidates_json) as { id: number }[]).map((c) => c.id);
        if (
          (s.calibre_id !== null && w.touched.has(s.calibre_id)) ||
          cands.some((id) => w.touched.has(id))
        ) {
          queue.push(f.unitKey);
          continue;
        }
        if (s.class !== 'auto' && candidatesOf(f, w.idx).some((e) => w.touched.has(e.id)))
          queue.push(f.unitKey);
      }
      // Recordings no longer in stage 5's analysis.
      const gone = [...stored.keys()].filter((k) => !w.facts!.has(k));
      if (gone.length)
        this.db.transaction(() => {
          const d1 = this.db.prepare('DELETE FROM audio_ebook_pairs WHERE unit_key = ?');
          const d2 = this.db.prepare('DELETE FROM audio_ebook_values WHERE unit_key = ?');
          const d3 = this.db.prepare('DELETE FROM audio_ebook_series WHERE unit_key = ?');
          for (const k of gone) {
            d1.run(k);
            d2.run(k);
            d3.run(k);
          }
        })();
      w.queue = queue;
      p.total = queue.length;
      p.done = 0;
      this.save(p);
    }
    const settings = getSettings(this.db).audiobooks;
    const s = {
      titleScore: settings.ebookTitleScore,
      titleMinChars: settings.ebookTitleMinChars,
      titleMinShare: settings.ebookTitleMinShare,
    };
    const choice = this.db.prepare(
      "SELECT value_json FROM audio_ebook_choices WHERE unit_key = ? AND field = 'pair'",
    );
    const old = this.db.prepare(
      'SELECT class, first_review_run, calibre_id, reason FROM audio_ebook_pairs WHERE unit_key = ?',
    );
    const put = this.db.prepare(
      `INSERT INTO audio_ebook_pairs (unit_key, library_id, calibre_id, class, kind, audio_title, audio_authors, reason,
         checks_json, candidates_json, audio_hash, ebook_fp, rules_version, first_review_run, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (unit_key) DO UPDATE SET library_id = excluded.library_id, calibre_id = excluded.calibre_id,
         class = excluded.class, kind = excluded.kind, audio_title = excluded.audio_title,
         audio_authors = excluded.audio_authors, reason = excluded.reason,
         candidates_json = excluded.candidates_json, audio_hash = excluded.audio_hash,
         ebook_fp = excluded.ebook_fp, rules_version = excluded.rules_version,
         first_review_run = excluded.first_review_run, decided_at = excluded.decided_at`,
    );
    const slice = w.queue.slice(p.done, p.done + SLICE);
    const now = this.now();
    this.db.transaction(() => {
      for (const key of slice) {
        const f = w.facts!.get(key)!;
        let r: PairResult = pairRecording(f, candidatesOf(f, w.idx!), s);
        const c = choice.get(key) as { value_json: string } | undefined;
        if (c && r.class !== 'excluded') {
          const id = JSON.parse(c.value_json) as number | null;
          if (id === null)
            r = { ...r, class: 'none', calibreId: null, reason: 'You chose: no ebook' };
          else if (w.books.has(id))
            r = { ...r, class: 'auto', calibreId: id, reason: 'You chose this ebook' };
          else
            r = {
              ...r,
              class: 'review',
              calibreId: null,
              reason: `The ebook you chose (${id}) is not in Calibre any more`,
            };
        }
        const prev = old.get(key) as
          | {
              class: string;
              first_review_run: number | null;
              calibre_id: number | null;
              reason: string | null;
            }
          | undefined;
        // Its ebook left Calibre: review, its values kept (no automatic change back).
        if (
          !c &&
          prev &&
          prev.calibre_id !== null &&
          ((prev.class === 'auto' && w.removed.has(prev.calibre_id)) || prev.reason === LOST) &&
          !w.books.has(prev.calibre_id) &&
          r.class !== 'auto'
        )
          r = { ...r, class: 'review', calibreId: prev.calibre_id, reason: LOST };
        const firstReview =
          r.class === 'review'
            ? prev?.class === 'review'
              ? prev.first_review_run
              : p.runId
            : null;
        const e = r.calibreId !== null ? w.books.get(r.calibreId) : undefined;
        put.run(
          key,
          cal.libraryId,
          r.calibreId,
          r.class,
          f.source,
          f.title,
          JSON.stringify(f.authors),
          r.reason,
          JSON.stringify(
            r.candidates.map((x) => ({ id: x.id, title: x.title, outcome: x.outcome, why: x.why })),
          ),
          f.hash,
          e?.fp ?? null,
          EBOOK_RULES_VERSION,
          firstReview,
          now,
        );
      }
    })();
    p.done += slice.length;
    p.paired = p.done;
    this.save(p);
    await new Promise((r) => setImmediate(r));
    if (p.done < w.queue.length) return 'more';
    this.countPairs(p);
    this.setPhase(p, 'values');
    return 'more';
  }

  private countPairs(p: Stage8Progress): void {
    p.counts = { auto: 0, review: 0, none: 0, excluded: 0 };
    p.bySource = {};
    for (const r of this.db
      .prepare('SELECT class, kind, COUNT(*) AS n FROM audio_ebook_pairs GROUP BY class, kind')
      .all() as {
      class: keyof Stage8Progress['counts'];
      kind: string;
      n: number;
    }[]) {
      p.counts[r.class] += r.n;
      (p.bySource[r.kind] ??= {})[r.class] = r.n;
    }
  }

  /**
   * Every pair's values (genres, tags, the series rule) and the ebooks' cleanup.db-only data
   * (readings, description). Cheap: the paired recordings only.
   */
  private valuesStep(p: Stage8Progress): void {
    const w = this.work;
    if (!w || !w.facts) {
      this.setPhase(p, 'check');
      return;
    }
    const cal = this.deps.calibre()!;
    const now = this.now();
    const pairs = this.db
      .prepare(
        "SELECT unit_key, calibre_id FROM audio_ebook_pairs WHERE class = 'auto' AND calibre_id IS NOT NULL",
      )
      .all() as { unit_key: string; calibre_id: number }[];
    const seriesRows = new Map<string, SeriesRow>();
    for (const r of this.db
      .prepare(
        `SELECT item_key, value_json, source, rules_json FROM ai_values WHERE stage = 'audio5' AND field = 'series'`,
      )
      .iterate() as Iterable<{
      item_key: string;
      value_json: string;
      source: string;
      rules_json: string | null;
    }>)
      seriesRows.set(r.item_key, {
        value: JSON.parse(r.value_json) as SeriesEntry[] | null,
        source: r.source,
        rules: r.rules_json ? (JSON.parse(r.rules_json) as unknown) : null,
      });
    const seriesChoice = new Map<string, string>();
    for (const r of this.db
      .prepare("SELECT unit_key, value_json FROM audio_ebook_choices WHERE field = 'series'")
      .all() as {
      unit_key: string;
      value_json: string;
    }[])
      seriesChoice.set(r.unit_key, JSON.parse(r.value_json) as string);
    // One series, one spelling: the store's name other recordings of the same Calibre series carry.
    const spelling = new Map<string, Map<string, number>>();
    for (const pr of pairs) {
      const e = w.books.get(pr.calibre_id);
      const sr = seriesRows.get(pr.unit_key);
      if (!e?.series || !sr || seriesOpen(sr)) continue;
      const k = titleForm(e.series);
      const names = spelling.get(k) ?? new Map<string, number>();
      for (const s of sr.value ?? [])
        if (s.position !== null) names.set(s.name, (names.get(s.name) ?? 0) + 1);
      spelling.set(k, names);
    }
    // Every position a series already has (stage 5's values): a filled number never takes one.
    // (series -> position -> the recordings holding it; a recording never collides with itself)
    const taken = new Map<string, Map<number, Set<string>>>();
    for (const [unit, sr] of seriesRows) {
      if (!w.facts.has(unit)) continue;
      for (const s of sr.value ?? [])
        if (s.position !== null) {
          const m = taken.get(titleForm(s.name)) ?? new Map<number, Set<string>>();
          const who = m.get(s.position) ?? new Set<string>();
          who.add(unit);
          m.set(s.position, who);
          taken.set(titleForm(s.name), m);
        }
    }
    const takenByOther = (name: string, pos: number, unit: string) =>
      [...(taken.get(titleForm(name))?.get(pos) ?? [])].some((u) => u !== unit);
    const values = {
      genres: 0,
      tags: 0,
      series: 0,
      seriesReview: 0,
      seriesDisagree: 0,
      noTerms: 0,
    };
    const putValue = this.db.prepare(
      'INSERT INTO audio_ebook_values (unit_key, field, value_json, calibre_id, decided_at) VALUES (?, ?, ?, ?, ?)',
    );
    const putSeries = this.db.prepare(
      `INSERT INTO audio_ebook_series (unit_key, kind, calibre_id, calibre_series, calibre_index, written_name, reason, current_json, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const putBook = this.db.prepare(
      `INSERT INTO audio_ebook_books (library_id, calibre_id, uuid, fp, last_modified, title, authors_json, author_sort,
         series, series_index, terms_json, description, cover_json, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (library_id, calibre_id) DO UPDATE SET uuid = excluded.uuid, fp = excluded.fp,
         last_modified = excluded.last_modified, title = excluded.title, authors_json = excluded.authors_json,
         author_sort = excluded.author_sort, series = excluded.series, series_index = excluded.series_index,
         terms_json = excluded.terms_json, description = excluded.description,
         cover_json = CASE WHEN audio_ebook_books.fp = excluded.fp THEN audio_ebook_books.cover_json ELSE NULL END,
         read_at = excluded.read_at`,
    );
    const filled = new Map<string, Set<number>>();
    // Values of pairs whose ebook left Calibre stay as they were (LOST).
    const lostValues = this.db
      .prepare(
        `SELECT v.unit_key, v.field, v.value_json, v.calibre_id, v.decided_at FROM audio_ebook_values v
         JOIN audio_ebook_pairs p ON p.unit_key = v.unit_key WHERE p.class = 'review' AND p.reason = ?`,
      )
      .all(LOST) as {
      unit_key: string;
      field: string;
      value_json: string;
      calibre_id: number;
      decided_at: number;
    }[];
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM audio_ebook_values').run();
      for (const r of lostValues)
        putValue.run(r.unit_key, r.field, r.value_json, r.calibre_id, r.decided_at);
      this.db.prepare('DELETE FROM audio_ebook_series').run();
      const keep = new Set<number>();
      for (const pr of pairs) {
        const e = w.books.get(pr.calibre_id);
        if (!e) continue;
        keep.add(e.id);
        const terms = ebookTerms(e.tags);
        putBook.run(
          cal.libraryId,
          e.id,
          e.uuid,
          e.fp,
          e.lastModified,
          e.title,
          JSON.stringify(e.authors.map((name, i) => ({ name, sort: e.authorSorts[i] ?? null }))),
          e.authorSort,
          e.series,
          e.index,
          JSON.stringify(terms),
          e.description,
          null,
          now,
        );
        if (terms.genres.length) {
          putValue.run(pr.unit_key, 'genres', JSON.stringify(terms.genres), e.id, now);
          values.genres++;
        }
        if (terms.tags.length) {
          putValue.run(pr.unit_key, 'tags', JSON.stringify(terms.tags), e.id, now);
          values.tags++;
        }
        if (!terms.genres.length && !terms.tags.length) values.noTerms++;
        // The series.
        const f = w.facts!.get(pr.unit_key);
        const sr = seriesRows.get(pr.unit_key);
        if (!e.series || !f) continue;
        if (!seriesOpen(sr)) {
          const cur = (sr?.value ?? []).filter((s) => s.position !== null);
          const agrees = cur.some(
            (s) =>
              (titleForm(s.name) === titleForm(e.series!) ||
                (spelling.get(titleForm(e.series!))?.has(s.name) ?? false)) &&
              s.position === e.index,
          );
          if (!agrees && cur.length) {
            putSeries.run(
              pr.unit_key,
              'disagree',
              e.id,
              e.series,
              e.index,
              null,
              "The store's series differs from Calibre's (shown only; nothing changes)",
              JSON.stringify(sr?.value ?? null),
              now,
            );
            values.seriesDisagree++;
          }
          continue;
        }
        const names = spelling.get(titleForm(e.series));
        // The spelling the recording's own (guessed) series already has when it names the same series
        // (RDGレッドデータガール for Calibre's レッドデータガール): its folder stays.
        const ek = titleForm(e.series);
        const own = (sr?.value ?? []).find((x) => {
          const k = titleForm(x.name);
          return k.length >= 2 && (k.includes(ek) || ek.includes(k));
        });
        // The other recordings' spelling only when this title names it too: theirs can be a
        // sub-series (とある飛空士への恋歌 under Calibre's 飛空士シリーズ), never this book's.
        const top = names && names.size ? [...names].sort((a, b) => b[1] - a[1])[0][0] : null;
        const sibling = top !== null && titleNamesSeries(f.title, top) ? top : null;
        const name = own ? own.name : (sibling ?? e.series);
        const choice = seriesChoice.get(pr.unit_key);
        if (choice === 'none') continue;
        const pos = e.index;
        let why: string | null = null;
        if (choice !== 'calibre') {
          if (!own && top !== null && sibling === null && titleForm(top) !== ek)
            why = `Other recordings of Calibre's series 「${e.series}」 carry 「${top}」, which this title doesn't name`;
          else if (!titleNamesSeries(f.title, e.series) && !titleNamesSeries(f.title, name))
            why = `Calibre's series 「${e.series}」 is not named in the recording's title`;
          else if (
            pos !== null &&
            (takenByOther(name, pos, pr.unit_key) || filled.get(titleForm(name))?.has(pos))
          )
            why = `Another recording is already #${pos} of 「${name}」`;
        }
        if (why) {
          putSeries.run(
            pr.unit_key,
            'review',
            e.id,
            e.series,
            pos,
            name,
            why,
            JSON.stringify(sr?.value ?? null),
            now,
          );
          values.seriesReview++;
          continue;
        }
        putValue.run(
          pr.unit_key,
          'series',
          JSON.stringify([{ name, position: pos, label: null }]),
          e.id,
          now,
        );
        putSeries.run(
          pr.unit_key,
          'fill',
          e.id,
          e.series,
          pos,
          name,
          choice === 'calibre' ? 'You chose its series' : null,
          JSON.stringify(sr?.value ?? null),
          now,
        );
        if (pos !== null) {
          const set = filled.get(titleForm(name)) ?? new Set<number>();
          set.add(pos);
          filled.set(titleForm(name), set);
        }
        values.series++;
      }
      // Ebooks no pair uses any more.
      const del = this.db.prepare(
        'DELETE FROM audio_ebook_books WHERE library_id = ? AND calibre_id = ?',
      );
      for (const r of this.db
        .prepare('SELECT calibre_id FROM audio_ebook_books WHERE library_id = ?')
        .all(cal.libraryId) as {
        calibre_id: number;
      }[])
        if (!keep.has(r.calibre_id)) del.run(cal.libraryId, r.calibre_id);
      this.db
        .prepare(
          `INSERT INTO audio_ebook_state (library_id, snapshot_mtime, snapshot_size, audio_key, rules_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (library_id) DO UPDATE SET snapshot_mtime = excluded.snapshot_mtime,
           snapshot_size = excluded.snapshot_size, audio_key = excluded.audio_key, rules_version = excluded.rules_version,
           updated_at = excluded.updated_at`,
        )
        .run(
          cal.libraryId,
          p.snapshot?.mtimeMs ?? null,
          p.snapshot?.size ?? null,
          this.audioKey(),
          EBOOK_RULES_VERSION,
          now,
        );
    })();
    p.values = values;
    this.setPhase(p, 'covers');
  }

  /** The paired ebooks' covers: stat and SHA-256, under the shared disk lock (Calibre first). */
  private async coversStep(p: Stage8Progress, stopped: () => boolean): Promise<Stage8Step> {
    const cal = this.deps.calibre()!;
    const todo = this.db
      .prepare(
        `SELECT b.calibre_id FROM audio_ebook_books b WHERE b.library_id = ? AND b.cover_json IS NULL ORDER BY b.calibre_id`,
      )
      .all(cal.libraryId) as { calibre_id: number }[];
    if (p.total === 0) p.total = todo.length;
    if (todo.length === 0) {
      this.deps.lock.release(OWNER);
      this.setPhase(p, 'gate');
      return 'more';
    }
    const w = this.work;
    if (!w) {
      this.setPhase(p, 'check');
      return 'more';
    }
    if (this.deps.lock.calibreBusy() || !this.deps.lock.tryAcquire(OWNER, 'audio')) {
      p.waiting = 'Waiting while the Calibre cleanup uses the disk (Calibre goes first)';
      p.covers.waitMs += 2000;
      this.save(p);
      return 'wait';
    }
    p.waiting = null;
    const put = this.db.prepare(
      'UPDATE audio_ebook_books SET cover_json = ? WHERE library_id = ? AND calibre_id = ?',
    );
    try {
      for (const r of todo.slice(0, COVERS_PER_TURN)) {
        if (stopped() || this.deps.lock.shouldYield(OWNER)) break;
        const e = w.books.get(r.calibre_id);
        let cover: Record<string, unknown> = { path: null, missing: true };
        if (e?.hasCover) {
          const rel = `${e.path}/cover.jpg`; // Calibre's book paths use '/'
          // Calibre's own file, read only (calibre/source-fs.ts; it refuses a path that leaves the library).
          const file = resolveInside(cal.libraryDir, rel);
          try {
            const st = await statFile(file);
            if (!st) throw new Error('no cover file');
            const sha = createHash('sha256')
              .update(await readSourceFile(file))
              .digest('hex');
            cover = { path: rel, size: st.size, mtimeMs: st.mtimeMs, sha256: sha };
            p.covers.read++;
          } catch {
            cover = { path: rel, missing: true };
            p.covers.missing++;
          }
        } else p.covers.missing++;
        put.run(JSON.stringify(cover), cal.libraryId, r.calibre_id);
        p.done++;
      }
    } finally {
      this.deps.lock.release(OWNER);
    }
    this.save(p);
    return 'more';
  }

  // ---- the gate ----------------------------------------------------------------------------------

  labels(): { labels: EbookLabel[] | null; error: string | null } {
    const r = this.deps.readLabels?.() ?? {
      text: null,
      error: 'The labeled ebook pairs are not set up',
    };
    if (!r.text) return { labels: null, error: r.error };
    try {
      const j = JSON.parse(r.text) as { books?: EbookLabel[] };
      return Array.isArray(j.books)
        ? { labels: j.books, error: null }
        : { labels: null, error: 'The labels file has no "books"' };
    } catch (err) {
      return { labels: null, error: `The labels file can't be read: ${(err as Error).message}` };
    }
  }

  /** The unit a labeled torrent file belongs to (as stage 5's gate finds it). */
  unitFinder(): (torrent: string) => string | null {
    const s5 = getAudioStage(this.db, 5).progress as { analysisId?: string; stage4Id?: string };
    const rows = this.db
      .prepare(
        `SELECT m.unit_key, o.inputs_json FROM audio_meta_units m
         JOIN audio_online_units o ON o.analysis_id = ? AND o.unit_key = m.unit_key
         WHERE m.analysis_id = ?`,
      )
      .all(s5.stage4Id ?? '', s5.analysisId ?? '') as { unit_key: string; inputs_json: string }[];
    const byPath = new Map<string, string>();
    for (const r of rows) {
      const inputs = JSON.parse(r.inputs_json) as UnitInputs;
      for (const f of inputs.opening) if (f.root === 'torrents') byPath.set(f.rel, r.unit_key);
      for (const pth of inputs.paths) {
        const rel = pth.slice(pth.indexOf(':') + 1);
        if (pth.startsWith('torrents:') && !byPath.has(rel)) byPath.set(rel, r.unit_key);
      }
    }
    return (torrent) => {
      const exact = byPath.get(torrent);
      if (exact) return exact;
      for (const [rel, u] of byPath) if (rel.startsWith(torrent + '/')) return u;
      return null;
    };
  }

  evaluateGate(): EbookGate {
    const l = this.labels();
    if (!l.labels)
      return { passed: false, labels: 0, notFound: [], kinds: {}, wrong: [], error: l.error };
    const pairOf = this.db.prepare(
      'SELECT class, calibre_id, audio_title FROM audio_ebook_pairs WHERE unit_key = ?',
    );
    return scoreEbookGate(l.labels, this.unitFinder(), (u) => {
      const r = pairOf.get(u) as
        | { class: string; calibre_id: number | null; audio_title: string }
        | undefined;
      return r ? { cls: r.class, id: r.calibre_id, title: r.audio_title } : null;
    });
  }

  private gateStep(p: Stage8Progress): Stage8Step {
    p.gate = this.evaluateGate();
    if (p.counts.auto + p.counts.review + p.counts.none + p.counts.excluded === 0)
      this.countPairs(p);
    this.save(p);
    this.setPhase(p, 'preview');
    if (!p.gate.passed && this.mode() === 'on')
      return {
        stop: p.gate.error
          ? `Stage 8's gate can't be scored: ${p.gate.error}`
          : `Stage 8's gate failed: ${p.gate.wrong.length} wrong automatic pair(s) on the labeled recordings${p.gate.notFound.length ? `, ${p.gate.notFound.length} labeled recording(s) not found` : ''}`,
      };
    return 'more';
  }

  // ---- the page -----------------------------------------------------------------------------------

  /** A review choice: field 'pair' (a Calibre id or null) or 'series' ('calibre' | 'none'). */
  choose(unitKey: string, field: string, value: unknown): void {
    if (!/^[A-Za-z0-9:_.-]{1,200}$/.test(unitKey)) throw new Error('Not a recording');
    const ok =
      (field === 'pair' &&
        (value === null ||
          (typeof value === 'number' && Number.isSafeInteger(value) && value > 0))) ||
      (field === 'series' && (value === 'calibre' || value === 'none'));
    if (!ok) throw new Error('Not a choice');
    const exists = this.db
      .prepare('SELECT 1 FROM audio_ebook_pairs WHERE unit_key = ?')
      .get(unitKey);
    if (!exists) throw new Error('Not a recording');
    this.db
      .prepare(
        `INSERT INTO audio_ebook_choices (unit_key, field, value_json, chosen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (unit_key, field) DO UPDATE SET value_json = excluded.value_json, chosen_at = excluded.chosen_at`,
      )
      .run(unitKey, field, JSON.stringify(value), this.now());
  }

  list(
    kind: string,
    opts: { offset?: number; limit?: number } = {},
  ): { total: number; items: unknown[] } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const db = this.db;
    if (['auto', 'review', 'none', 'excluded'].includes(kind)) {
      const total = (
        db.prepare('SELECT COUNT(*) AS n FROM audio_ebook_pairs WHERE class = ?').get(kind) as {
          n: number;
        }
      ).n;
      const items = (
        db
          .prepare(
            `SELECT p.unit_key, p.kind, p.audio_title, p.audio_authors, p.reason, p.calibre_id, p.candidates_json,
                    b.title AS ebook_title, b.series, b.series_index, b.terms_json,
                    (SELECT value_json FROM audio_ebook_choices c WHERE c.unit_key = p.unit_key AND c.field = 'pair') AS choice
             FROM audio_ebook_pairs p LEFT JOIN audio_ebook_books b ON b.library_id = p.library_id AND b.calibre_id = p.calibre_id
             WHERE p.class = ? ORDER BY p.audio_title, p.unit_key LIMIT ? OFFSET ?`,
          )
          .all(kind, limit, offset) as Record<string, unknown>[]
      ).map((r) => ({
        unitKey: r.unit_key,
        source: r.kind,
        title: r.audio_title,
        authors: JSON.parse(String(r.audio_authors)),
        reason: r.reason,
        calibreId: r.calibre_id,
        ebook: r.ebook_title
          ? {
              title: r.ebook_title,
              series: r.series,
              index: r.series_index,
              terms: JSON.parse(String(r.terms_json)),
            }
          : null,
        candidates: (JSON.parse(String(r.candidates_json)) as unknown[]).slice(0, 5),
        choice: r.choice ? JSON.parse(String(r.choice)) : undefined,
      }));
      return { total, items };
    }
    if (kind === 'series-fill' || kind === 'series-review' || kind === 'series-disagree') {
      const k = kind.slice('series-'.length);
      const total = (
        db.prepare('SELECT COUNT(*) AS n FROM audio_ebook_series WHERE kind = ?').get(k) as {
          n: number;
        }
      ).n;
      const items = (
        db
          .prepare(
            `SELECT s.*, p.audio_title, (SELECT value_json FROM audio_ebook_choices c WHERE c.unit_key = s.unit_key AND c.field = 'series') AS choice
             FROM audio_ebook_series s JOIN audio_ebook_pairs p ON p.unit_key = s.unit_key
             WHERE s.kind = ? ORDER BY p.audio_title, s.unit_key LIMIT ? OFFSET ?`,
          )
          .all(k, limit, offset) as Record<string, unknown>[]
      ).map((r) => ({
        unitKey: r.unit_key,
        title: r.audio_title,
        calibreId: r.calibre_id,
        calibreSeries: r.calibre_series,
        calibreIndex: r.calibre_index,
        name: r.written_name,
        reason: r.reason,
        current: r.current_json ? JSON.parse(String(r.current_json)) : null,
        choice: r.choice ? JSON.parse(String(r.choice)) : undefined,
      }));
      return { total, items };
    }
    if (kind === 'terms') {
      const total = (
        db
          .prepare(
            "SELECT COUNT(DISTINCT unit_key) AS n FROM audio_ebook_values WHERE field IN ('genres', 'tags')",
          )
          .get() as { n: number }
      ).n;
      const items = (
        db
          .prepare(
            `SELECT p.unit_key, p.audio_title, p.calibre_id, b.title AS ebook_title,
                    (SELECT value_json FROM audio_ebook_values v WHERE v.unit_key = p.unit_key AND v.field = 'genres') AS genres,
                    (SELECT value_json FROM audio_ebook_values v WHERE v.unit_key = p.unit_key AND v.field = 'tags') AS tags
             FROM audio_ebook_pairs p JOIN audio_ebook_books b ON b.library_id = p.library_id AND b.calibre_id = p.calibre_id
             WHERE p.class = 'auto' AND EXISTS (SELECT 1 FROM audio_ebook_values v WHERE v.unit_key = p.unit_key AND v.field IN ('genres', 'tags'))
             ORDER BY p.audio_title, p.unit_key LIMIT ? OFFSET ?`,
          )
          .all(limit, offset) as Record<string, unknown>[]
      ).map((r) => ({
        unitKey: r.unit_key,
        title: r.audio_title,
        calibreId: r.calibre_id,
        ebookTitle: r.ebook_title,
        genres: r.genres ? JSON.parse(String(r.genres)) : [],
        tags: r.tags ? JSON.parse(String(r.tags)) : [],
      }));
      return { total, items };
    }
    if (kind === 'preview') {
      const total = (
        db.prepare('SELECT COUNT(*) AS n FROM audio_ebook_preview').get() as { n: number }
      ).n;
      const items = (
        db
          .prepare('SELECT * FROM audio_ebook_preview ORDER BY folder_from LIMIT ? OFFSET ?')
          .all(limit, offset) as Record<string, unknown>[]
      ).map((r) => ({
        bookId: r.book_id,
        folderFrom: r.folder_from,
        folderTo: r.folder_to,
        fields: JSON.parse(String(r.fields_json)),
        reviews: JSON.parse(String(r.reviews_json)),
      }));
      return { total, items };
    }
    throw new Error('No such list');
  }

  /** The pairs as CSV (the page's download). */
  csv(): string {
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      'class,source,title,authors,calibre_id,ebook_title,series,index,genres,tags,reason',
    ];
    for (const r of this.db
      .prepare(
        `SELECT p.class, p.kind, p.audio_title, p.audio_authors, p.calibre_id, b.title, b.series, b.series_index,
                b.terms_json, p.reason
         FROM audio_ebook_pairs p LEFT JOIN audio_ebook_books b ON b.library_id = p.library_id AND b.calibre_id = p.calibre_id
         ORDER BY p.class, p.audio_title`,
      )
      .iterate() as Iterable<Record<string, unknown>>) {
      const t = r.terms_json
        ? (JSON.parse(String(r.terms_json)) as { genres: string[]; tags: string[] })
        : null;
      lines.push(
        [
          r.class,
          r.kind,
          r.audio_title,
          (JSON.parse(String(r.audio_authors)) as string[]).join(' & '),
          r.calibre_id,
          r.title,
          r.series,
          r.series_index,
          t?.genres.join(' / '),
          t?.tags.join(' / '),
          r.reason,
        ]
          .map(esc)
          .join(','),
      );
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Stage 8's part of a stage-7 run's report (the notifications read it): null when the pass did
   * not run in that run. `newReview`: recordings that went to review in this run.
   */
  runReport(runId: number | null): Stage8RunReport | null {
    const p = this.progress();
    if (!p || runId === null || p.runId !== runId) return null;
    const newReview = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audio_ebook_pairs WHERE class = 'review' AND first_review_run = ?",
        )
        .get(runId) as { n: number }
    ).n;
    return {
      mode: this.mode(),
      reason: p.reason ?? null,
      counts: p.counts,
      values: p.values,
      ebooks: p.ebooks ?? null,
      covers: p.covers,
      preview: p.preview,
      gate: p.gate
        ? { passed: p.gate.passed, labels: p.gate.labels, wrong: p.gate.wrong.length }
        : null,
      newReview,
      error: p.error,
    };
  }

  /** The page's status line. */
  status(): Record<string, unknown> {
    const p = this.progress();
    return {
      mode: this.mode(),
      progress: p,
      calibre: this.deps.calibre() ? true : false,
    };
  }
}
