/**
 * Replaced books (cleanup.db v42; rules in rules.ts): the pass that gives a new arrival kept
 * over a library book the old record's values it lacks. Its own Off / Preview / On per Calibre
 * library (Preview after the deploy: the proposals are listed, nothing is written).
 *
 * - Every replacement an On run applied since WP20g (an undo record of a stage 1/3 removal under
 *   `arrivals:<run>` whose kept copy a run added and that no Undo put back) is looked at once:
 *   the old record's values as the reader's index last read them (the reader keeps a removed
 *   book's record), the kept copy's as they are now.
 * - The changes are proposals of the stage that writes each field under the analysis
 *   `inherit` (never a stage's own, so no stage's own On plans them), written by those stages'
 *   field batches when the pass is On (stage 4, then 2, then 5), with their checks and Undo.
 * - What the cleanup knew of the old value comes with it (stage2-batches.ts `written`): a value
 *   the cleanup had written counts as written by it on the kept copy too, Calibre's own value as
 *   Calibre's own. A later decision then treats the kept copy as it treated the old book.
 * - A new-arrivals On run asks this pass for its own replacements right after its removals
 *   (run.ts phase `inherit`), so its stages 2-5 see the kept copy with the old record's values.
 * - Once a value is written, an open review item of another analysis proposing that same value
 *   for the same field is closed (Calibre has it now).
 */
import type Database from 'better-sqlite3';
import { getSettings } from '../settings';
import { catalogValues, bookOfUuid } from '../edits/catalog';
import { yoursOf } from '../edits/yours';
import type { Stage2Batches } from '../stage2-batches';
import { inheritChanges, type InheritChange, type InheritValues } from './rules';

export const INHERIT_ANALYSIS = 'inherit';
const SOURCE = 'inherit';
/** Replacements looked at in one step (each reads a few rows of both databases). */
const STEP_PAIRS = 200;

export type InheritMode = 'off' | 'analyse' | 'on';

export interface InheritDeps {
  db: Database.Database;
  main: Database.Database;
  batches: {
    stage2: Pick<Stage2Batches, 'plan'>;
    stage4: Pick<Stage2Batches, 'plan'>;
    stage5: Pick<Stage2Batches, 'plan'>;
  };
  /** Why the pass's write must wait now (another write, the safety checks), or null. */
  writeWait: (libraryId: string) => string | null;
  log?: (msg: string) => void;
}

export interface InheritPair {
  removedUuid: string;
  removedId: number;
  keptUuid: string;
  keptId: number;
  changeId: number;
  run: number | null;
}

interface Progress {
  /** The pass's write: when its first batch was planned and how many were written then. */
  write?: { startedAt: number; writtenAtStart: number };
  waiting?: string | null;
  /** The pass's applied proposals up to this id have closed the review items they answer. */
  closedUpTo?: number;
  /** Every undo record up to this rowid has been looked at (a poll then reads one number). */
  scannedTo?: number;
}

/** What the cleanup knew of the old record's value (stage2-batches.ts `written`). */
export interface InheritProvenance {
  /** The old record's applied_values row of the field (the cleanup wrote it), else null. */
  applied: { value_json: string; source: string; batch_id: string | null } | null;
  /** Whether that write was the models' unconfirmed value (a best guess). */
  unconfirmed: boolean;
}

export interface InheritEvidence {
  title: string;
  inherit: {
    fromUuid: string;
    fromCalibreId: number;
    run: number | null;
    /** Identifiers and tags merge into the kept copy's own: written as the cleanup's. */
    provenance: InheritProvenance | 'merged';
  };
  unconfirmed?: boolean;
}

export class InheritPass {
  constructor(
    private readonly deps: InheritDeps,
    readonly libraryId: string,
  ) {}

  private get db() {
    return this.deps.db;
  }

  state(): { mode: InheritMode; progress: Progress } {
    const r = this.db
      .prepare('SELECT mode, progress_json FROM calibre_inherit_state WHERE library_id = ?')
      .get(this.libraryId) as { mode: InheritMode; progress_json: string } | undefined;
    return {
      mode: r?.mode ?? 'analyse',
      progress: r ? (JSON.parse(r.progress_json) as Progress) : {},
    };
  }

  private saveProgress(p: Progress, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO calibre_inherit_state (library_id, progress_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(library_id) DO UPDATE SET progress_json = excluded.progress_json,
           updated_at = excluded.updated_at`,
      )
      .run(this.libraryId, JSON.stringify(p), now);
  }

  setMode(mode: InheritMode, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO calibre_inherit_state (library_id, mode, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(library_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      )
      .run(this.libraryId, mode, now);
    this.deps.log?.(`Replaced books: set ${mode === 'analyse' ? 'Preview' : mode}`);
  }

  /**
   * The replacements not looked at yet: removals of an arrivals run (stage 1 or 3, applied, not
   * undone) whose kept copy a run added (`calibre_known_books` origin import). `run`: only that
   * run's.
   */
  pending(limit = STEP_PAIRS, run: number | null = null, after = 0): InheritPair[] {
    const rows = this.db
      .prepare(
        `SELECT u.removed_uuid, u.removed_calibre_id, u.kept_uuid, u.kept_calibre_id, u.change_id,
           p.analysis_id
         FROM undo_records u JOIN proposed_changes p ON p.id = u.change_id
         WHERE u.library_id = ? AND u.rowid > ? AND u.restored_at IS NULL AND p.field = 'book'
           AND p.stage IN (1, 3) AND p.analysis_id ${run === null ? "LIKE 'arrivals:%'" : '= ?'}
           AND EXISTS (SELECT 1 FROM calibre_known_books k
             WHERE k.calibre_uuid = u.kept_uuid AND +k.library_id = u.library_id AND +k.origin = 'import')
           AND NOT EXISTS (SELECT 1 FROM calibre_inherits i
             WHERE i.library_id = u.library_id AND i.removed_uuid = u.removed_uuid)
         ORDER BY u.created_at, u.change_id LIMIT ?`,
      )
      .all(
        ...(run === null
          ? [this.libraryId, after, limit]
          : [this.libraryId, after, `arrivals:${run}`, limit]),
      ) as {
      removed_uuid: string;
      removed_calibre_id: number;
      kept_uuid: string;
      kept_calibre_id: number;
      change_id: number;
      analysis_id: string;
    }[];
    return rows.map((r) => ({
      removedUuid: r.removed_uuid,
      removedId: r.removed_calibre_id,
      keptUuid: r.kept_uuid,
      keptId: r.kept_calibre_id,
      changeId: r.change_id,
      run: Number(r.analysis_id.slice('arrivals:'.length)) || null,
    }));
  }

  /** The book's values as the reader's index last read them; a removed book's record too. */
  private values(
    uuid: string,
    removed: boolean,
  ): { values: InheritValues; title: string; calibreId: number } | null {
    const src = this.deps.main
      .prepare(
        `SELECT book_id, calibre_id FROM book_sources
         WHERE library_id = ? AND kind = 'calibre' AND calibre_uuid = ?${removed ? '' : ' AND missing_at IS NULL'}
         ORDER BY missing_at IS NULL DESC LIMIT 1`,
      )
      .get(this.libraryId, uuid) as { book_id: string; calibre_id: number } | undefined;
    if (!src) return null;
    const v = catalogValues(this.deps.main, src.book_id);
    if (!v) return null;
    const series = v.series as { name: string | null; index: number | null };
    return {
      title: v.title,
      calibreId: src.calibre_id,
      values: {
        series: { name: series.name ?? null, index: series.index ?? null },
        identifiers: (v.identifiers ?? {}) as Record<string, string>,
        publisher: (v.publisher as string | null) ?? null,
        languages: (v.languages as string[]) ?? [],
        illustrator: (v.illustrator as string[]) ?? [],
        tags: (v.tags as string[]) ?? [],
      },
    };
  }

  private provenance(uuid: string, field: string): InheritProvenance {
    const r = this.db
      .prepare(
        `SELECT a.value_json, a.source, a.batch_id,
           json_extract(c.evidence_json, '$.unconfirmed') AS guess
         FROM applied_values a LEFT JOIN proposed_changes c ON c.id = a.change_id
         WHERE a.library_id = ? AND a.calibre_uuid = ? AND a.field = ?`,
      )
      .get(this.libraryId, uuid, field) as
      | { value_json: string; source: string; batch_id: string | null; guess: number | null }
      | undefined;
    return r
      ? {
          applied: { value_json: r.value_json, source: r.source, batch_id: r.batch_id },
          unconfirmed: !!r.guess,
        }
      : { applied: null, unconfirmed: false };
  }

  /** Looks at the replacements given: proposals for what each kept copy lacks. */
  propose(pairs: InheritPair[], now = Date.now()): { pairs: number; changes: number } {
    const customTags = getSettings(this.db).customTags;
    const insert = this.db.prepare(
      `INSERT INTO proposed_changes (stage, library_id, calibre_id, calibre_uuid, field, old_json,
         new_json, source, evidence_json, class, state, analysis_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '${SOURCE}', ?, 'auto', 'proposed', '${INHERIT_ANALYSIS}', ?, ?)`,
    );
    const record = this.db.prepare(
      `INSERT OR REPLACE INTO calibre_inherits (library_id, removed_uuid, removed_calibre_id, kept_uuid,
         kept_calibre_id, removal_change_id, state, fields_json, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let changes = 0;
    this.db.transaction(() => {
      for (const pair of pairs) {
        const old = this.values(pair.removedUuid, true);
        const kept = bookOfUuid(this.deps.main, this.libraryId, pair.keptUuid)
          ? this.values(pair.keptUuid, false)
          : null;
        if (!old || !kept) {
          record.run(
            this.libraryId,
            pair.removedUuid,
            pair.removedId,
            pair.keptUuid,
            pair.keptId,
            pair.changeId,
            'gone',
            '[]',
            now,
          );
          continue;
        }
        const yours = new Set(yoursOf(this.db, this.libraryId, pair.keptUuid).map((y) => y.field));
        const list: InheritChange[] = inheritChanges(old.values, kept.values, customTags, yours);
        for (const c of list) {
          const merged = c.field === 'identifiers' || c.field === 'tags';
          const prov = merged ? null : this.provenance(pair.removedUuid, c.field);
          const ev: InheritEvidence = {
            title: kept.title,
            inherit: {
              fromUuid: pair.removedUuid,
              fromCalibreId: pair.removedId,
              run: pair.run,
              provenance: prov ?? 'merged',
            },
            ...(prov?.unconfirmed ? { unconfirmed: true } : {}),
          };
          insert.run(
            c.stage,
            this.libraryId,
            kept.calibreId,
            pair.keptUuid,
            c.field,
            JSON.stringify(c.before ?? null),
            JSON.stringify(c.value),
            JSON.stringify(ev),
            now,
            now,
          );
          changes++;
        }
        record.run(
          this.libraryId,
          pair.removedUuid,
          pair.removedId,
          pair.keptUuid,
          kept.calibreId,
          pair.changeId,
          list.length ? 'proposed' : 'nothing',
          JSON.stringify(list.map((c) => c.field)),
          now,
        );
      }
    })();
    return { pairs: pairs.length, changes };
  }

  /** Open proposals of the pass (proposed or queued), all or of one run's replacements. */
  open(run: number | null = null): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposed_changes
           WHERE source = '${SOURCE}' AND library_id = ? AND analysis_id = '${INHERIT_ANALYSIS}'
             AND state IN ('proposed', 'queued')
             AND class = 'auto'${run === null ? '' : " AND json_extract(evidence_json, '$.inherit.run') = ?"}`,
        )
        .get(...(run === null ? [this.libraryId] : [this.libraryId, run])) as { n: number }
    ).n;
  }

  /**
   * Plans the next batch of the pass's proposals (stage 4, then 2, then 5). Returns the batch
   * planned, or why nothing was (null when nothing is left).
   */
  async writeNext(now = Date.now()): Promise<{ batch: string | null; reason: string | null }> {
    const wait = this.deps.writeWait(this.libraryId);
    if (wait) return { batch: null, reason: wait };
    for (const stage of ['stage4', 'stage2', 'stage5'] as const) {
      const r = await this.deps.batches[stage].plan(this.libraryId, {
        analysisId: INHERIT_ANALYSIS,
      });
      if (r.batch) {
        const p = this.state().progress;
        if (!p.write) {
          p.write = { startedAt: now, writtenAtStart: this.counts().applied ?? 0 };
          this.saveProgress(p, now);
        }
        this.deps.log?.(`Replaced books: batch ${r.batch.id} planned (${stage})`);
        return { batch: r.batch.id, reason: null };
      }
      if (r.reason && !/nothing/i.test(r.reason)) return { batch: null, reason: r.reason };
    }
    return { batch: null, reason: null };
  }

  /**
   * Closes the open review items another analysis made for a field the pass has written with the
   * same value (Calibre has it now: 薬屋のひとりごと's series, "a best guess: listed, not written").
   */
  closeAnswered(now = Date.now()): number {
    const p = this.state().progress;
    const written = this.db
      .prepare(
        `SELECT id, calibre_uuid, field, new_json FROM proposed_changes
         WHERE source = '${SOURCE}' AND library_id = ? AND analysis_id = '${INHERIT_ANALYSIS}'
           AND state = 'applied' AND id > ? ORDER BY id`,
      )
      .all(this.libraryId, p.closedUpTo ?? 0) as {
      id: number;
      calibre_uuid: string;
      field: string;
      new_json: string;
    }[];
    if (written.length === 0) return 0;
    const close = this.db.prepare(
      `UPDATE proposed_changes SET state = 'skipped', decided_at = ?, updated_at = ?,
         review_reason = 'Calibre has this value now: taken over from the book this copy replaced'
       WHERE library_id = ? AND calibre_uuid = ? AND field = ? AND new_json = ?
         AND state = 'proposed' AND class = 'review'
         AND (analysis_id IS NULL OR analysis_id <> '${INHERIT_ANALYSIS}')`,
    );
    let n = 0;
    this.db.transaction(() => {
      for (const w of written)
        n += close.run(now, now, this.libraryId, w.calibre_uuid, w.field, w.new_json).changes;
      p.closedUpTo = written[written.length - 1].id;
      this.saveProgress(p, now);
    })();
    return n;
  }

  /**
   * The replacements not looked at yet (all, or one run's), proposed 200 at a time. Returns
   * whether some were found. Once none is left, the undo records up to the newest are marked
   * looked at: a later poll reads one number until a new removal is applied.
   */
  private scanNew(run: number | null, now: number): boolean {
    const top =
      (this.db.prepare('SELECT MAX(rowid) AS m FROM undo_records').get() as { m: number | null })
        .m ?? 0;
    const p = this.state().progress;
    const from = p.scannedTo ?? 0;
    if (from >= top) return false;
    const pairs = this.pending(STEP_PAIRS, run, from);
    if (pairs.length > 0) {
      const r = this.propose(pairs, now);
      if (r.changes)
        this.deps.log?.(`Replaced books: ${r.changes} values proposed for ${r.pairs} books`);
      return true;
    }
    // A run asks only for its own: the others wait for the pass's own scan.
    if (run === null) {
      p.scannedTo = top;
      this.saveProgress(p, now);
    }
    return false;
  }

  /** One step: looks at new replacements (Preview and On), writes when On. */
  async step(now = Date.now()): Promise<'more' | 'wait' | 'idle'> {
    const { mode } = this.state();
    if (mode === 'off') return 'idle';
    if (this.scanNew(null, now)) return 'more';
    if (mode !== 'on') return 'idle';
    this.closeAnswered(now);
    if (this.open() === 0) return 'idle';
    const w = await this.writeNext(now);
    const p = this.state().progress;
    if (p.waiting !== (w.batch ? null : w.reason)) {
      p.waiting = w.batch ? null : w.reason;
      this.saveProgress(p, now);
    }
    return 'wait';
  }

  /**
   * A new-arrivals On run, right after its removals: its own replacements proposed and written
   * (when the pass is On) before its stages 2-5 read the kept copies. Returns why the run must
   * wait, or null when it can go on (nothing to write, or the pass is not On).
   */
  async forRun(run: number, now = Date.now()): Promise<string | null> {
    if (this.state().mode !== 'on') return null;
    while (this.scanNew(run, now));
    if (this.open(run) === 0) {
      this.closeAnswered(now);
      return null;
    }
    const w = await this.writeNext(now);
    return w.batch ? 'Writing the values the replaced books had' : (w.reason ?? null);
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM proposed_changes
         WHERE source = '${SOURCE}' AND library_id = ? AND analysis_id = '${INHERIT_ANALYSIS}'
         GROUP BY state`,
      )
      .all(this.libraryId) as { state: string; n: number }[])
      out[r.state] = r.n;
    return out;
  }

  /** The card: books looked at, values by field and state, and a page of the list. */
  view(
    offset = 0,
    limit = 50,
  ): {
    books: Record<string, number>;
    fields: { field: string; state: string; n: number }[];
    items: {
      id: number;
      calibreId: number;
      title: string;
      field: string;
      before: unknown;
      value: unknown;
      state: string;
      reason: string | null;
    }[];
    total: number;
  } {
    const books: Record<string, number> = {};
    for (const r of this.db
      .prepare(
        'SELECT state, COUNT(*) AS n FROM calibre_inherits WHERE library_id = ? GROUP BY state',
      )
      .all(this.libraryId) as { state: string; n: number }[])
      books[r.state] = r.n;
    const fields = this.db
      .prepare(
        `SELECT field, state, COUNT(*) AS n FROM proposed_changes
         WHERE source = '${SOURCE}' AND library_id = ? AND analysis_id = '${INHERIT_ANALYSIS}'
         GROUP BY field, state ORDER BY field, state`,
      )
      .all(this.libraryId) as { field: string; state: string; n: number }[];
    const rows = this.db
      .prepare(
        `SELECT id, calibre_id, field, old_json, new_json, state, review_reason,
           json_extract(evidence_json, '$.title') AS title
         FROM proposed_changes
         WHERE source = '${SOURCE}' AND library_id = ? AND analysis_id = '${INHERIT_ANALYSIS}'
         ORDER BY calibre_id, id LIMIT ? OFFSET ?`,
      )
      .all(this.libraryId, limit, offset) as {
      id: number;
      calibre_id: number;
      field: string;
      old_json: string | null;
      new_json: string | null;
      state: string;
      review_reason: string | null;
      title: string | null;
    }[];
    return {
      books,
      fields,
      items: rows.map((r) => ({
        id: r.id,
        calibreId: r.calibre_id,
        title: r.title ?? '',
        field: r.field,
        before: r.old_json ? JSON.parse(r.old_json) : null,
        value: r.new_json ? JSON.parse(r.new_json) : null,
        state: r.state,
        reason: r.review_reason,
      })),
      total: fields.reduce((s, f) => s + f.n, 0),
    };
  }
}
