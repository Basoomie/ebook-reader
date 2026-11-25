/**
 * A book's history of changes (design: ⋯ → "History of changes"): every change the user made
 * from the reader, every change the cleanup wrote (per stage, new arrivals included), tags copied
 * onto it from a removed copy, and every change seen made in Calibre's own program.
 *
 * Undo (asked first on the page) is written as a new edit of the user's back to the entry's old
 * value, which becomes the user's (design). Only an entry whose field still holds its new value
 * and that is the field's latest change can be undone: a later change is undone first.
 */
import type Database from 'better-sqlite3';
import { EDIT_STAGE } from '../field-stages';
import type { BookRef } from './catalog';
import { EditError, sameValue, type EditField, type EditValues } from './fields';
import { earlierIdentities } from '../move/rekey';
import type { CoverArchive } from './cover-archive';

export type HistoryWho = 'you' | 'cleanup' | 'calibre' | 'shared_rename' | 'confirm' | 'copied';

export interface HistoryEntry {
  /** p<change id> (a write), s<id> (seen in Calibre / confirmed), t<batch>:<change> (tags copied). */
  id: string;
  at: number;
  who: HistoryWho;
  /** The cleanup's stage (2, 4, 5), or the user's edit (10). */
  stage: number | null;
  /** "New arrivals" for the arrivals' runs, the edit's kind (undo, carried) for the user's. */
  via: string | null;
  field: string;
  old: unknown;
  new: unknown;
  state: 'done' | 'undone' | 'waiting' | 'not_written';
  reason: string | null;
  /** The edit whose rename changed this book (shared_rename). */
  cause: string | null;
  undo: { possible: boolean; why: string | null; to: unknown };
}

/** The edit field an entry's field belongs to (the series' name and number are one field). */
export function editFieldOf(field: string): EditField | null {
  if (field === 'series_index') return 'series';
  const known: string[] = [
    'title',
    'sort',
    'authors',
    'author_sort',
    'illustrator',
    'series',
    'publisher',
    'pubdate',
    'languages',
    'rating',
    'description',
    'tags',
    'identifiers',
    'cover',
  ];
  return known.includes(field) ? (field as EditField) : null;
}

const tagsAfter = (before: string[], change: { added?: string[]; removed?: string[] }) => {
  const removed = new Set((change.removed ?? []).map((t) => t.toLowerCase()));
  const out = before.filter((t) => !removed.has(t.toLowerCase()));
  for (const t of change.added ?? [])
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  return out;
};

/** An index field's value (calibre_seen_changes) in the edit form's shape. */
function seenValue(field: string, v: unknown, current: EditValues): unknown {
  if (field === 'series')
    return v === null ? { name: null, index: null } : { name: v, index: current.series.index ?? 1 };
  if (field === 'series_index') return { name: current.series.name, index: v };
  return v;
}

export function bookHistory(
  db: Database.Database,
  ref: BookRef,
  current: EditValues,
  archive: CoverArchive | null = null,
): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const writes = db
    .prepare(
      `SELECT p.id, p.stage, p.field, p.old_json, p.new_json, p.state, p.source, p.review_reason,
              p.analysis_id, p.created_at, p.updated_at, p.evidence_json,
              f.old_json AS f_old, f.new_json AS f_new, f.created_at AS f_at,
              f.old_cover_path, f.restored_at, b.finished_at
       FROM proposed_changes p INDEXED BY proposed_changes_book
       LEFT JOIN field_undo f ON f.change_id = p.id AND f.batch_id = p.batch_id
       LEFT JOIN batches b ON b.id = p.batch_id
       WHERE p.library_id = ? AND p.calibre_uuid = ? AND p.field <> 'book'
         AND (p.state IN ('applied', 'undone') OR p.stage = ${EDIT_STAGE})`,
    )
    .all(ref.libraryId, ref.uuid) as {
    id: number;
    stage: number;
    field: string;
    old_json: string;
    new_json: string;
    state: string;
    source: string;
    review_reason: string | null;
    analysis_id: string | null;
    created_at: number;
    updated_at: number;
    evidence_json: string;
    f_old: string | null;
    f_new: string | null;
    f_at: number | null;
    old_cover_path: string | null;
    restored_at: number | null;
    finished_at: number | null;
  }[];
  const undoneBy = new Map<string, number>();
  for (const w of writes) {
    const ev = JSON.parse(w.evidence_json) as { undoOf?: string; edit?: string };
    if (w.stage === EDIT_STAGE && ev.undoOf && w.state === 'applied') undoneBy.set(ev.undoOf, w.id);
  }
  for (const w of writes) {
    const ev = JSON.parse(w.evidence_json) as { edit?: string };
    const edit = w.stage === EDIT_STAGE;
    let old: unknown = JSON.parse(w.f_old ?? w.old_json);
    let nv: unknown = JSON.parse(w.new_json);
    if (w.field === 'tags' && !edit && w.f_new) {
      // Stage 5's write is a change (added / removed) applied to the tags Calibre had.
      const before = Array.isArray(old) ? (old as string[]) : [];
      nv = tagsAfter(before, JSON.parse(w.f_new) as { added?: string[]; removed?: string[] });
      old = before;
    }
    // Book covers: the picture before the write, from the server's cover archive (else the
    // sidecar's quarantine, for writes made before the archive and not imported).
    const keptBefore = w.field === 'cover' ? (archive?.keptBefore(w.id) ?? null) : null;
    if (w.field === 'cover') {
      old = keptBefore || w.old_cover_path ? 'picture' : null;
      nv = 'picture';
    }
    const state: HistoryEntry['state'] =
      w.state === 'applied'
        ? w.restored_at
          ? 'undone'
          : 'done'
        : w.state === 'undone'
          ? 'undone'
          : w.state === 'skipped'
            ? 'not_written'
            : 'waiting';
    out.push({
      id: `p${w.id}`,
      at: w.f_at ?? w.finished_at ?? w.updated_at,
      who: edit ? 'you' : 'cleanup',
      stage: w.stage,
      via: edit
        ? (ev.edit ?? 'edit')
        : w.analysis_id?.startsWith('arrivals:')
          ? 'arrivals'
          : w.source === 'title-fit'
            ? 'title-fit'
            : null,
      field: w.field,
      old,
      new: nv,
      state: undoneBy.has(`p${w.id}`) && state === 'done' ? 'undone' : state,
      reason: state === 'not_written' ? w.review_reason : null,
      cause: null,
      undo: { possible: false, why: null, to: old },
    });
    if (w.field === 'cover')
      out[out.length - 1].undo.to = keptBefore
        ? { archive: keptBefore }
        : w.old_cover_path
          ? { quarantine: w.old_cover_path }
          : null;
  }
  // Manga part A: a moved book's writes and seen changes moved with it (move/rekey.ts); the tags
  // copied onto it by a removal are recorded under the identity it had then.
  const identities = [
    { libraryId: ref.libraryId, uuid: ref.uuid },
    ...earlierIdentities(db, ref.libraryId, ref.uuid),
  ];
  const copiedOf = db.prepare(
    `SELECT batch_id, change_id, added_tags_json, created_at, restored_at FROM undo_records
     WHERE library_id = ? AND kept_uuid = ? AND added_tags_json <> '[]'`,
  );
  const copied = identities.flatMap(
    (i) =>
      copiedOf.all(i.libraryId, i.uuid) as {
        batch_id: string;
        change_id: number;
        added_tags_json: string;
        created_at: number;
        restored_at: number | null;
      }[],
  );
  for (const c of copied) {
    const added = JSON.parse(c.added_tags_json) as string[];
    const id = `t${c.batch_id}:${c.change_id}`;
    out.push({
      id,
      at: c.created_at,
      who: 'copied',
      stage: null,
      via: null,
      field: 'tags',
      old: { removed: added },
      new: { added },
      state: c.restored_at || undoneBy.has(id) ? 'undone' : 'done',
      reason: null,
      cause: null,
      undo: { possible: false, why: null, to: null },
    });
  }
  const seen = db
    .prepare(
      `SELECT id, field, old_json, new_json, kind, cause_change_id, cause_title, seen_at
       FROM calibre_seen_changes WHERE library_id = ? AND calibre_uuid = ?`,
    )
    .all(ref.libraryId, ref.uuid) as {
    id: number;
    field: string;
    old_json: string;
    new_json: string;
    kind: 'calibre' | 'shared_rename' | 'confirm';
    cause_change_id: number | null;
    cause_title: string | null;
    seen_at: number;
  }[];
  for (const s of seen) {
    const id = `s${s.id}`;
    out.push({
      id,
      at: s.seen_at,
      who: s.kind === 'calibre' ? 'calibre' : s.kind,
      stage: null,
      via: null,
      field: s.field,
      old: s.field === 'cover' ? 'picture' : seenValue(s.field, JSON.parse(s.old_json), current),
      new: s.field === 'cover' ? 'picture' : seenValue(s.field, JSON.parse(s.new_json), current),
      state: undoneBy.has(id) ? 'undone' : 'done',
      reason: null,
      cause: s.cause_title,
      undo: { possible: false, why: null, to: null },
    });
    const e = out[out.length - 1];
    e.undo.to = e.old;
  }
  out.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  markUndoable(out, current);
  return out;
}

/**
 * Which entries can be undone: the latest done change of each field, while the field still holds
 * its new value. The reasons the page shows for the others.
 */
function markUndoable(entries: HistoryEntry[], current: EditValues): void {
  const latest = new Map<string, HistoryEntry>();
  for (const e of entries) {
    const f = editFieldOf(e.field);
    if (!f || e.state !== 'done') continue;
    if (!latest.has(f)) latest.set(f, e);
  }
  for (const e of entries) {
    const f = editFieldOf(e.field);
    const why = (w: string) => {
      e.undo.possible = false;
      e.undo.why = w;
    };
    if (e.state === 'undone') {
      why('Undone');
      continue;
    }
    if (e.state !== 'done') {
      why(e.state === 'waiting' ? 'Not written yet' : 'Nothing was written');
      continue;
    }
    if (e.who === 'confirm') {
      why('A confirmation changes nothing');
      continue;
    }
    if (e.who === 'shared_rename') {
      why(`Changed with your edit of ${e.cause ?? 'another book'}: undo that edit`);
      continue;
    }
    if (e.who === 'copied') {
      why('Undo the removal of the copy on /cleanup');
      continue;
    }
    if (!f) {
      why('This field can’t be edited here');
      continue;
    }
    if (latest.get(f) !== e) {
      why('Changed since: undo the later change first');
      continue;
    }
    if (f === 'cover') {
      if (e.who === 'calibre')
        why('Calibre doesn’t keep the earlier picture: pick it under Earlier covers if it’s there');
      else if (!e.undo.to) why('Calibre had no cover before, and a cover can’t be taken off');
      else e.undo.possible = true;
      continue;
    }
    if (!sameValue(f, current[f as keyof EditValues], e.new)) {
      why('Changed since: undo the later change first');
      continue;
    }
    e.undo.possible = true;
  }
}

/** The entry to undo, checked again (never trusted from the page). */
export function undoTarget(entries: HistoryEntry[], id: string): HistoryEntry {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new EditError(404, 'not_found', 'No such change in this book’s history');
  if (!e.undo.possible) throw new EditError(409, 'not_undoable', e.undo.why ?? 'Can’t be undone');
  return e;
}
