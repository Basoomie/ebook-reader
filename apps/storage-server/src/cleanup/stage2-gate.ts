/**
 * The stage-2 gate (WP20b, decided 2026-11-14): before anything is applied library-wide,
 * the stage's own decisions on the labeled books (gold800.json) are compared with the labels.
 *
 * - Titles: in each of the groups where the file's title is applied (Calibre's author
 *   "Unknown", tag metadata-processed), at least `titleMinPercent` right AND at least
 *   `titleMarginPoints` better than Calibre's current titles; where the titles already agree
 *   (normalization only) at least `titleMinPercent`.
 * - Authors: at least `authorsMinPercent` right over the groups where stage 2 decides them.
 * A field below its bar is paused (that field only); the page shows why. A new analysis
 * evaluates the gate again and lifts the pause when the field passes.
 *
 * The labels are keyed by Calibre id from before stage 1: a removed copy (47 of them) maps to
 * the copy it duplicated (the same file) through stage 1's undo records.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { Stage2Settings } from './settings';
import type { ApplyGroup, FieldProposal } from './stage2-rules';
import {
  type GoldLabel,
  type GroupScore,
  type ScoredBook,
  type Stage2Score,
  pct,
  scoreStage2,
} from './stage2-score';

export const GOLD_FILENAME = 'gold800.json';

export function defaultReferenceFile(dbDir: string): string {
  return path.join(dbDir, 'cleanup', 'reference-sample', GOLD_FILENAME);
}

export function loadGold(file: string): {
  gold: Record<string, GoldLabel> | null;
  error: string | null;
} {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { gold: null, error: `${file} is not a map of labeled books` };
    }
    return { gold: raw as Record<string, GoldLabel>, error: null };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      gold: null,
      error: e.code === 'ENOENT' ? `${file} is not there` : `${file}: ${e.message}`,
    };
  }
}

/**
 * Labeled id (Calibre id before stage 1) → the Calibre id to score now: a copy stage 1
 * removed (and that is still removed) maps to its kept copy, which is the same file.
 */
export function mapLabeledIds(
  cleanup: Database.Database,
  libraryId: string,
  goldIds: string[],
): Map<string, number> {
  const removed = new Map<number, number>();
  for (const r of cleanup
    .prepare(
      `SELECT removed_calibre_id, kept_calibre_id FROM undo_records
       WHERE library_id = ? AND restored_at IS NULL`,
    )
    .all(libraryId) as { removed_calibre_id: number; kept_calibre_id: number }[]) {
    removed.set(r.removed_calibre_id, r.kept_calibre_id);
  }
  const out = new Map<string, number>();
  for (const id of goldIds) {
    const n = Number(id);
    if (!Number.isInteger(n)) continue;
    out.set(id, removed.get(n) ?? n);
  }
  return out;
}

export interface FieldVerdict {
  ok: boolean;
  /** Plain words for the page when the field is paused. */
  reason: string | null;
}

export interface GateResult {
  evaluatedAt: number;
  /** Labeled books found in the library (with an EPUB read), and those not found. */
  labeled: number;
  missing: number;
  score: Omit<Stage2Score, 'misses'>;
  misses: Stage2Score['misses'];
  fields: { title: FieldVerdict; authors: FieldVerdict };
  /** Share of each field's proposals that go to review on the labeled books (%). */
  reviewShare: Record<string, number>;
}

const f1 = (x: number | null) => (x === null ? '–' : `${x.toFixed(1)} %`);
const GROUP_WORDS: Record<ApplyGroup, string> = {
  unknown: 'author "Unknown" in Calibre',
  processed: 'tagged metadata-processed',
  agree: 'Calibre and the file already agree',
  conflict: 'Calibre has its own value',
};

function titleVerdict(t: Record<ApplyGroup, GroupScore>, s: Stage2Settings): FieldVerdict {
  const problems: string[] = [];
  for (const g of ['unknown', 'processed', 'agree'] as const) {
    const x = t[g];
    if (x.n < s.gateMinBooks) continue;
    const applied = pct(x.applied, x.n)!;
    const calibre = pct(x.calibre, x.n)!;
    if (applied < s.titleMinPercent) {
      problems.push(`${GROUP_WORDS[g]}: ${f1(applied)} right, below ${s.titleMinPercent} %`);
    } else if (g !== 'agree' && applied - calibre < s.titleMarginPoints) {
      problems.push(
        `${GROUP_WORDS[g]}: ${f1(applied)} right, only ${(applied - calibre).toFixed(1)} points better than Calibre's titles (${f1(calibre)}); needs ${s.titleMarginPoints}`,
      );
    }
  }
  return problems.length
    ? { ok: false, reason: `Titles paused: ${problems.join('; ')}` }
    : { ok: true, reason: null };
}

function authorsVerdict(a: Record<ApplyGroup, GroupScore>, s: Stage2Settings): FieldVerdict {
  let n = 0;
  let right = 0;
  for (const g of ['unknown', 'processed', 'agree'] as const) {
    n += a[g].n;
    right += a[g].applied;
  }
  if (n < s.gateMinBooks) return { ok: true, reason: null };
  const p = pct(right, n)!;
  return p < s.authorsMinPercent
    ? {
        ok: false,
        reason: `Authors paused: ${f1(p)} right on the labeled books, below ${s.authorsMinPercent} %`,
      }
    : { ok: true, reason: null };
}

export function evaluateGate(
  books: ScoredBook[],
  missing: number,
  settings: Stage2Settings,
  now = Date.now(),
): GateResult {
  const score = scoreStage2(books);
  const { misses, ...rest } = score;
  const review: Record<string, { n: number; review: number }> = {};
  for (const b of books) {
    const fields = new Set(b.proposals.map((p) => p.field));
    for (const f of fields) {
      const r = (review[f] ??= { n: 0, review: 0 });
      r.n += 1;
      if (b.proposals.some((p: FieldProposal) => p.field === f && p.class === 'review'))
        r.review += 1;
    }
  }
  return {
    evaluatedAt: now,
    labeled: books.length,
    missing,
    score: rest,
    misses: misses.slice(0, 200),
    fields: {
      title: titleVerdict(score.title, settings),
      authors: authorsVerdict(score.authors, settings),
    },
    reviewShare: Object.fromEntries(
      Object.entries(review).map(([f, r]) => [
        f,
        Math.round((1000 * r.review) / Math.max(1, books.length)) / 10,
      ]),
    ),
  };
}

export interface FieldPause {
  field: string;
  reason: 'gate' | 'review_alarm' | 'failures' | 'no_labels';
  detail: string | null;
  pausedAt: number;
}

export function listFieldPauses(db: Database.Database, stage: number): FieldPause[] {
  return (
    db
      .prepare(
        'SELECT field, reason, detail, paused_at FROM stage_field_pauses WHERE stage = ? ORDER BY field',
      )
      .all(stage) as {
      field: string;
      reason: FieldPause['reason'];
      detail: string | null;
      paused_at: number;
    }[]
  ).map((r) => ({ field: r.field, reason: r.reason, detail: r.detail, pausedAt: r.paused_at }));
}

export function pauseField(
  db: Database.Database,
  stage: number,
  field: string,
  reason: FieldPause['reason'],
  detail: string | null,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO stage_field_pauses (stage, field, reason, detail, paused_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(stage, field) DO UPDATE SET reason = excluded.reason, detail = excluded.detail,
       paused_at = CASE WHEN stage_field_pauses.reason = excluded.reason THEN stage_field_pauses.paused_at
                        ELSE excluded.paused_at END`,
  ).run(stage, field, reason, detail, now);
}

export function resumeField(db: Database.Database, stage: number, field?: string): void {
  if (field)
    db.prepare('DELETE FROM stage_field_pauses WHERE stage = ? AND field = ?').run(stage, field);
  else db.prepare('DELETE FROM stage_field_pauses WHERE stage = ?').run(stage);
}

/** Applies the gate's verdicts: pauses a failing field, lifts an earlier gate pause that now passes. */
export function applyGate(db: Database.Database, gate: GateResult, now = Date.now()): void {
  for (const field of ['title', 'authors'] as const) {
    const v = gate.fields[field];
    const current = listFieldPauses(db, 2).find((p) => p.field === field);
    if (!v.ok) pauseField(db, 2, field, 'gate', v.reason, now);
    else if (current && (current.reason === 'gate' || current.reason === 'no_labels'))
      resumeField(db, 2, field);
  }
}

/** Without labels the gate can't run: titles and authors stay paused, with the reason. */
export function pauseForMissingLabels(
  db: Database.Database,
  error: string,
  now = Date.now(),
): void {
  for (const field of ['title', 'authors']) {
    pauseField(
      db,
      2,
      field,
      'no_labels',
      `The labeled books can't be read (${error}), so the gate can't check this field`,
      now,
    );
  }
}
