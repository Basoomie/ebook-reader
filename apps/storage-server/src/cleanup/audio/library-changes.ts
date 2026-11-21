/**
 * WP21f-2: changes to books already in the library, as part of stage 7's daily run, after the
 * new arrivals (decided with the user 2026-11-21; B0's proofs on a scratch ABS 2.37.1 on the
 * NAS). Its own mode (`audiobooks.libraryChanges`, default Preview), so a stage 7 that is On adds
 * new books while these stay a Preview until approved. Steps, each resumable with its progress:
 *
 *   sync       the ledger (audio_library_books): every book stage 6 or 7 built, once
 *   plan       each book's current plan (stage 6's plan code) against what was built and last
 *              written: field changes, a move, numbered link names (library-plan.ts); for the
 *              books that differ, their metadata.json now (your ABS edits), their inodes and
 *              what ABS has (GET only: item, every user's progress and bookmarks); the reader's
 *              links they change; the files the reader wrote that get their original name.
 *              Preview ends here.
 *   preflight  (On) the sidecar checks every operation may be made (write access, hard links)
 *   hold       the reader's hold (the switch's: scans, merges, PC jobs, link edits, writes wait)
 *              while folders or links move; refused while the reader is busy
 *   snapshot   a verified copy of ttsu.db when a reader link changes
 *   apply      the sidecar 1.3.0 under the shared disk lock (Calibre first, 2 s turns, leases):
 *              link renames, metadata.json replacements (only over the file read), moves (no
 *              target ever exists), emptied folders removed, reader files linked
 *   remap      the reader's links in one transaction (guarded by the old values; confirmed_at
 *              kept; never saveLink)
 *   rescan     the reader's own scan while held; verify; release
 *   abs_scan   one library scan in ABS (abs-library-scan.ts), then every changed book checked
 *              there: the same item at its new folder, our values, progress and bookmarks as
 *              before
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings } from '../settings';
import { getLink, resolveLink } from '../../audio/audio-links';
import { AbsClient } from './abs-client';
import { AbsLibraryScan } from './abs-library-scan';
import { AbsClearFields, CLEARABLE, type Clearable } from './abs-clear-fields';
import { ARRIVAL_AREA_FOLDERS, type ExistingTree } from './arrivals-plan';
import { insideRoot, lstatEntry, readSmall } from './audio-source-fs';
import type { PlannedBook } from './build-plan';
import { keptAsBuilt } from './library-keep';
import {
  leftBehind,
  libraryFolder,
  orderMoves,
  planLibraryChanges,
  type AbsBookState,
  type LedgerBook,
  type PlannedChange,
} from './library-plan';
import type { SwitchReader } from './stage6-switch';

export const LIBRARY_BATCH_BASE = 3_000_000_000;
export const LIBRARY_SIDECAR_VERSION = '1.3.0';
const OWNER = DISK_OWNERS.audio7;
const HOLD_MS = 2000;
const SLICE = 200;
/** metadata.json and covers in a book folder: ours or Audiobookshelf's, never the reader's. */
const ABS_OR_OURS = /^(metadata\.json|cover\.(jpe?g|png|webp))$/i;
const READER_ROOTS: Record<string, string> = {
  'japanese-generated': 'AI',
  'japanese-merged': '_merged',
};

export type ChangesPhase =
  | 'sync'
  | 'plan'
  | 'read'
  | 'preflight'
  | 'hold'
  | 'snapshot'
  | 'apply'
  | 'remap'
  | 'rescan'
  | 'release'
  | 'abs_scan'
  | 'abs_verify'
  | 'done';

export interface ChangesProgress {
  mode: 'analyse' | 'on';
  phase: ChangesPhase;
  startedAt: number;
  phaseStartedAt: number;
  /** Work per phase (waiting for Calibre or ABS left out). */
  phaseTimes: Record<string, { ms: number; items: number }>;
  waitMs: number;
  waitSince: number | null;
  waiting: string | null;
  /** The phase's bar. */
  done: number;
  total: number;
  ledger: number;
  /** Books whose plan differs from what was built (read before deciding). */
  candidates: number;
  counts: {
    changes: number;
    metadata: number;
    moves: number;
    renames: number;
    renamesHeld: number;
    rmdirs: number;
    readerFiles: number;
    readerWaiting: number;
    links: number;
    reviews: number;
    kept: number;
    userFields: number;
  };
  apply: {
    total: number;
    done: number;
    failed: number;
    batches: number;
    lockWaitMs: number;
    yields: number;
  };
  preflightProblems: string[];
  snapshot: string | null;
  remap: { changed: number; resolveBefore: number; resolveAfter: number } | null;
  abs: {
    library: string | null;
    before: number | null;
    after: number | null;
    scannedAt: number | null;
    verified: number;
    notYet: number;
    /** Books whose emptied fields were cleared through ABS's edit call (missing before B1's fix). */
    cleared?: number;
    problems: string[];
    error: string | null;
  };
  error: string | null;
}

export interface ChangesDeps {
  db: Database.Database;
  /** The read-only view of media/audiobooks (CLEANUP_AUDIO_MEDIA_DIR), or null. */
  media: string | null;
  lock: DiskLock;
  abs: () => { baseUrl: string; apiKey: string; timeoutMs: number } | null;
  fetchImpl?: typeof fetch;
  reader: () => SwitchReader | null;
  /** The library's folders now (stage 7's). */
  tree: () => Promise<ExistingTree>;
  /** Every unit's current plan (stage 6's plan code on the current analysis). */
  plan: () => Promise<PlannedBook[]>;
  sidecarVersion: () => { version: string | null; lastSeen: number | null };
  now?: () => number;
  log?: (m: string) => void;
}

export interface LibraryBatchOp {
  id: number;
  kind: 'replace_metadata' | 'move_book' | 'rmdir' | 'reader_link' | 'rename_file';
  book: string | null;
  dst: string;
  src: { rel: string; raw: string | null } | null;
  size: number | null;
  mtimeMs: number | null;
  dev: number | null;
  ino: number | null;
  bytes: string | null;
  sha256: string | null;
}

export interface LibraryBatch {
  id: number;
  kind: 'library_preflight' | 'library';
  leaseSeconds: number;
  ops: LibraryBatchOp[];
}

export interface LibraryOpResult {
  id: number;
  ok: boolean;
  problem?: string | null;
  error?: string | null;
  existed?: boolean;
  removed?: boolean;
  dev?: number;
  ino?: number;
}

function versionAtLeast(v: string | null, want: string): boolean {
  if (!v) return false;
  const a = v.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

const emptyCounts = (): ChangesProgress['counts'] => ({
  changes: 0,
  metadata: 0,
  moves: 0,
  renames: 0,
  renamesHeld: 0,
  rmdirs: 0,
  readerFiles: 0,
  readerWaiting: 0,
  links: 0,
  reviews: 0,
  kept: 0,
  userFields: 0,
});

export class LibraryChanges {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private handing = false;
  /** The plan phase's in-memory work between slices (rebuilt after a restart). */
  private work: {
    runId: number;
    candidates: LedgerBook[];
    plans: Map<number, PlannedBook>;
    tree: ExistingTree;
  } | null = null;

  constructor(private readonly deps: ChangesDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => undefined);
  }

  start(mode: 'analyse' | 'on'): ChangesProgress {
    const now = this.now();
    return {
      mode,
      phase: 'sync',
      startedAt: now,
      phaseStartedAt: now,
      phaseTimes: {},
      waitMs: 0,
      waitSince: null,
      waiting: null,
      done: 0,
      total: 0,
      ledger: 0,
      candidates: 0,
      counts: emptyCounts(),
      apply: { total: 0, done: 0, failed: 0, batches: 0, lockWaitMs: 0, yields: 0 },
      preflightProblems: [],
      snapshot: null,
      remap: null,
      abs: {
        library: null,
        before: null,
        after: null,
        scannedAt: null,
        verified: 0,
        notYet: 0,
        problems: [],
        error: null,
      },
      error: null,
    };
  }

  private setPhase(c: ChangesProgress, phase: ChangesPhase, items = 0): void {
    this.waitFor(c, null);
    const now = this.now();
    const t = (c.phaseTimes[c.phase] ??= { ms: 0, items: 0 });
    t.ms += Math.max(0, now - c.phaseStartedAt - c.waitMs);
    t.items += items;
    c.waitMs = 0;
    c.phase = phase;
    c.phaseStartedAt = now;
    c.done = 0;
    c.total = 0;
    c.waiting = null;
    this.log(`Audiobooks stage 7: library changes: ${phase}`);
  }

  /** Opens (a reason) or closes (null) a wait that is not work. */
  private waitFor(c: ChangesProgress, reason: string | null): void {
    const now = this.now();
    if (reason) {
      c.waitSince ??= now;
      c.waiting = reason;
    } else if (c.waitSince !== null) {
      c.waitMs += now - c.waitSince;
      c.waitSince = null;
      c.waiting = null;
    }
  }

  // ---- the ledger ------------------------------------------------------------------------------

  /** Every book stage 6 or 7 built gets its ledger row once (its folder, links, metadata). */
  syncLedger(): number {
    const db = this.db;
    const now = this.now();
    const put = db.prepare(
      `INSERT OR IGNORE INTO audio_library_books (folder, base_folder, area, origin_ref, unit_key, files_json, metadata, decided, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const p6 = db.prepare('SELECT progress_json FROM audio_stages WHERE stage = 6').get() as
      | { progress_json: string }
      | undefined;
    const analysis = p6
      ? ((JSON.parse(p6.progress_json) as { analysisId?: string }).analysisId ?? null)
      : null;
    let n = 0;
    db.transaction(() => {
      if (analysis) {
        const ops = db.prepare(
          `SELECT dst, src_file_id FROM audio_build_ops WHERE analysis_id = ? AND book_id = ? AND kind = 'link' ORDER BY id`,
        );
        for (const b of db
          .prepare(
            `SELECT id, folder, base_folder, area, unit_key, metadata FROM audio_build_books WHERE analysis_id = ? AND state IN ('build', 'pending')`,
          )
          .all(analysis) as {
          id: number;
          folder: string;
          base_folder: string;
          area: 'main' | 'ai';
          unit_key: string;
          metadata: Buffer;
        }[]) {
          const folder = libraryFolder(b.folder);
          const files = (
            ops.all(analysis, b.id) as { dst: string; src_file_id: number | null }[]
          ).map((o) => ({
            fileId: o.src_file_id,
            name: libraryFolder(o.dst).slice(folder.length + 1),
          }));
          n += put.run(
            folder,
            libraryFolder(b.base_folder),
            b.area,
            `b:${b.id}`,
            b.unit_key,
            JSON.stringify(files),
            b.metadata,
            b.metadata,
            now,
          ).changes;
        }
      }
      const aops = db.prepare(
        `SELECT dst, src_file_id FROM audio_arrival_ops WHERE run_id = ? AND book_folder = ? AND kind = 'link' ORDER BY id`,
      );
      for (const b of db
        .prepare(
          `SELECT id, run_id, folder, base_folder, area, unit_key, metadata FROM audio_arrival_books WHERE state = 'built'`,
        )
        .all() as {
        id: number;
        run_id: number;
        folder: string;
        base_folder: string;
        area: 'main' | 'ai';
        unit_key: string;
        metadata: Buffer;
      }[]) {
        const files = (
          aops.all(b.run_id, b.folder) as { dst: string; src_file_id: number | null }[]
        ).map((o) => ({
          fileId: o.src_file_id,
          name: o.dst.slice(b.folder.length + 1),
        }));
        n += put.run(
          b.folder,
          b.base_folder,
          b.area,
          `a:${b.id}`,
          b.unit_key,
          JSON.stringify(files),
          b.metadata,
          b.metadata,
          now,
        ).changes;
      }
    })();
    return n;
  }

  private ledger(): (LedgerBook & { unitKey: string | null })[] {
    return (
      this.db
        .prepare(
          `SELECT id, folder, base_folder, area, unit_key, files_json, metadata, decided, folder_ino FROM audio_library_books ORDER BY id`,
        )
        .all() as {
        id: number;
        folder: string;
        base_folder: string;
        area: 'main' | 'ai';
        unit_key: string | null;
        files_json: string;
        metadata: Buffer;
        decided: Buffer;
        folder_ino: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      folder: r.folder,
      baseFolder: r.base_folder,
      area: r.area,
      unitKey: r.unit_key,
      files: (JSON.parse(r.files_json) as { fileId: number; name: string; ino?: number }[]).map(
        (f) => ({
          fileId: f.fileId,
          name: f.name,
          ino: f.ino ?? 0,
        }),
      ),
      metadata: r.metadata,
      decided: r.decided,
      folderIno: r.folder_ino,
    }));
  }

  // ---- steps -------------------------------------------------------------------------------------

  async step(
    runId: number,
    c: ChangesProgress,
    stop: () => boolean,
  ): Promise<'more' | 'wait' | 'done' | { pause: string }> {
    try {
      switch (c.phase) {
        case 'sync':
          c.ledger = this.syncLedger() + 0;
          c.ledger = (
            this.db.prepare('SELECT COUNT(*) AS n FROM audio_library_books').get() as { n: number }
          ).n;
          this.setPhase(c, 'plan', c.ledger);
          return 'more';
        case 'plan':
          return await this.planStep(runId, c);
        case 'read':
          return await this.readStep(runId, c);
        case 'preflight':
          return this.preflightStep(runId, c);
        case 'hold':
          return await this.holdStep(runId, c);
        case 'snapshot':
          return await this.snapshotStep(runId, c);
        case 'apply':
          return await this.applyStep(runId, c, stop);
        case 'remap':
          return this.remapStep(runId, c);
        case 'rescan':
          return await this.rescanStep(runId, c);
        case 'release':
          return this.releaseStep(runId, c);
        case 'abs_scan':
          return await this.absScanStep(runId, c);
        case 'abs_verify':
          return await this.absVerifyStep(runId, c);
        case 'done':
          return 'done';
      }
    } catch (err) {
      c.error = (err as Error).message;
      return { pause: `Library changes: ${c.error}` };
    }
  }

  /** The pure comparison of every ledger book with its current plan; the ones that differ. */
  private async planStep(runId: number, c: ChangesProgress): Promise<'more'> {
    const plans = await this.deps.plan();
    const byIno = new Map<number, PlannedBook>();
    const inoOf = this.db.prepare('SELECT ino FROM audio_files WHERE id = ?');
    for (const b of plans)
      for (const f of b.files) {
        const r = inoOf.get(f.fileId) as { ino: number } | undefined;
        if (r) byIno.set(r.ino, b);
      }
    const ledger = this.ledger();
    const libIno = this.db.prepare(
      `SELECT ino FROM audio_files WHERE root = 'library' AND rel_path = ? AND gone_at IS NULL`,
    );
    const candidates: LedgerBook[] = [];
    const planOf = new Map<number, PlannedBook>();
    for (const b of ledger) {
      // The recording now: the plan whose files are this book's links (by inode, so a recording
      // whose units were rekeyed is followed). The links' inodes come from stage 1's walk of the
      // library (`library` rows: japanese/…), else the torrent file the ledger names.
      let cur: PlannedBook | undefined;
      for (const f of b.files) {
        const rel = b.folder.startsWith('japanese/')
          ? `${b.folder.slice('japanese/'.length)}/${f.name}`
          : null;
        const ino =
          (rel ? (libIno.get(rel) as { ino: number } | undefined)?.ino : undefined) ??
          (inoOf.get(f.fileId) as { ino: number } | undefined)?.ino;
        if (ino !== undefined) {
          f.ino = ino;
          cur ??= byIno.get(ino);
        }
      }
      if (!cur) continue;
      planOf.set(b.id, cur);
      const prefix = cur.folder + '/';
      const differs =
        !cur.metadata.equals(b.decided) ||
        libraryFolder(cur.baseFolder) !== b.baseFolder ||
        cur.files.some((f) => !b.files.some((x) => x.name === f.dst.slice(prefix.length)));
      if (differs) candidates.push(b);
    }
    this.work = { runId, candidates, plans: planOf, tree: await this.deps.tree() };
    c.candidates = candidates.length;
    this.setPhase(c, 'read', ledger.length);
    c.total = candidates.length;
    return 'more';
  }

  /** The books that differ: metadata.json and inodes now, ABS's state; then the plan. */
  private async readStep(runId: number, c: ChangesProgress): Promise<'more' | 'wait'> {
    if (!this.work || this.work.runId !== runId) {
      // After a restart: plan again (nothing was written yet).
      this.setPhase(c, 'plan');
      return 'more';
    }
    const media = this.deps.media;
    if (!media) throw new Error('The library view (CLEANUP_AUDIO_MEDIA_DIR) is not mounted');
    if (this.deps.lock.calibreBusy()) {
      this.waitFor(c, 'Waiting while the Calibre cleanup uses the disk');
      return 'wait';
    }
    this.waitFor(c, null);
    const w = this.work as typeof this.work & {
      disk?: Map<number, Buffer | null>;
      inos?: Map<number, number | null>;
      abs?: Map<number, AbsBookState | null>;
    };
    w.disk ??= new Map();
    w.inos ??= new Map();
    // Each book's metadata.json, folder inode and links' inodes (read only, a slice per step).
    const slice = w.candidates.slice(c.done, c.done + SLICE);
    for (const b of slice) {
      w.disk.set(
        b.id,
        await readSmall(insideRoot(media, `${b.folder}/metadata.json`), 1024 * 1024),
      );
      const st = await lstatEntry(insideRoot(media, b.folder));
      w.inos.set(b.id, st && st.isDir ? st.ino : null);
      for (const f of b.files) {
        const fst = await lstatEntry(insideRoot(media, `${b.folder}/${f.name}`));
        if (fst?.isFile) f.ino = fst.ino;
      }
      b.folderIno = w.inos.get(b.id) ?? null;
    }
    c.done += slice.length;
    if (c.done < w.candidates.length) return 'more';
    // What ABS has for them (GET only), for the books whose links would be renamed.
    w.abs = await this.absStates(w.candidates, c);
    const choices = this.db.prepare(
      'SELECT field, choice FROM audio_library_choices WHERE book_id = ?',
    );
    const rels = this.db.prepare('SELECT rel_path FROM audio_files WHERE id = ?');
    const tagsOf = this.db.prepare('SELECT tags_json FROM audio_file_health WHERE file_id = ?');
    const changes = planLibraryChanges({
      fileTags: (b) => {
        const r = b.files[0]
          ? (tagsOf.get(b.files[0].fileId) as { tags_json: string | null } | undefined)
          : undefined;
        try {
          return r?.tags_json ? (JSON.parse(r.tags_json) as Record<string, string>) : null;
        } catch {
          return null;
        }
      },
      books: w.candidates,
      current: (b) => w.plans.get(b.id) ?? null,
      disk: (b) => w.disk!.get(b.id) ?? null,
      abs: (b) => w.abs!.get(b.id) ?? null,
      keep: (b) =>
        keptAsBuilt(
          b.files
            .map((f) => (rels.get(f.fileId) as { rel_path: string } | undefined)?.rel_path)
            .filter((x): x is string => !!x),
        ),
      tree: w.tree,
      choices: (b) =>
        Object.fromEntries(
          (choices.all(b.id) as { field: string; choice: string }[]).map((r) => [
            r.field,
            r.choice,
          ]),
        ),
    });
    await this.record(runId, c, changes, w.candidates, w.abs);
    // Every user's progress and bookmarks before anything changes (GET only), compared after
    // ABS's scan: nothing may be lost (B0 proved a library scan keeps them).
    c.abs.problems = [];
    const before = await this.absProgress().catch(() => null);
    if (before)
      this.db
        .prepare(`UPDATE audio_library_changes SET abs_before_json = ? WHERE run_id = ?`)
        .run(JSON.stringify(before), runId);
    this.work = null;
    if (c.mode === 'analyse' || getSettings(this.db).audiobooks.libraryChanges !== 'on') {
      this.setPhase(c, 'done', changes.length);
      return 'more';
    }
    const ops = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audio_library_ops WHERE run_id = ?`)
        .get(runId) as { n: number }
    ).n;
    this.setPhase(c, ops ? 'preflight' : 'done', changes.length);
    return 'more';
  }

  /** ABS's item, progress and bookmarks of the candidate books (GET only). Null per book: not asked. */
  private async absStates(
    books: LedgerBook[],
    c: ChangesProgress,
  ): Promise<Map<number, AbsBookState | null>> {
    const out = new Map<number, AbsBookState | null>();
    const client = this.absClient();
    if (!client || books.length === 0) return out;
    try {
      const lib = await this.absLibrary(client);
      if (!lib) throw new Error('Audiobookshelf has no library on …/japanese');
      c.abs.library = lib.name;
      const items = await this.absItems(client, lib.id);
      c.abs.before = items.size;
      const users =
        (await client.get<{ users?: { id: string; username?: string }[] }>('/users'))?.users ?? [];
      const progress = new Map<
        string,
        { user: string; currentTime: number; isFinished: boolean }[]
      >();
      const marks = new Map<string, { user: string; time: number }[]>();
      for (const u of users) {
        const full = await client.get<{
          username?: string;
          mediaProgress?: {
            libraryItemId?: string;
            currentTime?: number;
            isFinished?: boolean;
            episodeId?: string | null;
          }[];
          bookmarks?: { libraryItemId?: string; time?: number }[];
        }>(`/users/${encodeURIComponent(u.id)}`);
        const name = full?.username ?? u.username ?? u.id;
        for (const m of full?.mediaProgress ?? []) {
          if (!m.libraryItemId) continue;
          const l = progress.get(m.libraryItemId) ?? [];
          l.push({
            user: name,
            currentTime: m.currentTime ?? 0,
            isFinished: m.isFinished === true,
          });
          progress.set(m.libraryItemId, l);
        }
        for (const m of full?.bookmarks ?? []) {
          if (!m.libraryItemId) continue;
          const l = marks.get(m.libraryItemId) ?? [];
          l.push({ user: name, time: m.time ?? 0 });
          marks.set(m.libraryItemId, l);
        }
      }
      for (const b of books) {
        if (b.area !== 'main') continue;
        const id = items.get(b.folder.slice('japanese/'.length)) ?? null;
        const pr = id ? (progress.get(id) ?? []) : [];
        const bm = id ? (marks.get(id) ?? []) : [];
        out.set(b.id, {
          found: id !== null,
          itemId: id,
          inProgress: pr.some((x) => !x.isFinished && x.currentTime > 0),
          finished: pr.some((x) => x.isFinished),
          bookmarks: bm.length,
          places: pr
            .filter((x) => !x.isFinished)
            .map((x) => ({ user: x.user, seconds: x.currentTime, file: null })),
        });
      }
    } catch (err) {
      c.abs.error = (err as Error).message;
      for (const b of books) out.set(b.id, null);
    }
    return out;
  }

  /** Every user's progress (currentTime, finished) and bookmarks per ABS item (GET only). */
  private async absProgress(): Promise<Record<
    string,
    { progress: string[]; bookmarks: string[] }
  > | null> {
    const client = this.absClient();
    if (!client) return null;
    const users =
      (await client.get<{ users?: { id: string; username?: string }[] }>('/users'))?.users ?? [];
    const out: Record<string, { progress: string[]; bookmarks: string[] }> = {};
    const at = (id: string) => (out[id] ??= { progress: [], bookmarks: [] });
    for (const u of users) {
      const full = await client.get<{
        mediaProgress?: { libraryItemId?: string; currentTime?: number; isFinished?: boolean }[];
        bookmarks?: { libraryItemId?: string; time?: number }[];
      }>(`/users/${encodeURIComponent(u.id)}`);
      for (const m of full?.mediaProgress ?? [])
        if (m.libraryItemId)
          at(m.libraryItemId).progress.push(
            `${u.id}:${Math.round(m.currentTime ?? 0)}:${m.isFinished ? 1 : 0}`,
          );
      for (const m of full?.bookmarks ?? [])
        if (m.libraryItemId)
          at(m.libraryItemId).bookmarks.push(`${u.id}:${Math.round(m.time ?? 0)}`);
    }
    for (const v of Object.values(out)) {
      v.progress.sort();
      v.bookmarks.sort();
    }
    return out;
  }

  /** Records the changes, their operations and the reader links they change. */
  private async record(
    runId: number,
    c: ChangesProgress,
    changes: PlannedChange[],
    books: LedgerBook[],
    abs: Map<number, AbsBookState | null> = new Map(),
  ): Promise<void> {
    const db = this.db;
    const byId = new Map(books.map((b) => [b.id, b]));
    const reader = this.deps.reader();
    const now = this.now();
    const counts = emptyCounts();
    // The reader-written files that get their original name (read only).
    const readerFiles = await this.readerFiles(c);
    db.transaction(() => {
      db.prepare('DELETE FROM audio_library_changes WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM audio_library_ops WHERE run_id = ?').run(runId);
      db.prepare('DELETE FROM audio_library_links WHERE run_id = ?').run(runId);
      const putChange = db.prepare(
        `INSERT INTO audio_library_changes (run_id, book_id, state, folder_from, folder_to, base_to, fields_json, user_fields_json,
           conflicts_json, renames_json, renames_held, reviews_json, skipped, metadata_new, decided_new, metadata_sha_read, abs_item_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let seq = 0;
      const putOp = db.prepare(
        `INSERT INTO audio_library_ops (run_id, change_id, seq, kind, book, src_rel, dst, size, mtime_ms, dev, ino, bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const moves: { from: string; to: string; ino: number; change: number }[] = [];
      for (const ch of changes) {
        const b = byId.get(ch.bookId)!;
        const applies =
          ch.skipped === null &&
          (ch.metadataNew !== null ||
            ch.folderTo !== null ||
            (ch.renames.length > 0 && !ch.renamesHeld));
        const state = ch.skipped ? 'skipped' : applies ? 'planned' : 'review';
        const id = Number(
          putChange.run(
            runId,
            ch.bookId,
            state,
            ch.folderFrom,
            ch.folderTo,
            ch.baseTo,
            JSON.stringify(ch.fields),
            JSON.stringify(ch.userFields),
            JSON.stringify(ch.conflicts),
            JSON.stringify(ch.renames),
            ch.renamesHeld ? 1 : 0,
            JSON.stringify(ch.reviews),
            ch.skipped,
            ch.metadataNew,
            ch.decidedNew,
            ch.metadataShaRead,
            abs.get(ch.bookId)?.itemId ?? null,
            now,
          ).lastInsertRowid,
        );
        if (ch.skipped) {
          counts.kept++;
          continue;
        }
        counts.changes++;
        counts.reviews += ch.reviews.length ? 1 : 0;
        counts.userFields += ch.userFields.length;
        if (!ch.renamesHeld)
          for (const r of ch.renames) {
            putOp.run(
              runId,
              id,
              ++seq,
              'rename_file',
              ch.folderFrom,
              r.from,
              r.to,
              null,
              null,
              null,
              r.ino,
              null,
              null,
            );
            counts.renames++;
          }
        else counts.renamesHeld += ch.renames.length;
        if (ch.metadataNew) {
          putOp.run(
            runId,
            id,
            ++seq,
            'replace_metadata',
            ch.folderFrom,
            null,
            `${ch.folderFrom}/metadata.json`,
            null,
            null,
            null,
            null,
            ch.metadataNew,
            ch.metadataShaRead,
          );
          counts.metadata++;
        }
        if (ch.folderTo && b.folderIno)
          moves.push({ from: ch.folderFrom, to: ch.folderTo, ino: b.folderIno, change: id });
        else if (ch.folderTo) {
          const reviews = [
            ...ch.reviews,
            {
              kind: 'abs_unknown',
              text: `Its folder could not be read: it stays at ${ch.folderFrom} for now`,
            },
          ];
          db.prepare(
            `UPDATE audio_library_changes SET reviews_json = ?, folder_to = NULL WHERE id = ?`,
          ).run(JSON.stringify(reviews), id);
        }
      }
      const changeOf = new Map(moves.map((m) => [m.from, m.change]));
      for (const m of orderMoves(moves)) {
        putOp.run(
          runId,
          changeOf.get(m.from) ?? null,
          ++seq,
          'move_book',
          null,
          m.from,
          m.to,
          null,
          null,
          null,
          m.ino,
          null,
          null,
        );
      }
      counts.moves = moves.length;
      const targets = moves.map((m) => m.to);
      for (const d of leftBehind(moves)) {
        if (targets.some((t) => t === d || t.startsWith(d + '/'))) continue;
        putOp.run(runId, null, ++seq, 'rmdir', null, null, d, null, null, null, null, null, null);
        counts.rmdirs++;
      }
      for (const f of readerFiles.ready) {
        putOp.run(
          runId,
          null,
          ++seq,
          'reader_link',
          null,
          f.rel,
          f.dst,
          f.size,
          f.mtimeMs,
          f.dev,
          f.ino,
          null,
          null,
        );
        counts.readerFiles++;
      }
      counts.readerWaiting = readerFiles.waiting;
      // The reader's links these moves and renames change.
      if (reader) {
        const links = reader.db
          .prepare(
            `SELECT * FROM audio_links WHERE state = 'linked' AND folder_rel_path IS NOT NULL`,
          )
          .all() as {
          user_id: string;
          book_id: string;
          folder_rel_path: string;
          file_name: string | null;
        }[];
        const putLink = db.prepare(
          `INSERT INTO audio_library_links (run_id, user_id, book_id, old_folder, old_file, new_folder, new_file, status, playable_before)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
        );
        for (const ch of changes) {
          if (ch.skipped) continue;
          const to = ch.folderTo ?? ch.folderFrom;
          const renames = ch.renamesHeld ? [] : ch.renames;
          if (to === ch.folderFrom && renames.length === 0) continue;
          for (const l of links) {
            const inside =
              l.folder_rel_path === ch.folderFrom ||
              l.folder_rel_path.startsWith(ch.folderFrom + '/');
            if (!inside) continue;
            const sub = l.folder_rel_path.slice(ch.folderFrom.length);
            const fileRel = l.file_name ? `${sub ? sub.slice(1) + '/' : ''}${l.file_name}` : null;
            const r = fileRel ? renames.find((x) => x.from === fileRel) : undefined;
            const newFile = r ? r.to.split('/').pop()! : l.file_name;
            const newFolder =
              to + (r && r.to.includes('/') ? '/' + r.to.split('/').slice(0, -1).join('/') : sub);
            if (newFolder === l.folder_rel_path && newFile === l.file_name) continue;
            const link = getLink(reader.db, l.user_id, l.book_id);
            const before = link ? resolveLink(reader.db, link).playable : false;
            putLink.run(
              runId,
              l.user_id,
              l.book_id,
              l.folder_rel_path,
              l.file_name,
              newFolder,
              newFile,
              before ? 1 : 0,
            );
            counts.links++;
          }
        }
      }
    })();
    c.counts = counts;
  }

  /**
   * Files the reader wrote in japanese-generated/ and japanese-merged/ with no other name (link
   * count 1), settled (unchanged for the settle minutes) and not being written (audio_writes):
   * ready to get their original name under the torrents' AI/ or _merged/.
   */
  private async readerFiles(c: ChangesProgress): Promise<{
    ready: { rel: string; dst: string; size: number; mtimeMs: number; dev: number; ino: number }[];
    waiting: number;
  }> {
    const media = this.deps.media;
    const out: {
      rel: string;
      dst: string;
      size: number;
      mtimeMs: number;
      dev: number;
      ino: number;
    }[] = [];
    let waiting = 0;
    if (!media) return { ready: out, waiting };
    const settle = getSettings(this.db).audiobooks.arrivalsSettleMinutes * 60_000;
    const reader = this.deps.reader();
    const writing = new Set<string>();
    if (reader)
      for (const r of reader.db
        .prepare(
          `SELECT temp_rel_path, final_rel_path FROM audio_writes WHERE state IN ('reserving', 'writing', 'published')`,
        )
        .all() as { temp_rel_path: string | null; final_rel_path: string | null }[]) {
        if (r.final_rel_path) writing.add(r.final_rel_path);
        if (r.temp_rel_path) writing.add(r.temp_rel_path);
      }
    const now = this.now();
    // The reader's own record of the files it wrote (never our own files there: the AI books'
    // links and their metadata.json). Over SMB every file shows link count 1; the server reads
    // through the disk's own mount, where a file with another name shows 2.
    const written = reader
      ? (
          reader.db
            .prepare(
              `SELECT DISTINCT final_rel_path AS rel FROM audio_writes WHERE state = 'done' AND final_rel_path IS NOT NULL`,
            )
            .all() as { rel: string }[]
        ).map((r) => r.rel)
      : [];
    for (const rel of written) {
      const parts = rel.split('/');
      const root = parts[0];
      const name = parts[parts.length - 1];
      if (!READER_ROOTS[root] || parts.length < 2) continue;
      if (name.startsWith('.') || ABS_OR_OURS.test(name)) continue;
      const s = await lstatEntry(insideRoot(media, rel));
      if (!s || !s.isFile || s.nlink !== 1) continue;
      if (writing.has(rel) || now - s.mtimeMs < settle) {
        waiting++;
        continue;
      }
      out.push({
        rel,
        dst: `${READER_ROOTS[root]}/${parts.slice(1).join('/')}`,
        size: s.size,
        mtimeMs: Math.floor(s.mtimeMs),
        dev: s.dev,
        ino: s.ino,
      });
    }
    void c;
    return { ready: out, waiting };
  }

  private preflightStep(runId: number, c: ChangesProgress): 'more' | 'wait' | { pause: string } {
    const left = this.db
      .prepare(`SELECT COUNT(*) AS n FROM audio_library_ops WHERE run_id = ? AND preflight IS NULL`)
      .get(runId) as { n: number };
    c.total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audio_library_ops WHERE run_id = ?`)
        .get(runId) as { n: number }
    ).n;
    c.done = c.total - left.n;
    if (left.n > 0) {
      this.waitFor(
        c,
        this.sidecarReady()
          ? null
          : `Waiting for the linking sidecar ${LIBRARY_SIDECAR_VERSION} or newer`,
      );
      return 'wait';
    }
    const problems = (
      this.db
        .prepare(
          `SELECT preflight FROM audio_library_ops WHERE run_id = ? AND preflight <> 'ok' ORDER BY seq LIMIT 20`,
        )
        .all(runId) as { preflight: string }[]
    ).map((r) => r.preflight);
    c.preflightProblems = problems;
    if (problems.length) {
      this.db.prepare(`UPDATE audio_library_ops SET preflight = NULL WHERE run_id = ?`).run(runId);
      return {
        pause: `Library changes: the sidecar can't make ${problems.length} change(s): ${problems[0]}`,
      };
    }
    const moves = this.needsHold(runId);
    this.setPhase(c, moves ? 'hold' : 'apply', c.total);
    return 'more';
  }

  private needsHold(runId: number): boolean {
    return (
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM audio_library_ops WHERE run_id = ? AND kind IN ('move_book', 'rename_file')`,
          )
          .get(runId) as { n: number }
      ).n > 0
    );
  }

  private async holdStep(runId: number, c: ChangesProgress): Promise<'more' | 'wait'> {
    const reader = this.deps.reader();
    if (!reader) {
      this.waitFor(c, "Waiting for the reader's audiobook services");
      return 'wait';
    }
    if (!reader.held('switch')) {
      const busy = reader.busy();
      if (busy.length) {
        this.waitFor(c, `Waiting for the reader: ${busy[0]}`);
        return 'wait';
      }
      reader.setHold('switch', true);
    }
    this.waitFor(c, 'Waiting for the reader’s scan to finish');
    await reader.scanIdle();
    this.waitFor(c, null);
    this.setPhase(c, 'snapshot');
    void runId;
    return 'more';
  }

  private async snapshotStep(runId: number, c: ChangesProgress): Promise<'more'> {
    const links = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audio_library_links WHERE run_id = ?`)
        .get(runId) as { n: number }
    ).n;
    const reader = this.deps.reader();
    if (links > 0 && reader && !c.snapshot) c.snapshot = await reader.snapshot('library-changes');
    this.setPhase(c, 'apply', links);
    return 'more';
  }

  private sidecarReady(): boolean {
    const s = this.deps.sidecarVersion();
    return (
      !!s.lastSeen &&
      this.now() - s.lastSeen < 90_000 &&
      versionAtLeast(s.version, LIBRARY_SIDECAR_VERSION)
    );
  }

  private inFlight(now = this.now()): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM audio_library_batches WHERE state = 'claimed' AND lease_until >= ? LIMIT 1`,
        )
        .get(now) !== undefined
    );
  }

  private expireLeases(now = this.now()): void {
    for (const b of this.db
      .prepare(`SELECT id FROM audio_library_batches WHERE state = 'claimed' AND lease_until < ?`)
      .all(now) as { id: number }[]) {
      this.db.transaction(() => {
        this.db
          .prepare(`UPDATE audio_library_batches SET state = 'expired' WHERE id = ?`)
          .run(b.id);
        this.db
          .prepare(
            `UPDATE audio_library_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(b.id);
      })();
    }
  }

  private async applyStep(
    runId: number,
    c: ChangesProgress,
    stop: () => boolean,
  ): Promise<'more' | 'wait' | { pause: string }> {
    this.expireLeases();
    const counts = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM audio_library_ops WHERE run_id = ? GROUP BY state`)
      .all(runId) as { state: string; n: number }[];
    const n = (s: string) => counts.find((x) => x.state === s)?.n ?? 0;
    c.total = counts.reduce((t, x) => t + x.n, 0);
    c.done = n('done');
    c.apply.total = c.total;
    c.apply.done = c.done;
    c.apply.failed = n('failed');
    if (n('failed') > 0) {
      const f = this.db
        .prepare(
          `SELECT result_json FROM audio_library_ops WHERE run_id = ? AND state = 'failed' ORDER BY seq LIMIT 1`,
        )
        .get(runId) as { result_json: string | null };
      this.giveBack();
      return {
        pause: `Library changes: a change failed: ${(f.result_json ?? '').slice(0, 300)} (Continue tries it again)`,
      };
    }
    if (n('planned') === 0 && n('claimed') === 0) {
      this.giveBack();
      this.setPhase(c, 'remap', c.done);
      return 'more';
    }
    if (!this.sidecarReady()) {
      this.waitFor(c, `Waiting for the linking sidecar ${LIBRARY_SIDECAR_VERSION} or newer`);
      return 'wait';
    }
    // The disk lock in turns (Calibre first).
    const lock = this.deps.lock;
    if (lock.holds(OWNER) && lock.shouldYield(OWNER) && !this.inFlight()) {
      lock.release(OWNER);
      this.handing = false;
      c.apply.yields++;
    }
    if (!lock.holds(OWNER)) {
      this.waitFor(c, 'Waiting for the disk (Calibre first)');
      const t = this.now();
      const got = await Promise.race([
        lock.acquire(OWNER, 'audio', stop),
        new Promise<boolean>((r) => setTimeout(() => r(false), HOLD_MS)),
      ]);
      c.apply.lockWaitMs += this.now() - t;
      if (!got && !lock.holds(OWNER)) return 'wait';
    }
    this.waitFor(c, null);
    this.handing = lock.holds(OWNER) && !lock.shouldYield(OWNER);
    return 'wait';
  }

  giveBack(): void {
    this.handing = false;
    if (this.deps.lock.holds(OWNER) && !this.inFlight()) this.deps.lock.release(OWNER);
  }

  private remapStep(runId: number, c: ChangesProgress): 'more' {
    const reader = this.deps.reader();
    const links = this.db
      .prepare(`SELECT * FROM audio_library_links WHERE run_id = ? AND status = 'planned'`)
      .all(runId) as {
      id: number;
      user_id: string;
      book_id: string;
      old_folder: string;
      old_file: string | null;
      new_folder: string;
      new_file: string | null;
    }[];
    if (links.length && reader) {
      const upd = reader.db.prepare(
        `UPDATE audio_links SET folder_rel_path = ?, file_name = ? WHERE user_id = ? AND book_id = ? AND folder_rel_path IS ? AND file_name IS ?`,
      );
      const now = reader.db.prepare(
        `SELECT folder_rel_path, file_name FROM audio_links WHERE user_id = ? AND book_id = ?`,
      );
      reader.db.transaction(() => {
        for (const l of links) {
          if (
            upd.run(l.new_folder, l.new_file, l.user_id, l.book_id, l.old_folder, l.old_file)
              .changes === 0
          ) {
            const r = now.get(l.user_id, l.book_id) as
              | { folder_rel_path: string | null; file_name: string | null }
              | undefined;
            if (!r || r.folder_rel_path !== l.new_folder || r.file_name !== l.new_file)
              throw new Error(
                `The reader's link of book ${l.book_id} changed during the library changes`,
              );
          }
        }
      })();
      this.db
        .prepare(
          `UPDATE audio_library_links SET status = 'remapped' WHERE run_id = ? AND status = 'planned'`,
        )
        .run(runId);
    }
    c.remap = { changed: links.length, resolveBefore: 0, resolveAfter: 0 };
    this.setPhase(c, this.needsHold(runId) ? 'rescan' : 'abs_scan', links.length);
    return 'more';
  }

  private async rescanStep(runId: number, c: ChangesProgress): Promise<'more'> {
    const reader = this.deps.reader();
    if (reader?.held('switch')) await reader.scanForSwitch();
    // Every remapped link resolves now (a link that played before still plays).
    if (reader) {
      const rows = this.db
        .prepare(
          `SELECT user_id, book_id, playable_before FROM audio_library_links WHERE run_id = ?`,
        )
        .all(runId) as { user_id: string; book_id: string; playable_before: number }[];
      let ok = 0;
      for (const r of rows) {
        const l = getLink(reader.db, r.user_id, r.book_id);
        if (l && resolveLink(reader.db, l).playable) ok++;
      }
      c.remap = {
        changed: rows.length,
        resolveBefore: rows.filter((r) => r.playable_before).length,
        resolveAfter: ok,
      };
      if (ok < c.remap.resolveBefore)
        throw new Error(
          `${c.remap.resolveBefore - ok} reader link(s) no longer play after the changes`,
        );
    }
    this.setPhase(c, 'release');
    return 'more';
  }

  private releaseStep(runId: number, c: ChangesProgress): 'more' {
    const reader = this.deps.reader();
    if (reader?.held('switch')) {
      reader.setHold('switch', false);
      reader.wakeScan();
      reader.resumeMerges();
    }
    this.updateLedger(runId);
    this.setPhase(c, 'abs_scan');
    return 'more';
  }

  /** The ledger after the run: folders, link names and the metadata.json written. */
  private updateLedger(runId: number): void {
    const db = this.db;
    const now = this.now();
    for (const ch of db
      .prepare(
        `SELECT id, book_id, folder_to, base_to, renames_json, renames_held, metadata_new, decided_new FROM audio_library_changes WHERE run_id = ? AND state = 'planned'`,
      )
      .all(runId) as {
      id: number;
      book_id: number;
      folder_to: string | null;
      base_to: string | null;
      renames_json: string;
      renames_held: number;
      metadata_new: Buffer | null;
      decided_new: Buffer | null;
    }[]) {
      const open = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM audio_library_ops WHERE change_id = ? AND state <> 'done'`,
          )
          .get(ch.id) as { n: number }
      ).n;
      if (open) continue;
      const b = db
        .prepare(
          'SELECT folder, base_folder, files_json, metadata FROM audio_library_books WHERE id = ?',
        )
        .get(ch.book_id) as {
        folder: string;
        base_folder: string;
        files_json: string;
        metadata: Buffer;
      };
      const files = JSON.parse(b.files_json) as { fileId: number; name: string }[];
      if (!ch.renames_held)
        for (const r of JSON.parse(ch.renames_json) as { from: string; to: string }[]) {
          const f = files.find((x) => x.name === r.from);
          if (f) f.name = r.to;
        }
      db.prepare(
        `UPDATE audio_library_books SET folder = ?, base_folder = ?, files_json = ?, metadata = ?, decided = COALESCE(?, decided), updated_at = ? WHERE id = ?`,
      ).run(
        ch.folder_to ?? b.folder,
        ch.base_to ?? b.base_folder,
        JSON.stringify(files),
        ch.metadata_new ?? b.metadata,
        ch.decided_new,
        now,
        ch.book_id,
      );
      db.prepare(`UPDATE audio_library_changes SET state = 'applied' WHERE id = ?`).run(ch.id);
    }
    db.prepare(
      `UPDATE audio_library_reader_files SET state = 'linked', linked_at = ? WHERE rel IN (SELECT src_rel FROM audio_library_ops WHERE run_id = ? AND kind = 'reader_link' AND state = 'done')`,
    ).run(now, runId);
  }

  private absClient(): AbsClient | null {
    const a = this.deps.abs();
    return a ? new AbsClient({ ...a, fetchImpl: this.deps.fetchImpl }) : null;
  }

  private async absLibrary(client: AbsClient): Promise<{ id: string; name: string } | null> {
    const libs =
      (
        await client.get<{
          libraries?: { id: string; name?: string; folders?: { fullPath?: string }[] }[];
        }>('/libraries')
      )?.libraries ?? [];
    const root = getSettings(this.db).audiobooks.absMediaFolder;
    const want = `${root === '/' ? '' : root}/${ARRIVAL_AREA_FOLDERS.main}`;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const l = libs.find((x) => (x.folders ?? []).some((f) => norm(f.fullPath ?? '') === want));
    return l ? { id: l.id, name: l.name ?? l.id } : null;
  }

  /** relPath -> item id of every item of the library (paged, minified). */
  private async absItems(client: AbsClient, libraryId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let page = 0; page < 1000; page++) {
      const r = await client.get<{ results?: { id: string; relPath?: string }[]; total?: number }>(
        `/libraries/${encodeURIComponent(libraryId)}/items?limit=500&page=${page}&minified=1`,
      );
      const rs = r?.results ?? [];
      for (const it of rs) if (it.relPath) out.set(it.relPath.replace(/\\/g, '/'), it.id);
      if (rs.length < 500) break;
    }
    return out;
  }

  private async absScanStep(runId: number, c: ChangesProgress): Promise<'more'> {
    const applied = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audio_library_changes WHERE run_id = ? AND state = 'applied' AND folder_from LIKE 'japanese/%'`,
        )
        .get(runId) as { n: number }
    ).n;
    const a = this.deps.abs();
    if (!applied || !a) {
      if (applied && !a)
        c.abs.error =
          'Audiobookshelf is not set up (address and API key): scan the library in ABS once';
      this.setPhase(c, 'done');
      return 'more';
    }
    const client = this.absClient()!;
    const lib = await this.absLibrary(client);
    if (!lib) {
      c.abs.error = 'Audiobookshelf has no library on …/japanese';
      this.setPhase(c, 'done');
      return 'more';
    }
    await new AbsLibraryScan({ ...a, fetchImpl: this.deps.fetchImpl }).scan(lib.id);
    c.abs.scannedAt = this.now();
    this.setPhase(c, 'abs_verify', applied);
    return 'more';
  }

  /** Every changed book in ABS: the same item at its new folder, progress and bookmarks kept. */
  private async absVerifyStep(runId: number, c: ChangesProgress): Promise<'more' | 'wait'> {
    const client = this.absClient();
    if (!client) {
      this.setPhase(c, 'done');
      return 'more';
    }
    const lib = await this.absLibrary(client);
    if (!lib) {
      this.setPhase(c, 'done');
      return 'more';
    }
    const items = await this.absItems(client, lib.id);
    const rows = this.db
      .prepare(
        `SELECT id, folder_from, folder_to, abs_item_id, abs_before_json FROM audio_library_changes WHERE run_id = ? AND state = 'applied' AND folder_from LIKE 'japanese/%'`,
      )
      .all(runId) as {
      id: number;
      folder_from: string;
      folder_to: string | null;
      abs_item_id: string | null;
      abs_before_json: string | null;
    }[];
    let ok = 0;
    const problems: string[] = [];
    for (const r of rows) {
      const rel = (r.folder_to ?? r.folder_from).slice('japanese/'.length);
      const id = items.get(rel);
      if (!id) continue;
      if (r.abs_item_id && id !== r.abs_item_id)
        problems.push(
          `${rel}: Audiobookshelf shows it as a new item (${id}, was ${r.abs_item_id})`,
        );
      ok++;
    }
    c.total = rows.length;
    c.done = ok;
    const waited = this.now() - (c.abs.scannedAt ?? this.now());
    const limit = getSettings(this.db).audiobooks.arrivalsAbsWaitMinutes * 60_000;
    if (ok < rows.length && waited < limit) {
      this.waitFor(
        c,
        `Waiting for Audiobookshelf's scan (${ok} of ${rows.length} changed books seen)`,
      );
      await new Promise((r) => setTimeout(r, 5000));
      return 'wait';
    }
    this.waitFor(c, null);
    // The fields a change emptied: ABS keeps its own value when its metadata file has an empty
    // one (found at stop B1), so they are cleared through its edit call, never a field you
    // edited, then read back.
    const a = this.deps.abs();
    if (a) {
      const clearer = new AbsClearFields({ ...a, fetchImpl: this.deps.fetchImpl });
      const fieldsOf = this.db.prepare(
        'SELECT fields_json, user_fields_json FROM audio_library_changes WHERE id = ?',
      );
      const empty = (v: unknown) =>
        v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
      for (const r of rows) {
        const id = items.get((r.folder_to ?? r.folder_from).slice('japanese/'.length));
        if (!id) continue;
        const f = fieldsOf.get(r.id) as { fields_json: string; user_fields_json: string };
        const mine = new Set(JSON.parse(f.user_fields_json) as string[]);
        const emptied = (JSON.parse(f.fields_json) as { field: string; to: unknown }[]).filter(
          (x) => empty(x.to) && !mine.has(x.field),
        );
        const fields = emptied
          .map((x) => x.field)
          .filter((x): x is Clearable => (CLEARABLE as readonly string[]).includes(x));
        const tags = emptied.some((x) => x.field === 'tags');
        if (!fields.length && !tags) continue;
        try {
          await clearer.clear(id, fields, tags);
          c.abs.cleared = (c.abs.cleared ?? 0) + 1;
          const now = await client.get<{
            media?: { metadata?: Record<string, unknown>; tags?: unknown[] };
          }>(`/items/${encodeURIComponent(id)}`);
          const m = now?.media?.metadata ?? {};
          const left = fields.filter((x) => !empty(m[x]));
          if (left.length || (tags && !empty(now?.media?.tags)))
            problems.push(
              `${r.folder_to ?? r.folder_from}: Audiobookshelf still shows ${[...left, ...(tags && !empty(now?.media?.tags) ? ['tags'] : [])].join(', ')}`,
            );
        } catch (err) {
          problems.push(`${r.folder_to ?? r.folder_from}: ${(err as Error).message}`);
        }
      }
    }
    // Progress and bookmarks of every changed book's item as before the changes.
    const before = rows[0]?.abs_before_json
      ? (JSON.parse(rows[0].abs_before_json) as Record<
          string,
          { progress: string[]; bookmarks: string[] }
        >)
      : null;
    const after = before ? await this.absProgress().catch(() => null) : null;
    if (before && after)
      for (const r of rows) {
        if (!r.abs_item_id) continue;
        const b = before[r.abs_item_id] ?? { progress: [], bookmarks: [] };
        const a = after[r.abs_item_id] ?? { progress: [], bookmarks: [] };
        if (JSON.stringify(b) !== JSON.stringify(a))
          problems.push(
            `${r.folder_to ?? r.folder_from}: progress or bookmarks differ in Audiobookshelf after the scan`,
          );
      }
    c.abs.problems = problems;
    c.abs.after = items.size;
    c.abs.verified = ok;
    c.abs.notYet = rows.length - ok;
    this.setPhase(c, 'done', rows.length);
    return 'more';
  }

  // ---- the sidecar's batches ---------------------------------------------------------------------

  claim(runId: number, c: ChangesProgress): LibraryBatch | null {
    this.expireLeases();
    if (!this.sidecarReady() || this.inFlight()) return null;
    const s = getSettings(this.db).audiobooks;
    const pre = c.phase === 'preflight';
    if (!pre && !(c.phase === 'apply' && this.handing)) return null;
    const ops = this.db
      .prepare(
        pre
          ? `SELECT * FROM audio_library_ops WHERE run_id = ? AND preflight IS NULL ORDER BY seq LIMIT ?`
          : `SELECT * FROM audio_library_ops WHERE run_id = ? AND state = 'planned' ORDER BY seq LIMIT ?`,
      )
      .all(runId, pre ? s.buildPreflightOps : s.buildBatchOps) as {
      id: number;
      kind: LibraryBatchOp['kind'];
      book: string | null;
      src_rel: string | null;
      dst: string;
      size: number | null;
      mtime_ms: number | null;
      dev: number | null;
      ino: number | null;
      bytes: Buffer | null;
      sha256: string | null;
    }[];
    if (!ops.length) return null;
    const now = this.now();
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO audio_library_batches (run_id, kind, state, ops, claimed_at, lease_until) VALUES (?, ?, 'claimed', ?, ?, ?)`,
        )
        .run(
          runId,
          pre ? 'library_preflight' : 'library',
          ops.length,
          now,
          now + s.buildLeaseSeconds * 1000,
        ).lastInsertRowid,
    );
    if (!pre)
      for (const o of ops)
        this.db
          .prepare(`UPDATE audio_library_ops SET state = 'claimed', batch_id = ? WHERE id = ?`)
          .run(id, o.id);
    else this.db.prepare(`UPDATE audio_library_batches SET state = 'claimed' WHERE id = ?`).run(id);
    return {
      id,
      kind: pre ? 'library_preflight' : 'library',
      leaseSeconds: s.buildLeaseSeconds,
      ops: ops.map((o) => ({
        id: o.id,
        kind: o.kind,
        book: o.book,
        dst: o.dst,
        src: o.src_rel !== null ? { rel: o.src_rel, raw: null } : null,
        size: o.size,
        mtimeMs: o.mtime_ms,
        dev: o.dev,
        ino: o.ino,
        bytes: o.bytes ? o.bytes.toString('base64') : null,
        sha256: o.sha256,
      })),
    };
  }

  report(batchId: number, results: LibraryOpResult[]): { accepted: number } {
    const batch = this.db
      .prepare('SELECT * FROM audio_library_batches WHERE id = ?')
      .get(batchId) as { id: number; run_id: number; kind: string; state: string } | undefined;
    if (!batch) throw new Error('No such batch');
    const now = this.now();
    let accepted = 0;
    this.db.transaction(() => {
      for (const r of results) {
        if (batch.kind === 'library_preflight') {
          accepted += this.db
            .prepare(`UPDATE audio_library_ops SET preflight = ? WHERE id = ? AND run_id = ?`)
            .run(r.ok ? 'ok' : (r.problem ?? 'refused'), r.id, batch.run_id).changes;
        } else {
          accepted += this.db
            .prepare(
              `UPDATE audio_library_ops SET state = ?, result_json = ?, done_at = ? WHERE id = ? AND batch_id = ?`,
            )
            .run(r.ok ? 'done' : 'failed', JSON.stringify(r), now, r.id, batchId).changes;
        }
      }
      // Ops of the batch the sidecar didn't reach (it stops at a failure) go back to planned.
      this.db
        .prepare(
          `UPDATE audio_library_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
        )
        .run(batchId);
      this.db.prepare(`UPDATE audio_library_batches SET state = 'done' WHERE id = ?`).run(batchId);
    })();
    return { accepted };
  }

  /** Continue after a pause: failed operations are tried again (each is safe to repeat). */
  retryFailed(runId: number): void {
    this.db
      .prepare(
        `UPDATE audio_library_ops SET state = 'planned', batch_id = NULL WHERE run_id = ? AND state = 'failed'`,
      )
      .run(runId);
  }

  /** A review choice for a book: a field 'mine' | 'ours', or 'rename' 'now'. */
  choose(bookId: number, field: string, choice: string): void {
    const ok =
      (field === 'rename' && choice === 'now') ||
      (/^[a-zA-Z]{1,40}$/.test(field) &&
        field !== 'rename' &&
        (choice === 'mine' || choice === 'ours'));
    if (!ok) throw new Error('Not a choice');
    this.db
      .prepare(
        `INSERT INTO audio_library_choices (book_id, field, choice, decided_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (book_id, field) DO UPDATE SET choice = excluded.choice, decided_at = excluded.decided_at`,
      )
      .run(bookId, field, choice, this.now());
  }

  /** The page's lists: the changes of a run, its review items, its reader files, its links. */
  list(
    runId: number,
    kind: 'changes' | 'review' | 'reader' | 'links' | 'kept',
    opts: { offset?: number; limit?: number } = {},
  ): { total: number; items: unknown[] } {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const db = this.db;
    if (kind === 'reader' || kind === 'links') {
      const where =
        kind === 'reader'
          ? `FROM audio_library_ops WHERE run_id = ? AND kind = 'reader_link'`
          : `FROM audio_library_links WHERE run_id = ?`;
      const total = (db.prepare(`SELECT COUNT(*) AS n ${where}`).get(runId) as { n: number }).n;
      const items = db
        .prepare(
          kind === 'reader'
            ? `SELECT src_rel AS rel, dst, size, state ${where} ORDER BY seq LIMIT ? OFFSET ?`
            : `SELECT book_id, old_folder, old_file, new_folder, new_file, status ${where} ORDER BY id LIMIT ? OFFSET ?`,
        )
        .all(runId, limit, offset);
      return { total, items };
    }
    const cond =
      kind === 'review'
        ? `AND reviews_json <> '[]'`
        : kind === 'kept'
          ? `AND state = 'skipped'`
          : `AND state <> 'skipped'`;
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM audio_library_changes WHERE run_id = ? ${cond}`)
        .get(runId) as { n: number }
    ).n;
    const items = (
      db
        .prepare(
          `SELECT id, book_id, state, folder_from, folder_to, fields_json, user_fields_json, conflicts_json, renames_json,
             renames_held, reviews_json, skipped FROM audio_library_changes WHERE run_id = ? ${cond} ORDER BY folder_from LIMIT ? OFFSET ?`,
        )
        .all(runId, limit, offset) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id,
      bookId: r.book_id,
      state: r.state,
      folderFrom: r.folder_from,
      folderTo: r.folder_to,
      fields: JSON.parse(r.fields_json as string),
      userFields: JSON.parse(r.user_fields_json as string),
      conflicts: JSON.parse(r.conflicts_json as string),
      renames: JSON.parse(r.renames_json as string),
      renamesHeld: r.renames_held === 1,
      reviews: JSON.parse(r.reviews_json as string),
      skipped: r.skipped,
    }));
    return { total, items };
  }
}

/** The library-relative name of a stage-6 path under media/audiobooks (for tests and reports). */
export function mediaRel(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/'));
}
