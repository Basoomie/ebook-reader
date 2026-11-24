/**
 * What /cleanup shows of the new arrivals (WP20g): the card's status (mode, schedule, each source
 * folder's first run, the run's phase with its bar and time left), the folded lists (paged, every
 * count from an index), and the "Not imported" list as CSV.
 */
import type Database from 'better-sqlite3';
import { getSettings } from '../settings';
import {
  COMPARE_STAGES,
  RUN_PHASES,
  type CompareStage,
  type BookArrivals,
  type RunPhase,
  type RunProgress,
  type RunReport,
} from './run';

export const LIST_OUTCOMES: Record<string, string[]> = {
  new: ['new', 'better'],
  added: ['added'],
  identical: ['identical'],
  duplicate: ['duplicate'],
  better: ['better', 'better_review'],
  not_imported: ['not_imported', 'unreadable'],
  too_long: ['too_long'],
  waiting: ['waiting', 'downloading'],
  removed: ['removed_by_you', 'undone'],
  failed: ['failed'],
};

export interface Bar {
  phase: RunPhase;
  index: number;
  phases: number;
  done: number;
  total: number;
  bytesDone: number | null;
  bytesTotal: number | null;
  secondsLeft: number | null;
  /**
   * The compare step's part (it runs six in turn, each counted from its start), so the card says
   * which one the count and the time left are for (WP20g, 2026-11-24: the bar went from 60 % to
   * 2 % when the reading part ended and the measuring began, which looked like a restart).
   */
  part: { index: number; count: number; stage: CompareStage } | null;
}

/** The running phase's bar and its time left (from what this phase measured since it started). */
export function runBar(p: RunProgress, now = Date.now()): Bar {
  const c = p.counts[p.phase] ?? { done: 0, total: 0 };
  // The compare phase's stages each count on their own: the pace from the stage's start.
  const sub = p.phase === 'compare' && p.cmp ? p.cmp : null;
  const elapsed = now - (sub ? sub.startedAt : p.phaseStartedAt);
  const byBytes = c.bytesTotal !== undefined && c.bytesTotal > 0;
  const done = byBytes ? (c.bytesDone ?? 0) : c.done;
  const total = byBytes ? c.bytesTotal! : c.total;
  const fresh = done - (sub ? sub.startDone : 0);
  const rate = fresh > 0 && elapsed > 0 ? fresh / elapsed : 0;
  return {
    phase: p.phase,
    index: RUN_PHASES.indexOf(p.phase),
    phases: RUN_PHASES.length - 1,
    done: c.done,
    total: c.total,
    bytesDone: byBytes ? (c.bytesDone ?? 0) : null,
    bytesTotal: byBytes ? c.bytesTotal! : null,
    secondsLeft: rate > 0 && total > done ? Math.round((total - done) / rate / 1000) : null,
    part: sub
      ? {
          index: COMPARE_STAGES.indexOf(sub.stage),
          count: COMPARE_STAGES.length,
          stage: sub.stage,
        }
      : null,
  };
}

export function arrivalsStatus(a: BookArrivals, db: Database.Database, now = Date.now()) {
  const s = a.state();
  const settings = getSettings(db);
  const run = a.currentRun();
  const last = db
    .prepare(
      `SELECT id, trigger, mode, state, started_at, finished_at, report_json, error FROM calibre_arrival_runs
       WHERE state <> 'running' ORDER BY id DESC LIMIT 1`,
    )
    .get() as
    | {
        id: number;
        trigger: string;
        mode: string;
        state: string;
        started_at: number;
        finished_at: number | null;
        report_json: string | null;
        error: string | null;
      }
    | undefined;
  const pairs = settings.arrivals.pairs.map((pr) => {
    const key = `${pr.id}|${pr.source}`;
    const row = db.prepare('SELECT * FROM calibre_arrival_pairs WHERE pair_key = ?').get(key) as
      | { first_run_id: number | null; first_done_at: number | null }
      | undefined;
    const n = (outcomes: string[]) =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
             WHERE outcome IN (${outcomes.map(() => '?').join(', ')}) AND pair_key = ? AND gone_at IS NULL`,
          )
          .get(...outcomes, key) as { n: number }
      ).n;
    const waiting = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
           WHERE outcome IN ('pending', 'waiting') AND pair_key = ? AND gone_at IS NULL
             AND kind IN ('epub', 'archive', 'volume')`,
        )
        .get(key) as { n: number }
    ).n;
    return {
      key,
      id: pr.id,
      source: pr.source,
      libraryId: pr.libraryId,
      firstRunId: row?.first_run_id ?? null,
      // Done once every file was looked at; runs that start after it add when On.
      firstDoneAt: row?.first_done_at ?? null,
      // Compared books only (a stopped run can leave new books not compared yet).
      wouldAdd: (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
             WHERE outcome IN ('new', 'better') AND pair_key = ? AND gone_at IS NULL
               AND json_extract(facts_json, '$.compared') IS NOT NULL`,
          )
          .get(key) as { n: number }
      ).n,
      added: n(['added']),
      // Books and archives not looked at yet (waiting to settle): a first run is done without any.
      waiting,
      settleMinutes: settings.arrivals.settleMinutes,
    };
  });
  const reviews = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM calibre_arrival_reviews INDEXED BY calibre_arrival_reviews_open WHERE decision IS NULL`,
      )
      .get() as { n: number }
  ).n;
  return {
    mode: s.mode,
    pause: s.pause_reason
      ? { reason: s.pause_reason, detail: s.pause_detail, at: s.paused_at }
      : null,
    nextRunAt: a.nextRunAt(now),
    timeZone: settings.arrivals.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    importProblem: a.importProblem(),
    design: settings.ai.booksArrivalsDesign,
    pairs,
    reviews,
    run: run
      ? {
          id: run.id,
          trigger: run.trigger,
          mode: run.mode,
          phase: run.p.phase,
          startedAt: run.started_at,
          waiting: run.p.waiting,
          bar: runBar(run.p, now),
          scope: { import: run.p.scope.import.length, hand: run.p.scope.hand.length },
          cost: run.p.cost,
          jGate: run.p.jGate,
          times: run.p.times,
        }
      : null,
    last: last
      ? {
          id: last.id,
          trigger: last.trigger,
          mode: last.mode,
          state: last.state,
          startedAt: last.started_at,
          finishedAt: last.finished_at,
          error: last.error,
          report: last.report_json ? (JSON.parse(last.report_json) as RunReport) : null,
        }
      : null,
  };
}

/** One folded list, paged (offset/limit at most 200). */
export function arrivalsList(
  db: Database.Database,
  list: string,
  offset = 0,
  limit = 50,
): { total: number; items: unknown[] } {
  const lim = Math.min(200, Math.max(1, limit));
  const off = Math.max(0, offset);
  if (LIST_OUTCOMES[list]) {
    const outs = LIST_OUTCOMES[list];
    const ph = outs.map(() => '?').join(', ');
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
           WHERE outcome IN (${ph}) AND gone_at IS NULL`,
        )
        .get(...outs) as { n: number }
    ).n;
    const items = db
      .prepare(
        `SELECT id, pair_key, rel_path, size, mtime_ms, format, kind, outcome, detail, calibre_id, calibre_uuid,
           run_id, decided_at, archive_id, json_extract(facts_json, '$.title') AS title,
           json_extract(facts_json, '$.addedAs.calibreId') AS added_as
         FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
         WHERE outcome IN (${ph}) AND gone_at IS NULL ORDER BY outcome, pair_key, id LIMIT ? OFFSET ?`,
      )
      .all(...outs, lim, off);
    return { total, items };
  }
  if (list === 'archives') {
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM calibre_arrival_archives').get() as { n: number }
    ).n;
    const items = db
      .prepare(
        `SELECT id, pair_key, rel_path, size, state, detail, books, volumes_json, listed_at, unpacked_at
         FROM calibre_arrival_archives ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off);
    return { total, items };
  }
  if (list === 'reviews') {
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM calibre_arrival_reviews INDEXED BY calibre_arrival_reviews_open WHERE decision IS NULL`,
        )
        .get() as { n: number }
    ).n;
    const items = db
      .prepare(
        `SELECT r.id, r.kind, r.file_id, r.calibre_id, r.calibre_uuid, r.detail_json, r.run_id, r.created_at,
           f.rel_path, f.pair_key
         FROM calibre_arrival_reviews r INDEXED BY calibre_arrival_reviews_open
         LEFT JOIN calibre_arrival_files f ON f.id = r.file_id
         WHERE r.decision IS NULL ORDER BY r.id LIMIT ? OFFSET ?`,
      )
      .all(lim, off);
    return { total, items };
  }
  if (list === 'hand') {
    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM calibre_known_books WHERE origin = 'hand'`).get() as {
        n: number;
      }
    ).n;
    const items = db
      .prepare(
        `SELECT calibre_id, calibre_uuid, added_at, settled_at, run_id FROM calibre_known_books
         WHERE origin = 'hand' ORDER BY added_at DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off);
    return { total, items };
  }
  if (list === 'runs') {
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM calibre_arrival_runs').get() as { n: number }
    ).n;
    const items = (
      db
        .prepare(
          `SELECT id, CASE WHEN json_extract(progress_json, '$.followUp') = 'settle' THEN 'files settled'
             ELSE trigger END AS trigger, mode, state, phase, started_at, finished_at, report_json, error
           FROM calibre_arrival_runs ORDER BY id DESC LIMIT ? OFFSET ?`,
        )
        .all(lim, off) as { report_json: string | null }[]
    ).map((r) => ({
      ...r,
      report: r.report_json ? JSON.parse(r.report_json) : null,
      report_json: undefined,
    }));
    return { total, items };
  }
  if (list === 'batches') {
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM calibre_arrival_batches').get() as { n: number }
    ).n;
    const items = db
      .prepare(
        `SELECT b.id, b.run_id, b.kind, b.state, b.undo_of, b.item_count, b.created_at, b.finished_at, b.error,
           (SELECT COUNT(*) FROM calibre_arrival_batch_items i WHERE i.batch_id = b.id AND i.state IN ('added', 'removed')) AS done,
           (SELECT COUNT(*) FROM calibre_arrival_batch_items i WHERE i.batch_id = b.id AND i.state = 'failed') AS failed,
           EXISTS (SELECT 1 FROM calibre_arrival_batches u WHERE u.undo_of = b.id) AS undone
         FROM calibre_arrival_batches b ORDER BY b.id DESC LIMIT ? OFFSET ?`,
      )
      .all(lim, off);
    return { total, items };
  }
  throw new Error(`No such list: ${list}`);
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The "Not imported" list (file, format, reason) as CSV, for the page's download. */
export function notImportedCsv(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT pair_key, rel_path, size, format, outcome, detail FROM calibre_arrival_files INDEXED BY calibre_arrival_files_outcome
       WHERE outcome IN ('not_imported', 'unreadable', 'too_long') AND gone_at IS NULL ORDER BY outcome, pair_key, id`,
    )
    .all() as {
    pair_key: string;
    rel_path: string;
    size: number;
    format: string | null;
    outcome: string;
    detail: string | null;
  }[];
  const lines = ['source,file,size,format,reason'];
  for (const r of rows)
    lines.push(
      [
        r.pair_key.split('|').slice(1).join('|'),
        r.rel_path,
        r.size,
        r.format ?? '',
        r.detail ?? r.outcome,
      ]
        .map(csvCell)
        .join(','),
    );
  return lines.join('\n') + '\n';
}
