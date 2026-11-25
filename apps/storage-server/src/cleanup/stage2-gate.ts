/**
 * The stage-2 gate (WP20b, decided 2026-11-14): before anything is applied library-wide,
 * the stage's own decisions on the labeled books (gold800.json) are compared with the labels.
 *
 * - Titles: in each of the groups where the file's title is applied (Calibre's author
 *   "Unknown", tag metadata-processed), at least the title bar (gate.fieldPercent.title) right AND at least
 *   `gate.marginPoints` better than Calibre's current titles; where the titles already agree
 *   (normalization only) at least the title bar.
 * - Authors: at least the authors bar (gate.defaultPercent unless set per field) right over the groups where stage 2 decides them.
 * A field below its bar is paused (that field only); the page shows why. A new analysis
 * evaluates the gate again and lifts the pause when the field passes.
 *
 * The labels are keyed by Calibre id from before stage 1: a removed copy (47 of them) maps to
 * the copy it duplicated (the same file) through stage 1's undo records.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { gateBar, type CleanupSettings } from './settings';
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

function titleVerdict(t: Record<ApplyGroup, GroupScore>, s: CleanupSettings): FieldVerdict {
  const problems: string[] = [];
  const bar = gateBar(s, 'title');
  const { minBooks, marginPoints } = s.gate;
  for (const g of ['unknown', 'processed', 'agree'] as const) {
    const x = t[g];
    if (x.n < minBooks) continue;
    const applied = pct(x.applied, x.n)!;
    const calibre = pct(x.calibre, x.n)!;
    if (applied < bar) {
      problems.push(`${GROUP_WORDS[g]}: ${f1(applied)} right, below ${bar} %`);
    } else if (g !== 'agree' && applied - calibre < marginPoints) {
      problems.push(
        `${GROUP_WORDS[g]}: ${f1(applied)} right, only ${(applied - calibre).toFixed(1)} points better than Calibre's titles (${f1(calibre)}); needs ${marginPoints}`,
      );
    }
  }
  return problems.length
    ? { ok: false, reason: `Titles paused: ${problems.join('; ')}` }
    : { ok: true, reason: null };
}

function authorsVerdict(a: Record<ApplyGroup, GroupScore>, s: CleanupSettings): FieldVerdict {
  const bar = gateBar(s, 'authors');
  let n = 0;
  let right = 0;
  for (const g of ['unknown', 'processed', 'agree'] as const) {
    n += a[g].n;
    right += a[g].applied;
  }
  if (n < s.gate.minBooks) return { ok: true, reason: null };
  const p = pct(right, n)!;
  return p < bar
    ? {
        ok: false,
        reason: `Authors paused: ${f1(p)} right on the labeled books, below ${bar} %`,
      }
    : { ok: true, reason: null };
}

export function evaluateGate(
  books: ScoredBook[],
  missing: number,
  settings: CleanupSettings,
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

/**
 * Manga part B: a pause belongs to one library, or to every library (library_id '' : a gate's
 * verdict, answer 2 at stop 0: one gate per stage across both libraries). A library's pauses are
 * its own and the shared ones; a field paused both ways is listed once (its own pause).
 */
export const ALL_LIBRARIES = '';

/** The reasons that come from a gate and so pause the field in every library. */
export const SHARED_PAUSE_REASONS: readonly FieldPause['reason'][] = ['gate', 'no_labels'];

export function listFieldPauses(
  db: Database.Database,
  libraryId: string,
  stage: number,
): FieldPause[] {
  const rows = db
    .prepare(
      `SELECT field, reason, detail, paused_at FROM stage_field_pauses
       WHERE stage = ? AND library_id IN (?, '')
       ORDER BY field, library_id = '' -- the library's own pause first`,
    )
    .all(stage, libraryId) as {
    field: string;
    reason: FieldPause['reason'];
    detail: string | null;
    paused_at: number;
  }[];
  const out: FieldPause[] = [];
  for (const r of rows) {
    if (out.length > 0 && out[out.length - 1].field === r.field) continue;
    out.push({ field: r.field, reason: r.reason, detail: r.detail, pausedAt: r.paused_at });
  }
  return out;
}

/**
 * Pauses a field. A gate's reason (SHARED_PAUSE_REASONS) pauses it in every library, whatever
 * library is given; any other reason only in that library.
 */
export function pauseField(
  db: Database.Database,
  libraryId: string,
  stage: number,
  field: string,
  reason: FieldPause['reason'],
  detail: string | null,
  now = Date.now(),
): void {
  const lib = SHARED_PAUSE_REASONS.includes(reason) ? ALL_LIBRARIES : libraryId;
  db.prepare(
    `INSERT INTO stage_field_pauses (stage, library_id, field, reason, detail, paused_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(stage, library_id, field) DO UPDATE SET reason = excluded.reason,
       detail = excluded.detail,
       paused_at = CASE WHEN stage_field_pauses.reason = excluded.reason THEN stage_field_pauses.paused_at
                        ELSE excluded.paused_at END`,
  ).run(stage, lib, field, reason, detail, now);
}

/**
 * Lifts a field's pause in this library and its shared (gate) pause; without a field, every
 * pause of the stage there. A gate that passes again lifts its pause in every library.
 */
export function resumeField(
  db: Database.Database,
  libraryId: string,
  stage: number,
  field?: string,
): void {
  if (field)
    db.prepare(
      `DELETE FROM stage_field_pauses WHERE stage = ? AND library_id IN (?, '') AND field = ?`,
    ).run(stage, libraryId, field);
  else
    db.prepare(`DELETE FROM stage_field_pauses WHERE stage = ? AND library_id IN (?, '')`).run(
      stage,
      libraryId,
    );
}

/** Applies the gate's verdicts: pauses a failing field, lifts an earlier gate pause that now passes. */
export function applyGate(
  db: Database.Database,
  libraryId: string,
  gate: GateResult,
  now = Date.now(),
): void {
  for (const field of ['title', 'authors'] as const) {
    const v = gate.fields[field];
    const current = listFieldPauses(db, libraryId, 2).find((p) => p.field === field);
    if (!v.ok) pauseField(db, libraryId, 2, field, 'gate', v.reason, now);
    else if (current && (current.reason === 'gate' || current.reason === 'no_labels'))
      resumeField(db, libraryId, 2, field);
  }
}

/** Without labels the gate can't run: titles and authors stay paused, with the reason. */
export function pauseForMissingLabels(
  db: Database.Database,
  libraryId: string,
  error: string,
  now = Date.now(),
): void {
  for (const field of ['title', 'authors']) {
    pauseField(
      db,
      libraryId,
      2,
      field,
      'no_labels',
      `The labeled books can't be read (${error}), so the gate can't check this field`,
      now,
    );
  }
}
