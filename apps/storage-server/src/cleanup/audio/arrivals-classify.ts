/**
 * Stage 7 (WP21f-1): what each recording is to the library after stages 1-5 ran again (plan
 * section 9). Pure: the inputs are loaded by `loadClassifyInputs` from cleanup.db.
 *
 * A recording is stage 4's unit (a proven group of copies is one unit; every unproven copy is
 * its own). The library is known by inode: a copy is in the library when one of its files is a
 * hard link there (stage 1's walk of media/audiobooks/japanese, plus japanese-generated). A copy
 * is an arrival when one of its files was not under the torrents when stage 6 built the library
 * (its walk before the build), so everything known at the build stays as the build decided.
 *
 *   existing   a copy of the recording is in the library (an arrival in it is reported below)
 *   identical  an arrival byte-identical to a copy in the library (stage 1's hash): recorded
 *   duplicate  an arrival proven the same recording (stage 3) whose kept copy is the library's
 *   better     proven the same, but stage 3 keeps the arrival: review (the library's copy
 *              stays; never replaced: user, 2026-11-17)
 *   new        not in the library: planned (with unproven copies, every copy stays)
 *   waiting    a file of it changed in the last `settleMinutes` (still downloading or copied)
 *   held       its start or end doesn't play (stage 2): not added; "Add anyway" adds it
 *   removed    the cleanup linked it once and the link is gone (removed by hand): never added again
 */
import type Database from 'better-sqlite3';
import { droppedCopies, type PlanCopy, type PlanCopyGroup } from './build-plan';
import { getAudioStage } from './audio-stages';

export type ArrivalOutcomeKind =
  | 'existing'
  | 'identical'
  | 'duplicate'
  | 'better'
  | 'new'
  | 'waiting'
  | 'held'
  | 'removed';

export interface ArrivalFile {
  id: number;
  root: 'torrents' | 'library';
  rel: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  sha: string | null;
  /** Stage 2's short plays at both ends (null: not checked). */
  startOk: boolean | null;
  endOk: boolean | null;
}

export interface ClassifyUnit {
  key: string;
  name: string;
  copyKeys: string[];
}

export interface ClassifyInput {
  units: ClassifyUnit[];
  copies: Map<string, PlanCopy>;
  files: Map<number, ArrivalFile>;
  decisions: Map<string, string>;
  /** The torrents' file paths when stage 6 built the library (null: unknown, all count as new). */
  baseline: Set<string> | null;
  /** `dev:ino` of every audio file in the library now. */
  present: Set<string>;
  /** `dev:ino` of every file the cleanup ever linked (stage 6's and stage 7's manifests). */
  everLinked: Set<string>;
  /** Copy keys the user chose "Add anyway" for (held arrivals). */
  addAnyway: Set<string>;
  now: number;
  settleMs: number;
}

export interface ArrivalOutcome {
  unitKey: string;
  name: string;
  outcome: ArrivalOutcomeKind;
  reason: string | null;
  /** The arrival copies of the recording (copy keys). */
  arrivals: string[];
  /** The copies to link (new recordings: every copy that is not a proven duplicate). */
  link: string[];
  /** Copies in the library (existing recordings). */
  linked: string[];
}

export interface ClassifyResult {
  outcomes: ArrivalOutcome[];
  counts: Record<ArrivalOutcomeKind, number>;
  /** Recordings that were under the torrents at the build and are not in the library. */
  unlinkedKnown: number;
}

const inode = (f: { dev: number; ino: number }) => `${f.dev}:${f.ino}`;

export function classifyArrivals(input: ClassifyInput): ClassifyResult {
  const dropped = droppedCopies(input.copies.values(), input.decisions);
  const counts: Record<ArrivalOutcomeKind, number> = {
    existing: 0,
    identical: 0,
    duplicate: 0,
    better: 0,
    new: 0,
    waiting: 0,
    held: 0,
    removed: 0,
  };
  const filesOf = (c: PlanCopy) =>
    c.fileIds.map((id) => input.files.get(id)).filter((f): f is ArrivalFile => !!f);
  const inLibrary = (c: PlanCopy) => filesOf(c).some((f) => input.present.has(inode(f)));
  const isArrival = (c: PlanCopy) =>
    input.baseline === null ||
    filesOf(c).some((f) => f.root === 'torrents' && !input.baseline!.has(f.rel));
  const linkedOnce = (c: PlanCopy) => filesOf(c).some((f) => input.everLinked.has(inode(f)));
  const librarySha = new Set<string>();
  for (const f of input.files.values())
    if (f.sha && input.present.has(inode(f))) librarySha.add(f.sha);

  const outcomes: ArrivalOutcome[] = [];
  let unlinkedKnown = 0;
  for (const unit of input.units) {
    const copies = unit.copyKeys
      .map((k) => input.copies.get(k))
      .filter((c): c is PlanCopy => !!c && !c.excluded);
    if (copies.length === 0) continue;
    const linked = copies.filter(inLibrary);
    const arrivals = copies.filter((c) => !inLibrary(c) && isArrival(c));
    const base = {
      unitKey: unit.key,
      name: unit.name,
      arrivals: arrivals.map((c) => c.key),
      linked: linked.map((c) => c.key),
    };
    const put = (outcome: ArrivalOutcomeKind, reason: string | null, link: string[] = []) => {
      counts[outcome]++;
      outcomes.push({ ...base, outcome, reason, link });
    };

    if (linked.length > 0) {
      if (arrivals.length === 0) {
        counts.existing++;
        continue;
      }
      // An arrival in a recording the library has: identical, a proven worse copy, or better.
      const better = arrivals.filter((c) => !dropped.has(c.key) && provenGroup(c.group));
      if (better.length && linked.every((c) => dropped.get(c.key)?.kept !== undefined)) {
        put(
          'better',
          'Proven the same recording as a book in the library, and the new copy is the better one: the library keeps its copy (never replaced automatically)',
        );
        continue;
      }
      const identical = arrivals.every((c) => {
        const fs = filesOf(c);
        return fs.length > 0 && fs.every((f) => f.sha && librarySha.has(f.sha));
      });
      put(
        identical ? 'identical' : 'duplicate',
        identical
          ? 'Byte-identical to a file in the library: recorded, not linked'
          : 'Proven the same recording as a book in the library: recorded, not linked',
      );
      continue;
    }

    if (copies.some(linkedOnce)) {
      put(
        'removed',
        'The cleanup linked it once and its link is gone (removed by hand): not added again',
      );
      continue;
    }
    if (arrivals.length === 0 && input.baseline !== null) {
      // Known at the build and never linked: nothing to do in this run (stage 6 decided it).
      unlinkedKnown++;
      continue;
    }
    const link = copies.filter((c) => !dropped.has(c.key));
    const linkFiles = link.flatMap(filesOf);
    const fresh = linkFiles.filter((f) => input.now - f.mtimeMs < input.settleMs);
    if (fresh.length) {
      put(
        'waiting',
        `${fresh.length} file${fresh.length === 1 ? '' : 's'} changed in the last ${Math.round(input.settleMs / 60000)} minutes (still downloading or being copied)`,
        link.map((c) => c.key),
      );
      continue;
    }
    const bad = linkFiles.filter((f) => f.startOk === false || f.endOk === false);
    if (bad.length && !link.every((c) => input.addAnyway.has(c.key))) {
      put(
        'held',
        `The ${bad.some((f) => f.startOk === false) ? 'start' : 'end'} of ${bad.length === 1 ? 'a file' : `${bad.length} files`} doesn't play (still downloading, or damaged): not added`,
        link.map((c) => c.key),
      );
      continue;
    }
    put(
      'new',
      null,
      link.map((c) => c.key),
    );
  }
  return { outcomes, counts, unlinkedKnown };
}

function provenGroup(g: PlanCopyGroup | null): boolean {
  return !!g && g.kind === 'group' && g.outcome === 'auto';
}

// ---------------------------------------------------------------------------------------------
// inputs (cleanup.db only)

interface StageP {
  analysisId?: string;
}

/** The stage-6 build's walk of the torrents (before it linked anything), or null. */
export function buildBaseline(db: Database.Database): Set<string> | null {
  const p6 = getAudioStage(db, 6).progress as StageP;
  if (!p6.analysisId) return null;
  const rows = db
    .prepare(
      `SELECT rel FROM audio_build_manifest WHERE analysis_id = ? AND phase = 'before'
       AND root = 'torrents' AND is_dir = 0`,
    )
    .all(p6.analysisId) as { rel: string }[];
  return rows.length ? new Set(rows.map((r) => r.rel)) : null;
}

/** `dev:ino` of every file stage 6 and stage 7 linked (their done link and PDF operations). */
export function everLinkedInodes(db: Database.Database): Set<string> {
  const out = new Set<string>();
  for (const sql of [
    `SELECT dev, ino FROM audio_build_ops WHERE state = 'done' AND kind IN ('link', 'pdf') AND ino IS NOT NULL`,
    `SELECT dev, ino FROM audio_arrival_ops WHERE state = 'done' AND kind IN ('link', 'pdf') AND ino IS NOT NULL`,
  ])
    for (const r of db.prepare(sql).all() as { dev: number; ino: number }[]) out.add(inode(r));
  return out;
}

export function loadClassifyInputs(
  db: Database.Database,
  ids: { s1: string; s3: string; s4: string },
  extra: { generatedInodes: Set<string>; now: number; settleMs: number },
): ClassifyInput {
  const files = new Map<number, ArrivalFile>();
  const present = new Set<string>(extra.generatedInodes);
  for (const r of db
    .prepare(
      `SELECT f.id, f.root, f.rel_path, f.size, f.mtime_ms, f.dev, f.ino, f.sha256,
              h.start_decode_ok, h.end_decode_ok
       FROM audio_files f LEFT JOIN audio_file_health h ON h.file_id = f.id
       WHERE f.gone_at IS NULL AND f.kind = 'audio'`,
    )
    .all() as {
    id: number;
    root: 'torrents' | 'library';
    rel_path: string;
    size: number;
    mtime_ms: number;
    dev: number;
    ino: number;
    sha256: string | null;
    start_decode_ok: number | null;
    end_decode_ok: number | null;
  }[]) {
    const f: ArrivalFile = {
      id: r.id,
      root: r.root,
      rel: r.rel_path,
      size: r.size,
      mtimeMs: r.mtime_ms,
      dev: r.dev,
      ino: r.ino,
      sha: r.sha256,
      startOk: r.start_decode_ok === null ? null : r.start_decode_ok === 1,
      endOk: r.end_decode_ok === null ? null : r.end_decode_ok === 1,
    };
    files.set(r.id, f);
    if (r.root === 'library') present.add(inode(f));
  }
  const groupOf = new Map<number, PlanCopyGroup>();
  for (const r of db
    .prepare(
      `SELECT m.copy_id, m.rank, m.role, g.id, g.group_key, g.kind, g.outcome
       FROM audio_dup_members m JOIN audio_dup_groups g ON g.id = m.group_id
       WHERE g.analysis_id = ?`,
    )
    .all(ids.s3) as {
    copy_id: number;
    rank: number;
    role: PlanCopyGroup['role'];
    id: number;
    group_key: string;
    kind: PlanCopyGroup['kind'];
    outcome: PlanCopyGroup['outcome'];
  }[])
    groupOf.set(r.copy_id, {
      id: r.id,
      key: r.group_key,
      kind: r.kind,
      outcome: r.outcome,
      role: r.role,
      rank: r.rank,
    });
  const copies = new Map<string, PlanCopy>();
  for (const r of db
    .prepare(
      `SELECT id, copy_key, book_key, kind, file_ids, ai, excluded FROM audio_dup_copies
       WHERE analysis_id = ?`,
    )
    .all(ids.s3) as {
    id: number;
    copy_key: string;
    book_key: string;
    kind: PlanCopy['kind'];
    file_ids: string;
    ai: number;
    excluded: string | number | null;
  }[])
    copies.set(r.copy_key, {
      id: r.id,
      key: r.copy_key,
      bookKey: r.book_key,
      kind: r.kind,
      fileIds: JSON.parse(r.file_ids) as number[],
      ai: r.ai === 1,
      // The reason a copy never competes (text, e.g. a reader merge); 0/'' is none.
      excluded: r.excluded !== null && r.excluded !== '' && Number(r.excluded) !== 0,
      group: groupOf.get(r.id) ?? null,
    });
  const units = (
    db
      .prepare(
        'SELECT unit_key, name, copy_keys FROM audio_online_units WHERE analysis_id = ? ORDER BY unit_key',
      )
      .all(ids.s4) as { unit_key: string; name: string; copy_keys: string }[]
  ).map((r) => ({ key: r.unit_key, name: r.name, copyKeys: JSON.parse(r.copy_keys) as string[] }));
  const decisions = new Map<string, string>();
  for (const r of db.prepare('SELECT group_key, decision FROM audio_dup_decisions').all() as {
    group_key: string;
    decision: string;
  }[])
    decisions.set(r.group_key, r.decision);
  const addAnyway = new Set<string>();
  for (const r of db
    .prepare(
      `SELECT review_key FROM audio_arrival_reviews WHERE kind = 'held' AND decision = 'add_anyway'`,
    )
    .all() as { review_key: string }[])
    addAnyway.add(r.review_key.slice('held:'.length));
  return {
    units,
    copies,
    files,
    decisions,
    baseline: buildBaseline(db),
    present,
    everLinked: everLinkedInodes(db),
    addAnyway,
    now: extra.now,
    settleMs: extra.settleMs,
  };
}
