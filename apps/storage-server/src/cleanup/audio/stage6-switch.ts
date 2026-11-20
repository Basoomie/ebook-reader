/**
 * The switch to the new audiobook library (WP21e-2, plan section 8 steps 4-9, the checked list
 * `design/wp21e-2-switch-checklist.md`). After stage 6 has built and checked `japanese-new`:
 *
 * Switch (asks first; everything up to the deletion is undone by renaming back):
 *   hold          the reader's audiobook hold (scans, merges, PC jobs, link edits, writes wait;
 *                 src/audio/audio-hold.ts); the running scan finishes first
 *   late          media/audiobooks/japanese listed: audio files that arrived after stage 1
 *                 pause the switch (decided with the user then)
 *   from_library  the library-only files: the sidecar re-checks each (size, mtime, inode,
 *                 SHA-256), links it under torrents/…/_from-library/<folder>/, then into its
 *                 planned folder in japanese-new (decided 2026-11-20: links, not moves)
 *   check         stage 6's check again, with those links (must pass)
 *   links         every reader link mapped through the move list (switch-remap.ts); one that
 *                 can't be mapped pauses the switch before anything is renamed
 *   snapshot      a verified copy of ttsu.db
 *   rename        japanese -> japanese-old, japanese-new -> japanese,
 *                 japanese-generated-new -> japanese-generated (the sidecar's writer)
 *   remap         the reader's links rewritten in one ttsu.db transaction (directly: not through
 *                 saveLink, which would forget whispersync's saved match; confirmed_at kept)
 *   rescan        the reader's scan of the new folders (the hold's one scan)
 *   verify        every link resolves as before; the number of links unchanged
 *   release       the hold and merges' wait end
 * Undo (only before the deletion): hold -> the three reverse renames -> the links restored ->
 * rescan -> verify -> release (merges wait again).
 * Delete japanese-old (asks first; can't be undone): stage 6's check on the switched layout ->
 * the PDFs and archives read again on both sides -> the old copy script's files kept -> a fresh
 * list of japanese-old, every entry as the build's walk saw it -> the sidecar deletes it -> report.
 *
 * Nothing here writes a file: the server reads the trees through read-only mounts; the
 * sidecar's writer does every rename, link, copy and deletion. Every phase shows its progress.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { resolveLink, type AudioLink } from '../../audio/audio-links';
import { DISK_OWNERS, type DiskLock } from '../disk-lock';
import { getSettings } from '../settings';
import { hashFile, insideRoot, lstatEntry, ReadPacer } from './audio-source-fs';
import { walkTree, type ManifestEntry } from './build-check';
import { AREA_FOLDERS } from './build-plan';
import type {
  AudioStage6,
  BuildRoots,
  CheckContext,
  LinkOpResult,
  Stage6Check,
} from './stage6-build';
import {
  afterRenames,
  remapCounts,
  remapLinks,
  type RemapResult,
  type SwitchLink,
  type SwitchMove,
} from './switch-remap';

const OWNER = DISK_OWNERS.audio6switch;
/** Switch batches are numbered from here, so a report never meets a build batch's id. */
export const SWITCH_BATCH_BASE = 1_000_000_000;
const AUDIO_EXT = /\.(m4b|m4a|mp3|mp4|aac|flac|ogg|opus|wav|wma)$/i;
/** The old copy script's files at the library's root (checklist section 4). */
const INVENTORY = [
  'needs_extraction.csv',
  'needs_review.csv',
  'restructure_log.csv',
  'unmatched_bonus_content.csv',
  '.processed_files.json',
];
/** Folders of media/audiobooks the switch knows (their last part; Audiobookshelf's folders). */
const SWITCH_FOLDERS = [
  'japanese',
  'japanese-new',
  'japanese-old',
  'japanese-generated',
  'japanese-generated-new',
];

export type SwitchAction = 'switch' | 'undo' | 'delete';
export type SwitchState = 'none' | 'running' | 'switched' | 'deleted';

export const SWITCH_PHASES = [
  'hold',
  'late',
  'from_library',
  'check',
  'links',
  'snapshot',
  'rename',
  'remap',
  'rescan',
  'verify',
  'release',
] as const;
export const UNDO_PHASES = ['hold', 'rename', 'restore', 'rescan', 'verify', 'release'] as const;
export const DELETE_PHASES = ['check', 'files', 'inventory', 'list', 'delete', 'report'] as const;

export const PHASES: Record<SwitchAction, readonly string[]> = {
  switch: SWITCH_PHASES,
  undo: UNDO_PHASES,
  delete: DELETE_PHASES,
};

/** Before these, a running switch can still be cancelled (nothing renamed yet). */
const CANCELLABLE: Record<SwitchAction, readonly string[]> = {
  switch: ['hold', 'late', 'from_library', 'check', 'links', 'snapshot'],
  undo: [],
  delete: ['check', 'files', 'inventory', 'list'],
};

/** The reader's side, given by the server at start (the cleanup has no other way in). */
export interface SwitchReader {
  /** ttsu.db. */
  db: Database.Database;
  setHold(kind: 'switch' | 'merge_wait', on: boolean): void;
  held(kind: 'switch' | 'merge_wait'): boolean;
  /** Waits for a scan pass that is running. */
  scanIdle(): Promise<void>;
  /** The hold's own scan of every library. Throws when a library's scan failed. */
  scanForSwitch(): Promise<void>;
  /** Folders the running scan has indexed. */
  scanned(): number;
  /** Starts a regular scan pass (after the hold). */
  wakeScan(): void;
  /** Merges that waited start (after the hold). */
  resumeMerges(): void;
  /** What keeps the switch from starting: merges, PC jobs, unfinished writes. */
  busy(): string[];
  /** A verified copy of ttsu.db in its snapshots folder; returns its file name. */
  snapshot(label: string): Promise<string>;
}

export interface SwitchDeps {
  db: Database.Database;
  stage6: AudioStage6;
  roots: BuildRoots;
  lock: DiskLock;
  /**
   * Audiobookshelf's libraries and their folders (a GET-only snapshot), or null when it can't
   * be asked (no address or key, or it didn't answer).
   */
  absLibraries: () => Promise<{ name: string | null; folders: string[] }[] | null>;
  log?: (m: string) => void;
}

export interface SwitchProgress {
  runId: string;
  action: SwitchAction;
  phase: string;
  startedAt: number;
  finishedAt: number | null;
  phaseStartedAt: number;
  phaseTimes: Record<string, number>;
  /** The step now and how far it is (the card's bar and time left). */
  current: { step: string; done: number; total: number; startedAt: number } | null;
  /** What the phase waits for now (Calibre, the sidecar), or null. */
  waiting: string | null;
  lateArrivals: string[];
  fromLibrary: { rel: string; dst: string; link: string }[];
  /**
   * The library-only files' SHA-256, read by the server through the read-only view (stage 1
   * hashed only files whose size occurs in the torrents); the sidecar reads each again and
   * links it only when it is the same.
   */
  fromLibraryHashes: Record<string, string>;
  check: {
    passed: boolean;
    items: { key: string; name: string; ok: boolean | null; detail: string }[];
  } | null;
  links: Record<string, number> | null;
  linksBefore: number | null;
  snapshot: string | null;
  renamed: { from: string; to: string }[];
  generatedRenamed: boolean;
  rescan: { folders: number; ms: number } | null;
  verify: {
    links: number;
    resolved: number;
    notResolved: number;
    playableLost: number;
    countBefore: number;
    countAfter: number;
    passed: boolean;
  } | null;
  restored: { restored: number; listed: number } | null;
  files: {
    total: number;
    same: number;
    different: number;
    noTwin: number;
    unreadable: number;
    bytes: number;
  } | null;
  inventory: { copied: string[] } | null;
  deletion: {
    entries: number;
    files: number;
    dirs: number;
    bytes: number;
    freed: number;
    freeBefore: number | null;
    freeAfter: number | null;
    unknown: string[];
  } | null;
  /** Earlier runs (switch, undo, delete): when and how they ended. */
  history: { action: SwitchAction; startedAt: number; finishedAt: number; result: string }[];
  error: string | null;
}

interface SwitchRow {
  state: SwitchState;
  progress_json: string;
  pause_reason: string | null;
  pause_detail: string | null;
}

interface OpRow {
  id: number;
  run_id: string;
  phase: string;
  seq: number;
  kind: 'rename' | 'from_library' | 'folder' | 'link' | 'metadata' | 'inventory' | 'delete';
  book_id: number | null;
  src_rel: string | null;
  src_raw: string | null;
  dst: string;
  size: number | null;
  mtime_ms: number | null;
  dev: number | null;
  ino: number | null;
  sha256: string | null;
  is_dir: number;
  state: 'planned' | 'claimed' | 'done' | 'failed';
  result_json: string | null;
}

export interface SwitchBatch {
  id: number;
  kind: 'switch';
  leaseSeconds: number;
  ops: {
    id: number;
    kind: OpRow['kind'];
    dst: string;
    src: { rel: string; raw: string | null } | null;
    size: number | null;
    mtimeMs: number | null;
    dev: number | null;
    ino: number | null;
    bytes: string | null;
    sha256: string | null;
    dir: boolean;
  }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function emptyProgress(action: SwitchAction, history: SwitchProgress['history']): SwitchProgress {
  const now = Date.now();
  return {
    runId: randomUUID(),
    action,
    phase: PHASES[action][0],
    startedAt: now,
    finishedAt: null,
    phaseStartedAt: now,
    phaseTimes: {},
    current: null,
    waiting: null,
    lateArrivals: [],
    fromLibrary: [],
    fromLibraryHashes: {},
    check: null,
    links: null,
    linksBefore: null,
    snapshot: null,
    renamed: [],
    generatedRenamed: false,
    rescan: null,
    verify: null,
    restored: null,
    files: null,
    inventory: null,
    deletion: null,
    history,
    error: null,
  };
}

export class AudioSwitch {
  private readonly db: Database.Database;
  private reader: SwitchReader | null = null;
  /** True while a sidecar phase may hand out batches (the switch holds the disk lock). */
  private handing = false;

  constructor(private readonly deps: SwitchDeps) {
    this.db = deps.db;
  }

  /** The reader's side (set by the server once the audiobook services exist). */
  attachReader(reader: SwitchReader): void {
    this.reader = reader;
    this.syncMergeWait();
  }

  /**
   * Merges wait from the deploy until the switch is done (decided 2026-11-20): on while the
   * switch has not been done (or was undone), off once switched.
   */
  syncMergeWait(): void {
    const r = this.reader;
    if (!r) return;
    const st = this.row().state;
    const switched =
      st === 'deleted' ||
      (st === 'switched' && !this.isRunning()) ||
      (st === 'running' && this.progress()?.action === 'delete');
    r.setHold('merge_wait', !switched);
  }

  // -------------------------------------------------------------------------------------------
  // state

  private row(): SwitchRow {
    return this.db
      .prepare(
        'SELECT state, progress_json, pause_reason, pause_detail FROM audio_switch WHERE id = 1',
      )
      .get() as SwitchRow;
  }

  state(): SwitchState {
    return this.row().state;
  }

  progress(): SwitchProgress | null {
    const p = JSON.parse(this.row().progress_json) as Partial<SwitchProgress>;
    return p.runId ? (p as SwitchProgress) : null;
  }

  pause(): { reason: string; detail: string | null } | null {
    const r = this.row();
    return r.pause_reason ? { reason: r.pause_reason, detail: r.pause_detail } : null;
  }

  isRunning(): boolean {
    return this.row().state === 'running';
  }

  private save(p: SwitchProgress, state?: SwitchState): void {
    if (state)
      this.db
        .prepare(
          'UPDATE audio_switch SET state = ?, progress_json = ?, updated_at = ? WHERE id = 1',
        )
        .run(state, JSON.stringify(p), Date.now());
    else
      this.db
        .prepare('UPDATE audio_switch SET progress_json = ?, updated_at = ? WHERE id = 1')
        .run(JSON.stringify(p), Date.now());
  }

  private setPause(reason: string | null, detail: string | null = null): void {
    this.db
      .prepare(
        'UPDATE audio_switch SET pause_reason = ?, pause_detail = ?, updated_at = ? WHERE id = 1',
      )
      .run(reason, detail ? detail.slice(0, 2000) : null, Date.now());
    if (reason) this.deps.log?.(`Audiobooks switch: paused (${reason}): ${detail ?? ''}`);
  }

  private setPhase(p: SwitchProgress, phase: string): void {
    const now = Date.now();
    p.phaseTimes[p.phase] = (p.phaseTimes[p.phase] ?? 0) + (now - p.phaseStartedAt);
    p.phase = phase;
    p.phaseStartedAt = now;
    p.current = null;
    p.waiting = null;
    this.save(p);
    this.deps.log?.(`Audiobooks switch (${p.action}): ${phase}`);
  }

  private bar(p: SwitchProgress, step: string | null, done = 0, total = 0): void {
    if (step === null) p.current = null;
    else if (p.current?.step === step) p.current = { ...p.current, done, total };
    else p.current = { step, done, total, startedAt: Date.now() };
    this.save(p);
  }

  // -------------------------------------------------------------------------------------------
  // what may start

  private stage6Ready(): { ok: boolean; why: string | null; check: Stage6Check | null } {
    const p6 = this.deps.stage6.progress();
    if (!p6 || p6.phase !== 'done')
      return { ok: false, why: 'Stage 6 has not built and checked japanese-new', check: null };
    if (!p6.check?.passed)
      return { ok: false, why: 'Stage 6’s check has not passed', check: p6.check };
    return { ok: true, why: null, check: p6.check };
  }

  /** The library's folder name (the last part of CLEANUP_AUDIO_LIBRARY_DIR). */
  private libraryFolder(): string {
    return path.basename(this.deps.roots.library);
  }

  /** Why `action` can't start now (empty: it can). Audiobookshelf is asked in start(). */
  refusals(action: SwitchAction): string[] {
    const out: string[] = [];
    const st = this.row().state;
    if (st === 'running') out.push('The switch is working (or paused): finish or cancel it first');
    if (!this.deps.roots.media)
      out.push('CLEANUP_AUDIO_MEDIA_DIR is not set: the folders can’t be read');
    if (!this.reader) out.push('The reader’s audiobooks are not set up on this server');
    if (!this.deps.stage6.sidecar().online) out.push('The linking sidecar is offline');
    if (action === 'switch') {
      if (st !== 'none') out.push('Already switched');
      const r = this.stage6Ready();
      if (!r.ok) out.push(r.why!);
      if (this.libraryFolder() !== 'japanese')
        out.push(`The library folder is ${this.libraryFolder()}, not japanese`);
      const moves = this.moveCounts();
      if (moves.unaccounted)
        out.push(`${moves.unaccounted} audio files of the library are unaccounted for`);
      if (moves.reader_written)
        out.push(
          `${moves.reader_written} audio files were written by the reader (merges): decide first`,
        );
      if (this.reader) out.push(...this.reader.busy());
    } else if (action === 'undo') {
      if (st !== 'switched') out.push('Nothing to undo (not switched, or japanese-old is deleted)');
      if (this.reader) out.push(...this.reader.busy());
    } else if (action === 'delete') {
      if (st !== 'switched') out.push('Not switched');
    }
    return out;
  }

  private moveCounts(): Record<string, number> {
    const a = this.deps.stage6.progress()?.analysisId;
    const c: Record<string, number> = {};
    if (!a) return c;
    for (const r of this.db
      .prepare(
        'SELECT outcome, COUNT(*) AS n FROM audio_build_moves WHERE analysis_id = ? GROUP BY outcome',
      )
      .all(a) as { outcome: string; n: number }[])
      c[r.outcome] = r.n;
    return c;
  }

  /** Audiobookshelf libraries on the folders the action touches (asked now, GET only). */
  private async absProblems(action: SwitchAction): Promise<string[]> {
    const libs = await this.deps.absLibraries().catch(() => null);
    if (!libs)
      return [
        'Audiobookshelf could not be asked which folders its libraries use (check the address and key in Settings)',
      ];
    const names = action === 'delete' ? ['japanese-old'] : SWITCH_FOLDERS;
    const out: string[] = [];
    for (const l of libs)
      for (const f of l.folders) {
        const last = f.replace(/\/+$/, '').split('/').pop() ?? '';
        if (names.includes(last))
          out.push(
            `Audiobookshelf’s library “${l.name ?? '?'}” uses ${f}: delete that library in Audiobookshelf first`,
          );
      }
    return out;
  }

  /** Starts `action` (the page asked first). Throws with the reasons when it can't. */
  async start(action: SwitchAction): Promise<void> {
    const refusals = this.refusals(action);
    if (!refusals.length) refusals.push(...(await this.absProblems(action)));
    if (action === 'switch' && !refusals.length) {
      const media = this.deps.roots.media!;
      if (await lstatEntry(path.join(media, 'japanese-old')))
        refusals.push('media/audiobooks/japanese-old exists already');
      if (await lstatEntry(path.join(media, 'japanese-generated')))
        refusals.push(
          'media/audiobooks/japanese-generated exists (a TTS audiobook was made): its folder must move into the torrents first (checklist 2.3)',
        );
      if (!(await lstatEntry(path.join(media, AREA_FOLDERS.main))))
        refusals.push(`media/audiobooks/${AREA_FOLDERS.main} is missing`);
    }
    if (refusals.length) throw new Error(refusals.join('; '));
    const history = this.progress()?.history ?? [];
    const p = emptyProgress(action, history);
    if (action !== 'delete') {
      // The hold first, in the same turn as the busy check (nothing can start in between).
      this.reader!.setHold('switch', true);
      this.reader!.setHold('merge_wait', true);
      p.linksBefore = this.linkRows().length;
    }
    this.setPause(null);
    this.save(p, 'running');
    this.deps.log?.(`Audiobooks switch: ${action} started (run ${p.runId})`);
  }

  /** Clears a pause (the page's "Continue"); the phase runs again from its start. */
  resume(): void {
    if (!this.isRunning()) throw new Error('Nothing is paused');
    this.setPause(null);
  }

  /** Cancels a run that hasn't renamed or deleted anything yet. */
  cancel(): void {
    const p = this.progress();
    if (!p || !this.isRunning()) throw new Error('Nothing is running');
    if (!CANCELLABLE[p.action].includes(p.phase))
      throw new Error(
        p.action === 'switch'
          ? 'The folders are renamed already: use Undo once the switch has finished'
          : 'This step can’t be cancelled',
      );
    this.giveBack();
    this.db
      .prepare(
        `UPDATE audio_switch_ops SET state = 'failed', result_json = '{"error":"cancelled"}' WHERE run_id = ? AND state IN ('planned','claimed')`,
      )
      .run(p.runId);
    p.history.push({
      action: p.action,
      startedAt: p.startedAt,
      finishedAt: Date.now(),
      result: 'cancelled',
    });
    p.finishedAt = Date.now();
    this.setPause(null);
    this.save(p, p.action === 'delete' ? 'switched' : 'none');
    if (p.action !== 'delete') this.reader?.setHold('switch', false);
    this.syncMergeWait();
    this.reader?.wakeScan();
    this.deps.log?.(`Audiobooks switch: ${p.action} cancelled`);
  }

  // -------------------------------------------------------------------------------------------
  // the sidecar

  /** The sidecar should poll fast (a phase has work for it). */
  active(): boolean {
    const p = this.progress();
    return (
      this.isRunning() &&
      !!p &&
      ['from_library', 'rename', 'inventory', 'delete'].includes(p.phase) &&
      !this.pause()
    );
  }

  expireLeases(now = Date.now()): void {
    const p = this.progress();
    if (!p) return;
    const expired = this.db
      .prepare(
        `SELECT id FROM audio_switch_batches WHERE run_id = ? AND state = 'claimed' AND lease_until < ?`,
      )
      .all(p.runId, now) as { id: number }[];
    if (!expired.length) return;
    this.db.transaction(() => {
      for (const b of expired) {
        this.db.prepare(`UPDATE audio_switch_batches SET state = 'expired' WHERE id = ?`).run(b.id);
        this.db
          .prepare(
            `UPDATE audio_switch_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
          )
          .run(b.id);
      }
    })();
  }

  inFlight(now = Date.now()): boolean {
    const p = this.progress();
    if (!p) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM audio_switch_batches WHERE run_id = ? AND state = 'claimed' AND lease_until >= ? LIMIT 1`,
        )
        .get(p.runId, now) !== undefined
    );
  }

  /** The next batch for the sidecar, or null. */
  claim(now = Date.now()): SwitchBatch | null {
    this.expireLeases(now);
    const p = this.progress();
    if (!p || !this.isRunning() || this.pause()) return null;
    if (!this.handing || !this.deps.lock.holds(OWNER) || this.deps.lock.shouldYield(OWNER))
      return null;
    if (this.inFlight(now)) return null;
    const s = getSettings(this.db).audiobooks;
    const limit = p.phase === 'delete' ? s.deleteBatchOps : 50;
    const rows = this.db
      .prepare(
        `SELECT * FROM audio_switch_ops WHERE run_id = ? AND phase = ? AND state = 'planned'
         ORDER BY seq LIMIT ?`,
      )
      .all(p.runId, p.phase, limit) as OpRow[];
    if (!rows.length) return null;
    const lease = s.switchLeaseSeconds;
    const rowId = Number(
      this.db
        .prepare(
          `INSERT INTO audio_switch_batches (run_id, state, ops, claimed_at, lease_until)
           VALUES (?, 'claimed', ?, ?, ?)`,
        )
        .run(p.runId, rows.length, now, now + lease * 1000).lastInsertRowid,
    );
    this.db.transaction(() => {
      const upd = this.db.prepare(
        `UPDATE audio_switch_ops SET state = 'claimed', batch_id = ? WHERE id = ?`,
      );
      for (const r of rows) upd.run(rowId, r.id);
    })();
    const metaOf = this.db.prepare('SELECT metadata FROM audio_build_books WHERE id = ?');
    return {
      id: SWITCH_BATCH_BASE + rowId,
      kind: 'switch',
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
        sha256: r.sha256,
        dir: r.is_dir === 1,
      })),
    };
  }

  /** The sidecar's results of a switch batch (`batchId` as handed out). */
  report(
    batchId: number,
    results: (LinkOpResult & { freed?: number; sha256?: string; size?: number })[],
    now = Date.now(),
  ): { accepted: number } {
    const p = this.progress();
    if (!p) throw new Error('No switch run');
    const rowId = batchId - SWITCH_BATCH_BASE;
    const batch = this.db
      .prepare('SELECT id FROM audio_switch_batches WHERE id = ? AND run_id = ?')
      .get(rowId, p.runId) as { id: number } | undefined;
    if (!batch) throw new Error('No such batch');
    let accepted = 0;
    let failure: string | null = null;
    this.db.transaction(() => {
      const ok = this.db.prepare(
        `UPDATE audio_switch_ops SET state = 'done', result_json = ?, done_at = ?
         WHERE id = ? AND batch_id = ? AND state IN ('claimed', 'planned')`,
      );
      const bad = this.db.prepare(
        `UPDATE audio_switch_ops SET state = 'failed', result_json = ?, done_at = ?
         WHERE id = ? AND batch_id = ? AND state IN ('claimed', 'planned')`,
      );
      for (const r of results) {
        const json = JSON.stringify({
          existed: r.existed ?? false,
          dev: r.dev ?? null,
          ino: r.ino ?? null,
          freed: r.freed ?? null,
          sha256: r.sha256 ?? null,
          size: r.size ?? null,
          error: r.error ?? null,
        });
        if (r.ok) accepted += ok.run(json, now, r.id, rowId).changes;
        else {
          accepted += bad.run(json, now, r.id, rowId).changes;
          failure ??= `${r.error ?? 'failed'} (operation ${r.id})`;
        }
      }
      this.db
        .prepare(
          `UPDATE audio_switch_ops SET state = 'planned', batch_id = NULL WHERE batch_id = ? AND state = 'claimed'`,
        )
        .run(rowId);
      this.db
        .prepare(`UPDATE audio_switch_batches SET state = 'reported', reported_at = ? WHERE id = ?`)
        .run(now, rowId);
    })();
    if (failure) this.setPause('sidecar_failed', failure);
    return { accepted };
  }

  /** Stops handing out batches and gives the disk lock back once nothing is out. */
  giveBack(): void {
    this.handing = false;
    if (this.deps.lock.holds(OWNER) && !this.inFlight()) this.deps.lock.release(OWNER);
  }

  isHanding(): boolean {
    return this.handing;
  }

  private opCounts(
    p: SwitchProgress,
    phase: string,
  ): { total: number; done: number; failed: number } {
    const rows = this.db
      .prepare(
        `SELECT state, COUNT(*) AS n FROM audio_switch_ops WHERE run_id = ? AND phase = ? GROUP BY state`,
      )
      .all(p.runId, phase) as { state: string; n: number }[];
    const n = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
    return { total: rows.reduce((x, r) => x + r.n, 0), done: n('done'), failed: n('failed') };
  }

  private planOps(
    p: SwitchProgress,
    phase: string,
    ops: (Omit<OpRow, 'id' | 'run_id' | 'phase' | 'state' | 'result_json' | 'book_id'> & {
      book_id?: number | null;
    })[],
  ): void {
    const ins = this.db.prepare(
      `INSERT INTO audio_switch_ops (run_id, phase, seq, kind, book_id, src_rel, src_raw, dst, size,
         mtime_ms, dev, ino, sha256, is_dir) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < ops.length; i += 1000)
      this.db.transaction(() => {
        for (const o of ops.slice(i, i + 1000))
          ins.run(
            p.runId,
            phase,
            o.seq,
            o.kind,
            o.book_id ?? null,
            o.src_rel,
            o.src_raw,
            o.dst,
            o.size,
            o.mtime_ms,
            o.dev,
            o.ino,
            o.sha256,
            o.is_dir,
          );
      })();
  }

  private hasOps(p: SwitchProgress, phase: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM audio_switch_ops WHERE run_id = ? AND phase = ? LIMIT 1')
        .get(p.runId, phase) !== undefined
    );
  }

  /**
   * Runs the planned operations of `phase` through the sidecar under the disk lock (Calibre
   * first). Returns 'done', 'wait' (call again) or 'paused'.
   */
  private async sidecarPhase(
    p: SwitchProgress,
    phase: string,
    stop: () => boolean,
    label: string,
  ): Promise<'done' | 'wait' | 'paused'> {
    this.expireLeases();
    const c = this.opCounts(p, phase);
    this.bar(p, label, c.done, c.total);
    if (c.failed > 0 || this.pause()) {
      this.giveBack();
      if (!this.pause()) this.setPause('sidecar_failed', 'An operation failed (see Details)');
      return 'paused';
    }
    if (c.done === c.total && !this.inFlight()) {
      this.giveBack();
      return 'done';
    }
    if (stop()) {
      this.giveBack();
      return 'wait';
    }
    if (!this.deps.stage6.sidecar().online) {
      p.waiting = 'Waiting for the linking sidecar (it is offline)';
      this.save(p);
      this.giveBack();
      await sleep(1000);
      return 'wait';
    }
    if (!this.deps.lock.holds(OWNER)) {
      p.waiting = this.deps.lock.calibreBusy()
        ? 'Waiting while the Calibre cleanup uses the disk'
        : null;
      this.save(p);
      const until = Date.now() + 2000;
      const got = await this.deps.lock.acquire(OWNER, 'audio', () => stop() || Date.now() > until);
      if (!got) return 'wait';
    }
    if (this.deps.lock.shouldYield(OWNER)) {
      this.handing = false;
      if (!this.inFlight()) this.deps.lock.release(OWNER);
      await sleep(500);
      return 'wait';
    }
    p.waiting = null;
    this.handing = true;
    await sleep(250);
    return 'wait';
  }

  /** Waits while the Calibre cleanup uses the disk (shown on the card). False when stopped. */
  private async calibreFirst(p: SwitchProgress, stop: () => boolean): Promise<boolean> {
    while (this.deps.lock.calibreBusy()) {
      if (stop()) return false;
      if (p.waiting === null) {
        p.waiting = 'Waiting while the Calibre cleanup uses the disk';
        this.save(p);
      }
      await sleep(1000);
    }
    if (p.waiting !== null) {
      p.waiting = null;
      this.save(p);
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // the loop

  /** One step (the service calls it while running and not paused). True: nothing more now. */
  /** True while a step runs: steps never overlap (the service's loop and a caller's). */
  private stepping = false;

  async step(stop: () => boolean): Promise<boolean> {
    if (this.stepping) return true;
    this.stepping = true;
    try {
      return await this.stepOnce(stop);
    } finally {
      this.stepping = false;
    }
  }

  private async stepOnce(stop: () => boolean): Promise<boolean> {
    const p = this.progress();
    if (!p || !this.isRunning()) return true;
    if (this.pause()) {
      this.giveBack();
      return true;
    }
    try {
      const next = await this.runPhase(p, stop);
      if (next === 'stay') return stop();
      if (next === 'paused') return true;
      const phases = PHASES[p.action];
      const i = phases.indexOf(p.phase);
      if (i < phases.length - 1) {
        this.setPhase(p, phases[i + 1]);
        return false;
      }
      this.finish(p);
      return true;
    } catch (err) {
      this.giveBack();
      p.error = (err as Error).message.slice(0, 500);
      this.save(p);
      this.setPause('failed', p.error);
      return true;
    }
  }

  private finish(p: SwitchProgress): void {
    p.phaseTimes[p.phase] = (p.phaseTimes[p.phase] ?? 0) + (Date.now() - p.phaseStartedAt);
    p.finishedAt = Date.now();
    p.current = null;
    p.waiting = null;
    p.history.push({
      action: p.action,
      startedAt: p.startedAt,
      finishedAt: p.finishedAt,
      result: 'done',
    });
    const state: SwitchState =
      p.action === 'switch' ? 'switched' : p.action === 'undo' ? 'none' : 'deleted';
    this.save(p, state);
    this.syncMergeWait();
    this.deps.log?.(`Audiobooks switch: ${p.action} done`);
  }

  private async runPhase(
    p: SwitchProgress,
    stop: () => boolean,
  ): Promise<'next' | 'stay' | 'paused'> {
    const media = this.deps.roots.media!;
    const r = this.reader!;
    if (p.action !== 'delete' && !r.held('switch')) r.setHold('switch', true);
    switch (`${p.action}:${p.phase}`) {
      case 'switch:hold':
      case 'undo:hold':
        this.bar(p, 'waiting for the reader’s scan to finish');
        await r.scanIdle();
        return 'next';
      case 'switch:late':
        return this.lateArrivals(p, stop);
      case 'switch:from_library':
        return this.fromLibrary(p, stop);
      case 'switch:check':
        return this.check(p, stop, false);
      case 'switch:links':
        return this.planLinks(p);
      case 'switch:snapshot':
        this.bar(p, 'a copy of ttsu.db');
        p.snapshot = await r.snapshot('switch');
        this.save(p);
        return 'next';
      case 'switch:rename':
      case 'undo:rename':
        return this.renames(p, stop, p.action === 'undo');
      case 'switch:remap':
        return this.remap(p);
      case 'undo:restore':
        return this.restore(p);
      case 'switch:rescan':
      case 'undo:rescan': {
        if (!(await this.calibreFirst(p, stop))) return 'stay';
        const started = Date.now();
        const expected = this.expectedFolders(p.action === 'undo');
        this.bar(p, 'the reader’s scan of the audiobooks', 0, expected);
        const timer = setInterval(
          () => this.bar(p, 'the reader’s scan of the audiobooks', r.scanned(), expected),
          2000,
        );
        try {
          await r.scanForSwitch();
        } finally {
          clearInterval(timer);
        }
        p.rescan = { folders: r.scanned(), ms: Date.now() - started };
        this.save(p);
        return 'next';
      }
      case 'switch:verify':
      case 'undo:verify':
        return this.verifyLinks(p);
      case 'switch:release':
      case 'undo:release':
        r.setHold('switch', false);
        r.setHold('merge_wait', p.action === 'undo');
        r.resumeMerges();
        r.wakeScan();
        return 'next';
      case 'delete:check':
        return this.check(p, stop, true);
      case 'delete:files':
        return this.rereadFiles(p, stop, media);
      case 'delete:inventory':
        return this.inventory(p, stop);
      case 'delete:list':
        return this.deleteList(p, stop, media);
      case 'delete:delete': {
        const d = await this.sidecarPhase(p, 'delete', stop, 'deleting japanese-old');
        if (d !== 'done') return d === 'paused' ? 'paused' : 'stay';
        return 'next';
      }
      case 'delete:report':
        return this.deleteReport(p, stop);
    }
    throw new Error(`Unknown phase ${p.action}:${p.phase}`);
  }

  // -------------------------------------------------------------------------------------------
  // switch phases

  /** Stage 1's audio files of the library (relative to the library folder). */
  private knownLibraryFiles(): Set<string> {
    return new Set(
      (
        this.db
          .prepare(`SELECT rel_path FROM audio_files WHERE root = 'library' AND gone_at IS NULL`)
          .all() as { rel_path: string }[]
      ).map((x) => x.rel_path),
    );
  }

  private async lateArrivals(
    p: SwitchProgress,
    stop: () => boolean,
  ): Promise<'next' | 'stay' | 'paused'> {
    if (!(await this.calibreFirst(p, stop))) return 'stay';
    const media = this.deps.roots.media!;
    const expected = this.knownLibraryFiles().size;
    this.bar(p, 'listing japanese (files that arrived after stage 1)', 0, expected);
    const out = await walkTree(path.join(media, 'japanese'), {
      shouldStop: stop,
      shouldPause: () => this.deps.lock.calibreBusy(),
      onEntries: (n) => {
        if (n % 2000 === 0)
          this.bar(p, 'listing japanese (files that arrived after stage 1)', n, expected);
      },
    });
    if (!out) return 'stay';
    const known = this.knownLibraryFiles();
    p.lateArrivals = out.entries
      .filter((e) => !e.isDir && AUDIO_EXT.test(e.rel) && !known.has(e.rel))
      .map((e) => e.rel)
      .slice(0, 500);
    this.save(p);
    if (p.lateArrivals.length) {
      this.setPause(
        'late_arrivals',
        `${p.lateArrivals.length} audio files arrived in japanese after stage 1 (e.g. ${p.lateArrivals[0]}): they would stay in japanese-old. Decide what to do with them, then cancel or continue.`,
      );
      return 'paused';
    }
    return 'next';
  }

  /** The library-only files of the move list, with what stage 1 saw. */
  private libraryOnly(): {
    rel: string;
    raw: string | null;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    sha256: string | null;
    newPath: string;
  }[] {
    const a = this.deps.stage6.progress()?.analysisId;
    return this.db
      .prepare(
        `SELECT f.rel_path AS rel, f.rel_path_raw AS raw, f.size, f.mtime_ms AS mtimeMs, f.dev, f.ino,
                  f.sha256, m.new_path AS newPath
           FROM audio_build_moves m JOIN audio_files f ON f.id = m.file_id
           WHERE m.analysis_id = ? AND m.outcome = 'library_only_pending' ORDER BY m.old_path`,
      )
      .all(a) as ReturnType<AudioSwitch['libraryOnly']>;
  }

  /** `_from-library/<the file's folder name>/<file>` for each library-only file (unique). */
  private fromLibraryPaths(): {
    rel: string;
    raw: string | null;
    dst: string;
    newPath: string;
    size: number;
    mtimeMs: number;
    dev: number;
    ino: number;
    sha256: string | null;
  }[] {
    const used = new Set<string>();
    return this.libraryOnly().map((f) => {
      const folder = baseOf(dirOf(f.rel)) || 'library';
      let dst = `_from-library/${folder}/${baseOf(f.rel)}`;
      for (let n = 2; used.has(dst); n++) dst = `_from-library/${folder} (${n})/${baseOf(f.rel)}`;
      used.add(dst);
      return { ...f, dst };
    });
  }

  private async fromLibrary(
    p: SwitchProgress,
    stop: () => boolean,
  ): Promise<'next' | 'stay' | 'paused'> {
    if (!this.hasOps(p, 'from_library')) {
      const files = this.fromLibraryPaths();
      const problems = files.filter((f) => f.raw !== null).map((f) => f.rel);
      if (problems.length) {
        this.setPause(
          'library_only',
          `Library-only files whose names are not UTF-8: ${problems.join(', ')}`,
        );
        return 'paused';
      }
      // 1. Each file read in full by the server (read-only view, under the disk lock).
      p.fromLibraryHashes ??= {};
      const media = this.deps.roots.media!;
      const pacer = new ReadPacer(0);
      const total = files.reduce((x, f) => x + f.size, 0);
      for (const f of files) {
        if (p.fromLibraryHashes[f.rel]) continue;
        const done = files
          .filter((x) => p.fromLibraryHashes[x.rel])
          .reduce((x, g) => x + g.size, 0);
        this.bar(
          p,
          'the library-only files read (MB)',
          Math.round(done / 1e6),
          Math.round(total / 1e6),
        );
        if (stop()) {
          this.deps.lock.release(OWNER);
          return 'stay';
        }
        if (!(await this.deps.lock.acquire(OWNER, 'audio', stop))) return 'stay';
        const h = await hashFile(
          insideRoot(path.join(media, 'japanese'), f.rel),
          pacer,
          () => this.deps.lock.shouldYield(OWNER) || stop(),
        );
        this.deps.lock.release(OWNER);
        if (h === null) {
          await sleep(1000);
          return 'stay';
        }
        if (h.bytes !== f.size || (f.sha256 && f.sha256 !== h.sha256)) {
          this.setPause('library_only', `A library-only file changed since stage 1: ${f.rel}`);
          return 'paused';
        }
        p.fromLibraryHashes[f.rel] = h.sha256;
        this.save(p);
      }
      const ops: Parameters<AudioSwitch['planOps']>[2] = [];
      let seq = 0;
      for (const f of files)
        ops.push({
          seq: ++seq,
          kind: 'from_library',
          src_rel: `japanese/${f.rel}`,
          src_raw: null,
          dst: f.dst,
          size: f.size,
          mtime_ms: f.mtimeMs,
          dev: f.dev,
          ino: f.ino,
          sha256: p.fromLibraryHashes[f.rel],
          is_dir: 0,
        });
      // Their books' folders and metadata.json (the build made none for a pending book).
      const extra = this.pendingBookEntries();
      for (const d of extra.folders)
        ops.push({
          seq: ++seq,
          kind: 'folder',
          src_rel: null,
          src_raw: null,
          dst: d,
          size: null,
          mtime_ms: null,
          dev: null,
          ino: null,
          sha256: null,
          is_dir: 1,
        });
      for (const f of files)
        ops.push({
          seq: ++seq,
          kind: 'link',
          src_rel: f.dst,
          src_raw: null,
          dst: f.newPath,
          size: f.size,
          mtime_ms: f.mtimeMs,
          dev: f.dev,
          ino: f.ino,
          sha256: null,
          is_dir: 0,
        });
      for (const m of extra.metadata)
        ops.push({
          seq: ++seq,
          kind: 'metadata',
          book_id: m.bookId,
          src_rel: null,
          src_raw: null,
          dst: m.dst,
          size: null,
          mtime_ms: null,
          dev: null,
          ino: null,
          sha256: null,
          is_dir: 0,
        });
      this.planOps(p, 'from_library', ops);
      p.fromLibrary = files.map((f) => ({ rel: f.rel, dst: f.dst, link: f.newPath }));
      this.save(p);
    }
    const d = await this.sidecarPhase(
      p,
      'from_library',
      stop,
      'the library-only files (read again, then linked)',
    );
    if (d === 'paused') return 'paused';
    return d === 'done' ? 'next' : 'stay';
  }

  /**
   * The library-only (pending) books' folders the build didn't make (each level, parents
   * first) and their metadata.json files.
   */
  private pendingBookEntries(): { folders: string[]; metadata: { bookId: number; dst: string }[] } {
    const a = this.deps.stage6.progress()?.analysisId;
    const made = new Set(
      (
        this.db
          .prepare(`SELECT dst FROM audio_build_ops WHERE analysis_id = ? AND kind = 'folder'`)
          .all(a) as { dst: string }[]
      ).map((x) => x.dst),
    );
    const folders: string[] = [];
    const metadata: { bookId: number; dst: string }[] = [];
    for (const b of this.db
      .prepare(
        `SELECT id, folder FROM audio_build_books WHERE analysis_id = ? AND state = 'pending' ORDER BY folder`,
      )
      .all(a) as { id: number; folder: string }[]) {
      const parts = b.folder.split('/');
      for (let i = 2; i <= parts.length; i++) {
        const d = parts.slice(0, i).join('/');
        if (!made.has(d) && !folders.includes(d)) folders.push(d);
      }
      metadata.push({ bookId: b.id, dst: `${b.folder}/metadata.json` });
    }
    return { folders, metadata };
  }

  /** What stage 6's check is told about the switch's own additions. */
  private checkContext(switched: boolean): CheckContext {
    const media = this.deps.roots.media!;
    const files = this.fromLibraryPaths();
    const pending = this.pendingBookEntries();
    const torrentsAdded = new Map<string, { dev: number; ino: number } | null>();
    const libraryLinks = new Map<string, number>();
    for (const f of files) {
      const parts = f.dst.split('/');
      for (let i = 1; i < parts.length; i++) torrentsAdded.set(parts.slice(0, i).join('/'), null);
      torrentsAdded.set(f.dst, { dev: f.dev, ino: f.ino });
      libraryLinks.set(f.rel, 2);
    }
    return {
      areas: switched
        ? { [AREA_FOLDERS.main]: 'japanese', [AREA_FOLDERS.ai]: 'japanese-generated' }
        : { [AREA_FOLDERS.main]: AREA_FOLDERS.main, [AREA_FOLDERS.ai]: AREA_FOLDERS.ai },
      libraryRoot: path.join(media, switched ? 'japanese-old' : 'japanese'),
      extraOps: [
        ...pending.folders.map((d) => ({ kind: 'folder' as const, dst: d, dev: null, ino: null })),
        ...files.map((f) => ({ kind: 'link' as const, dst: f.newPath, dev: f.dev, ino: f.ino })),
        ...pending.metadata.map((m) => ({
          kind: 'metadata' as const,
          dst: m.dst,
          dev: null,
          ino: null,
        })),
      ],
      torrentsAdded,
      libraryLinks,
      switched,
    };
  }

  private async check(
    p: SwitchProgress,
    stop: () => boolean,
    switched: boolean,
  ): Promise<'next' | 'stay' | 'paused'> {
    if (!(await this.calibreFirst(p, stop))) return 'stay';
    this.bar(p, 'stage 6’s check (the walks and the new folders)');
    const timer = setInterval(() => {
      const p6 = this.deps.stage6.progress();
      const c =
        p6?.checking ??
        (p6?.walk.current
          ? {
              step: 'listing the torrents and the library',
              ...p6.walk.current,
              total: p6.walk.current.expected,
            }
          : null);
      if (c) this.bar(p, `stage 6’s check: ${c.step}`, c.done, c.total);
    }, 2000);
    let result: Stage6Check | null;
    try {
      result = await this.deps.stage6.verify(this.checkContext(switched), stop);
    } finally {
      clearInterval(timer);
    }
    if (!result) return 'stay';
    p.check = { passed: result.passed, items: result.items };
    this.save(p);
    if (!result.passed) {
      const bad = result.items.filter((i) => i.ok === false).map((i) => `${i.name}: ${i.detail}`);
      this.setPause('check_failed', `Stage 6’s check did not pass: ${bad.join('; ')}`);
      return 'paused';
    }
    return 'next';
  }

  /** Every reader link of every user. */
  private linkRows(): (SwitchLink & {
    subtitleRelPath: string | null;
    subtitleState: 'linked' | 'none' | null;
    source: 'library' | 'migrated';
    confirmedAt: number;
  })[] {
    return this.reader!.db.prepare(
      `SELECT user_id AS userId, book_id AS bookId, state, folder_rel_path AS folderRelPath,
                  file_name AS fileName, subtitle_rel_path AS subtitleRelPath,
                  subtitle_state AS subtitleState, source, confirmed_at AS confirmedAt
           FROM audio_links ORDER BY user_id, book_id`,
    ).all() as ReturnType<AudioSwitch['linkRows']>;
  }

  /** The remap of every link (from the move list; nothing is written). */
  computeRemap(): RemapResult[] {
    const a = this.deps.stage6.progress()?.analysisId;
    const moves = this.db
      .prepare(
        `SELECT old_path AS oldPath, outcome, new_path AS newPath, kept_path AS keptPath
           FROM audio_build_moves WHERE analysis_id = ?`,
      )
      .all(a) as SwitchMove[];
    const plannedFiles = new Map<string, string[]>();
    for (const o of this.db
      .prepare(`SELECT dst FROM audio_build_ops WHERE analysis_id = ? AND kind = 'link'`)
      .all(a) as { dst: string }[]) {
      const d = dirOf(o.dst);
      plannedFiles.set(d, [...(plannedFiles.get(d) ?? []), o.dst]);
    }
    for (const m of moves)
      if (m.outcome === 'library_only_pending' && m.newPath) {
        const d = dirOf(m.newPath);
        plannedFiles.set(d, [...(plannedFiles.get(d) ?? []), m.newPath]);
      }
    return remapLinks(this.linkRows(), moves, {
      libraryFolder: this.libraryFolder(),
      plannedFiles,
    });
  }

  private planLinks(p: SwitchProgress): 'next' | 'paused' {
    this.bar(p, 'mapping the reader’s links through the move list');
    const results = this.computeRemap();
    const listed = results.filter((x) => x.outcome === 'listed');
    p.links = remapCounts(results);
    // What the links resolve to now (before anything moves).
    const db = this.reader!.db;
    const byKey = new Map(this.linkRows().map((l) => [`${l.userId}\u0000${l.bookId}`, l]));
    this.db.prepare('DELETE FROM audio_switch_links WHERE run_id = ?').run(p.runId);
    const ins = this.db.prepare(
      `INSERT INTO audio_switch_links (run_id, user_id, book_id, old_folder, old_file, new_folder,
         new_file, outcome, detail, changed, status_before, playable_before)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const x of results) {
        const l = byKey.get(`${x.userId}\u0000${x.bookId}`);
        const resolved = l ? resolveLink(db, l as AudioLink) : null;
        ins.run(
          p.runId,
          x.userId,
          x.bookId,
          x.oldFolder,
          x.oldFile,
          x.newFolder,
          x.newFile,
          x.outcome,
          x.detail,
          x.changed ? 1 : 0,
          resolved?.status ?? null,
          resolved?.playable ? 1 : 0,
        );
      }
    })();
    this.save(p);
    if (listed.length) {
      this.setPause(
        'links_unmapped',
        `${listed.length} reader links can’t be mapped to the new folders (e.g. book ${listed[0].bookId}: ${listed[0].detail}). Nothing is renamed yet: cancel, or fix them and continue.`,
      );
      return 'paused';
    }
    return 'next';
  }

  private async renames(
    p: SwitchProgress,
    stop: () => boolean,
    undo: boolean,
  ): Promise<'next' | 'stay' | 'paused'> {
    const media = this.deps.roots.media!;
    if (!this.hasOps(p, 'rename')) {
      const pairs: [string, string][] = undo
        ? [
            ['japanese', 'japanese-new'],
            ['japanese-old', 'japanese'],
          ]
        : [
            ['japanese', 'japanese-old'],
            ['japanese-new', 'japanese'],
          ];
      const last = [...p.history]
        .reverse()
        .find((h) => h.action === 'switch' && h.result === 'done');
      const switchRun = undo ? this.lastSwitchProgress() : null;
      if (!undo && (await lstatEntry(path.join(media, AREA_FOLDERS.ai))))
        pairs.push(['japanese-generated-new', 'japanese-generated']);
      if (undo && last && switchRun?.generatedRenamed) {
        const extra = await this.generatedExtras();
        if (extra.length) {
          this.setPause(
            'generated_changed',
            `japanese-generated holds files the build didn't make (e.g. ${extra[0]}): undo can't rename it back`,
          );
          return 'paused';
        }
        pairs.push(['japanese-generated', 'japanese-generated-new']);
      }
      const ops: Parameters<AudioSwitch['planOps']>[2] = [];
      // The inodes: of each folder as it is before its own rename (a rename keeps the inode).
      const ino = new Map<string, { dev: number; ino: number }>();
      for (const [from] of pairs) {
        const st = await lstatEntry(path.join(media, from));
        if (!st?.isDir) throw new Error(`media/audiobooks/${from} is missing`);
        ino.set(from, { dev: st.dev, ino: st.ino });
      }
      // The second rename's source is the first's target name: its inode is the first lstat's
      // of that name (japanese-new before), already in the map.
      pairs.forEach(([from, to], i) =>
        ops.push({
          seq: i + 1,
          kind: 'rename',
          src_rel: from,
          src_raw: null,
          dst: to,
          size: null,
          mtime_ms: null,
          dev: ino.get(from)!.dev,
          ino: ino.get(from)!.ino,
          sha256: null,
          is_dir: 1,
        }),
      );
      this.planOps(p, 'rename', ops);
      p.generatedRenamed = !undo && pairs.some(([f]) => f === 'japanese-generated-new');
      p.renamed = pairs.map(([from, to]) => ({ from, to }));
      this.save(p);
    }
    const d = await this.sidecarPhase(p, 'rename', stop, 'renaming the folders');
    if (d === 'paused') return 'paused';
    if (d !== 'done') return 'stay';
    // Checked from here too: every target is the planned folder, every source gone.
    for (const o of this.db
      .prepare(`SELECT * FROM audio_switch_ops WHERE run_id = ? AND phase = 'rename' ORDER BY seq`)
      .all(p.runId) as OpRow[]) {
      const st = await lstatEntry(path.join(media, o.dst));
      if (!st?.isDir || st.ino !== o.ino)
        throw new Error(`After the rename, ${o.dst} is not the planned folder`);
    }
    return 'next';
  }

  /** The progress of the last finished switch (for Undo). */
  private lastSwitchProgress(): { generatedRenamed: boolean; runId: string } | null {
    // The last finished switch: its links (status 'restored' rows are Undo's own).
    const r = this.db
      .prepare(
        `SELECT run_id FROM audio_switch_links WHERE outcome <> 'restored' ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as { run_id: string } | undefined;
    if (!r) return null;
    const gen =
      this.db
        .prepare(
          `SELECT 1 FROM audio_switch_ops WHERE run_id = ? AND phase = 'rename'
           AND src_rel = 'japanese-generated-new' AND state = 'done' LIMIT 1`,
        )
        .get(r.run_id) !== undefined;
    return { generatedRenamed: gen, runId: r.run_id };
  }

  /** Entries of japanese-generated the build didn't plan (a TTS book made after the switch). */
  private async generatedExtras(): Promise<string[]> {
    const media = this.deps.roots.media!;
    const a = this.deps.stage6.progress()?.analysisId;
    const planned = new Set(
      (
        this.db
          .prepare(`SELECT dst FROM audio_build_ops WHERE analysis_id = ? AND dst LIKE ?`)
          .all(a, `${AREA_FOLDERS.ai}/%`) as { dst: string }[]
      ).map((x) => afterRenames(x.dst)),
    );
    const out = await walkTree(path.join(media, 'japanese-generated'));
    return (out?.entries ?? [])
      .map((e) => `japanese-generated/${e.rel}`)
      .filter(
        (rel) =>
          !planned.has(rel) &&
          !/(^|\/)cover\.(jpe?g|png|webp)$/i.test(rel) &&
          !rel.endsWith('/metadata.json'),
      );
  }

  /** The remap, in one ttsu.db transaction (written directly; confirmed_at kept). */
  private remap(p: SwitchProgress): 'next' {
    const rows = this.db
      .prepare(`SELECT * FROM audio_switch_links WHERE run_id = ? AND changed = 1`)
      .all(p.runId) as {
      user_id: string;
      book_id: string;
      old_folder: string | null;
      old_file: string | null;
      new_folder: string | null;
      new_file: string | null;
    }[];
    this.bar(p, 'rewriting the reader’s links', 0, rows.length);
    const db = this.reader!.db;
    const upd = db.prepare(
      `UPDATE audio_links SET folder_rel_path = ?, file_name = ?
       WHERE user_id = ? AND book_id = ? AND folder_rel_path IS ? AND file_name IS ?`,
    );
    const cur = db.prepare(
      'SELECT folder_rel_path, file_name FROM audio_links WHERE user_id = ? AND book_id = ?',
    );
    db.transaction(() => {
      for (const x of rows) {
        if (
          upd.run(x.new_folder, x.new_file, x.user_id, x.book_id, x.old_folder, x.old_file).changes
        )
          continue;
        const now = cur.get(x.user_id, x.book_id) as
          | { folder_rel_path: string | null; file_name: string | null }
          | undefined;
        // Already rewritten (a restart after the transaction): fine; anything else stops it all.
        if (now && now.folder_rel_path === x.new_folder && now.file_name === x.new_file) continue;
        throw new Error(`The link of book ${x.book_id} changed during the switch`);
      }
    })();
    this.bar(p, 'rewriting the reader’s links', rows.length, rows.length);
    this.deps.log?.(`Audiobooks switch: ${rows.length} reader links rewritten`);
    return 'next';
  }

  /** Undo: the links the switch changed get their old values back (if not changed since). */
  private restore(p: SwitchProgress): 'next' {
    const last = this.lastSwitchProgress();
    if (!last) throw new Error('No switch to undo');
    const rows = this.db
      .prepare(
        `SELECT * FROM audio_switch_links WHERE run_id = ? AND changed = 1 AND restored_at IS NULL`,
      )
      .all(last.runId) as {
      user_id: string;
      book_id: string;
      old_folder: string | null;
      old_file: string | null;
      new_folder: string | null;
      new_file: string | null;
    }[];
    const db = this.reader!.db;
    const upd = db.prepare(
      `UPDATE audio_links SET folder_rel_path = ?, file_name = ?
       WHERE user_id = ? AND book_id = ? AND folder_rel_path IS ? AND file_name IS ?`,
    );
    const mark = this.db.prepare(
      `UPDATE audio_switch_links SET restored_at = ? WHERE run_id = ? AND user_id = ? AND book_id = ?`,
    );
    let restored = 0;
    let listed = 0;
    db.transaction(() => {
      for (const x of rows) {
        if (
          upd.run(x.old_folder, x.old_file, x.user_id, x.book_id, x.new_folder, x.new_file).changes
        )
          restored++;
        else listed++;
      }
    })();
    const now = Date.now();
    this.db.transaction(() => {
      for (const x of rows) mark.run(now, last.runId, x.user_id, x.book_id);
    })();
    p.restored = { restored, listed };
    // Undo's verify compares with the switch's "before".
    this.db.prepare('DELETE FROM audio_switch_links WHERE run_id = ?').run(p.runId);
    this.db
      .prepare(
        `INSERT INTO audio_switch_links (run_id, user_id, book_id, old_folder, old_file, new_folder,
           new_file, outcome, detail, changed, status_before, playable_before)
         SELECT ?, user_id, book_id, new_folder, new_file, old_folder, old_file, 'restored', detail,
                changed, status_before, playable_before
         FROM audio_switch_links WHERE run_id = ?`,
      )
      .run(p.runId, last.runId);
    this.save(p);
    return 'next';
  }

  /** How many folders the rescan should find (for its bar). */
  private expectedFolders(undo: boolean): number {
    if (undo) {
      const dirs = new Set<string>();
      for (const r of this.db
        .prepare(
          `SELECT rel_path FROM audio_files WHERE root = 'library' AND kind = 'audio' AND gone_at IS NULL`,
        )
        .iterate() as Iterable<{ rel_path: string }>)
        dirs.add(dirOf(r.rel_path));
      return dirs.size;
    }
    const a = this.deps.stage6.progress()?.analysisId;
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM audio_build_books WHERE analysis_id = ? AND state IN ('build', 'pending')`,
        )
        .get(a) as { n: number }
    ).n;
  }

  private verifyLinks(p: SwitchProgress): 'next' | 'paused' {
    const db = this.reader!.db;
    const links = this.linkRows();
    this.bar(p, 'checking every reader link', 0, links.length);
    const before = new Map(
      (
        this.db
          .prepare(
            `SELECT user_id, book_id, status_before, playable_before FROM audio_switch_links WHERE run_id = ?`,
          )
          .all(p.runId) as {
          user_id: string;
          book_id: string;
          status_before: string | null;
          playable_before: number;
        }[]
      ).map((x) => [`${x.user_id}\u0000${x.book_id}`, x]),
    );
    const upd = this.db.prepare(
      `UPDATE audio_switch_links SET status_after = ?, playable_after = ? WHERE run_id = ? AND user_id = ? AND book_id = ?`,
    );
    let resolved = 0;
    let notResolved = 0;
    let playableLost = 0;
    let linked = 0;
    this.db.transaction(() => {
      for (const l of links) {
        const r = resolveLink(db, l as AudioLink);
        upd.run(r.status, r.playable ? 1 : 0, p.runId, l.userId, l.bookId);
        if (l.state !== 'linked') continue;
        linked++;
        const b = before.get(`${l.userId}\u0000${l.bookId}`);
        if (r.status === 'ok') resolved++;
        // A link that didn't resolve before the switch isn't the switch's doing.
        else if (b?.status_before === 'ok' || !b) notResolved++;
        if (b?.playable_before === 1 && !r.playable) playableLost++;
      }
    })();
    const countBefore = p.linksBefore ?? links.length;
    p.verify = {
      links: linked,
      resolved,
      notResolved,
      playableLost,
      countBefore,
      countAfter: links.length,
      passed: notResolved === 0 && playableLost === 0 && countBefore === links.length,
    };
    this.bar(p, 'checking every reader link', links.length, links.length);
    if (!p.verify.passed) {
      this.setPause(
        'links_wrong',
        `${notResolved} links don’t resolve, ${playableLost} no longer play, links ${countBefore} → ${links.length}. The folders are renamed: Undo puts everything back.`,
      );
      return 'paused';
    }
    return 'next';
  }

  // -------------------------------------------------------------------------------------------
  // deleting japanese-old

  private async rereadFiles(
    p: SwitchProgress,
    stop: () => boolean,
    media: string,
  ): Promise<'next' | 'stay' | 'paused'> {
    const torrents = this.deps.roots.torrents;
    const has = this.db
      .prepare('SELECT 1 FROM audio_switch_files WHERE run_id = ? LIMIT 1')
      .get(p.runId);
    if (!has) {
      const lib = this.db
        .prepare(
          `SELECT rel_path, rel_path_raw, size, kind, ext FROM audio_files
           WHERE root = 'library' AND gone_at IS NULL AND (kind = 'archive' OR ext = '.pdf')`,
        )
        .all() as {
        rel_path: string;
        rel_path_raw: string | null;
        size: number;
        kind: string;
        ext: string;
      }[];
      const twin = this.db.prepare(
        `SELECT rel_path, rel_path_raw FROM audio_files WHERE root = 'torrents' AND gone_at IS NULL AND size = ?
         AND (rel_path = ? OR rel_path LIKE ? ESCAPE '\\') ORDER BY rel_path LIMIT 1`,
      );
      const ins = this.db.prepare(
        `INSERT INTO audio_switch_files (run_id, kind, lib_rel, lib_raw, torrent_rel, torrent_raw, size, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      this.db.transaction(() => {
        for (const f of lib) {
          const name = baseOf(f.rel_path);
          const t = twin.get(f.size, name, `%/${name.replace(/[%_\\]/g, (c) => `\\${c}`)}`) as
            | { rel_path: string; rel_path_raw: string | null }
            | undefined;
          ins.run(
            p.runId,
            f.ext === '.pdf' ? 'pdf' : 'archive',
            f.rel_path,
            f.rel_path_raw,
            t?.rel_path ?? null,
            t?.rel_path_raw ?? null,
            f.size,
            t ? 'planned' : 'no_twin',
          );
        }
      })();
    }
    const total = this.db
      .prepare(
        'SELECT COALESCE(SUM(size), 0) AS b, COUNT(*) AS n FROM audio_switch_files WHERE run_id = ?',
      )
      .get(p.runId) as { b: number; n: number };
    const pacer = new ReadPacer(0);
    for (;;) {
      const next = this.db
        .prepare(
          `SELECT * FROM audio_switch_files WHERE run_id = ? AND state = 'planned' ORDER BY lib_rel LIMIT 1`,
        )
        .get(p.runId) as
        | {
            lib_rel: string;
            lib_raw: string | null;
            torrent_rel: string;
            torrent_raw: string | null;
            size: number;
          }
        | undefined;
      const done = (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(size), 0) AS b FROM audio_switch_files WHERE run_id = ? AND state <> 'planned'`,
          )
          .get(p.runId) as { b: number }
      ).b;
      this.bar(
        p,
        'the PDFs and archives read again on both sides (MB)',
        Math.round(done / 1e6),
        Math.round(total.b / 1e6),
      );
      if (!next) break;
      if (stop()) {
        this.deps.lock.release(OWNER);
        return 'stay';
      }
      if (!(await this.deps.lock.acquire(OWNER, 'audio', stop))) return 'stay';
      const yieldNow = () => this.deps.lock.shouldYield(OWNER) || stop();
      const libHash = await hashFile(
        insideRoot(path.join(media, 'japanese-old'), next.lib_rel, next.lib_raw),
        pacer,
        yieldNow,
      ).catch(() => 'unreadable' as const);
      const torHash =
        libHash && libHash !== 'unreadable'
          ? await hashFile(
              insideRoot(torrents, next.torrent_rel, next.torrent_raw),
              pacer,
              yieldNow,
            ).catch(() => 'unreadable' as const)
          : libHash;
      if (libHash === null || torHash === null) {
        this.deps.lock.release(OWNER);
        await sleep(1000);
        continue;
      }
      const state =
        libHash === 'unreadable' || torHash === 'unreadable'
          ? 'unreadable'
          : libHash.sha256 === torHash.sha256 && libHash.bytes === next.size
            ? 'same'
            : 'different';
      this.db
        .prepare(
          `UPDATE audio_switch_files SET lib_sha = ?, torrent_sha = ?, state = ? WHERE run_id = ? AND lib_rel = ?`,
        )
        .run(
          libHash === 'unreadable' ? null : libHash.sha256,
          torHash === 'unreadable' ? null : torHash.sha256,
          state,
          p.runId,
          next.lib_rel,
        );
    }
    this.deps.lock.release(OWNER);
    const c = Object.fromEntries(
      (
        this.db
          .prepare(
            `SELECT state, COUNT(*) AS n FROM audio_switch_files WHERE run_id = ? GROUP BY state`,
          )
          .all(p.runId) as { state: string; n: number }[]
      ).map((x) => [x.state, x.n]),
    );
    p.files = {
      total: total.n,
      same: c.same ?? 0,
      different: c.different ?? 0,
      noTwin: c.no_twin ?? 0,
      unreadable: c.unreadable ?? 0,
      bytes: total.b,
    };
    this.save(p);
    if (p.files.same !== p.files.total) {
      this.setPause(
        'files_differ',
        `Of ${p.files.total} PDFs and archives, ${p.files.different} differ from their torrent twin, ${p.files.noTwin} have none, ${p.files.unreadable} couldn’t be read: nothing is deleted`,
      );
      return 'paused';
    }
    return 'next';
  }

  private async inventory(
    p: SwitchProgress,
    stop: () => boolean,
  ): Promise<'next' | 'stay' | 'paused'> {
    const media = this.deps.roots.media!;
    if (!this.hasOps(p, 'inventory')) {
      const ops: Parameters<AudioSwitch['planOps']>[2] = [];
      let seq = 0;
      for (const name of INVENTORY) {
        const st = await lstatEntry(path.join(media, 'japanese-old', name));
        if (!st?.isFile) continue;
        ops.push({
          seq: ++seq,
          kind: 'inventory',
          src_rel: null,
          src_raw: null,
          dst: name,
          size: st.size,
          mtime_ms: Math.floor(st.mtimeMs),
          dev: st.dev,
          ino: st.ino,
          sha256: null,
          is_dir: 0,
        });
      }
      this.planOps(p, 'inventory', ops);
      p.inventory = { copied: ops.map((o) => o.dst) };
      this.save(p);
      if (!ops.length) return 'next';
    }
    const d = await this.sidecarPhase(
      p,
      'inventory',
      stop,
      'the old copy script’s files kept in _inventory/old-copy-script',
    );
    if (d === 'paused') return 'paused';
    return d === 'done' ? 'next' : 'stay';
  }

  private async deleteList(
    p: SwitchProgress,
    stop: () => boolean,
    media: string,
  ): Promise<'next' | 'stay' | 'paused'> {
    if (this.hasOps(p, 'delete')) return 'next';
    if (!(await this.calibreFirst(p, stop))) return 'stay';
    const a = this.deps.stage6.progress()!.analysisId;
    const before = new Map(
      (
        this.db
          .prepare(
            `SELECT rel, raw, is_dir, size, mtime_ms, dev, ino FROM audio_build_manifest WHERE analysis_id = ? AND phase = 'before' AND root = 'library'`,
          )
          .all(a) as {
          rel: string;
          raw: string | null;
          is_dir: number;
          size: number;
          mtime_ms: number;
          dev: number;
          ino: number;
        }[]
      ).map((r) => [r.rel, r]),
    );
    this.bar(p, 'listing japanese-old', 0, before.size);
    const root = path.join(media, 'japanese-old');
    const top = await lstatEntry(root);
    if (!top?.isDir) throw new Error('media/audiobooks/japanese-old is missing');
    const out = await walkTree(root, {
      shouldStop: stop,
      shouldPause: () => this.deps.lock.calibreBusy(),
      onEntries: (n) => {
        if (n % 2000 === 0) this.bar(p, 'listing japanese-old', n, before.size);
      },
    });
    if (!out) return 'stay';
    if (out.errors.length) throw new Error(`japanese-old could not be listed: ${out.errors[0]}`);
    const unknown: string[] = [];
    // Audiobookshelf's own files of the old library may have been rewritten by it before its
    // library was deleted (the checklist deletes them with japanese-old): the same file
    // (inode) is enough; the deletion uses what is there now.
    const absOwn = /(^|\/)(metadata\.json|cover\.(jpe?g|png|webp))$/i;
    for (const e of out.entries) {
      const b = before.get(e.rel);
      if (
        !b ||
        (b.is_dir === 1) !== e.isDir ||
        b.dev !== e.dev ||
        b.ino !== e.ino ||
        (!e.isDir && !absOwn.test(e.rel) && (b.size !== e.size || b.mtime_ms !== e.mtimeMs))
      )
        unknown.push(e.rel);
    }
    const files = out.entries.filter((e) => !e.isDir);
    const dirs = out.entries.filter((e) => e.isDir);
    p.deletion = {
      entries: out.entries.length + 1,
      files: files.length,
      dirs: dirs.length + 1,
      bytes: files.reduce((x, e) => x + e.size, 0),
      freed: 0,
      freeBefore: null,
      freeAfter: null,
      unknown: unknown.slice(0, 200),
    };
    this.save(p);
    if (unknown.length) {
      this.setPause(
        'unknown_entries',
        `${unknown.length} entries of japanese-old are not as the build listed them (e.g. ${unknown[0]}): nothing is deleted`,
      );
      return 'paused';
    }
    const depth = (rel: string) => rel.split('/').length;
    const ops: Parameters<AudioSwitch['planOps']>[2] = [];
    let seq = 0;
    const entry = (e: ManifestEntry, dir: boolean) =>
      ops.push({
        seq: ++seq,
        kind: 'delete',
        src_rel: `japanese-old/${e.rel}`,
        src_raw:
          e.raw === null
            ? null
            : Buffer.concat([Buffer.from('japanese-old/'), Buffer.from(e.raw, 'hex')]).toString(
                'hex',
              ),
        dst: `japanese-old/${e.rel}`,
        size: e.size,
        mtime_ms: e.mtimeMs,
        dev: e.dev,
        ino: e.ino,
        sha256: null,
        is_dir: dir ? 1 : 0,
      });
    for (const e of files.sort((x, y) => (x.rel < y.rel ? -1 : 1))) entry(e, false);
    for (const e of dirs.sort((x, y) => depth(y.rel) - depth(x.rel) || (x.rel < y.rel ? -1 : 1)))
      entry(e, true);
    ops.push({
      seq: ++seq,
      kind: 'delete',
      src_rel: 'japanese-old',
      src_raw: null,
      dst: 'japanese-old',
      size: 0,
      mtime_ms: Math.floor(top.mtimeMs),
      dev: top.dev,
      ino: top.ino,
      sha256: null,
      is_dir: 1,
    });
    this.planOps(p, 'delete', ops);
    const free = this.deps.stage6.sidecar().info?.freeBytes;
    p.deletion.freeBefore = typeof free === 'number' ? free : null;
    this.save(p);
    return 'next';
  }

  private async deleteReport(p: SwitchProgress, stop: () => boolean): Promise<'next' | 'stay'> {
    const freed = (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(json_extract(result_json, '$.freed')), 0) AS b FROM audio_switch_ops WHERE run_id = ? AND phase = 'delete' AND state = 'done'`,
        )
        .get(p.runId) as { b: number }
    ).b;
    const lastReport =
      (
        this.db
          .prepare(`SELECT MAX(reported_at) AS t FROM audio_switch_batches WHERE run_id = ?`)
          .get(p.runId) as { t: number | null }
      ).t ?? 0;
    // The disk's free space from a heartbeat after the last batch (at most a minute).
    const sc = this.deps.stage6.sidecar();
    if ((sc.lastSeenAt ?? 0) <= lastReport && Date.now() - lastReport < 70_000 && !stop()) {
      this.bar(p, 'waiting for the sidecar’s next report of the free space');
      await sleep(1000);
      return 'stay';
    }
    const free = sc.info?.freeBytes;
    p.deletion = { ...p.deletion!, freed, freeAfter: typeof free === 'number' ? free : null };
    const gone = !(await lstatEntry(path.join(this.deps.roots.media!, 'japanese-old')));
    if (!gone) throw new Error('japanese-old is still there after the deletion');
    this.save(p);
    return 'next';
  }

  // -------------------------------------------------------------------------------------------
  // the page

  status() {
    const p = this.progress();
    const row = this.row();
    return {
      state: row.state,
      pause: this.pause(),
      progress: p,
      handing: this.handing,
      refusals: {
        switch: this.refusals('switch'),
        undo: this.refusals('undo'),
        delete: this.refusals('delete'),
      },
      cancellable: !!p && row.state === 'running' && CANCELLABLE[p.action].includes(p.phase),
      phases: p ? PHASES[p.action] : SWITCH_PHASES,
    };
  }

  /** The links the last switch (or undo) looked at. */
  links(opts: { offset?: number; limit?: number; changedOnly?: boolean } = {}) {
    const p = this.progress();
    if (!p) return { total: 0, items: [] };
    const run = this.db
      .prepare('SELECT 1 FROM audio_switch_links WHERE run_id = ? LIMIT 1')
      .get(p.runId)
      ? p.runId
      : (this.lastSwitchProgress()?.runId ?? p.runId);
    const where = `run_id = ?${opts.changedOnly ? ' AND changed = 1' : ''}`;
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audio_switch_links WHERE ${where}`).get(run) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT * FROM audio_switch_links WHERE ${where} ORDER BY outcome, book_id LIMIT ? OFFSET ?`,
      )
      .all(run, Math.min(opts.limit ?? 100, 1000), opts.offset ?? 0);
    return { total, items };
  }

  /** Every link the switch looked at, as CSV (the report). */
  linksCsv(): string {
    const p = this.progress();
    const run = p
      ? this.db.prepare('SELECT 1 FROM audio_switch_links WHERE run_id = ? LIMIT 1').get(p.runId)
        ? p.runId
        : this.lastSwitchProgress()?.runId
      : null;
    const q = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      'user,book,outcome,changed,old_folder,old_file,new_folder,new_file,status_before,status_after,playable_before,playable_after,detail',
    ];
    if (run)
      for (const r of this.db
        .prepare(`SELECT * FROM audio_switch_links WHERE run_id = ? ORDER BY outcome, book_id`)
        .iterate(run) as Iterable<Record<string, unknown>>)
        lines.push(
          [
            r.user_id,
            r.book_id,
            r.outcome,
            r.changed,
            r.old_folder,
            r.old_file,
            r.new_folder,
            r.new_file,
            r.status_before,
            r.status_after,
            r.playable_before,
            r.playable_after,
            r.detail,
          ]
            .map(q)
            .join(','),
        );
    return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n';
  }

  /** The switch's own additions under the torrents (for the e2e and the report). */
  fromLibraryPlan() {
    return this.fromLibraryPaths().map((f) => ({
      library: `japanese/${f.rel}`,
      fromLibrary: f.dst,
      newPath: afterRenames(f.newPath),
    }));
  }

  /** Tick helper for long synchronous loops. */
  static async yieldNow(): Promise<void> {
    await tick();
  }
}
