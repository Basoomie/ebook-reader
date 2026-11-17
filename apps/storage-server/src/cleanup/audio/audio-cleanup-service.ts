/**
 * The audiobook cleanup inside the storage server (WP21a): the Audiobookshelf snapshot
 * (stage 0), identity (stage 1) and books and file health (stage 2). Analysis only: nothing
 * here writes to the audiobook roots or to Audiobookshelf (read-only mounts, the read-only
 * file module, a GET-only ABS client). Every failure is caught and logged; reading is never
 * affected.
 */
import type Database from 'better-sqlite3';
import type { DiskLock } from '../disk-lock';
import { DISK_OWNERS } from '../disk-lock';
import type { SecretStore } from '../secrets';
import { getSettings } from '../settings';
import { AbsClient } from './abs-client';
import {
  getSnapshot,
  listSnapshots,
  progressCsv,
  saveSnapshot,
  takeAbsSnapshot,
  type AbsSnapshotData,
} from './abs-snapshot';
import { isWritable, lstatEntry } from './audio-source-fs';
import {
  AUDIO_ANALYSIS_STAGES,
  getAudioStage,
  listAudioStages,
  setAudioStageMode,
  updateAudioStage,
  type AudioStageMode,
} from './audio-stages';
import type { ToolPaths } from './probe';
import { AudioStage1, identityCounts, type AudioStage1Progress } from './stage1-identity';
import { AudioStage2, booksCounts } from './stage2-books';
import type { AudioRoots } from './walk';

const TICK_MS = 5000;
const ROOTS_CHECK_MS = 60_000;

export interface AudioCleanupOptions {
  db: Database.Database;
  secrets: SecretStore;
  lock: DiskLock;
  /** null: CLEANUP_AUDIO_TORRENTS_DIR / CLEANUP_AUDIO_LIBRARY_DIR are not set. */
  roots: AudioRoots | null;
  tools: ToolPaths;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  logError?: (m: string, err?: unknown) => void;
}

export interface RootsCheck {
  ok: boolean;
  problem: string | null;
  checkedAt: number;
}

/**
 * Both roots must exist, be read-only to this process, and be on one filesystem (same device,
 * so inode numbers can be compared; /mnt/user's FUSE layer would make them up).
 */
export async function checkRoots(roots: AudioRoots | null): Promise<RootsCheck> {
  const now = Date.now();
  if (!roots) {
    return {
      ok: false,
      problem:
        'The audiobook folders are not set up (CLEANUP_AUDIO_TORRENTS_DIR, CLEANUP_AUDIO_LIBRARY_DIR)',
      checkedAt: now,
    };
  }
  const t = await lstatEntry(roots.torrents).catch(() => null);
  const l = await lstatEntry(roots.library).catch(() => null);
  if (!t?.isDir)
    return {
      ok: false,
      problem: `The torrents folder is missing: ${roots.torrents}`,
      checkedAt: now,
    };
  if (!l?.isDir)
    return {
      ok: false,
      problem: `The library folder is missing: ${roots.library}`,
      checkedAt: now,
    };
  for (const [name, dir] of [
    ['torrents', roots.torrents],
    ['library', roots.library],
  ] as const) {
    if (await isWritable(dir)) {
      return {
        ok: false,
        problem: `The ${name} folder is writable; the audiobook cleanup only runs on read-only mounts`,
        checkedAt: now,
      };
    }
  }
  if (t.dev !== l.dev) {
    return {
      ok: false,
      problem:
        'The two folders are on different filesystems, so their inode numbers can’t be compared (mount both from /mnt/disk1)',
      checkedAt: now,
    };
  }
  return { ok: true, problem: null, checkedAt: now };
}

export class AudioCleanupService {
  readonly stage1: AudioStage1 | null;
  readonly stage2: AudioStage2 | null;
  private roots: RootsCheck = { ok: false, problem: 'Not checked yet', checkedAt: 0 };
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private running1: Promise<void> | null = null;
  private running2: Promise<void> | null = null;
  private snapshotting: Promise<void> | null = null;
  private stopped = false;
  waiting1: string | null = null;
  waiting2: string | null = null;
  private readonly log: (m: string) => void;
  private readonly logError: (m: string, err?: unknown) => void;

  constructor(private readonly opts: AudioCleanupOptions) {
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.stage1 = opts.roots
      ? new AudioStage1({ db: opts.db, roots: opts.roots, lock: opts.lock, log: this.log })
      : null;
    this.stage2 = opts.roots
      ? new AudioStage2({ db: opts.db, roots: opts.roots, tools: opts.tools, log: this.log })
      : null;
  }

  get db(): Database.Database {
    return this.opts.db;
  }

  start({ timer = true }: { timer?: boolean } = {}): void {
    if (timer) {
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      this.timer.unref();
    }
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking;
    await this.running1;
    await this.running2;
    await this.snapshotting;
    this.opts.lock.release(DISK_OWNERS.audio1);
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        await this.round();
      } catch (err) {
        this.logError('Audiobook cleanup: round failed:', err);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async round(): Promise<void> {
    if (Date.now() - this.roots.checkedAt > ROOTS_CHECK_MS || !this.roots.ok) {
      this.roots = await checkRoots(this.opts.roots);
    }
    this.round1();
    this.round2();
  }

  private round1(): void {
    const st = getAudioStage(this.db, 1);
    if (st.mode === 'off' || !this.stage1) {
      this.waiting1 = st.mode === 'off' ? null : this.roots.problem;
      return;
    }
    if (!this.roots.ok) {
      this.waiting1 = this.roots.problem;
      return;
    }
    const p = this.stage1.progress() ?? this.stage1.restart();
    if (p.phase === 'done') {
      this.waiting1 = p.error ? `The analysis failed: ${p.error}` : 'Preview: nothing is changed';
      return;
    }
    this.waiting1 = this.waiting1Text(p);
    if (!this.running1) this.run1();
  }

  private waiting1Text(p: AudioStage1Progress): string {
    if (p.phase === 'hash') {
      const lock = this.opts.lock.state();
      if (lock.calibreApplying) return `Waiting for the disk: ${lock.calibreApplying}`;
      if (lock.holder && lock.holder.owner !== DISK_OWNERS.audio1) {
        return `Waiting for the disk: ${lock.holder.owner} is reading`;
      }
      if (lock.waiting.some((w) => w.side === 'calibre'))
        return 'Giving the disk to the Calibre cleanup';
    }
    return 'Analysing';
  }

  private run1(): void {
    const stage = this.stage1!;
    const stop = () => this.stopped || getAudioStage(this.db, 1).mode === 'off';
    this.running1 = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          const done = await stage.step(stop);
          if (done) break;
          const p = stage.progress();
          if (p) this.waiting1 = this.waiting1Text(p);
          // A step that gave the disk away (or is waiting for it) lets the Calibre job run.
          if (p?.phase === 'hash' && !this.opts.lock.holds(DISK_OWNERS.audio1)) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } catch (err) {
        this.logError('Audiobook cleanup: stage 1 failed:', err);
      } finally {
        this.opts.lock.release(DISK_OWNERS.audio1);
        this.running1 = null;
        void this.tick();
      }
    })();
  }

  private round2(): void {
    const st = getAudioStage(this.db, 2);
    if (st.mode === 'off' || !this.stage2) {
      this.waiting2 = st.mode === 'off' ? null : this.roots.problem;
      return;
    }
    if (!this.roots.ok) {
      this.waiting2 = this.roots.problem;
      return;
    }
    const p = this.stage2.progress() ?? this.stage2.restart();
    if (p.phase === 'done') {
      this.waiting2 = p.error ? `The analysis failed: ${p.error}` : 'Preview: nothing is changed';
      return;
    }
    if (this.stage1Hashing()) {
      this.waiting2 = 'Waiting for stage 1 to finish hashing (both would read the same disk)';
      return;
    }
    this.waiting2 = 'Analysing';
    if (!this.running2) this.run2();
  }

  private stage1Hashing(): boolean {
    return getAudioStage(this.db, 1).mode !== 'off' && this.stage1?.hashing() === true;
  }

  private run2(): void {
    const stage = this.stage2!;
    const stop = () =>
      this.stopped || getAudioStage(this.db, 2).mode === 'off' || this.stage1Hashing();
    this.running2 = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          const done = await stage.step(stop);
          if (done) break;
        }
      } catch (err) {
        this.logError('Audiobook cleanup: stage 2 failed:', err);
      } finally {
        this.running2 = null;
        void this.tick();
      }
    })();
  }

  setMode(stage: number, mode: AudioStageMode): void {
    if (!AUDIO_ANALYSIS_STAGES.includes(stage)) throw new Error('No such stage');
    setAudioStageMode(this.db, stage, mode);
    void this.tick();
  }

  /** "Run the analysis again" (keeps the hashes and health of unchanged files). */
  reanalyse(stage: number): void {
    if (stage === 1 && this.stage1) this.stage1.restart();
    else if (stage === 2 && this.stage2) this.stage2.restart();
    else throw new Error('The audiobook folders are not set up');
    void this.tick();
  }

  /** Stage 0: takes a read-only snapshot of Audiobookshelf now. */
  takeSnapshot(): Promise<void> {
    if (this.snapshotting) return this.snapshotting;
    const s = getSettings(this.db).audiobooks;
    const key = this.opts.secrets.read('absApiKey');
    if (!s.absUrl || !key) {
      throw new Error('Fill in the Audiobookshelf address and API key (Settings tab)');
    }
    updateAudioStage(this.db, 0, {
      state: 'taking',
      progress: { ...getAudioStage(this.db, 0).progress, startedAt: Date.now(), error: null },
    });
    const client = new AbsClient({
      baseUrl: s.absUrl,
      apiKey: key,
      timeoutMs: s.absTimeoutSeconds * 1000,
      fetchImpl: this.opts.fetchImpl,
    });
    this.snapshotting = (async () => {
      try {
        const data = await takeAbsSnapshot(client, s.absUrl);
        const id = saveSnapshot(this.db, data);
        updateAudioStage(this.db, 0, {
          state: 'ready',
          progress: { lastId: id, takenAt: data.takenAt, error: null },
        });
        this.log(
          `Audiobook cleanup: Audiobookshelf snapshot ${id} (${data.progress.length} progress entries)`,
        );
      } catch (err) {
        updateAudioStage(this.db, 0, {
          state: 'failed',
          progress: {
            ...getAudioStage(this.db, 0).progress,
            error: (err as Error).message.slice(0, 500),
          },
        });
      } finally {
        this.snapshotting = null;
      }
    })();
    return this.snapshotting;
  }

  snapshot(id: number): AbsSnapshotData | null {
    return getSnapshot(this.db, id);
  }

  snapshotCsv(id: number): string | null {
    const d = getSnapshot(this.db, id);
    return d ? progressCsv(d) : null;
  }

  status() {
    const p1 = this.stage1?.progress() ?? null;
    const p2 = this.stage2?.progress() ?? null;
    const snapshots = listSnapshots(this.db);
    return {
      roots: this.roots,
      stages: listAudioStages(this.db),
      lock: this.opts.lock.state(),
      stage0: {
        snapshotting: this.snapshotting !== null,
        latest: snapshots[0] ?? null,
        snapshots: snapshots.slice(0, 10),
        absUrlSet: getSettings(this.db).audiobooks.absUrl !== '',
        keySet: this.opts.secrets.read('absApiKey') !== null,
      },
      stage1: {
        waiting: this.waiting1,
        progress: p1
          ? { ...p1, walk: p1.walk ? { ...p1.walk, errors: p1.walk.errors.slice(0, 20) } : null }
          : null,
        counts:
          p1?.phase === 'done' && !p1.error
            ? identityCounts(this.db, p1.analysisId)
            : (p1?.counts ?? null),
      },
      stage2: {
        waiting: this.waiting2,
        progress: p2
          ? { ...p2, walk: p2.walk ? { ...p2.walk, errors: p2.walk.errors.slice(0, 20) } : null }
          : null,
        counts:
          p2?.phase === 'done' && !p2.error
            ? booksCounts(this.db, p2.analysisId)
            : (p2?.counts ?? null),
      },
    };
  }

  /** Stage 1's and 2's file lists (paged), each file with what stage 2 found in it. */
  files(
    list: string,
    { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const p1 = this.stage1?.progress();
    let where: string;
    const params: unknown[] = [];
    let from = 'audio_files f';
    let extra = '';
    const identity = (cls: string, root: string) => {
      from = 'audio_identity c JOIN audio_files f ON f.id = c.file_id';
      extra = ', c.class, c.ai_original, c.group_sha256, c.original_file_ids, c.detail';
      params.push(p1?.analysisId ?? '', cls, root);
      return `c.analysis_id = ? AND c.class = ? AND f.root = ?`;
    };
    switch (list) {
      case 'library_only':
      case 'size_only':
      case 'unhashed':
      case 'linked':
        where = identity(list, 'library');
        break;
      case 'torrent_only':
      case 'torrent_copy':
        where = identity(list, 'torrents');
        break;
      case 'archive_torrents':
        where = identity('archive', 'torrents');
        break;
      case 'archive_library':
        where = identity('archive', 'library');
        break;
      case 'ai':
        from = 'audio_identity c JOIN audio_files f ON f.id = c.file_id';
        extra = ', c.class, c.ai_original, c.original_file_ids';
        where = `c.analysis_id = ? AND c.ai_original = 1 AND f.root = 'library'`;
        params.push(p1?.analysisId ?? '');
        break;
      case 'mojibake':
        where = `f.decoded_path IS NOT NULL AND f.gone_at IS NULL`;
        break;
      case 'raw_names':
        where = `f.rel_path_raw IS NOT NULL AND f.gone_at IS NULL`;
        break;
      case 'unreadable':
      case 'damaged':
      case 'ext_mismatch':
        from = 'audio_files f JOIN audio_file_health h ON h.file_id = f.id';
        where =
          list === 'unreadable'
            ? `f.gone_at IS NULL AND h.header_ok = 0`
            : list === 'damaged'
              ? `f.gone_at IS NULL AND h.header_ok = 1 AND (h.start_decode_ok = 0 OR h.end_decode_ok = 0)`
              : `f.gone_at IS NULL AND h.header_ok = 1 AND f.ext <> '.' || h.format AND NOT (h.format = 'mp4' AND f.ext IN ('.m4b', '.m4a', '.mp4', '.aac'))`;
        break;
      default:
        throw new Error('No such list');
    }
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT f.id, f.root, f.rel_path, f.decoded_path, f.rel_path_raw IS NOT NULL AS raw_name, f.size,
           f.ext, f.nlink, f.sha256, fh.format, fh.codec, fh.duration, fh.error, fh.decode_error ${extra}
         FROM ${from} LEFT JOIN audio_file_health fh ON fh.file_id = f.id
         WHERE ${where} ORDER BY f.root, f.rel_path LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];
    // For library copies and AI files: the original's path.
    const orig = this.db.prepare('SELECT root, rel_path FROM audio_files WHERE id = ?');
    for (const it of items) {
      if (typeof it.original_file_ids === 'string') {
        const ids = JSON.parse(it.original_file_ids) as number[];
        it.originals = ids.slice(0, 5).map((id) => orig.get(id));
        delete it.original_file_ids;
      }
    }
    return { total, items };
  }

  /** Stage 2's books (paged): likely_copies, unclear, parts, decoded (mojibake names). */
  books(
    list: string,
    { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const p2 = this.stage2?.progress();
    const params: unknown[] = [p2?.analysisId ?? ''];
    let where: string;
    if (list === 'likely_copies' || list === 'unclear' || list === 'parts') {
      where = 'b.analysis_id = ? AND b.multi_class = ?';
      params.push(list);
    } else if (list === 'decoded') {
      where = 'b.analysis_id = ? AND b.name_decoded IS NOT NULL';
    } else throw new Error('No such list');
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM audio_books b WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
    const items = this.db
      .prepare(
        `SELECT b.id, b.root, b.unit_rel_path, b.unit_kind, b.source, b.name_raw, b.name_decoded,
           b.file_count, b.total_seconds, b.multi_class, b.class_reason
         FROM audio_books b WHERE ${where} ORDER BY b.root, b.unit_rel_path LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];
    const files = this.db.prepare(
      `SELECT f.rel_path, f.size, h.duration, h.format, h.codec, h.chapter_count FROM audio_book_files bf
       JOIN audio_files f ON f.id = bf.file_id LEFT JOIN audio_file_health h ON h.file_id = f.id
       WHERE bf.book_id = ? ORDER BY bf.position LIMIT 20`,
    );
    for (const it of items) it.files = files.all(it.id);
    return { total, items };
  }
}
