/**
 * Series under a short and a full name: the pass (tier 4, Part 3; cleanup-finish.md, stops 1-3
 * in cleanup-reference/tier4-series-pairs-stop{1,2}.md).
 *
 * Off / Preview / On, like More Bookmeter matches. Preview: the library's pairs (pairs.ts), each
 * pair's signals from Calibre now and stage 4's stored store answers, the rules' answer (the
 * rules proposed at stop 1, with stop 2's guards), and the merge proposals. On: the merges are
 * written through stage 4's field batches (the sidecar's series write, Undo per batch), then the
 * open stage-4 series proposals of the merged books follow the merge.
 *
 * - A merge keeps the short name as written (commonName) and each book's number; it never puts
 *   two books on one number (a pair that would goes to review, and Merge is refused for it).
 * - One choice per pair, shared with the series editor (series_pair_decisions): Merge, Keep
 *   separate, Forget my choice; an automatic merge is recorded there as the rules' once written.
 * - No merge touches a book whose series field is the user's (the whole pair goes to review).
 * - Everything runs in short slices (WP20 lessons 3: nothing blocks the server).
 */
import type Database from 'better-sqlite3';
import type { Stage2Batches } from '../stage2-batches';
import { seriesKey } from '../stage4/series-spelling';
import {
  CANDIDATE_RULES,
  PROPOSED_RULE_IDS,
  answerPair,
  commonName,
  libraryPairs,
  pairGroup,
  pairSignals,
  type NamePair,
  type PairAnswer,
  type PairBook,
  type PairGroup,
  type PairSignals,
} from './pairs';

export type SpMode = 'off' | 'analyse' | 'on';
export type SpPhase = 'pairs' | 'signals' | 'propose' | 'write' | 'done';
export type SpStep = 'more' | 'wait' | 'idle';

/** One Calibre book with its series as Calibre holds it now (the reader's snapshot). */
export interface SpLibraryBook {
  uuid: string;
  calibreId: number;
  title: string;
  authors: string[];
  identifiers: Record<string, string>;
  series: string | null;
  index: number | null;
}

/** What stage 4 stored about a book (only records it accepted as the book). */
export interface SpFacts {
  kind: PairBook['kind'];
  own: string[];
  amazonSeries: string | null;
  ranobedbSeries: { id: string; name: string | null } | null;
  bookwalkerUrl: string | null;
  asin: string | null;
}

export interface SeriesPairsSource {
  /** Every book of the library with its series now; null when the snapshot isn't ready. */
  books(libraryId: string): SpLibraryBook[] | null;
  facts(libraryId: string, uuid: string): SpFacts | null;
}

export interface SeriesPairsDeps {
  db: Database.Database;
  source: SeriesPairsSource;
  batches: Pick<Stage2Batches, 'plan'>;
  targetLibrary: () => string | null;
  /** Why the write must wait now (stage 4 paused, a batch open, the safety checks), else null. */
  writeWait: (libraryId: string) => string | null;
  log?: (msg: string) => void;
}

export interface SpProgress {
  run: number;
  libraryId: string | null;
  phase: SpPhase;
  cursor: number;
  pairs: number;
  done: number;
  startedAt: number | null;
  phaseStartedAt: number | null;
  finishedAt: number | null;
  counts: Record<PairAnswer, number>;
  propose: { books: number; pairs: number; yours: number };
  write: { batches: string[]; waiting: string | null; repointed: number; closed: number };
  error: string | null;
}

export function emptySpProgress(run = 1, libraryId: string | null = null): SpProgress {
  return {
    run,
    libraryId,
    phase: 'pairs',
    cursor: 0,
    pairs: 0,
    done: 0,
    startedAt: null,
    phaseStartedAt: null,
    finishedAt: null,
    counts: { merge: 0, separate: 0, review: 0 },
    propose: { books: 0, pairs: 0, yours: 0 },
    write: { batches: [], waiting: null, repointed: 0, closed: 0 },
    error: null,
  };
}

export const seriesPairsAnalysisId = (run: number) => `series-pairs:${run}`;

/** Work per slice before the server gets the event loop back. */
const SLICE_MS = 25;

/**
 * Pairs Claude's check at stop 2 sends to review although a rule would merge them (the user,
 * 2026-11-23, "Build stop 3": as proposed). By the two names as Calibre holds them.
 */
export const CHECK_HOLDS: { short: string; long: string; note: string }[] = [
  {
    short: '欲望の守護神',
    long: '欲望の守護神シリーズ',
    note: 'Not verifiable: Amazon shows these books only behind its adult-content gate, and no other store has them',
  },
  {
    short: 'ミルク',
    long: 'ミルクシリーズ',
    note: 'Not verifiable: Amazon shows these books only behind its adult-content gate, and no other store has them',
  },
  {
    short: '亜由美',
    long: '亜由美シリーズ',
    note: 'One series by the titles (小説『亜由美』第一部/第二部/第三部), but the full name also holds 安里咲 1-2, which may be a series of its own',
  },
];

const RULES = PROPOSED_RULE_IDS.map((id) => CANDIDATE_RULES.find((r) => r.id === id)!);

/** A pair row as the page shows it. */
export interface SpPairView {
  id: number;
  short: string;
  long: string;
  group: PairGroup;
  added: string;
  kept: string;
  shortBooks: number;
  longBooks: number;
  answer: PairAnswer | null;
  rule: string | null;
  held: string | null;
  note: string | null;
  signals: PairSignals | null;
  books: { short: SpBookView[]; long: SpBookView[] };
  decision: {
    decision: 'different' | 'merged';
    by: string;
    note: string | null;
    at: number;
  } | null;
  /** Merge proposals of this run for the pair, by state. */
  merge: Record<string, number>;
}

export interface SpBookView {
  uuid: string;
  calibreId: number;
  title: string;
  authors: string[];
  index: number | null;
  kind: PairBook['kind'];
  links: { site: string; url: string }[];
}

export interface SpState {
  mode: SpMode;
  progress: SpProgress;
  pausedReason: string | null;
}

export function getSpState(db: Database.Database): SpState {
  const r = db.prepare('SELECT * FROM series_pairs_state WHERE id = 1').get() as {
    mode: SpMode;
    progress_json: string;
    paused_reason: string | null;
  };
  const stored = JSON.parse(r.progress_json) as Partial<SpProgress>;
  const base = emptySpProgress();
  return {
    mode: r.mode,
    progress: stored.phase ? { ...base, ...stored } : base,
    pausedReason: r.paused_reason,
  };
}

function saveProgress(db: Database.Database, p: SpProgress): void {
  db.prepare(
    'UPDATE series_pairs_state SET progress_json = ?, library_id = ?, updated_at = ? WHERE id = 1',
  ).run(JSON.stringify(p), p.libraryId, Date.now());
}

const pairKey = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export class SeriesPairs {
  private readonly db: Database.Database;
  /** The library's books by series name, kept for one run's slices. */
  private library: { at: number; byName: Map<string, SpLibraryBook[]> } | null = null;
  /** Each book's pair facts, read once per run (a big pair is read over several slices). */
  private facts = new Map<string, PairBook>();

  constructor(private readonly deps: SeriesPairsDeps) {
    this.db = deps.db;
  }

  state(): SpState {
    return getSpState(this.db);
  }

  setMode(mode: SpMode): void {
    this.db
      .prepare('UPDATE series_pairs_state SET mode = ?, updated_at = ? WHERE id = 1')
      .run(mode, Date.now());
    this.deps.log?.(`Series under two names: ${mode === 'analyse' ? 'Preview' : mode}`);
  }

  /** Starts over from the library as it is now (a new run; written merges stay written). */
  again(): void {
    const p = this.state().progress;
    saveProgress(this.db, emptySpProgress(p.run + 1, p.libraryId));
    this.library = null;
    this.facts.clear();
  }

  /** One step; 'idle' when there is nothing to do now. */
  async step(): Promise<SpStep> {
    const st = this.state();
    if (st.mode === 'off') return 'idle';
    const lib = this.deps.targetLibrary();
    if (!lib) return 'idle';
    let p = st.progress;
    if (p.libraryId !== lib) {
      p = emptySpProgress(p.run + (p.libraryId ? 1 : 0), lib);
      saveProgress(this.db, p);
      this.library = null;
      this.facts.clear();
    }
    if (p.phase === 'done') return 'idle';
    p.startedAt ??= Date.now();
    p.phaseStartedAt ??= Date.now();
    let r: SpStep = 'idle';
    try {
      if (p.phase === 'pairs') r = this.pairsStep(p, lib);
      else if (p.phase === 'signals') r = this.signalsStep(p, lib);
      else if (p.phase === 'propose') r = this.proposeStep(p, lib);
      else if (p.phase === 'write') r = st.mode === 'on' ? await this.writeStep(p, lib) : 'idle';
    } catch (err) {
      p.error = String((err as Error).message ?? err).slice(0, 500);
      p.phase = 'done';
      p.finishedAt = Date.now();
      this.deps.log?.(`Series under two names failed: ${p.error}`);
      r = 'idle';
    } finally {
      saveProgress(this.db, p);
    }
    return r;
  }

  private next(p: SpProgress, phase: SpPhase): void {
    p.phase = phase;
    p.cursor = 0;
    p.phaseStartedAt = Date.now();
    if (phase === 'done') p.finishedAt = Date.now();
  }

  private byName(lib: string): Map<string, SpLibraryBook[]> | null {
    if (this.library) return this.library.byName;
    const books = this.deps.source.books(lib);
    if (!books) return null;
    const byName = new Map<string, SpLibraryBook[]>();
    for (const b of books) {
      if (!b.series) continue;
      byName.set(b.series, [...(byName.get(b.series) ?? []), b]);
    }
    this.library = { at: Date.now(), byName };
    return byName;
  }

  /** The pairs of the library as it is now (one transaction; about 450 rows). */
  private pairsStep(p: SpProgress, lib: string): SpStep {
    const byName = this.byName(lib);
    if (!byName) return 'wait';
    const pairs = libraryPairs([...byName].map(([name, bs]) => ({ name, books: bs.length })));
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM series_pairs WHERE library_id = ?').run(lib);
      const ins = this.db.prepare(
        `INSERT INTO series_pairs (library_id, run, short_name, long_name, grp, added, kept_name,
           short_books, long_books, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const q of pairs)
        ins.run(
          lib,
          p.run,
          q.short,
          q.long,
          q.group,
          q.added,
          commonName(q.short, q.long).name,
          q.shortBooks,
          q.longBooks,
          now,
        );
    })();
    p.pairs = pairs.length;
    p.done = 0;
    p.counts = { merge: 0, separate: 0, review: 0 };
    this.next(p, 'signals');
    return 'more';
  }

  private pairBook(lib: string, b: SpLibraryBook): PairBook {
    const f = this.deps.source.facts(lib, b.uuid);
    const links: PairBook['links'] = [];
    const asin = b.identifiers.amazon_jp ?? b.identifiers.amazon ?? f?.asin ?? null;
    if (asin) links.push({ site: 'amazon', url: `https://www.amazon.co.jp/dp/${asin}` });
    if (b.identifiers.bookwalker)
      links.push({
        site: 'bookwalker',
        url: `https://bookwalker.jp/de${b.identifiers.bookwalker}/`,
      });
    else if (f?.bookwalkerUrl) links.push({ site: 'bookwalker', url: f.bookwalkerUrl });
    if (f?.ranobedbSeries)
      links.push({ site: 'ranobedb', url: `https://ranobedb.org/series/${f.ranobedbSeries.id}` });
    if (b.identifiers.bookmeter)
      links.push({
        site: 'bookmeter',
        url: `https://bookmeter.com/books/${b.identifiers.bookmeter}`,
      });
    return {
      uuid: b.uuid,
      calibreId: b.calibreId,
      title: b.title,
      authors: b.authors,
      index: b.index,
      kind: f?.kind ?? 'full',
      own: f?.own?.length ? f.own : [b.title],
      amazonSeries: f?.amazonSeries ?? null,
      ranobedbSeries: f?.ranobedbSeries ?? null,
      links,
    };
  }

  /** The pair's answer: the user's choice, Claude's check, else the rules'. */
  private decide(
    lib: string,
    pair: NamePair,
    s: PairSignals,
    yours: boolean,
  ): { answer: PairAnswer; rule: string | null; held: string | null; note: string | null } {
    const d = this.decision(lib, pair.short, pair.long);
    if (d?.decision === 'different')
      return { answer: 'separate', rule: `decided:${d.by}`, held: null, note: d.note };
    if (d?.decision === 'merged') {
      if (s.collisions > 0)
        return { answer: 'review', rule: `decided:${d.by}`, held: 'collision', note: d.note };
      // The write never changes a series field of yours: the merge would stop halfway.
      if (yours) return { answer: 'review', rule: `decided:${d.by}`, held: 'yours', note: d.note };
      return { answer: 'merge', rule: `decided:${d.by}`, held: null, note: d.note };
    }
    const a = answerPair(pair, s, RULES);
    if (a.answer === 'merge') {
      if (yours) return { answer: 'review', rule: a.rule, held: 'yours', note: null };
      const hold = CHECK_HOLDS.find((h) => h.short === pair.short && h.long === pair.long);
      if (hold) return { answer: 'review', rule: a.rule, held: 'check', note: hold.note };
    }
    return { answer: a.answer, rule: a.rule, held: a.held ?? null, note: null };
  }

  private decision(
    lib: string,
    a: string,
    b: string,
  ): { decision: 'different' | 'merged'; by: string; note: string | null; at: number } | null {
    const [x, y] = pairKey(a, b);
    const r = this.db
      .prepare(
        `SELECT decision, decided_by, note, decided_at FROM series_pair_decisions
         WHERE library_id = ? AND name_a = ? AND name_b = ?`,
      )
      .get(lib, x, y) as
      | {
          decision: 'different' | 'merged';
          decided_by: string;
          note: string | null;
          decided_at: number;
        }
      | undefined;
    return r ? { decision: r.decision, by: r.decided_by, note: r.note, at: r.decided_at } : null;
  }

  private yoursUuids(lib: string): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT calibre_uuid FROM user_fields WHERE library_id = ? AND field IN ('series', 'series_index')`,
          )
          .all(lib) as { calibre_uuid: string }[]
      ).map((r) => r.calibre_uuid),
    );
  }

  private signalsStep(p: SpProgress, lib: string): SpStep {
    const byName = this.byName(lib);
    if (!byName) return 'wait';
    const rows = this.db
      .prepare(
        `SELECT id, short_name, long_name, grp, added, short_books, long_books FROM series_pairs
         WHERE library_id = ? AND id > ? ORDER BY id LIMIT 50`,
      )
      .all(lib, p.cursor) as {
      id: number;
      short_name: string;
      long_name: string;
      grp: PairGroup;
      added: string;
      short_books: number;
      long_books: number;
    }[];
    if (!rows.length) {
      this.next(p, 'propose');
      return 'more';
    }
    const yours = this.yoursUuids(lib);
    const t0 = performance.now();
    const upd = this.db.prepare(
      `UPDATE series_pairs SET signals_json = ?, books_json = ?, answer = ?, rule = ?, held = ?, note = ?, updated_at = ?
       WHERE id = ?`,
    );
    for (const r of rows) {
      // The pair's books, one at a time (解註謡曲全集 has 199): a slice that runs out returns
      // and the next one goes on from the books already read.
      const all = [...(byName.get(r.short_name) ?? []), ...(byName.get(r.long_name) ?? [])];
      for (const b of all) {
        if (this.facts.has(b.uuid)) continue;
        if (performance.now() - t0 > SLICE_MS) return 'more';
        this.facts.set(b.uuid, this.pairBook(lib, b));
      }
      if (performance.now() - t0 > SLICE_MS) return 'more';
      const shortBooks = (byName.get(r.short_name) ?? []).map((b) => this.facts.get(b.uuid)!);
      const longBooks = (byName.get(r.long_name) ?? []).map((b) => this.facts.get(b.uuid)!);
      const pair: NamePair = {
        short: r.short_name,
        long: r.long_name,
        shortBooks: shortBooks.length,
        longBooks: longBooks.length,
        group: r.grp,
        added: r.added,
      };
      const s = pairSignals(pair, shortBooks, longBooks);
      const mine = [...shortBooks, ...longBooks].some((b) => yours.has(b.uuid));
      const d = this.decide(lib, pair, s, mine);
      const view = (b: PairBook): SpBookView => ({
        uuid: b.uuid,
        calibreId: b.calibreId,
        title: b.title,
        authors: b.authors,
        index: b.index,
        kind: b.kind,
        links: b.links,
      });
      upd.run(
        JSON.stringify(s),
        JSON.stringify({ short: shortBooks.map(view), long: longBooks.map(view) }),
        d.answer,
        d.rule,
        d.held,
        d.note,
        Date.now(),
        r.id,
      );
      p.counts[d.answer]++;
      p.done++;
      p.cursor = r.id;
    }
    return 'more';
  }

  /**
   * The merge proposals: every book not under the kept name gets the kept name and keeps its
   * number. Stage 4's field batches write them (only this run's, by its analysis id).
   */
  private proposeStep(p: SpProgress, lib: string): SpStep {
    const aid = seriesPairsAnalysisId(p.run);
    if (p.cursor === 0) {
      // This run's open proposals are made again; set-aside and written ones stay.
      this.db
        .prepare(
          `DELETE FROM proposed_changes WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ?
             AND state = 'proposed' AND stage = 4 AND field = 'series' AND batch_id IS NULL`,
        )
        .run(lib, aid);
      p.propose = { books: 0, pairs: 0, yours: 0 };
    }
    const rows = this.db
      .prepare(
        `SELECT id, short_name, long_name, kept_name, books_json, rule FROM series_pairs
         WHERE library_id = ? AND answer = 'merge' AND id > ? ORDER BY id LIMIT 20`,
      )
      .all(lib, p.cursor) as {
      id: number;
      short_name: string;
      long_name: string;
      kept_name: string;
      books_json: string;
      rule: string | null;
    }[];
    if (!rows.length) {
      this.next(p, 'write');
      return 'more';
    }
    const t0 = performance.now();
    for (const r of rows) {
      if (performance.now() - t0 > SLICE_MS) break;
      p.cursor = r.id;
      p.propose.books += this.proposeMerge(lib, p.run, r);
      p.propose.pairs++;
    }
    return 'more';
  }

  /** Proposes one pair's merge; the number of books proposed. */
  private proposeMerge(
    lib: string,
    run: number,
    r: {
      short_name: string;
      long_name: string;
      kept_name: string;
      books_json: string;
      rule: string | null;
    },
  ): number {
    const aid = seriesPairsAnalysisId(run);
    const books = JSON.parse(r.books_json) as { short: SpBookView[]; long: SpBookView[] };
    const now = Date.now();
    const already = this.db.prepare(
      `SELECT state FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND field = 'series' AND analysis_id LIKE 'series-pairs:%'
         AND state IN ('applied', 'queued', 'undone')`,
    );
    const ins = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json, new_json, source,
         evidence_json, class, review_reason, state, analysis_id, created_at, updated_at)
       VALUES (4, ?, ?, ?, 'series', ?, ?, 'series-pairs', ?, 'auto', NULL, 'proposed', ?, ?, ?)`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const [side, list] of [
        ['short', books.short],
        ['long', books.long],
      ] as const) {
        const from = side === 'short' ? r.short_name : r.long_name;
        if (from === r.kept_name) continue;
        for (const b of list) {
          // Written, being written, or undone by the user: never proposed again.
          if (already.get(lib, b.uuid)) continue;
          ins.run(
            lib,
            b.calibreId,
            b.uuid,
            JSON.stringify({ name: from, index: b.index }),
            JSON.stringify({ name: r.kept_name, index: b.index }),
            JSON.stringify({
              seriesPair: {
                short: r.short_name,
                long: r.long_name,
                kept: r.kept_name,
                rule: r.rule,
              },
            }),
            aid,
            now,
            now,
          );
          n++;
        }
      }
    })();
    return n;
  }

  private async writeStep(p: SpProgress, lib: string): Promise<SpStep> {
    // The merges written so far: stage 4's open proposals of those books follow the merge.
    this.followMerges(p, lib);
    const wait = this.deps.writeWait(lib);
    if (wait) {
      p.write.waiting = wait;
      return 'wait';
    }
    const r = await this.deps.batches.plan(lib, { analysisId: seriesPairsAnalysisId(p.run) });
    if (r.batch) {
      p.write.batches.push(r.batch.id);
      p.write.waiting = 'A batch is being applied';
      this.deps.log?.(`Series under two names: batch ${r.batch.id} planned`);
      return 'wait';
    }
    if (r.reason && !/nothing/i.test(r.reason)) {
      p.write.waiting = r.reason;
      return 'wait';
    }
    this.followMerges(p, lib);
    p.write.waiting = null;
    this.next(p, 'done');
    return 'more';
  }

  /**
   * After a merge is written: the pair is recorded as merged (the rules', unless someone chose),
   * and each open stage-4 series proposal of a merged book that names one of the two names takes
   * the kept name (its number unchanged); one that then changes nothing is closed. Accepting one
   * later can no longer split the series again (stop 2: 34 books in 15 merges).
   */
  followMerges(p: SpProgress, lib: string): void {
    const aid = seriesPairsAnalysisId(p.run);
    const rows = this.db
      .prepare(
        `SELECT id, calibre_uuid, new_json, evidence_json FROM proposed_changes
         WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ? AND state = 'applied'
           AND stage = 4 AND field = 'series' AND json_extract(evidence_json, '$.followed') IS NULL`,
      )
      .all(lib, aid) as {
      id: number;
      calibre_uuid: string;
      new_json: string;
      evidence_json: string;
    }[];
    if (!rows.length) return;
    const open = this.db.prepare(
      `SELECT id, new_json FROM proposed_changes INDEXED BY proposed_changes_book
       WHERE library_id = ? AND calibre_uuid = ? AND stage = 4 AND field = 'series' AND state = 'proposed'
         AND (analysis_id IS NULL OR analysis_id NOT LIKE 'series-pairs:%')`,
    );
    const now = Date.now();
    /** One book's open stage-4 series proposals, now that Calibre holds `now` for it. */
    const follow = (
      uuid: string,
      keys: Set<string>,
      calibre: { name: string; index: number | null },
    ) => {
      for (const o of open.all(lib, uuid) as { id: number; new_json: string }[]) {
        const n = JSON.parse(o.new_json) as { name?: string | null; index?: number | null } | null;
        if (!n?.name || !keys.has(seriesKey(n.name))) continue;
        const moved = { name: calibre.name, index: n.index ?? null };
        if (moved.index === calibre.index) {
          this.db
            .prepare(
              `UPDATE proposed_changes SET state = 'skipped', review_reason = ?, updated_at = ? WHERE id = ?`,
            )
            .run('Done by the series merge (series under two names)', now, o.id);
          p.write.closed++;
        } else {
          this.db
            .prepare(
              `UPDATE proposed_changes SET old_json = ?, new_json = ?, updated_at = ? WHERE id = ?`,
            )
            .run(JSON.stringify(calibre), JSON.stringify(moved), now, o.id);
          p.write.repointed++;
        }
      }
    };
    const pairs = new Map<string, { short: string; long: string; kept: string }>();
    this.db.transaction(() => {
      for (const r of rows) {
        const ev = JSON.parse(r.evidence_json) as {
          seriesPair: { short: string; long: string; kept: string };
          followed?: boolean;
        };
        const written = JSON.parse(r.new_json) as { name: string; index: number | null };
        const keys = new Set([seriesKey(ev.seriesPair.short), seriesKey(ev.seriesPair.long)]);
        follow(r.calibre_uuid, keys, written);
        pairs.set(`${ev.seriesPair.short}\u0000${ev.seriesPair.long}`, ev.seriesPair);
        ev.followed = true;
        this.db
          .prepare('UPDATE proposed_changes SET evidence_json = ? WHERE id = ?')
          .run(JSON.stringify(ev), r.id);
      }
      // The books that were under the kept name already: their open proposals naming the
      // other name would split the series again too.
      for (const sp of pairs.values()) {
        const row = this.db
          .prepare(
            'SELECT books_json FROM series_pairs WHERE library_id = ? AND short_name = ? AND long_name = ?',
          )
          .get(lib, sp.short, sp.long) as { books_json: string | null } | undefined;
        const books = row?.books_json
          ? (JSON.parse(row.books_json) as { short: SpBookView[]; long: SpBookView[] })
          : null;
        const kept = sp.kept === sp.short ? books?.short : sp.kept === sp.long ? books?.long : null;
        const keys = new Set([seriesKey(sp.short), seriesKey(sp.long)]);
        for (const b of kept ?? []) follow(b.uuid, keys, { name: sp.kept, index: b.index });
        const [x, y] = pairKey(sp.short, sp.long);
        this.db
          .prepare(
            `INSERT INTO series_pair_decisions (library_id, name_a, name_b, decision, decided_at, decided_by, note)
             VALUES (?, ?, ?, 'merged', ?, 'rules', NULL) ON CONFLICT(library_id, name_a, name_b) DO NOTHING`,
          )
          .run(lib, x, y, now);
      }
    })();
  }

  // ------------------------------------------------------------ the page

  /** A page of pairs: review (default), merge, separate, or decided. */
  list(
    lib: string,
    view: 'review' | 'merge' | 'separate' | 'decided',
    offset: number,
    limit: number,
  ): { total: number; pairs: SpPairView[] } {
    const run = this.state().progress.run;
    const where =
      view === 'decided'
        ? `library_id = ? AND EXISTS (SELECT 1 FROM series_pair_decisions d WHERE d.library_id = series_pairs.library_id
             AND d.decided_by = 'you'
             AND ((d.name_a = short_name AND d.name_b = long_name) OR (d.name_a = long_name AND d.name_b = short_name)))`
        : `library_id = ? AND answer = '${view}'`;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM series_pairs WHERE ${where}`).get(lib) as {
        n: number;
      }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM series_pairs WHERE ${where} ORDER BY short_books + long_books DESC, id LIMIT ? OFFSET ?`,
      )
      .all(lib, limit, offset) as SpRow[];
    return { total, pairs: rows.map((r) => this.view(lib, run, r)) };
  }

  pair(lib: string, id: number): SpPairView | null {
    const r = this.db
      .prepare('SELECT * FROM series_pairs WHERE library_id = ? AND id = ?')
      .get(lib, id) as SpRow | undefined;
    return r ? this.view(lib, this.state().progress.run, r) : null;
  }

  private view(lib: string, run: number, r: SpRow): SpPairView {
    const merge: Record<string, number> = {};
    for (const m of this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes
         WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ?
           AND json_extract(evidence_json, '$.seriesPair.short') = ? AND json_extract(evidence_json, '$.seriesPair.long') = ?
         GROUP BY state`,
      )
      .all(lib, seriesPairsAnalysisId(run), r.short_name, r.long_name) as {
      state: string;
      n: number;
    }[])
      merge[m.state] = m.n;
    return {
      id: r.id,
      short: r.short_name,
      long: r.long_name,
      group: r.grp,
      added: r.added,
      kept: r.kept_name,
      shortBooks: r.short_books,
      longBooks: r.long_books,
      answer: r.answer,
      rule: r.rule,
      held: r.held,
      note: r.note,
      signals: r.signals_json ? (JSON.parse(r.signals_json) as PairSignals) : null,
      books: r.books_json
        ? (JSON.parse(r.books_json) as { short: SpBookView[]; long: SpBookView[] })
        : { short: [], long: [] },
      decision: this.decision(lib, r.short_name, r.long_name),
      merge,
    };
  }

  /**
   * The user's choice for a pair (the review list): Merge, Keep separate, or Forget my choice.
   * Merge is refused where two books would share a number. The pair is answered again at once;
   * a merge is proposed at once and written by the next On run.
   */
  decidePair(
    lib: string,
    id: number,
    choice: 'merge' | 'separate' | 'clear',
    now = Date.now(),
  ): SpPairView {
    const r = this.db
      .prepare('SELECT * FROM series_pairs WHERE library_id = ? AND id = ?')
      .get(lib, id) as SpRow | undefined;
    if (!r) throw new Error('No such pair');
    const s = r.signals_json ? (JSON.parse(r.signals_json) as PairSignals) : null;
    if (choice === 'merge' && (!s || s.collisions > 0))
      throw new Error(
        'Two books would share a number under one name: set their numbers in the series editor first',
      );
    if (choice === 'merge' && r.held === 'yours')
      throw new Error(
        'You edited the series of a book here, and the cleanup never changes it: merge them in the series editor',
      );
    const [x, y] = pairKey(r.short_name, r.long_name);
    const run = this.state().progress.run;
    const aid = seriesPairsAnalysisId(run);
    this.db.transaction(() => {
      if (choice === 'clear')
        this.db
          .prepare(
            'DELETE FROM series_pair_decisions WHERE library_id = ? AND name_a = ? AND name_b = ?',
          )
          .run(lib, x, y);
      else
        this.db
          .prepare(
            `INSERT INTO series_pair_decisions (library_id, name_a, name_b, decision, decided_at, decided_by, note)
             VALUES (?, ?, ?, ?, ?, 'you', NULL)
             ON CONFLICT(library_id, name_a, name_b) DO UPDATE SET decision = excluded.decision,
               decided_at = excluded.decided_at, decided_by = 'you', note = NULL`,
          )
          .run(lib, x, y, choice === 'merge' ? 'merged' : 'different', now);
      // The pair's open merge proposals go; a written merge stays (Undo is per batch).
      this.db
        .prepare(
          `DELETE FROM proposed_changes WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ?
             AND state = 'proposed' AND batch_id IS NULL
             AND json_extract(evidence_json, '$.seriesPair.short') = ? AND json_extract(evidence_json, '$.seriesPair.long') = ?`,
        )
        .run(lib, aid, r.short_name, r.long_name);
      const pair: NamePair = {
        short: r.short_name,
        long: r.long_name,
        shortBooks: r.short_books,
        longBooks: r.long_books,
        group: r.grp,
        added: r.added,
      };
      if (s) {
        const books = r.books_json
          ? (JSON.parse(r.books_json) as { short: SpBookView[]; long: SpBookView[] })
          : { short: [], long: [] };
        const yours = this.yoursUuids(lib);
        const mine = [...books.short, ...books.long].some((b) => yours.has(b.uuid));
        const d = this.decide(lib, pair, s, mine);
        this.db
          .prepare(
            'UPDATE series_pairs SET answer = ?, rule = ?, held = ?, note = ?, updated_at = ? WHERE id = ?',
          )
          .run(d.answer, d.rule, d.held, d.note, now, r.id);
        // The card's counts follow the choice.
        const p = this.state().progress;
        if (r.answer && p.counts[r.answer] > 0) p.counts[r.answer]--;
        p.counts[d.answer]++;
        saveProgress(this.db, p);
        if (d.answer === 'merge' && r.books_json)
          this.proposeMerge(lib, run, { ...r, books_json: r.books_json, rule: d.rule });
      }
    })();
    // A finished run goes back to writing when a merge was chosen.
    const p = this.state().progress;
    if (choice === 'merge' && p.phase === 'done' && !p.error) {
      p.phase = 'write';
      p.finishedAt = null;
      saveProgress(this.db, p);
    }
    return this.pair(lib, id)!;
  }

  /** The proposals of this run by state (the card's write bar). */
  proposalCounts(lib: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes
         WHERE source = 'series-pairs' AND library_id = ? AND analysis_id = ? GROUP BY state`,
      )
      .all(lib, seriesPairsAnalysisId(this.state().progress.run)) as { state: string; n: number }[])
      out[r.state] = r.n;
    return out;
  }
}

interface SpRow {
  id: number;
  library_id: string;
  run: number;
  short_name: string;
  long_name: string;
  grp: PairGroup;
  added: string;
  kept_name: string;
  short_books: number;
  long_books: number;
  signals_json: string | null;
  books_json: string | null;
  answer: PairAnswer | null;
  rule: string | null;
  held: string | null;
  note: string | null;
  updated_at: number;
}

/** For tests: a pair's group from its names (re-exported so callers need one import). */
export { pairGroup };
