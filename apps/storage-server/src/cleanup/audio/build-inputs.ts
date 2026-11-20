/**
 * Stage 6's inputs from cleanup.db (WP21e-1): the analyses of stages 1-5 that belong together
 * (stage 5's stage-4 id, stage 4's stage-3 id, stage 3's stage-1 and stage-2 ids) and everything
 * the plan needs from them. Reads only cleanup.db.
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import { getAudioStage } from './audio-stages';
import type {
  PlanBookUnit,
  PlanCopy,
  PlanCopyGroup,
  PlanFile,
  PlanIdentity,
  PlanInputs,
  PlanUnit,
} from './build-plan';

export interface StageIds {
  s1: string;
  s2: string;
  s3: string;
  s4: string;
  s5: string;
  /** Stage 5's rules and models keys (a change decides values again). */
  s5Rules: string | null;
  s5Ask: string | null;
}

interface StageP {
  analysisId?: string;
  phase?: string;
  error?: string | null;
  stage1Id?: string | null;
  stage2Id?: string | null;
  stage3Id?: string | null;
  stage4Id?: string | null;
  rulesKey?: string | null;
  askKey?: string | null;
  gate?: { passed?: boolean } | null;
}

/** The finished analyses stage 6 builds from, or why it can't yet. */
export function stageIds(db: Database.Database): { ids: StageIds | null; problem: string | null } {
  const p = (n: number) => getAudioStage(db, n).progress as StageP;
  const s1 = p(1);
  const s2 = p(2);
  const s3 = p(3);
  const s4 = p(4);
  const s5 = p(5);
  for (const [n, s] of [
    [1, s1],
    [2, s2],
    [3, s3],
    [4, s4],
    [5, s5],
  ] as const) {
    if (!s.analysisId || s.phase !== 'done')
      return { ids: null, problem: `Waiting for stage ${n} to finish` };
    if (s.error) return { ids: null, problem: `Stage ${n} failed: ${s.error}` };
  }
  if (
    s5.stage4Id !== s4.analysisId ||
    s4.stage3Id !== s3.analysisId ||
    s3.stage1Id !== s1.analysisId ||
    s3.stage2Id !== s2.analysisId
  )
    return {
      ids: null,
      problem: 'Waiting for stages 3-5 to finish on the latest analyses (one of them ran again)',
    };
  return {
    ids: {
      s1: s1.analysisId!,
      s2: s2.analysisId!,
      s3: s3.analysisId!,
      s4: s4.analysisId!,
      s5: s5.analysisId!,
      s5Rules: s5.rulesKey ?? null,
      s5Ask: s5.askKey ?? null,
    },
    problem: null,
  };
}

/** Whether stages 3, 4 and 5 passed their gates on the labeled books. */
export function gatesPassed(db: Database.Database): { passed: boolean; failed: number[] } {
  const failed: number[] = [];
  for (const n of [3, 4, 5]) {
    const g = (getAudioStage(db, n).progress as StageP).gate;
    if (!g?.passed) failed.push(n);
  }
  return { passed: failed.length === 0, failed };
}

/** The review-page choices: their hash is part of the plan's input key. */
export function decisionsKey(db: Database.Database): string {
  const rows = db
    .prepare('SELECT group_key, decision FROM audio_dup_decisions ORDER BY group_key')
    .all() as { group_key: string; decision: string }[];
  return createHash('sha1')
    .update(rows.map((r) => `${r.group_key}=${r.decision}`).join('\n'))
    .digest('hex')
    .slice(0, 12);
}

const PAGE = 4000;

/**
 * All rows of a query, a page at a time (keyset on `_k`, which the query selects and orders by),
 * giving the event loop a turn between pages: the plan's inputs are tens of thousands of rows.
 */
async function paged<T>(db: Database.Database, sql: string, args: unknown[] = []): Promise<T[]> {
  const stmt = db.prepare(`SELECT * FROM (${sql}) WHERE _k > ? ORDER BY _k LIMIT ${PAGE}`);
  const out: T[] = [];
  let last: unknown = -1;
  for (;;) {
    const rows = stmt.all(...args, last) as (T & { _k: unknown })[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    last = rows[rows.length - 1]._k;
    await new Promise((r) => setImmediate(r));
  }
}

export async function loadPlanInputs(
  db: Database.Database,
  ids: StageIds,
  opts: { readerWritten: string[]; libraryFolder: string },
): Promise<PlanInputs> {
  // Files (every current file of both roots: audio and PDFs are used).
  const files = new Map<number, PlanFile>();
  const fileRows = (await paged(
    db,
    `SELECT f.id AS _k, f.id, f.root, f.rel_path, f.rel_path_raw, f.decoded_path, f.ext, f.kind,
            f.size, f.mtime_ms, f.dev, f.ino, h.has_cover
     FROM audio_files f LEFT JOIN audio_file_health h ON h.file_id = f.id
     WHERE f.gone_at IS NULL AND (f.kind = 'audio' OR f.ext = '.pdf')`,
  )) as {
    id: number;
    root: 'torrents' | 'library';
    rel_path: string;
    rel_path_raw: string | null;
    decoded_path: string | null;
    ext: string;
    kind: string;
    size: number;
    mtime_ms: number;
    dev: number;
    ino: number;
    has_cover: number | null;
  }[];
  const libraryAudio: number[] = [];
  const pdfs: number[] = [];
  for (const r of fileRows) {
    files.set(r.id, {
      id: r.id,
      root: r.root,
      rel: r.rel_path,
      raw: r.rel_path_raw,
      decoded: r.decoded_path,
      size: r.size,
      mtimeMs: r.mtime_ms,
      dev: r.dev,
      ino: r.ino,
      cover: r.has_cover === null ? null : r.has_cover === 1,
    });
    if (r.root === 'library' && r.kind === 'audio') libraryAudio.push(r.id);
    if (r.root === 'torrents' && r.ext === '.pdf') pdfs.push(r.id);
  }

  // Stage 2's book units (torrents).
  const books = new Map<string, PlanBookUnit>();
  for (const r of db
    .prepare('SELECT book_key, unit_rel_path, unit_kind FROM audio_books WHERE analysis_id = ?')
    .all(ids.s2) as { book_key: string; unit_rel_path: string; unit_kind: 'folder' | 'file' }[])
    books.set(r.book_key, { key: r.book_key, rel: r.unit_rel_path, kind: r.unit_kind });

  // Stage 3's copies with their group.
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
  for (const r of (await paged(
    db,
    `SELECT id AS _k, id, copy_key, book_key, kind, file_ids, ai, excluded FROM audio_dup_copies
     WHERE analysis_id = ?`,
    [ids.s3],
  )) as {
    id: number;
    copy_key: string;
    book_key: string;
    kind: PlanCopy['kind'];
    file_ids: string;
    ai: number;
    excluded: number | null;
  }[])
    copies.set(r.copy_key, {
      id: r.id,
      key: r.copy_key,
      bookKey: r.book_key,
      kind: r.kind,
      fileIds: JSON.parse(r.file_ids) as number[],
      ai: r.ai === 1,
      excluded: r.excluded === 1,
      group: groupOf.get(r.id) ?? null,
    });

  // Stage 4/5's units with stage 5's values.
  const values = new Map<string, Record<string, unknown>>();
  for (const r of (await paged(
    db,
    `SELECT rowid AS _k, item_key, field, value_json FROM ai_values WHERE stage = 'audio5'`,
  )) as { item_key: string; field: string; value_json: string | null }[]) {
    const v = values.get(r.item_key) ?? {};
    v[r.field] = r.value_json === null ? null : (JSON.parse(r.value_json) as unknown);
    values.set(r.item_key, v);
  }
  const copyKeysOf = new Map<string, string[]>();
  for (const r of (await paged(
    db,
    'SELECT id AS _k, unit_key, copy_keys FROM audio_online_units WHERE analysis_id = ?',
    [ids.s4],
  )) as { unit_key: string; copy_keys: string }[])
    copyKeysOf.set(r.unit_key, JSON.parse(r.copy_keys) as string[]);
  const units: PlanUnit[] = (
    db
      .prepare(
        `SELECT unit_key, kind, name FROM audio_meta_units WHERE analysis_id = ? ORDER BY unit_key`,
      )
      .all(ids.s5) as { unit_key: string; kind: PlanUnit['kind']; name: string }[]
  ).map((r) => ({
    key: r.unit_key,
    kind: r.kind,
    name: r.name,
    copyKeys: copyKeysOf.get(r.unit_key) ?? [],
    values: values.get(r.unit_key) ?? {},
  }));

  // Stage 1's identities of the library's files.
  const identity = new Map<number, PlanIdentity>();
  for (const r of (await paged(
    db,
    `SELECT i.rowid AS _k, i.file_id, i.class, i.original_file_ids FROM audio_identity i
     JOIN audio_files f ON f.id = i.file_id
     WHERE i.analysis_id = ? AND f.root = 'library'`,
    [ids.s1],
  )) as { file_id: number; class: string; original_file_ids: string | null }[])
    identity.set(r.file_id, {
      cls: r.class,
      originals: r.original_file_ids ? (JSON.parse(r.original_file_ids) as number[]) : [],
    });

  const decisions = new Map<string, string>();
  for (const r of db.prepare('SELECT group_key, decision FROM audio_dup_decisions').all() as {
    group_key: string;
    decision: string;
  }[])
    decisions.set(r.group_key, r.decision);

  return {
    units,
    copies,
    files,
    books,
    identity,
    libraryAudio,
    pdfs,
    decisions,
    readerWritten: new Set(opts.readerWritten),
    libraryFolder: opts.libraryFolder,
  };
}

/** Archives under the torrents (the daily run unpacks them later: only counted). */
export function torrentArchives(db: Database.Database): { count: number; bytes: number } {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM audio_files
       WHERE root = 'torrents' AND kind = 'archive' AND gone_at IS NULL`,
    )
    .get() as { n: number; b: number };
  return { count: r.n, bytes: r.b };
}

/** The live library's other files by extension (for WP21e-2's list). */
export function libraryOtherFiles(
  db: Database.Database,
): { ext: string; kind: string; count: number; bytes: number }[] {
  return db
    .prepare(
      `SELECT ext, kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM audio_files
       WHERE root = 'library' AND kind <> 'audio' AND gone_at IS NULL
       GROUP BY ext, kind ORDER BY count DESC`,
    )
    .all() as { ext: string; kind: string; count: number; bytes: number }[];
}
