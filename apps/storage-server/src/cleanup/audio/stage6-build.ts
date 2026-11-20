/**
 * Audiobook stage 6 (WP21e-1, plan section 8 steps 1-3): builds `media/audiobooks/japanese-new/`
 * (and `japanese-generated-new/` for the AI books) next to the live library from the decisions of
 * stages 1-5, made only of hard links to the torrents' files plus each book's metadata.json, and
 * checks it. The live library, the torrents, Audiobookshelf and the reader stay as they are.
 *
 * Phases (resumable; the progress is in audio_stages row 6):
 *   plan        cleanup.db only: books, folders, links, PDFs, metadata, the move list.
 *   preflight   the linking sidecar lstats every planned source (read only).
 *   planned     Preview ends here. On continues:
 *   walk_before lstat of the torrents and the live library (the "before" of the check).
 *   build       the sidecar makes the folders, links and metadata files, in batches handed out
 *               only while this stage holds the shared disk lock (Calibre first).
 *   walk_after  the same walk again.
 *   check       the new trees against the plan, before vs after, a re-hash sample, the move
 *               list, the labeled books, Audiobookshelf and the reader unchanged.
 *   done
 *
 * Nothing here writes a file: the server never has the trees writable (read-only mounts, the
 * read-only module); only the sidecar's writer module creates folders, links and metadata.json.
 */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings } from '../settings';
import { getAudioStage, pauseAudioStage, updateAudioStage } from './audio-stages';
import { hashFile, insideRoot, lstatEntry, readSmall, ReadPacer } from './audio-source-fs';
import {
  compareManifests,
  compareNewTree,
  walkTree,
  type ManifestEntry,
  type NewTreeResult,
} from './build-check';
import {
  decisionsKey,
  gatesPassed,
  libraryOtherFiles,
  loadPlanInputs,
  stageIds,
  torrentArchives,
  type StageIds,
} from './build-inputs';
import {
  AREA_FOLDERS,
  BUILD_PLAN_VERSION,
  layoutFolder,
  layoutOf,
  planBuildSliced,
  type BuildArea,
  type PlanCounts,
} from './build-plan';
import { GATE_FIELDS, labelAgrees, type MetaLabel } from './meta-gate';
import { titleKey } from './meta-prompt';
import type { AudioStage5 } from './stage5-meta';
import type { SeriesEntry } from './meta-rules';

export const STAGE6 = 6;
const OWNER = DISK_OWNERS.audio6;
const SIDECAR_OFFLINE_MS = 90_000;
const INSERT_CHUNK = 1000;
const SAMPLE_SEED = 20261120;
const SAMPLE_SIZE = 30;

export type Stage6Phase =
  | 'plan'
  | 'preflight'
  | 'planned'
  | 'walk_before'
  | 'build'
  | 'walk_after'
  | 'check'
  | 'done';

export const STAGE6_PHASES: Stage6Phase[] = [
  'plan',
  'preflight',
  'planned',
  'walk_before',
  'build',
  'walk_after',
  'check',
  'done',
];

export interface PhaseTime {
  ms: number;
  items: number;
}

export interface CheckItem {
  key: string;
  name: string;
  ok: boolean | null;
  detail: string;
}

export interface Stage6Check {
  passed: boolean;
  at: number;
  items: CheckItem[];
  newTree: NewTreeResult | null;
  metadataWrong: string[];
  torrents: ReturnType<typeof compareManifests> | null;
  library: ReturnType<typeof compareManifests> | null;
  rehash: { checked: number; same: number; different: string[] };
  moves: { library: number; listed: number; unaccounted: number; arrivedAfterStage1: string[] };
  labels: {
    books: number;
    notFound: string[];
    folderRight: number;
    folderWrong: { id: string; expected: string; got: string; why: string }[];
    valuesWrong: { id: string; field: string; expected: unknown; got: unknown; why: string }[];
    valuesChecked: number;
    /** Differences that are neither an unconfirmed value nor a stage-5 gate miss. */
    unexplained: number;
  };
  abs: { before: number | null; after: number | null; same: boolean | null; detail: string };
  reader: { before: string | null; after: string | null; same: boolean | null };
}

export interface AudioStage6Progress {
  analysisId: string;
  phase: Stage6Phase;
  startedAt: number;
  finishedAt: number | null;
  /** The analyses, rules and choices the plan comes from (a change plans again, or pauses a build). */
  inputKey: string | null;
  ids: StageIds | null;
  counts: PlanCounts | null;
  archives: { count: number; bytes: number } | null;
  libraryOther: { ext: string; kind: string; count: number; bytes: number }[] | null;
  phaseStartedAt: number;
  phaseStartDone: number;
  phaseTimes: Record<string, PhaseTime>;
  /** Longest synchronous stretch of the plan phase (ms). */
  planLongestMs: number;
  preflight: {
    total: number;
    done: number;
    problems: number;
    byProblem: Record<string, number>;
    info: Record<string, unknown> | null;
  };
  build: {
    startedAt: number | null;
    finishedAt: number | null;
    total: number;
    done: number;
    failed: number;
    batches: number;
    lockWaits: number;
    lockWaitMs: number;
    yields: number;
    firstFailure: string | null;
  };
  walk: {
    before: { entries: number; ms: number; pausedMs: number; errors: string[] } | null;
    after: { entries: number; ms: number; pausedMs: number; errors: string[] } | null;
    current: { done: number; expected: number } | null;
  };
  abs: { before: number | null; after: number | null };
  reader: { before: string | null; after: string | null };
  check: Stage6Check | null;
  error: string | null;
}

export function emptyStage6(now = Date.now()): AudioStage6Progress {
  return {
    analysisId: randomUUID(),
    phase: 'plan',
    startedAt: now,
    finishedAt: null,
    inputKey: null,
    ids: null,
    counts: null,
    archives: null,
    libraryOther: null,
    phaseStartedAt: now,
    phaseStartDone: 0,
    phaseTimes: {},
    planLongestMs: 0,
    preflight: { total: 0, done: 0, problems: 0, byProblem: {}, info: null },
    build: {
      startedAt: null,
      finishedAt: null,
      total: 0,
      done: 0,
      failed: 0,
      batches: 0,
      lockWaits: 0,
      lockWaitMs: 0,
      yields: 0,
      firstFailure: null,
    },
    walk: { before: null, after: null, current: null },
    abs: { before: null, after: null },
    reader: { before: null, after: null },
    check: null,
    error: null,
  };
}

/** The roots stage 6 reads (all read-only in the server). */
export interface BuildRoots {
  torrents: string;
  library: string;
  /** media/audiobooks (CLEANUP_AUDIO_MEDIA_DIR): the new folders are checked through it. */
  media: string | null;
}

export interface Stage6Deps {
  db: Database.Database;
  roots: BuildRoots;
  lock: DiskLock;
  stage5: AudioStage5;
  readerWritten?: () => string[];
  log?: (m: string) => void;
}

/** A batch for the sidecar. */
export interface LinkBatch {
  id: number;
  kind: 'preflight' | 'build';
  leaseSeconds: number;
  ops: {
    id: number;
    kind: 'folder' | 'link' | 'pdf' | 'metadata';
    dst: string;
    src: { rel: string; raw: string | null } | null;
    size: number | null;
    mtimeMs: number | null;
    dev: number | null;
    ino: number | null;
    bytes: string | null;
  }[];
}

export interface LinkOpResult {
  id: number;
  ok: boolean;
  /** Preflight: what is wrong with the source (missing, changed, not a file, can't link). */
  problem?: string | null;
  error?: string | null;
  existed?: boolean;
  dev?: number;
  ino?: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

export class AudioStage6 {
  private readonly db: Database.Database;
  /** True while the build may hand out batches (the stage holds the disk lock). */
  private handing = false;
  private planning: Promise<void> | null = null;
  /** When the build started waiting for the disk lock (null: not waiting). */
  private waitingSince: number | null = null;

  constructor(private readonly deps: Stage6Deps) {
    this.db = deps.db;
  }

  // -------------------------------------------------------------------------------------------
  // progress

  progress(): AudioStage6Progress | null {
    const p = getAudioStage(this.db, STAGE6).progress as Partial<AudioStage6Progress>;
    return p && p.analysisId ? (p as AudioStage6Progress) : null;
  }

  private save(p: AudioStage6Progress): void {
    updateAudioStage(this.db, STAGE6, {
      state: p.phase,
      progress: p as unknown as Record<string, unknown>,
    });
  }

  private setPhase(p: AudioStage6Progress, phase: Stage6Phase, items = 0): void {
    const now = Date.now();
    const t = (p.phaseTimes[p.phase] ??= { ms: 0, items: 0 });
    t.ms += now - p.phaseStartedAt;
    t.items += items;
    p.phase = phase;
    p.phaseStartedAt = now;
    p.phaseStartDone = 0;
    if (phase === 'done') p.finishedAt = now;
    this.save(p);
    this.deps.log?.(`Audiobooks stage 6: ${phase}`);
  }

  /** True once the build has written anything (a new plan would no longer match the disk). */
  buildStarted(p: AudioStage6Progress | null = this.progress()): boolean {
    return !!p && p.build.startedAt !== null;
  }

  /** A fresh analysis (only before a build has started). */
  restart(): AudioStage6Progress {
    if (this.buildStarted()) throw new Error('The build has started; it can only be continued');
    const p = emptyStage6();
    this.clearOld(p.analysisId);
    this.save(p);
    return p;
  }

  private clearOld(keep: string): void {
    for (const t of [
      'audio_build_ops',
      'audio_build_batches',
      'audio_build_books',
      'audio_build_moves',
      'audio_build_manifest',
    ])
      this.db.prepare(`DELETE FROM ${t} WHERE analysis_id <> ?`).run(keep);
  }

  /** The key of everything the plan is made from. */
  inputKey(ids: StageIds): string {
    return [
      `v${BUILD_PLAN_VERSION}`,
      ids.s1,
      ids.s2,
      ids.s3,
      ids.s4,
      ids.s5,
      ids.s5Rules ?? '',
      ids.s5Ask ?? '',
      decisionsKey(this.db),
      path.basename(this.deps.roots.library),
    ].join('|');
  }

  // -------------------------------------------------------------------------------------------
  // plan

  /** Plans (cleanup.db only). Returns the counts. */
  async plan(p: AudioStage6Progress, ids: StageIds): Promise<void> {
    if (this.planning) return this.planning;
    this.planning = (async () => {
      let longest = 0;
      const timed = <T>(f: () => T): T => {
        const t = performance.now();
        const r = f();
        longest = Math.max(longest, performance.now() - t);
        return r;
      };
      // Both in slices: the server keeps answering (the inputs are tens of thousands of rows).
      const inputs = await loadPlanInputs(this.db, ids, {
        readerWritten: this.deps.readerWritten?.() ?? [],
        libraryFolder: path.basename(this.deps.roots.library),
      });
      await tick();
      const result = await planBuildSliced(inputs);
      await tick();
      const a = p.analysisId;
      timed(() =>
        this.db.transaction(() => {
          for (const t of ['audio_build_ops', 'audio_build_books', 'audio_build_moves'])
            this.db.prepare(`DELETE FROM ${t} WHERE analysis_id = ?`).run(a);
        })(),
      );
      // The sample: 30 books drawn with a fixed seed (the same at stop 1 and on the NAS).
      const rand = mulberry32(SAMPLE_SEED);
      const order = result.books.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const sample = new Set(order.slice(0, SAMPLE_SIZE));
      const insBook = this.db.prepare(
        `INSERT INTO audio_build_books (analysis_id, unit_key, copy_key, area, state, folder,
           base_folder, author, series, title, notes_json, files, pdfs, cover, metadata, sample)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const bookIds: number[] = [];
      for (let i = 0; i < result.books.length; i += INSERT_CHUNK) {
        timed(() =>
          this.db.transaction(() => {
            for (let j = i; j < Math.min(i + INSERT_CHUNK, result.books.length); j++) {
              const b = result.books[j];
              bookIds[j] = Number(
                insBook.run(
                  a,
                  b.unitKey,
                  b.copyKey,
                  b.area,
                  b.state,
                  b.folder,
                  b.baseFolder,
                  b.author,
                  b.series,
                  b.title,
                  JSON.stringify(b.notes),
                  b.files.length,
                  b.pdfs.length,
                  b.cover ? 1 : 0,
                  b.metadata,
                  sample.has(j) ? 1 : 0,
                ).lastInsertRowid,
              );
            }
          })(),
        );
        await tick();
      }
      const insOp = this.db.prepare(
        `INSERT INTO audio_build_ops (analysis_id, book_id, kind, dst, src_file_id, src_rel, src_raw,
           size, mtime_ms, dev, ino) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < result.ops.length; i += INSERT_CHUNK) {
        timed(() =>
          this.db.transaction(() => {
            for (let j = i; j < Math.min(i + INSERT_CHUNK, result.ops.length); j++) {
              const o = result.ops[j];
              const f = o.srcFileId !== null ? inputs.files.get(o.srcFileId) : undefined;
              insOp.run(
                a,
                o.book === null ? null : bookIds[o.book],
                o.kind,
                o.dst,
                o.srcFileId,
                f?.rel ?? null,
                f?.raw ?? null,
                f?.size ?? null,
                f?.mtimeMs ?? null,
                f?.dev ?? null,
                f?.ino ?? null,
              );
            }
          })(),
        );
        await tick();
      }
      const insMove = this.db.prepare(
        `INSERT INTO audio_build_moves (analysis_id, file_id, old_path, outcome, new_path, kept_path, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < result.moves.length; i += INSERT_CHUNK) {
        timed(() =>
          this.db.transaction(() => {
            for (const m of result.moves.slice(i, i + INSERT_CHUNK))
              insMove.run(a, m.fileId, m.oldPath, m.outcome, m.newPath, m.keptPath, m.detail);
          })(),
        );
        await tick();
      }
      p.counts = result.counts;
      p.archives = torrentArchives(this.db);
      p.libraryOther = libraryOtherFiles(this.db);
      p.ids = ids;
      p.inputKey = this.inputKey(ids);
      p.planLongestMs = Math.round(longest);
      p.preflight = {
        total: result.counts.links + result.counts.pdfLinks,
        done: 0,
        problems: 0,
        byProblem: {},
        info: null,
      };
      p.build.total = result.counts.ops;
      this.setPhase(p, 'preflight', result.books.length);
    })();
    try {
      await this.planning;
    } finally {
      this.planning = null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // the sidecar

  heartbeat(body: {
    sidecarId: string;
    runId: string | null;
    version: string | null;
    problem: string | null;
    info: Record<string, unknown> | null;
  }): { active: boolean; pollSeconds: number } {
    this.db
      .prepare(
        `INSERT INTO link_sidecar_status (id, sidecar_id, run_id, version, last_seen_at, problem, info_json)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sidecar_id = excluded.sidecar_id, run_id = excluded.run_id,
           version = excluded.version, last_seen_at = excluded.last_seen_at,
           problem = excluded.problem, info_json = excluded.info_json`,
      )
      .run(
        body.sidecarId,
        body.runId,
        body.version,
        Date.now(),
        body.problem,
        body.info ? JSON.stringify(body.info) : null,
      );
    const p = this.progress();
    const st = getAudioStage(this.db, STAGE6);
    const active =
      st.mode !== 'off' &&
      !!p &&
      (p.phase === 'preflight' || (p.phase === 'build' && st.mode === 'on'));
    return { active, pollSeconds: active ? 1 : 15 };
  }

  sidecar(now = Date.now()) {
    const r = this.db.prepare('SELECT * FROM link_sidecar_status WHERE id = 1').get() as
      | {
          sidecar_id: string | null;
          run_id: string | null;
          version: string | null;
          last_seen_at: number | null;
          problem: string | null;
          info_json: string | null;
        }
      | undefined;
    return {
      online: !!r?.last_seen_at && now - r.last_seen_at < SIDECAR_OFFLINE_MS,
      lastSeenAt: r?.last_seen_at ?? null,
      version: r?.version ?? null,
      problem: r?.problem ?? null,
      info: r?.info_json ? (JSON.parse(r.info_json) as Record<string, unknown>) : null,
    };
  }

  /** Batches whose lease ran out: their claimed operations go back to planned. */
  expireLeases(now = Date.now()): number {
    const p = this.progress();
    if (!p) return 0;
    const expired = this.db
      .prepare(
        `SELECT id FROM audio_build_batches WHERE analysis_id = ? AND state = 'claimed' AND lease_until < ?`,
      )
      .all(p.analysisId, now) as { id: number }[];
    if (!expired.length) return 0;
    this.db.transaction(() => {
      for (const b of expired) {
        this.db.prepare(`UPDATE audio_build_batches SET state = 'expired' WHERE id = ?`).run(b.id);
        this.db
          .prepare(
            `UPDATE audio_build_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(b.id);
      }
    })();
    return expired.length;
  }

  /** A batch is out at the sidecar and its lease runs. */
  inFlight(now = Date.now()): boolean {
    const p = this.progress();
    if (!p) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM audio_build_batches WHERE analysis_id = ? AND state = 'claimed' AND lease_until >= ? LIMIT 1`,
        )
        .get(p.analysisId, now) !== undefined
    );
  }

  /** The next batch for the sidecar, or null (nothing to do now). */
  claim(now = Date.now()): LinkBatch | null {
    this.expireLeases(now);
    const p = this.progress();
    const st = getAudioStage(this.db, STAGE6);
    if (!p || st.mode === 'off' || st.pauseReason) return null;
    if (this.inFlight(now)) return null;
    const s = getSettings(this.db).audiobooks;
    const lease = s.buildLeaseSeconds;
    let kind: 'preflight' | 'build';
    let rows: OpRow[];
    if (p.phase === 'preflight') {
      if (this.deps.lock.calibreBusy()) return null;
      kind = 'preflight';
      rows = this.db
        .prepare(
          `SELECT * FROM audio_build_ops INDEXED BY audio_build_ops_preflight
           WHERE analysis_id = ? AND preflight IS NULL AND kind IN ('link', 'pdf')
           ORDER BY id LIMIT ?`,
        )
        .all(p.analysisId, s.buildPreflightOps) as OpRow[];
    } else if (p.phase === 'build' && st.mode === 'on') {
      if (!this.handing || !this.deps.lock.holds(OWNER) || this.deps.lock.shouldYield(OWNER))
        return null;
      kind = 'build';
      rows = this.db
        .prepare(
          `SELECT * FROM audio_build_ops WHERE analysis_id = ? AND state = 'planned'
           ORDER BY id LIMIT ?`,
        )
        .all(p.analysisId, s.buildBatchOps) as OpRow[];
    } else return null;
    if (!rows.length) return null;
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO audio_build_batches (analysis_id, kind, state, ops, claimed_at, lease_until)
           VALUES (?, ?, 'claimed', ?, ?, ?)`,
        )
        .run(p.analysisId, kind, rows.length, now, now + lease * 1000).lastInsertRowid,
    );
    const metaOf = this.db.prepare('SELECT metadata FROM audio_build_books WHERE id = ?');
    this.db.transaction(() => {
      const upd = this.db.prepare(
        kind === 'build'
          ? `UPDATE audio_build_ops SET state = 'claimed', batch_id = ? WHERE id = ?`
          : `UPDATE audio_build_ops SET batch_id = ? WHERE id = ?`,
      );
      for (const r of rows) upd.run(id, r.id);
    })();
    if (kind === 'build') {
      p.build.batches++;
      if (p.build.startedAt === null) p.build.startedAt = now;
      this.save(p);
    }
    return {
      id,
      kind,
      leaseSeconds: lease,
      ops: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        dst: r.dst,
        src: r.src_rel === null ? null : { rel: r.src_rel, raw: r.src_raw },
        size: r.size,
        mtimeMs: r.mtime_ms,
        dev: r.dev,
        ino: r.ino,
        bytes:
          r.kind === 'metadata' && r.book_id !== null
            ? (metaOf.get(r.book_id) as { metadata: Buffer }).metadata.toString('base64')
            : null,
      })),
    };
  }

  /** The sidecar's results of a batch. */
  report(batchId: number, results: LinkOpResult[], now = Date.now()): { accepted: number } {
    const p = this.progress();
    if (!p) throw new Error('No build analysis');
    const batch = this.db
      .prepare('SELECT * FROM audio_build_batches WHERE id = ? AND analysis_id = ?')
      .get(batchId, p.analysisId) as
      | { id: number; kind: 'preflight' | 'build'; state: string }
      | undefined;
    if (!batch) throw new Error('No such batch');
    let accepted = 0;
    let failure: string | null = null;
    this.db.transaction(() => {
      if (batch.kind === 'preflight') {
        const upd = this.db.prepare(
          `UPDATE audio_build_ops SET preflight = ? WHERE id = ? AND batch_id = ? AND preflight IS NULL`,
        );
        for (const r of results) {
          const v = r.ok ? 'ok' : (r.problem ?? r.error ?? 'problem').slice(0, 200);
          accepted += upd.run(v, r.id, batchId).changes;
        }
      } else {
        const ok = this.db.prepare(
          `UPDATE audio_build_ops SET state = 'done', result_json = ?, done_at = ?
           WHERE id = ? AND batch_id = ? AND state IN ('claimed', 'planned')`,
        );
        const bad = this.db.prepare(
          `UPDATE audio_build_ops SET state = 'failed', result_json = ?, done_at = ?
           WHERE id = ? AND batch_id = ? AND state IN ('claimed', 'planned')`,
        );
        for (const r of results) {
          const json = JSON.stringify({
            existed: r.existed ?? false,
            dev: r.dev ?? null,
            ino: r.ino ?? null,
            error: r.error ?? null,
          });
          if (r.ok) accepted += ok.run(json, now, r.id, batchId).changes;
          else {
            accepted += bad.run(json, now, r.id, batchId).changes;
            failure ??= `${r.error ?? 'failed'} (operation ${r.id})`;
          }
        }
        // Operations the sidecar didn't get to go back to planned.
        this.db
          .prepare(
            `UPDATE audio_build_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(batchId);
      }
      this.db
        .prepare(`UPDATE audio_build_batches SET state = 'reported', reported_at = ? WHERE id = ?`)
        .run(now, batchId);
    })();
    if (batch.kind === 'preflight') this.refreshPreflight(p);
    else {
      this.refreshBuild(p);
      if (failure) {
        p.build.firstFailure ??= failure;
        this.save(p);
        pauseAudioStage(this.db, STAGE6, 'build_failed', failure);
      }
    }
    return { accepted };
  }

  private refreshPreflight(p: AudioStage6Progress): void {
    const rows = this.db
      .prepare(
        `SELECT preflight, COUNT(*) AS n FROM audio_build_ops
         WHERE analysis_id = ? AND kind IN ('link', 'pdf') GROUP BY preflight`,
      )
      .all(p.analysisId) as { preflight: string | null; n: number }[];
    let done = 0;
    let problems = 0;
    const byProblem: Record<string, number> = {};
    for (const r of rows) {
      if (r.preflight === null) continue;
      done += r.n;
      if (r.preflight !== 'ok') {
        problems += r.n;
        const k = r.preflight.split(':')[0];
        byProblem[k] = (byProblem[k] ?? 0) + r.n;
      }
    }
    p.preflight = { ...p.preflight, done, problems, byProblem, info: this.sidecar().info };
    this.save(p);
  }

  private refreshBuild(p: AudioStage6Progress): void {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM audio_build_ops WHERE analysis_id = ? GROUP BY state`,
      )
      .all(p.analysisId) as { state: string; n: number }[];
    const n = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
    p.build.done = n('done');
    p.build.failed = n('failed');
    this.save(p);
  }

  // -------------------------------------------------------------------------------------------
  // the loop (called by the service while the stage is not off)

  /**
   * One step. `mode` is the stage's mode; `stop` turns true when it changes. Returns true when
   * there is nothing more to do in this mode.
   */
  async step(
    stop: () => boolean,
    mode: 'analyse' | 'on',
    hooks: {
      absSnapshot?: () => Promise<number | null>;
      readerState?: () => string | null;
      absCompare?: (before: number, after: number) => { same: boolean; detail: string };
    } = {},
  ): Promise<boolean> {
    let p = this.progress() ?? this.restart();
    const { ids, problem } = stageIds(this.db);
    if (!ids) {
      if (!this.buildStarted(p)) return true; // the service shows the problem
      pauseAudioStage(this.db, STAGE6, 'inputs_changed', problem);
      return true;
    }
    const key = this.inputKey(ids);
    if (p.inputKey && p.inputKey !== key) {
      if (this.buildStarted(p)) {
        pauseAudioStage(
          this.db,
          STAGE6,
          'inputs_changed',
          'Stages 1-5 or the review choices changed after the build started',
        );
        return true;
      }
      p = this.restart();
    }
    switch (p.phase) {
      case 'plan':
        await this.plan(p, ids);
        return false;
      case 'preflight': {
        this.refreshPreflight(p);
        if (p.preflight.done >= p.preflight.total) {
          this.setPhase(p, 'planned', p.preflight.done);
          return false;
        }
        await sleep(250);
        return stop();
      }
      case 'planned':
        if (mode !== 'on') return true;
        p.reader.before = hooks.readerState?.() ?? null;
        p.abs.before = (await hooks.absSnapshot?.().catch(() => null)) ?? null;
        this.setPhase(p, 'walk_before');
        return false;
      case 'walk_before':
      case 'walk_after': {
        // The walk before starts the build (On only); the walk after and the check only read, so
        // "Check again" also runs them from Preview.
        if (mode !== 'on' && p.phase === 'walk_before') return true;
        const done = await this.walkPhase(p, p.phase === 'walk_before' ? 'before' : 'after', stop);
        if (!done) return stop();
        this.setPhase(p, p.phase === 'walk_before' ? 'build' : 'check');
        return false;
      }
      case 'build':
        if (mode !== 'on') {
          this.giveBack();
          return true;
        }
        return this.buildStep(p, stop);
      case 'check': {
        const ok = await this.checkPhase(p, stop, hooks);
        if (!ok) return stop();
        this.setPhase(p, 'done');
        return true;
      }
      case 'done':
        return true;
    }
  }

  /** Stops handing out batches and gives the lock back once nothing is at the sidecar. */
  giveBack(): void {
    this.handing = false;
    if (this.deps.lock.holds(OWNER) && !this.inFlight()) this.deps.lock.release(OWNER);
  }

  private async buildStep(p: AudioStage6Progress, stop: () => boolean): Promise<boolean> {
    this.expireLeases();
    this.refreshBuild(p);
    if (p.build.failed > 0) {
      this.giveBack();
      if (!getAudioStage(this.db, STAGE6).pauseReason)
        pauseAudioStage(this.db, STAGE6, 'build_failed', p.build.firstFailure);
      return true;
    }
    const left = p.build.total - p.build.done;
    if (left === 0 && !this.inFlight()) {
      this.giveBack();
      p.build.finishedAt = Date.now();
      p.reader.after = null;
      this.setPhase(p, 'walk_after', p.build.done);
      return false;
    }
    if (stop() || getAudioStage(this.db, STAGE6).pauseReason) {
      this.giveBack();
      return true;
    }
    if (!this.deps.lock.holds(OWNER)) {
      // Wait for the disk in short turns (the page and the stop check stay current); a wait
      // is counted once, from its first turn to the lock.
      this.waitingSince ??= Date.now();
      const until = Date.now() + 2000;
      const got = await this.deps.lock.acquire(OWNER, 'audio', () => stop() || Date.now() > until);
      if (!got) return stop();
      const waited = Date.now() - this.waitingSince;
      this.waitingSince = null;
      if (waited > 500) {
        p.build.lockWaits++;
        p.build.lockWaitMs += waited;
        this.save(p);
      }
    }
    if (this.deps.lock.shouldYield(OWNER)) {
      this.handing = false;
      if (!this.inFlight()) {
        this.deps.lock.release(OWNER);
        p.build.yields++;
        this.save(p);
      }
      await sleep(500);
      return false;
    }
    this.handing = true;
    await sleep(250);
    return false;
  }

  /** True while the build hands out batches (shown on the card). */
  isHanding(): boolean {
    return this.handing;
  }

  // -------------------------------------------------------------------------------------------
  // walks

  private async walkPhase(
    p: AudioStage6Progress,
    which: 'before' | 'after',
    stop: () => boolean,
  ): Promise<boolean> {
    const started = Date.now();
    let pausedMs = 0;
    const errors: string[] = [];
    const expected = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audio_files WHERE gone_at IS NULL`).get() as {
        n: number;
      }
    ).n;
    let total = 0;
    this.db
      .prepare('DELETE FROM audio_build_manifest WHERE analysis_id = ? AND phase = ?')
      .run(p.analysisId, which);
    for (const root of ['torrents', 'library'] as const) {
      const out = await walkTree(this.deps.roots[root], {
        shouldStop: stop,
        shouldPause: () => this.deps.lock.calibreBusy(),
        onEntries: (n) => {
          p.walk.current = { done: total + n, expected };
          if (n % 5000 === 0) this.save(p);
        },
      });
      if (!out) return false;
      pausedMs += out.pausedMs;
      errors.push(...out.errors.map((e) => `${root}/${e}`));
      this.storeManifest(p.analysisId, which, root, out.entries);
      total += out.entries.length;
      await tick();
    }
    p.walk[which] = {
      entries: total,
      ms: Date.now() - started,
      pausedMs,
      errors: errors.slice(0, 50),
    };
    p.walk.current = null;
    this.save(p);
    return true;
  }

  private storeManifest(
    analysisId: string,
    phase: 'before' | 'after',
    root: 'torrents' | 'library',
    entries: ManifestEntry[],
  ): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO audio_build_manifest (analysis_id, phase, root, rel, raw, is_dir, size,
         mtime_ms, dev, ino, nlink) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
      this.db.transaction(() => {
        for (const e of entries.slice(i, i + INSERT_CHUNK))
          ins.run(
            analysisId,
            phase,
            root,
            e.rel,
            e.raw,
            e.isDir ? 1 : 0,
            e.size,
            e.mtimeMs,
            e.dev,
            e.ino,
            e.nlink,
          );
      })();
    }
  }

  private manifest(
    analysisId: string,
    phase: 'before' | 'after',
    root: 'torrents' | 'library',
  ): ManifestEntry[] {
    return (
      this.db
        .prepare(
          `SELECT rel, raw, is_dir, size, mtime_ms, dev, ino, nlink FROM audio_build_manifest
           WHERE analysis_id = ? AND phase = ? AND root = ?`,
        )
        .all(analysisId, phase, root) as {
        rel: string;
        raw: string | null;
        is_dir: number;
        size: number;
        mtime_ms: number;
        dev: number;
        ino: number;
        nlink: number;
      }[]
    ).map((r) => ({
      rel: r.rel,
      raw: r.raw,
      isDir: r.is_dir === 1,
      size: r.size,
      mtimeMs: r.mtime_ms,
      dev: r.dev,
      ino: r.ino,
      nlink: r.nlink,
    }));
  }

  // -------------------------------------------------------------------------------------------
  // the check

  /** "Check again" (only after a build). */
  checkAgain(): void {
    const p = this.progress();
    if (!p || (p.phase !== 'done' && p.phase !== 'check'))
      throw new Error('Nothing built to check');
    if (p.phase === 'done') this.setPhase(p, 'walk_after');
  }

  private async checkPhase(
    p: AudioStage6Progress,
    stop: () => boolean,
    hooks: {
      absSnapshot?: () => Promise<number | null>;
      readerState?: () => string | null;
      absCompare?: (before: number, after: number) => { same: boolean; detail: string };
    },
  ): Promise<boolean> {
    const items: CheckItem[] = [];
    const a = p.analysisId;
    const media = this.deps.roots.media;
    const ops = this.db
      .prepare(
        `SELECT o.id, o.kind, o.dst, o.dev, o.ino, o.src_rel, o.src_file_id, o.state, o.book_id
         FROM audio_build_ops o WHERE o.analysis_id = ?`,
      )
      .all(a) as {
      id: number;
      kind: 'folder' | 'link' | 'pdf' | 'metadata';
      dst: string;
      dev: number | null;
      ino: number | null;
      src_rel: string | null;
      src_file_id: number | null;
      state: string;
      book_id: number | null;
    }[];
    const notDone = ops.filter((o) => o.state !== 'done').length;
    items.push({
      key: 'ops',
      name: 'Every planned operation done',
      ok: notDone === 0,
      detail: `${ops.length - notDone} of ${ops.length}`,
    });

    // 1. The new trees against the plan.
    let newTree: NewTreeResult | null = null;
    const metadataWrong: string[] = [];
    if (!media) {
      items.push({
        key: 'new_tree',
        name: 'The new folders',
        ok: false,
        detail: 'CLEANUP_AUDIO_MEDIA_DIR is not set: the new folders can’t be read',
      });
    } else {
      const entries: ManifestEntry[] = [];
      for (const area of Object.values(AREA_FOLDERS)) {
        const top = path.join(media, area);
        const st = await lstatEntry(top);
        if (!st) continue;
        entries.push({
          rel: area,
          raw: null,
          isDir: st.isDir,
          size: 0,
          mtimeMs: Math.floor(st.mtimeMs),
          dev: st.dev,
          ino: st.ino,
          nlink: st.nlink,
        });
        const out = await walkTree(top, {
          shouldStop: stop,
          shouldPause: () => this.deps.lock.calibreBusy(),
        });
        if (!out) return false;
        for (const e of out.entries) entries.push({ ...e, rel: `${area}/${e.rel}` });
      }
      newTree = compareNewTree(
        entries,
        ops.map((o) => ({ kind: o.kind, dst: o.dst, dev: o.dev, ino: o.ino })),
      );
      // metadata.json: the planned bytes.
      const metaOf = this.db.prepare('SELECT metadata FROM audio_build_books WHERE id = ?');
      for (const o of ops) {
        if (o.kind !== 'metadata' || o.book_id === null) continue;
        if (stop()) return false;
        while (this.deps.lock.calibreBusy() && !stop()) await sleep(1000);
        const want = (metaOf.get(o.book_id) as { metadata: Buffer }).metadata;
        const got = await readSmall(insideRoot(media, o.dst), 4 * 1024 * 1024).catch(() => null);
        if (!got || !got.equals(want)) metadataWrong.push(o.dst);
      }
      items.push({
        key: 'new_tree',
        name: 'Every audio file and PDF is a hard link to its torrent file; folders and metadata as planned',
        ok:
          newTree.wrongCount === 0 &&
          newTree.extraCount === 0 &&
          metadataWrong.length === 0 &&
          newTree.links.ok === newTree.links.planned,
        detail:
          `links ${newTree.links.ok}/${newTree.links.planned}, PDFs ${newTree.pdfs.ok}/${newTree.pdfs.planned}, ` +
          `folders ${newTree.folders.ok}/${newTree.folders.planned}, metadata ${newTree.metadata.planned - metadataWrong.length}/${newTree.metadata.planned}` +
          (newTree.wrongCount ? `, ${newTree.wrongCount} wrong` : '') +
          (newTree.extraCount ? `, ${newTree.extraCount} not planned` : ''),
      });
    }

    // 2. The torrents and the live library: before vs after.
    const linksTo = new Map<string, number>();
    for (const o of ops)
      if ((o.kind === 'link' || o.kind === 'pdf') && o.state === 'done' && o.src_rel)
        linksTo.set(o.src_rel, (linksTo.get(o.src_rel) ?? 0) + 1);
    const torrents = compareManifests(
      this.manifest(a, 'before', 'torrents'),
      this.manifest(a, 'after', 'torrents'),
      linksTo,
    );
    const library = compareManifests(
      this.manifest(a, 'before', 'library'),
      this.manifest(a, 'after', 'library'),
      new Map(),
    );
    for (const [k, name, d] of [
      ['torrents', 'The torrents unchanged (only link counts grew by the links made)', torrents],
      ['library', 'The live library unchanged', library],
    ] as const) {
      const c = d.counts;
      items.push({
        key: k,
        name,
        ok: c.added + c.removed + c.changed + c.nlinkWrong === 0,
        detail:
          `${c.added} added, ${c.removed} removed, ${c.changed} changed, ${c.nlinkWrong} link counts off` +
          (k === 'torrents' ? `; ${d.linkedAsPlanned} files linked as planned` : ''),
      });
    }

    // 3. A re-hash sample through the new paths, against stage 1's SHA-256.
    const s = getSettings(this.db).audiobooks;
    const rehash = { checked: 0, same: 0, different: [] as string[] };
    if (media && s.buildRehashSample > 0) {
      const cands = this.db
        .prepare(
          `SELECT o.dst, f.sha256 FROM audio_build_ops o JOIN audio_files f ON f.id = o.src_file_id
           WHERE o.analysis_id = ? AND o.kind = 'link' AND o.state = 'done' AND f.sha256 IS NOT NULL
           ORDER BY o.id`,
        )
        .all(a) as { dst: string; sha256: string }[];
      const rand = mulberry32(SAMPLE_SEED + 1);
      const picked: typeof cands = [];
      const pool = [...cands];
      while (picked.length < s.buildRehashSample && pool.length)
        picked.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
      const pacer = new ReadPacer(0);
      for (const c of picked) {
        for (;;) {
          if (stop()) {
            this.deps.lock.release(OWNER);
            return false;
          }
          if (!(await this.deps.lock.acquire(OWNER, 'audio', stop))) return false;
          const h = await hashFile(
            insideRoot(media, c.dst),
            pacer,
            () => this.deps.lock.shouldYield(OWNER) || stop(),
          ).catch(() => ({ sha256: 'unreadable', bytes: 0 }));
          if (h === null) {
            this.deps.lock.release(OWNER);
            await sleep(1000);
            continue;
          }
          rehash.checked++;
          if (h.sha256 === c.sha256) rehash.same++;
          else rehash.different.push(c.dst);
          break;
        }
      }
      this.deps.lock.release(OWNER);
      items.push({
        key: 'rehash',
        name: 'Linked files read again: the same bytes as stage 1 hashed',
        ok: rehash.checked === rehash.same,
        detail: `${rehash.same} of ${rehash.checked}`,
      });
    }

    // 4. The move list covers every audio file of the live library.
    const libCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audio_files WHERE root = 'library' AND kind = 'audio' AND gone_at IS NULL`,
        )
        .get() as { n: number }
    ).n;
    const moveRows = this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS n FROM audio_build_moves WHERE analysis_id = ? GROUP BY outcome`,
      )
      .all(a) as { outcome: string; n: number }[];
    const listed = moveRows.reduce((x, r) => x + r.n, 0);
    const unaccounted = moveRows.find((r) => r.outcome === 'unaccounted')?.n ?? 0;
    const known = new Set(
      (
        this.db
          .prepare(`SELECT rel_path FROM audio_files WHERE root = 'library' AND gone_at IS NULL`)
          .all() as { rel_path: string }[]
      ).map((r) => r.rel_path),
    );
    const audioExt = /\.(m4b|m4a|mp3|mp4|aac|flac|ogg|opus|wav|wma)$/i;
    const arrived = this.manifest(a, 'after', 'library')
      .filter((e) => !e.isDir && audioExt.test(e.rel) && !known.has(e.rel))
      .map((e) => e.rel);
    items.push({
      key: 'moves',
      name: 'The move list accounts for every audio file of the live library',
      ok: listed === libCount && unaccounted === 0,
      detail:
        `${listed} of ${libCount} listed, ${unaccounted} unaccounted` +
        (arrived.length ? `; ${arrived.length} arrived after stage 1 (for WP21e-2)` : ''),
    });

    // 5. The labeled books.
    const labels = this.labelCheck();
    items.push({
      key: 'labels',
      name: 'The labeled books are where their labels say, with those values',
      ok: labels.unexplained === 0 && labels.notFound.length === 0,
      detail:
        `${labels.folderRight} of ${labels.books} folders as labeled; ${labels.valuesWrong.length} values differ, ` +
        `all explained by unconfirmed values or stage 5's gate misses`.replace(
          'all explained',
          labels.unexplained ? `${labels.unexplained} NOT explained` : 'all explained',
        ) +
        (labels.notFound.length ? `, ${labels.notFound.length} not found` : ''),
    });

    // 6. Audiobookshelf and the reader unchanged.
    p.abs.after = (await hooks.absSnapshot?.().catch(() => null)) ?? null;
    const abs = {
      before: p.abs.before,
      after: p.abs.after,
      same: null as boolean | null,
      detail: '',
    };
    if (p.abs.before !== null && p.abs.after !== null && hooks.absCompare) {
      const c = hooks.absCompare(p.abs.before, p.abs.after);
      abs.same = c.same;
      abs.detail = c.detail;
    } else abs.detail = 'Not compared (no Audiobookshelf address or key, or a snapshot failed)';
    items.push({ key: 'abs', name: 'Audiobookshelf unchanged', ok: abs.same, detail: abs.detail });
    p.reader.after = hooks.readerState?.() ?? null;
    const reader = {
      before: p.reader.before,
      after: p.reader.after,
      same: p.reader.before && p.reader.after ? p.reader.before === p.reader.after : null,
    };
    items.push({
      key: 'reader',
      name: 'The reader’s audio links and audiobook folders unchanged',
      ok: reader.same,
      detail: reader.same === null ? 'Not compared' : reader.same ? 'same' : 'changed',
    });

    p.check = {
      passed: items.every(
        (i) => i.ok === true || (i.ok === null && (i.key === 'abs' || i.key === 'reader')),
      ),
      at: Date.now(),
      items,
      newTree,
      metadataWrong: metadataWrong.slice(0, 200),
      torrents,
      library,
      rehash,
      moves: { library: libCount, listed, unaccounted, arrivedAfterStage1: arrived.slice(0, 200) },
      labels,
      abs,
      reader,
    };
    this.save(p);
    return true;
  }

  /**
   * The labeled books: the folder their label's values give, and the values in their
   * metadata.json. A difference is explained when the value is one stage 5 left unconfirmed (its
   * best guess) or one of stage 5's gate misses; the check fails on anything else (a folder
   * that differs although every value agrees, or an automatic value the gate didn't count).
   */
  labelCheck(): Stage6Check['labels'] {
    const out: Stage6Check['labels'] = {
      books: 0,
      notFound: [],
      folderRight: 0,
      folderWrong: [],
      valuesWrong: [],
      valuesChecked: 0,
      unexplained: 0,
    };
    const p = this.progress();
    const p5 = this.deps.stage5.progress();
    const l = this.deps.stage5.labels();
    if (!p || !p5 || !l.books) return out;
    const unitOf = this.deps.stage5.unitFinder(p5);
    const gateMisses = new Set((p5.gate?.misses ?? []).map((m) => `${m.id}|${m.field}`));
    const bookOf = this.db.prepare(
      `SELECT * FROM audio_build_books WHERE analysis_id = ? AND unit_key = ? ORDER BY id LIMIT 1`,
    );
    const stored = this.db.prepare(
      `SELECT field, source, flagged FROM ai_values WHERE stage = 'audio5' AND item_key = ?`,
    );
    const AUTOMATIC = new Set(['rules', 'both_models', 'upgrade_models', 'user']);
    const folderKey = (f: string) =>
      f
        .split('/')
        .map((s) => titleKey(s))
        .join('/');
    for (const label of l.books as MetaLabel[]) {
      out.books++;
      const u = unitOf(label.torrent);
      const b = u ? (bookOf.get(p.analysisId, u.unitKey) as BookRow | undefined) : undefined;
      if (!b || !u) {
        out.notFound.push(label.id);
        continue;
      }
      const source = new Map(
        (stored.all(u.unitKey) as { field: string; source: string; flagged: number }[]).map((r) => [
          r.field,
          AUTOMATIC.has(r.source) && r.flagged === 0 ? 'automatic' : 'unconfirmed',
        ]),
      );
      const meta = JSON.parse(b.metadata.toString('utf8')) as Record<string, unknown>;
      const tags = (meta.tags as string[]) ?? [];
      const values: Record<string, unknown> = {
        title: meta.title,
        authors: meta.authors,
        narrators: meta.narrators,
        series: ((meta.series as string[]) ?? []).map((s) => {
          const m = /^(.*) #(\S+)$/.exec(s);
          return m
            ? { name: m[1], position: Number(m[2]), label: null }
            : { name: s, position: null, label: null };
        }),
        drama: tags.includes('ドラマCD'),
        multi_narr: tags.includes('複数ナレーター'),
      };
      const differs = new Map<string, string>();
      for (const f of GATE_FIELDS) {
        const ok = labelAgrees(f, label, values[f]);
        if (ok === undefined) continue;
        out.valuesChecked++;
        if (ok) continue;
        const cls = source.get(f) ?? 'unconfirmed';
        const why =
          cls === 'unconfirmed'
            ? 'unconfirmed (stage 5’s best guess)'
            : gateMisses.has(`${label.id}|${f}`)
              ? 'a stage-5 gate miss'
              : 'unexplained';
        if (why === 'unexplained') out.unexplained++;
        differs.set(f, why);
        out.valuesWrong.push({
          id: label.id,
          field: f,
          expected: (label as unknown as Record<string, unknown>)[f],
          got: values[f],
          why,
        });
      }
      if (!label.title) continue;
      // A field the label leaves open (null) takes the book's own value.
      const series: SeriesEntry[] | null = Array.isArray(label.series)
        ? label.series.map(([name, pos, lab]) => ({
            name,
            position: pos === null || pos === undefined || pos === '' ? null : Number(pos),
            label: lab,
          }))
        : (values.series as SeriesEntry[]);
      const authors = Array.isArray(label.authors) ? label.authors : (values.authors as string[]);
      const expected = layoutFolder(b.area, layoutOf({ title: label.title, authors, series }));
      if (folderKey(expected) === folderKey(b.base_folder)) {
        out.folderRight++;
        continue;
      }
      const reasons = ['title', 'authors', 'series']
        .map((f) => differs.get(f))
        .filter((x): x is string => !!x);
      const why = reasons.length ? [...new Set(reasons)].join(', ') : 'unexplained';
      if (why === 'unexplained') out.unexplained++;
      out.folderWrong.push({ id: label.id, expected, got: b.base_folder, why });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // the page

  /** Why On can't be switched on now (empty: it can). */
  onRefusals(): string[] {
    const r: string[] = [];
    const p = this.progress();
    const st = getAudioStage(this.db, STAGE6);
    if (!p || !p.inputKey) r.push('Run the Preview first (the plan)');
    else if (STAGE6_PHASES.indexOf(p.phase) < STAGE6_PHASES.indexOf('planned'))
      r.push('Wait for the Preview to finish (plan and the sidecar’s check of the sources)');
    const { ids, problem } = stageIds(this.db);
    if (!ids) r.push(problem ?? 'Stages 1-5 are not done');
    else if (p?.inputKey && p.inputKey !== this.inputKey(ids))
      r.push('Stages 1-5 changed since the plan: wait for the new plan');
    const g = gatesPassed(this.db);
    if (!g.passed) r.push(`The gate of stage ${g.failed.join(', ')} has not passed`);
    if (!this.sidecar().online) r.push('The linking sidecar is offline');
    if (p && p.preflight.problems > 0)
      r.push(`The sidecar found ${p.preflight.problems} sources it can’t link (see Details)`);
    if (!this.deps.roots.media)
      r.push('CLEANUP_AUDIO_MEDIA_DIR is not set (the check reads the new folders through it)');
    if (st.pauseReason) r.push(`The stage is paused: ${st.pauseDetail ?? st.pauseReason}`);
    return r;
  }

  /** Whether the new folders are already there before this build started (On refuses then). */
  async foreignFolders(): Promise<string[]> {
    const media = this.deps.roots.media;
    if (!media || this.buildStarted()) return [];
    const out: string[] = [];
    for (const area of Object.values(AREA_FOLDERS))
      if (await lstatEntry(path.join(media, area))) out.push(area);
    return out;
  }

  /** Seconds left in the current phase (estimate), or null. */
  secondsLeft(p: AudioStage6Progress, now = Date.now()): number | null {
    const rate = (done: number, total: number) => {
      const n = done - p.phaseStartDone;
      const ms = now - p.phaseStartedAt;
      if (n <= 0 || ms <= 0) return null;
      return Math.max(0, ((total - done) * ms) / n / 1000);
    };
    switch (p.phase) {
      case 'preflight':
        return rate(p.preflight.done, p.preflight.total);
      case 'build':
        return rate(p.build.done, p.build.total);
      case 'walk_before':
      case 'walk_after':
        return p.walk.current ? rate(p.walk.current.done, p.walk.current.expected) : null;
      case 'done':
      case 'planned':
        return 0;
      default:
        return null;
    }
  }

  status() {
    const p = this.progress();
    return {
      progress: p
        ? {
            ...p,
            check: p.check
              ? {
                  passed: p.check.passed,
                  at: p.check.at,
                  items: p.check.items,
                  labels: {
                    ...p.check.labels,
                    folderWrong: p.check.labels.folderWrong.slice(0, 20),
                    valuesWrong: p.check.labels.valuesWrong.slice(0, 20),
                  },
                }
              : null,
          }
        : null,
      secondsLeft: p ? this.secondsLeft(p) : null,
      sidecar: this.sidecar(),
      handing: this.handing,
      onRefusals: this.onRefusals(),
    };
  }

  /** Lists for the page (paged). */
  list(
    list: string,
    { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const p = this.progress();
    if (!p) return { total: 0, items: [] };
    const a = p.analysisId;
    const page = (where: string, args: unknown[], order = 'id') => {
      const total = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM audio_build_books WHERE analysis_id = ? ${where}`)
          .get(a, ...args) as {
          n: number;
        }
      ).n;
      const rows = this.db
        .prepare(
          `SELECT * FROM audio_build_books WHERE analysis_id = ? ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(a, ...args, limit, offset) as BookRow[];
      return { total, items: rows.map((b) => this.bookView(b)) };
    };
    if (list === 'sample') return page('AND sample = 1', []);
    if (list === 'books') return page('', []);
    if (list === 'pending') return page(`AND state = 'pending'`, []);
    if (list === 'collisions')
      return page(`AND (notes_json LIKE '%narrator%' OR notes_json LIKE '%number%')`, []);
    if (list.startsWith('moves')) {
      const outcome = list.split(':')[1] ?? null;
      const where = outcome ? 'AND outcome = ?' : '';
      const args = outcome ? [outcome] : [];
      const total = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM audio_build_moves WHERE analysis_id = ? ${where}`)
          .get(a, ...args) as { n: number }
      ).n;
      const items = this.db
        .prepare(
          `SELECT file_id AS fileId, old_path AS oldPath, outcome, new_path AS newPath,
             kept_path AS keptPath, detail FROM audio_build_moves INDEXED BY audio_build_moves_outcome
           WHERE analysis_id = ? ${where} ORDER BY outcome, file_id LIMIT ? OFFSET ?`,
        )
        .all(a, ...args, limit, offset) as Record<string, unknown>[];
      return { total, items };
    }
    if (list === 'failed') {
      const items = this.db
        .prepare(
          `SELECT id, kind, dst, result_json FROM audio_build_ops INDEXED BY audio_build_ops_state
           WHERE analysis_id = ? AND state = 'failed' ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(a, limit, offset) as Record<string, unknown>[];
      return { total: p.build.failed, items };
    }
    if (list === 'preflight') {
      const items = this.db
        .prepare(
          `SELECT id, kind, dst, src_rel AS src, preflight FROM audio_build_ops INDEXED BY audio_build_ops_preflight
           WHERE analysis_id = ? AND preflight IS NOT NULL AND preflight <> 'ok' ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(a, limit, offset) as Record<string, unknown>[];
      return { total: p.preflight.problems, items };
    }
    if (list === 'unplaced_pdfs') {
      const placed = new Set(
        (
          this.db
            .prepare(
              `SELECT DISTINCT src_file_id FROM audio_build_ops WHERE analysis_id = ? AND kind = 'pdf'`,
            )
            .all(a) as { src_file_id: number }[]
        ).map((r) => r.src_file_id),
      );
      const all = (
        this.db
          .prepare(
            `SELECT id, rel_path FROM audio_files WHERE root = 'torrents' AND ext = '.pdf' AND gone_at IS NULL ORDER BY rel_path`,
          )
          .all() as { id: number; rel_path: string }[]
      ).filter((r) => !placed.has(r.id));
      return {
        total: all.length,
        items: all.slice(offset, offset + limit).map((r) => ({ path: `torrents/${r.rel_path}` })),
      };
    }
    return { total: 0, items: [] };
  }

  private bookView(b: BookRow): Record<string, unknown> {
    const files = this.db
      .prepare(
        `SELECT kind, dst, src_rel FROM audio_build_ops INDEXED BY audio_build_ops_book
         WHERE book_id = ? AND kind IN ('link', 'pdf') ORDER BY id`,
      )
      .all(b.id) as { kind: string; dst: string; src_rel: string }[];
    return {
      id: b.id,
      area: b.area,
      state: b.state,
      folder: b.folder,
      baseFolder: b.base_folder,
      author: b.author,
      series: b.series,
      title: b.title,
      notes: JSON.parse(b.notes_json) as string[],
      files: files
        .slice(0, 50)
        .map((f) => ({ kind: f.kind, from: `torrents/${f.src_rel}`, to: f.dst })),
      fileCount: b.files,
      pdfs: b.pdfs,
      cover: b.cover === 1,
      metadata: JSON.parse(b.metadata.toString('utf8')) as unknown,
    };
  }

  /** The move list as CSV (WP21e-2's input), UTF-8 with a BOM. */
  movesCsv(): string {
    const p = this.progress();
    if (!p) return '';
    const q = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = this.db
      .prepare(
        `SELECT old_path, outcome, new_path, kept_path, detail FROM audio_build_moves
         WHERE analysis_id = ? ORDER BY old_path`,
      )
      .all(p.analysisId) as Record<string, unknown>[];
    const lines = ['old_path,outcome,new_path,kept_path,detail'];
    for (const r of rows)
      lines.push([r.old_path, r.outcome, r.new_path, r.kept_path, r.detail].map(q).join(','));
    return '' + String.fromCharCode(0xfeff) + '' + lines.join('\r\n') + '\r\n';
  }

  /** The plan as CSV: one line per link (book folder, file, torrent source). */
  planCsv(): string {
    const p = this.progress();
    if (!p) return '';
    const q = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = this.db
      .prepare(
        `SELECT o.kind, o.dst, o.src_rel, o.state FROM audio_build_ops o
         WHERE o.analysis_id = ? ORDER BY o.id`,
      )
      .all(p.analysisId) as { kind: string; dst: string; src_rel: string | null; state: string }[];
    const lines = ['kind,new_path,torrent_source,state'];
    for (const r of rows)
      lines.push(
        [r.kind, r.dst, r.src_rel ? `torrents/${r.src_rel}` : '', r.state].map(q).join(','),
      );
    return '' + String.fromCharCode(0xfeff) + '' + lines.join('\r\n') + '\r\n';
  }
}

interface OpRow {
  id: number;
  analysis_id: string;
  book_id: number | null;
  kind: 'folder' | 'link' | 'pdf' | 'metadata';
  dst: string;
  src_file_id: number | null;
  src_rel: string | null;
  src_raw: string | null;
  size: number | null;
  mtime_ms: number | null;
  dev: number | null;
  ino: number | null;
  state: string;
}

interface BookRow {
  id: number;
  analysis_id: string;
  unit_key: string;
  copy_key: string;
  area: BuildArea;
  state: 'build' | 'pending';
  folder: string;
  base_folder: string;
  author: string;
  series: string | null;
  title: string;
  notes_json: string;
  files: number;
  pdfs: number;
  cover: number;
  metadata: Buffer;
  sample: number;
}

/** A short hash of rows (the reader's state before and after). */
export function rowsHash(rows: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}
