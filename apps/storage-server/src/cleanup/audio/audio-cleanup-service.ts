/**
 * The audiobook cleanup inside the storage server (WP21a): the Audiobookshelf snapshot
 * (stage 0), identity (stage 1), books and file health (stage 2) and duplicates (stage 3,
 * WP21b). Analysis only: nothing here writes to the audiobook roots or to Audiobookshelf
 * (read-only mounts, the read-only file module, a GET-only ABS client). Every failure is
 * caught and logged; reading is never affected.
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
import { insideRoot } from './audio-source-fs';
import { cutClip, type ToolPaths } from './probe';
import { AudioStage1, identityCounts, type AudioStage1Progress } from './stage1-identity';
import { AudioStage2, booksCounts } from './stage2-books';
import { AudioStage3, stage3SettingsKey, type LoadedCopy } from './stage3-dups';
import {
  AudioStage4,
  STAGE4_UNITS_VERSION,
  stage4SettingsKey,
  stage4StartsOver,
} from './stage4-online';
import { audioSiteLines, onlineList, unitStates } from './online-views';
import { AiRunner, modeOf } from '../ai/runner';
import { STAGE4_SPEC } from '../stage4/ai-prompt';
import { STAGE5_SPEC } from '../stage5/prompt';
import { META_SPEC } from './meta-prompt';
import { providerOf, type ProviderClient } from '../ai/providers';
import type { Provider } from '../ai/types';
import { AudioStage5, stage5AskKey, stage5RulesKey } from './stage5-meta';
import { spendNow } from '../ai/spend';
import { metaList } from './meta-views';
import type { FetchQueue } from '../stage4/queue';
import { AUDIO_FETCH_SITES } from '../settings';
import type { AudioRoots } from './walk';
import { AudioStage6, type LinkBatch, type LinkOpResult } from './stage6-build';
import { AudioCovers } from './stage6-covers';
import {
  AudioSwitch,
  SWITCH_BATCH_BASE,
  type SwitchAction,
  type SwitchBatch,
  type SwitchReader,
} from './stage6-switch';
import { AUDIO_ON_STAGES } from './audio-stages';
import { stageIds } from './build-inputs';
import { librarySwitched } from './switch-state';
import {
  ARRIVAL_BATCH_BASE,
  AudioStage7,
  type ArrivalBatch,
  type ArrivalOpResult,
} from './stage7-arrivals';

/** A clip can't be cut now (a Calibre job uses the disk): try again in a moment. */
export class AudioBusyError extends Error {}

/** What the review page may record for a group (WP21e applies it). */
export type DupDecision = 'keep_all' | `keep:${string}` | 'clear';

const TICK_MS = 5000;
const ROOTS_CHECK_MS = 60_000;

export interface AudioCleanupOptions {
  db: Database.Database;
  secrets: SecretStore;
  lock: DiskLock;
  /** null: CLEANUP_AUDIO_TORRENTS_DIR / CLEANUP_AUDIO_LIBRARY_DIR are not set. */
  roots: AudioRoots | null;
  tools: ToolPaths;
  /** Stage 3's labeled pairs (labels.json) as text, or why they can't be read. */
  readLabels?: () => { text: string | null; error: string | null };
  /** Library paths of files the reader wrote (merges): they never compete in stage 3. */
  readerWrittenFiles?: () => string[];
  /** Stage 6 (WP21e-1): a hash of the reader's audio links and folders (before vs after). */
  readerState?: () => string | null;
  fetchImpl?: typeof fetch;
  /** Stage 4 (WP21c): the shared fetch queue (the Calibre cleanup's), and its fetcher's state. */
  fetchQueue?: FetchQueue | null;
  fetcherStatus?: () => unknown;
  /** Stage 5 (WP21d): tests give their own AI provider clients. */
  aiProviders?: (provider: Provider, key: string) => ProviderClient;
  /**
   * The runner shared with the Calibre cleanup (WP20e: one runner for every stage that asks the
   * models); a runner of its own when not given (tests).
   */
  aiRunner?: AiRunner;
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
  readonly stage3: AudioStage3 | null;
  readonly stage4: AudioStage4 | null;
  /** Stage 5 (WP21d): needs only cleanup.db (no folders, no disk, no fetching). */
  readonly stage5: AudioStage5;
  /** Stage 6 (WP21e-1): the build of japanese-new (needs the folders). */
  readonly stage6: AudioStage6 | null;
  /** WP21e-2: the switch to the new library (after stage 6). */
  readonly switcher: AudioSwitch | null;
  /** WP21e-2: covers for the books without embedded art (stop 3). */
  readonly covers: AudioCovers | null;
  readonly ai: AiRunner;
  private roots: RootsCheck = { ok: false, problem: 'Not checked yet', checkedAt: 0 };
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private running1: Promise<void> | null = null;
  private running2: Promise<void> | null = null;
  private running3: Promise<void> | null = null;
  private running4: Promise<void> | null = null;
  private running5: Promise<void> | null = null;
  private running6: Promise<void> | null = null;
  private runningSwitch: Promise<void> | null = null;
  private runningCovers: Promise<void> | null = null;
  private running7: Promise<void> | null = null;
  /** Stage 7 (WP21f-1): the daily new arrivals (after the switch). */
  readonly stage7: AudioStage7 | null;
  private snapshotting: Promise<void> | null = null;
  private stopped = false;
  waiting1: string | null = null;
  waiting2: string | null = null;
  waiting3: string | null = null;
  waiting4: string | null = null;
  waiting5: string | null = null;
  waiting6: string | null = null;
  private readonly log: (m: string) => void;
  private readonly logError: (m: string, err?: unknown) => void;

  constructor(private readonly opts: AudioCleanupOptions) {
    this.log = opts.log ?? console.log;
    this.logError = opts.logError ?? console.error;
    this.stage1 = opts.roots
      ? new AudioStage1({ db: opts.db, roots: opts.roots, lock: opts.lock, log: this.log })
      : null;
    this.stage2 = opts.roots
      ? new AudioStage2({
          db: opts.db,
          roots: opts.roots,
          tools: opts.tools,
          calibreBusy: () => {
            const s = opts.lock.state();
            return (
              s.calibreApplying !== null ||
              s.holder?.side === 'calibre' ||
              s.waiting.some((w) => w.side === 'calibre')
            );
          },
          log: this.log,
        })
      : null;
    this.stage3 = opts.roots
      ? new AudioStage3({
          db: opts.db,
          roots: opts.roots,
          tools: opts.tools,
          lock: opts.lock,
          calibreBusy: () => opts.lock.calibreBusy(),
          readLabels: opts.readLabels,
          readerWrittenFiles: opts.readerWrittenFiles,
          log: this.log,
        })
      : null;
    this.stage4 =
      opts.roots && this.stage3 && opts.fetchQueue
        ? new AudioStage4({
            db: opts.db,
            roots: opts.roots,
            tools: opts.tools,
            lock: opts.lock,
            queue: opts.fetchQueue,
            stage3: this.stage3,
            calibreBusy: () => opts.lock.calibreBusy(),
            readLabels: opts.readLabels,
            log: this.log,
          })
        : null;
    this.ai =
      opts.aiRunner ??
      new AiRunner({
        db: opts.db,
        secrets: opts.secrets,
        providers: opts.aiProviders,
        log: this.log,
      });
    this.stage5 = new AudioStage5({
      db: opts.db,
      runner: this.ai,
      readLabels: opts.readLabels,
      // WP21f-1: the new arrivals are decided with the arrivals' setup (default J).
      designs: (stage4Id) => this.stage7?.designsFor(stage4Id) ?? new Map(),
      log: this.log,
    });
    this.stage7 = opts.roots
      ? new AudioStage7({
          db: opts.db,
          roots: {
            torrents: opts.roots.torrents,
            library: opts.roots.library,
            media: opts.roots.media ?? null,
          },
          lock: opts.lock,
          reanalyse: (n) => this.reanalyse(n),
          abs: () => {
            const s = getSettings(this.db).audiobooks;
            const key = this.opts.secrets.read('absApiKey');
            return s.absUrl && key
              ? { baseUrl: s.absUrl, apiKey: key, timeoutMs: s.absTimeoutSeconds * 1000 }
              : null;
          },
          fetchImpl: opts.fetchImpl,
          log: this.log,
        })
      : null;
    this.stage6 = opts.roots
      ? new AudioStage6({
          db: opts.db,
          roots: {
            torrents: opts.roots.torrents,
            library: opts.roots.library,
            media: opts.roots.media ?? null,
          },
          lock: opts.lock,
          stage5: this.stage5,
          readerWritten: opts.readerWrittenFiles,
          log: this.log,
        })
      : null;
    this.switcher =
      this.stage6 && opts.roots
        ? new AudioSwitch({
            db: opts.db,
            stage6: this.stage6,
            roots: {
              torrents: opts.roots.torrents,
              library: opts.roots.library,
              media: opts.roots.media ?? null,
            },
            lock: opts.lock,
            absLibraries: () => this.absLibraries(),
            log: this.log,
          })
        : null;
    const switcher = this.switcher;
    this.covers =
      this.stage6 && switcher
        ? new AudioCovers({
            db: opts.db,
            stage6: this.stage6,
            media: opts.roots?.media ?? null,
            switchState: () => switcher.state(),
            abs: () => {
              const s = getSettings(this.db).audiobooks;
              const key = this.opts.secrets.read('absApiKey');
              return s.absUrl && key
                ? { baseUrl: s.absUrl, apiKey: key, timeoutMs: s.absTimeoutSeconds * 1000 }
                : null;
            },
            fetchImpl: opts.fetchImpl,
            log: this.log,
          })
        : null;
  }

  /** WP21e-2: the reader's side of the switch (the server gives it once its audio services exist). */
  attachReader(reader: SwitchReader): void {
    this.switcher?.attachReader(reader);
    void this.tick();
  }

  /** Audiobookshelf's libraries and folders now (a GET-only snapshot), or null. */
  private async absLibraries(): Promise<{ name: string | null; folders: string[] }[] | null> {
    const s = getSettings(this.db).audiobooks;
    if (!s.absUrl || !this.opts.secrets.read('absApiKey')) return null;
    await this.takeSnapshot();
    const p0 = getAudioStage(this.db, 0).progress as { lastId?: number; error?: string | null };
    if (p0.error || !p0.lastId) return null;
    const snap = getSnapshot(this.db, p0.lastId);
    return snap ? snap.libraries.map((l) => ({ name: l.name, folders: l.folders })) : null;
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
    await this.running3;
    await this.running4;
    await this.running5;
    await this.running6;
    await this.runningSwitch;
    await this.runningCovers;
    await this.running7;
    await this.snapshotting;
    this.opts.lock.release(DISK_OWNERS.audio7);
    this.opts.lock.release(DISK_OWNERS.audio1);
    this.opts.lock.release(DISK_OWNERS.audio3);
    this.opts.lock.release(DISK_OWNERS.audio4);
    this.opts.lock.release(DISK_OWNERS.audio6);
    this.opts.lock.release(DISK_OWNERS.audio6switch);
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      // Set before the round runs: a step that asks a stage to run again calls tick() from
      // inside the round (WP21f-1: stage 7's first step started a second stage-7 loop).
      await Promise.resolve();
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
    this.round3();
    this.round4();
    this.round5();
    this.round6();
    this.roundSwitch();
    this.round7();
    // Settings > AI "Test batch" results (each checked at the batch poll pace).
    await this.ai.pollBatchTests().catch((err) => this.logError('AI: batch tests:', err));
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

  /**
   * What stage 1 is doing now. Both its listing (walk) and its hashing wait while a Calibre job
   * uses the disk, so both say so (found live 2026-11-17: the listing waited but the page said
   * "Analysing").
   */
  private waiting1Text(p: AudioStage1Progress): string {
    if (p.phase === 'walk' || p.phase === 'hash') {
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
    if (this.stage1Reading()) {
      this.waiting2 = 'Waiting for stage 1 to finish reading the files (both read the same disk)';
      return;
    }
    this.waiting2 = this.opts.lock.calibreBusy()
      ? 'Waiting while the Calibre cleanup uses the disk'
      : 'Analysing';
    if (!this.running2) this.run2();
  }

  /** Stage 2 starts only once stage 1 has finished listing and hashing (found live 2026-11-17:
   * stage 2 said "Analysing" while its listing was queued behind stage 1's). */
  private stage1Reading(): boolean {
    return getAudioStage(this.db, 1).mode !== 'off' && this.stage1?.reading() === true;
  }

  private run2(): void {
    const stage = this.stage2!;
    const stop = () =>
      this.stopped || getAudioStage(this.db, 2).mode === 'off' || this.stage1Reading();
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

  private round3(): void {
    const st = getAudioStage(this.db, 3);
    if (st.mode === 'off' || !this.stage3) {
      this.waiting3 = st.mode === 'off' ? null : this.roots.problem;
      return;
    }
    if (!this.roots.ok) {
      this.waiting3 = this.roots.problem;
      return;
    }
    // Stage 3 compares what stages 1 and 2 found: it starts once both have finished, and
    // starts over when either ran again.
    const s1 = getAudioStage(this.db, 1).progress as { analysisId?: string; phase?: string };
    const s2 = getAudioStage(this.db, 2).progress as { analysisId?: string; phase?: string };
    if (s1.phase !== 'done' || s2.phase !== 'done') {
      this.waiting3 = 'Waiting for stages 1 and 2 to finish (stage 3 compares what they found)';
      return;
    }
    let p = this.stage3.progress();
    if (!p || (p.stage1Id && (p.stage1Id !== s1.analysisId || p.stage2Id !== s2.analysisId))) {
      if (this.running3) return;
      p = this.stage3.restart();
    }
    // Changed settings: compare again from the stored measurements (nothing read twice).
    const key = stage3SettingsKey(getSettings(this.db).audiobooks);
    if (p.rulesKey && p.rulesKey !== key && p.phase !== 'copies' && p.phase !== 'candidates') {
      if (this.running3) return;
      this.stage3.recompare();
      p = this.stage3.progress()!;
    }
    if (p.phase === 'done') {
      this.waiting3 = p.error ? `The analysis failed: ${p.error}` : 'Preview: nothing is changed';
      return;
    }
    this.waiting3 = this.waiting3Text();
    if (!this.running3) this.run3();
  }

  /** What stage 3 is doing now, and what it waits for. */
  private waiting3Text(): string {
    const p = this.stage3?.progress();
    const lock = this.opts.lock.state();
    if (p?.phase === 'fingerprints' && this.opts.lock.calibreBusy()) {
      return 'Waiting while the Calibre cleanup uses the disk';
    }
    if (p?.phase === 'decode' && !this.opts.lock.holds(DISK_OWNERS.audio3)) {
      if (lock.calibreApplying) return `Waiting for the disk: ${lock.calibreApplying}`;
      if (lock.holder && lock.holder.owner !== DISK_OWNERS.audio3) {
        return `Waiting for the disk: ${lock.holder.owner} is reading`;
      }
      if (lock.waiting.some((w) => w.side === 'calibre'))
        return 'Giving the disk to the Calibre cleanup';
    }
    return 'Analysing';
  }

  /** Stages 1 and 2 have both finished (stage 3 works only on what they found). */
  private stages12Done(): boolean {
    const s1 = getAudioStage(this.db, 1).progress as { phase?: string };
    const s2 = getAudioStage(this.db, 2).progress as { phase?: string };
    return s1.phase === 'done' && s2.phase === 'done';
  }

  private run3(): void {
    const stage = this.stage3!;
    // Stage 3 also stops when stage 1 or 2 runs again (found live 2026-11-18: it kept reading
    // while stage 2 listed the folders again); round3 then waits and starts it over.
    const stop = () =>
      this.stopped || getAudioStage(this.db, 3).mode === 'off' || !this.stages12Done();
    this.running3 = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          const done = await stage.step(stop);
          this.waiting3 = this.waiting3Text();
          if (done) break;
          // Let the server answer requests between steps (each is short).
          await new Promise((r) => setImmediate(r));
          const p = stage.progress();
          if (p?.phase === 'decode' && !this.opts.lock.holds(DISK_OWNERS.audio3)) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      } catch (err) {
        this.logError('Audiobook cleanup: stage 3 failed:', err);
      } finally {
        this.opts.lock.release(DISK_OWNERS.audio3);
        this.running3 = null;
        void this.tick();
      }
    })();
  }

  /**
   * Stage 4 (WP21c): looks the recordings stage 3 found up online. It starts once stage 3 has
   * finished, starts over when stage 3 runs again, and decides again (nothing fetched twice)
   * when its settings change. It needs the fetch container (the Calibre cleanup's queue).
   */
  private round4(): void {
    const st = getAudioStage(this.db, 4);
    if (st.mode === 'off' || !this.stage4) {
      this.waiting4 =
        st.mode === 'off'
          ? null
          : !this.opts.fetchQueue
            ? 'The fetch container is not set up'
            : this.roots.problem;
      return;
    }
    if (!this.roots.ok) {
      this.waiting4 = this.roots.problem;
      return;
    }
    const s3 = this.stage3?.progress();
    if (!s3 || s3.phase !== 'done' || s3.error) {
      this.waiting4 = 'Waiting for stage 3 to finish (stage 4 looks up the recordings it found)';
      return;
    }
    let p = this.stage4.progress();
    // A new stage-3 analysis, or units built by older code (WP21c follow-up (2): titles and
    // folders), start over from the units; every answer comes from the cache.
    if (!p || stage4StartsOver(p, s3.analysisId)) {
      if (this.running4) return;
      if (p)
        this.log(
          `Audiobooks stage 4: starting over (units v${p.unitsVersion ?? 1}, now v${STAGE4_UNITS_VERSION}; stage 3 ${s3.analysisId})`,
        );
      p = this.stage4.restart();
    }
    if (p.phase === 'done') {
      // A settings change after the analysis finished: decide again from the stored answers.
      const key = stage4SettingsKey(getSettings(this.db).audiobooks);
      if (p.rulesKey && p.rulesKey !== key && !p.error && !this.running4) {
        this.stage4.redecide();
        p = this.stage4.progress()!;
      } else {
        // A corrected labels.json scores the gate again (nothing is looked up again).
        this.stage4.refreshGate();
        this.waiting4 = p.error ? `The analysis failed: ${p.error}` : 'Preview: nothing is changed';
        return;
      }
    }
    this.waiting4 = this.waiting4Text();
    if (!this.running4) this.run4();
  }

  /** What stage 4 is doing now, and what it waits for. */
  private waiting4Text(): string {
    const p = this.stage4?.progress();
    if ((p?.phase === 'lookups' || p?.phase === 'records') && this.stage4?.waitingForDisk()) {
      const lock = this.opts.lock.state();
      if (lock.calibreApplying) return `Waiting for the disk: ${lock.calibreApplying}`;
      if (this.opts.lock.calibreBusy()) return 'Waiting while the Calibre cleanup uses the disk';
    }
    if (p?.phase === 'lookups') {
      const f = this.opts.fetcherStatus?.() as { online?: boolean } | undefined;
      if (f && f.online === false) return 'Waiting for the fetch container (it is offline)';
      return 'Looking up';
    }
    if (p?.phase === 'records') return 'Checking recordings that share a store record';
    return 'Analysing';
  }

  /** Stage 3 has finished the analysis stage 4 works on. */
  private stage3Done(): boolean {
    const s3 = this.stage3?.progress();
    const p = this.stage4?.progress();
    return (
      !!s3 && s3.phase === 'done' && !s3.error && (!p?.stage3Id || p.stage3Id === s3.analysisId)
    );
  }

  private run4(): void {
    const stage = this.stage4!;
    const stop = () =>
      this.stopped || getAudioStage(this.db, 4).mode === 'off' || !this.stage3Done();
    this.running4 = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          // Changed settings: every unit is decided again from the answers it has.
          const p = stage.progress();
          const key = stage4SettingsKey(getSettings(this.db).audiobooks);
          if (p && p.rulesKey && p.rulesKey !== key && p.phase === 'lookups') stage.redecide();
          const done = await stage.step(stop);
          this.waiting4 = this.waiting4Text();
          if (done) break;
          await new Promise((r) => setImmediate(r));
        }
      } catch (err) {
        this.logError('Audiobook cleanup: stage 4 failed:', err);
      } finally {
        this.opts.lock.release(DISK_OWNERS.audio4);
        this.running4 = null;
        void this.tick();
      }
    })();
  }

  /**
   * Stage 5 (WP21d): decides the metadata of the recordings stage 4 looked up. It starts once
   * stage 4 has finished, starts over when stage 4 runs again, decides again (nobody asked again)
   * when its rules' settings change, and asks again (answers already given are kept) when the
   * models, the prompt or the labeled-only setting change. It reads nothing but cleanup.db.
   */
  private round5(): void {
    const st = getAudioStage(this.db, 5);
    if (st.mode === 'off') {
      this.waiting5 = null;
      return;
    }
    const s4 = getAudioStage(this.db, 4).progress as {
      analysisId?: string;
      phase?: string;
      error?: string | null;
    };
    if (!s4?.analysisId || s4.phase !== 'done' || s4.error) {
      this.waiting5 = 'Waiting for stage 4 to finish (stage 5 decides from the records it found)';
      return;
    }
    let p = this.stage5.progress();
    if (!p || (p.stage4Id && p.stage4Id !== s4.analysisId)) {
      if (this.running5) return;
      if (p) this.log(`Audiobooks stage 5: starting over (stage 4 ${s4.analysisId})`);
      p = this.stage5.restart();
    }
    if (p.phase === 'done') {
      if (!p.error && !this.running5) {
        if (p.askKey && p.askKey !== stage5AskKey(this.db)) this.stage5.reask();
        else if (p.rulesKey && p.rulesKey !== stage5RulesKey(this.db)) this.stage5.redecide();
        else {
          this.stage5.refreshGate();
          this.waiting5 = p.error
            ? `The analysis failed: ${p.error}`
            : 'Preview: nothing is changed';
          return;
        }
        p = this.stage5.progress()!;
      } else {
        this.waiting5 = p.error ? `The analysis failed: ${p.error}` : 'Preview: nothing is changed';
        return;
      }
    }
    this.waiting5 = this.waiting5Text();
    if (!this.running5) this.run5(s4.analysisId);
  }

  private waiting5Text(): string {
    const p = this.stage5.progress();
    if (p?.phase === 'models') return p.wait ?? 'Asking the models';
    if (p?.phase === 'evidence') return 'Building the evidence records';
    if (p?.phase === 'decide') return 'Deciding';
    return 'Analysing';
  }

  private run5(stage4Id: string): void {
    const stage = this.stage5;
    const stop = () => {
      if (this.stopped || getAudioStage(this.db, 5).mode === 'off') return true;
      const s4 = getAudioStage(this.db, 4).progress as { analysisId?: string; phase?: string };
      return s4?.analysisId !== stage4Id || s4.phase !== 'done';
    };
    this.running5 = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          const p = stage.progress();
          if (p && p.phase === 'decide' && p.rulesKey && p.rulesKey !== stage5RulesKey(this.db))
            stage.redecide();
          const r = await stage.step(stop, stage4Id);
          this.waiting5 = this.waiting5Text();
          if (r === 'done') break;
          if (r === 'wait') {
            // Waiting for the providers' batches, the limit or a key: check again in a moment.
            for (let i = 0; i < 10 && !stop(); i++)
              await new Promise((res) => setTimeout(res, 500));
          } else await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Audiobook cleanup: stage 5 failed:', err);
      } finally {
        this.running5 = null;
        void this.tick();
      }
    })();
  }

  /**
   * Stage 6 (WP21e-1): plans the new library from stages 1-5 (Preview), then, when switched On,
   * builds it through the linking sidecar and checks it. A new analysis of stages 1-5 plans
   * again; after the build has started it pauses the stage instead.
   */
  private round6(): void {
    const st = getAudioStage(this.db, 6);
    if (st.mode === 'off' || !this.stage6) {
      this.stage6?.giveBack();
      this.waiting6 = st.mode === 'off' ? null : this.roots.problem;
      return;
    }
    if (!this.roots.ok) {
      this.waiting6 = this.roots.problem;
      return;
    }
    this.waiting6 = this.waiting6Text();
    if (!this.running6 && !st.pauseReason) this.run6(st.mode === 'on' ? 'on' : 'analyse');
  }

  /** What stage 6 does now, and what it waits for. */
  private waiting6Text(): string {
    const s6 = this.stage6;
    if (!s6) return 'The audiobook folders are not set up';
    const st = getAudioStage(this.db, 6);
    if (st.pauseReason) return `Paused: ${st.pauseDetail ?? st.pauseReason}`;
    if (librarySwitched(this.db))
      return 'Built, checked and switched: new books are added by stage 7';
    const { ids, problem } = stageIds(this.db);
    const p = s6.progress();
    if (!ids && !s6.buildStarted(p)) return problem ?? 'Waiting for stages 1-5';
    const lock = this.opts.lock.state();
    const sidecar = s6.sidecar();
    switch (p?.phase) {
      case undefined:
      case 'plan':
        return 'Planning (reads only cleanup.db)';
      case 'preflight':
        if (!sidecar.online)
          return 'Planned. Waiting for the linking sidecar to check the planned torrent files (start ttsu-cleanup-link)';
        if (this.opts.lock.calibreBusy()) return 'Waiting while the Calibre cleanup uses the disk';
        return 'The linking sidecar is checking the planned torrent files (read only)';
      case 'planned':
        return st.mode === 'on'
          ? 'Starting the build'
          : 'Preview: planned, nothing written. Switch On to build japanese-new';
      case 'walk_before':
      case 'walk_after':
        if (st.mode !== 'on' && p.phase === 'walk_before')
          return 'Preview: the build waits (switch On to continue)';
        if (this.opts.lock.calibreBusy()) return 'Waiting while the Calibre cleanup uses the disk';
        return p.phase === 'walk_before'
          ? 'Listing the torrents and the live library (before the build)'
          : 'Listing the torrents and the live library again (after the build)';
      case 'build':
        if (st.mode !== 'on') return 'Preview: the build waits (switch On to continue)';
        if (!sidecar.online) return 'Waiting for the linking sidecar (it is offline)';
        if (s6.isHanding())
          return 'Building: the linking sidecar makes the folders, links and metadata files';
        if (lock.calibreApplying) return `Waiting for the disk: ${lock.calibreApplying}`;
        if (lock.holder && lock.holder.owner !== DISK_OWNERS.audio6)
          return `Waiting for the disk: ${lock.holder.owner} is using it`;
        if (lock.waiting.some((w) => w.side === 'calibre'))
          return 'Giving the disk to the Calibre cleanup';
        return 'Building';
      case 'check':
        if (this.opts.lock.calibreBusy()) return 'Waiting while the Calibre cleanup uses the disk';
        return 'Checking the new folders, the torrents, the library, Audiobookshelf and the reader';
      case 'done':
        return p.check?.passed
          ? 'Built and checked'
          : 'Built; the check found problems (see Details)';
    }
    return 'Working';
  }

  private run6(mode: 'analyse' | 'on'): void {
    const stage = this.stage6!;
    const stop = () => {
      if (this.stopped) return true;
      const st = getAudioStage(this.db, 6);
      return st.mode !== mode || st.pauseReason !== null;
    };
    const hooks = {
      absSnapshot: async (): Promise<number | null> => {
        const s = getSettings(this.db).audiobooks;
        if (!s.absUrl || !this.opts.secrets.read('absApiKey')) return null;
        await this.takeSnapshot();
        const p0 = getAudioStage(this.db, 0).progress as { lastId?: number; error?: string | null };
        return p0.error ? null : (p0.lastId ?? null);
      },
      readerState: () => this.opts.readerState?.() ?? null,
      absCompare: (a: number, b: number) =>
        compareAbsSnapshots(getSnapshot(this.db, a), getSnapshot(this.db, b)),
    };
    this.running6 = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          const done = await stage.step(stop, mode, hooks);
          this.waiting6 = this.waiting6Text();
          if (done) break;
          await new Promise((r) => setImmediate(r));
        }
      } catch (err) {
        this.logError('Audiobook cleanup: stage 6 failed:', err);
        const p = stage.progress();
        if (p) {
          p.error = (err as Error).message.slice(0, 500);
          updateAudioStage(this.db, 6, { progress: p as unknown as Record<string, unknown> });
        }
      } finally {
        stage.giveBack();
        this.running6 = null;
        void this.tick();
      }
    })();
  }

  /**
   * Stage 7 (WP21f-1): starts the daily run when it is due (or Run now) and runs its phases while
   * it isn't paused. Off stops a run (setMode).
   */
  private round7(): void {
    const s7 = this.stage7;
    if (!s7 || this.running7) return;
    const st = getAudioStage(this.db, 7);
    if (st.mode === 'off' || st.pauseReason) {
      s7.giveBack();
      return;
    }
    if (!this.roots.ok) return;
    if (!s7.maybeStart()) return;
    const stop = () => {
      if (this.stopped) return true;
      const x = getAudioStage(this.db, 7);
      return x.mode === 'off' || x.pauseReason !== null;
    };
    this.running7 = (async () => {
      // Set before the first step (it calls tick() through reanalyse()).
      await Promise.resolve();
      try {
        for (;;) {
          if (stop()) break;
          const r = await s7.step(stop);
          if (r === 'done') break;
          if (r === 'wait') {
            for (let i = 0; i < 4 && !stop(); i++) await new Promise((res) => setTimeout(res, 500));
          } else await new Promise((res) => setImmediate(res));
        }
      } catch (err) {
        this.logError('Audiobook cleanup: stage 7 failed:', err);
      } finally {
        s7.giveBack();
        this.running7 = null;
        void this.tick();
      }
    })();
  }

  /** WP21e-2: runs the switch's phases while it is running and not paused. */
  private roundSwitch(): void {
    this.roundCovers();
    const sw = this.switcher;
    if (!sw || this.runningSwitch || !sw.isRunning() || sw.pause()) return;
    if (!this.roots.ok) return;
    const stop = () => this.stopped || !sw.isRunning() || sw.pause() !== null;
    this.runningSwitch = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          const done = await sw.step(stop);
          if (done) break;
          await new Promise((r) => setImmediate(r));
        }
      } catch (err) {
        this.logError('Audiobook cleanup: the switch failed:', err);
      } finally {
        sw.giveBack();
        this.runningSwitch = null;
        void this.tick();
      }
    })();
  }

  /** WP21e-2 stop 3: sets the covers while that run is on and not paused. */
  private roundCovers(): void {
    const c = this.covers;
    if (!c || this.runningCovers || !c.isRunning() || c.pause()) return;
    const stop = () => this.stopped || !c.isRunning() || c.pause() !== null;
    this.runningCovers = (async () => {
      try {
        for (;;) {
          if (stop()) break;
          if (await c.step(stop)) break;
          await new Promise((r) => setImmediate(r));
        }
      } catch (err) {
        this.logError('Audiobook cleanup: covers failed:', err);
      } finally {
        this.runningCovers = null;
      }
    })();
  }

  coversStart(): void {
    if (!this.covers) throw new Error('The audiobook folders are not set up');
    this.covers.start();
    void this.tick();
  }

  coversResume(): void {
    if (!this.covers) throw new Error('The audiobook folders are not set up');
    this.covers.resume();
    void this.tick();
  }

  /** The page's switch actions (each asked first on the page). */
  async switchStart(action: SwitchAction): Promise<void> {
    if (!this.switcher) throw new Error('The audiobook folders are not set up');
    if (this.running6) throw new Error('Stage 6 is working; wait for it or switch it to Preview');
    await this.switcher.start(action);
    this.log(`Audiobooks: ${action} started from the page`);
    void this.tick();
  }

  switchResume(): void {
    if (!this.switcher) throw new Error('The audiobook folders are not set up');
    this.switcher.resume();
    void this.tick();
  }

  async switchCancel(): Promise<void> {
    if (!this.switcher) throw new Error('The audiobook folders are not set up');
    await this.runningSwitch;
    this.switcher.cancel();
    void this.tick();
  }

  /** The linking sidecar's routes (/api/v1/cleanup-link/*). */
  linkHeartbeat(body: Parameters<AudioStage6['heartbeat']>[0]) {
    if (!this.stage6) throw new Error('The audiobook folders are not set up');
    const r = this.stage6.heartbeat(body);
    if (this.switcher?.active() || this.stage7?.active()) return { active: true, pollSeconds: 1 };
    return r;
  }

  linkClaim(): LinkBatch | SwitchBatch | ArrivalBatch | null {
    return this.switcher?.claim() ?? this.stage7?.claim() ?? this.stage6?.claim() ?? null;
  }

  linkReport(batchId: number, results: LinkOpResult[]) {
    if (!this.stage6) throw new Error('The audiobook folders are not set up');
    const r =
      batchId >= ARRIVAL_BATCH_BASE && this.stage7
        ? this.stage7.report(batchId, results as unknown as ArrivalOpResult[])
        : batchId >= SWITCH_BATCH_BASE && this.switcher
          ? this.switcher.report(batchId, results)
          : this.stage6.report(batchId, results);
    void this.tick();
    return r;
  }

  /** Stage 7's lists, review choices, Resume and the plan's CSV. */
  arrivals(list: string, opts: { offset?: number; limit?: number } = {}) {
    return this.stage7?.list(list, opts) ?? { total: 0, items: [] };
  }

  arrivalsDecide(reviewId: number, decision: string): void {
    if (!this.stage7) throw new Error('The audiobook folders are not set up');
    this.stage7.decide(reviewId, decision);
  }

  arrivalsResume(): void {
    if (!this.stage7) throw new Error('The audiobook folders are not set up');
    this.stage7.resume();
    void this.tick();
  }

  arrivalsCsv(): string {
    return this.stage7?.planCsv() ?? '';
  }

  /** Stage 6's lists and downloads. */
  build(list: string, opts: { offset?: number; limit?: number } = {}) {
    return this.stage6?.list(list, opts) ?? { total: 0, items: [] };
  }

  buildCsv(which: 'moves' | 'plan'): string {
    if (!this.stage6) return '';
    return which === 'moves' ? this.stage6.movesCsv() : this.stage6.planCsv();
  }

  /** "Check again": the after-walk and the check, once more (nothing is written). */
  buildCheckAgain(): void {
    if (!this.stage6) throw new Error('The audiobook folders are not set up');
    if (this.running6) throw new Error('Stage 6 is working; switch it to Preview first');
    this.stage6.checkAgain();
    void this.tick();
  }

  /** An answer reached the shared queue: stage 4's loop takes it on its next step. */
  answerArrived(): void {
    if (!this.stopped && !this.running4 && getAudioStage(this.db, 4).mode !== 'off') {
      void this.tick();
    }
  }

  async setMode(stage: number, mode: AudioStageMode): Promise<void> {
    if (!AUDIO_ANALYSIS_STAGES.includes(stage)) throw new Error('No such stage');
    if (stage === 7) {
      if (!this.stage7) throw new Error('The audiobook folders are not set up');
      if (mode === 'on') {
        const refusals = await this.stage7.onRefusals();
        if (refusals.length) throw new Error(refusals.join('; '));
        this.log('Audiobooks stage 7: switched On (new books are added to the library)');
      }
      // A run going on keeps its mode; Off stops it.
      if (mode === 'off') this.stage7.stopRun('Switched Off');
      setAudioStageMode(this.db, stage, mode);
      void this.tick();
      return;
    }
    if (mode === 'on') {
      if (!AUDIO_ON_STAGES.includes(stage))
        throw new Error('Only stage 6 (the build) can be switched on');
      if (!this.stage6) throw new Error('The audiobook folders are not set up');
      const refusals = this.stage6.onRefusals();
      const foreign = await this.stage6.foreignFolders();
      if (foreign.length)
        refusals.push(
          `${foreign.join(' and ')} already exist (not made by this build): remove them first`,
        );
      if (refusals.length) throw new Error(refusals.join('; '));
      this.log('Audiobooks stage 6: switched On (the build starts)');
    }
    setAudioStageMode(this.db, stage, mode);
    void this.tick();
  }

  /** "Run the analysis again" (keeps the hashes and health of unchanged files). */
  reanalyse(stage: number): void {
    this.log(`Audiobooks stage ${stage}: run the analysis again (asked from the page)`);
    if (stage === 7) {
      // Stage 7's "Run now".
      if (!this.stage7) throw new Error('The audiobook folders are not set up');
      this.stage7.requestRun();
      void this.tick();
      return;
    }
    if (stage === 6) {
      if (!this.stage6) throw new Error('The audiobook folders are not set up');
      if (this.running6) throw new Error('Stage 6 is working; switch it Off first');
      this.stage6.restart();
      void this.tick();
      return;
    }
    if (stage === 5) {
      if (this.running5) throw new Error('Stage 5 is analysing; switch it Off first');
      this.stage5.restart();
      void this.tick();
      return;
    }
    if (stage === 1 && this.stage1) this.stage1.restart();
    else if (stage === 2 && this.stage2) this.stage2.restart();
    else if (stage === 3 && this.stage3) {
      if (this.running3) throw new Error('Stage 3 is analysing; switch it Off first');
      this.stage3.restart();
    } else if (stage === 4 && this.stage4) {
      if (this.running4) throw new Error('Stage 4 is looking up; switch it Off first');
      this.stage4.restart();
    } else throw new Error('The audiobook folders are not set up');
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
    const p3 = this.stage3?.progress() ?? null;
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
      stage3: {
        waiting: this.waiting3,
        progress: p3
          ? {
              ...p3,
              gateCopyIds: undefined,
              gate: p3.gate ? { ...p3.gate, results: undefined } : null,
            }
          : null,
        counts: p3?.counts ?? null,
      },
      stage4: this.stage4Status(),
      stage5: { available: true, waiting: this.waiting5, ...this.stage5.status() },
      stage6: this.stage6
        ? { available: true, waiting: this.waiting6, ...this.stage6.status() }
        : { available: false, waiting: this.waiting6 },
      stage7: this.stage7 ? { available: true, ...this.stage7.status() } : { available: false },
      switch: this.switcher
        ? { available: true, ...this.switcher.status(), covers: this.covers?.status() ?? null }
        : { available: false },
    };
  }

  /** Stage 4's card: progress, the sites' queues and time left, the gate. */
  private stage4Status() {
    const p4 = this.stage4?.progress() ?? null;
    const lines = audioSiteLines(this.db, p4, Date.now());
    return {
      available: this.stage4 !== null,
      waiting: this.waiting4,
      fetcher: this.opts.fetcherStatus?.() ?? null,
      progress: p4 ? { ...p4, gate: p4.gate ? { ...p4.gate, results: undefined } : null } : null,
      units: p4 ? unitStates(this.db, p4.analysisId) : {},
      sites: lines.sites,
      secondsLeft: lines.secondsLeft,
      ratios: lines.ratios,
      counts: p4?.counts ?? null,
    };
  }

  /** Stage 5's lists (paged). */
  meta(
    list: string,
    opts: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const p = this.stage5.progress();
    if (!p) return { total: 0, items: [] };
    return metaList(this.db, p, list, opts, this.stage5);
  }

  /** The AI framework's state for Settings: spending, the models per task and their checks. */
  aiStatus() {
    const s = getSettings(this.db);
    const checks = this.ai.modelChecks();
    const tasks = Object.entries(s.models).map(([task, model]) => {
      const provider = providerOf(model);
      const c = checks[provider];
      return {
        task,
        model,
        provider,
        price: s.ai.prices[model] ?? null,
        checked: c ? (c.models ? c.models.includes(model) : null) : null,
        mode: modeOf(s.ai, model),
      };
    });
    return {
      settings: s.ai,
      spend: { ...spendNow(this.db), limitUsd: s.ai.spendLimitUsd },
      keys: {
        anthropic: this.opts.secrets.read('anthropicApiKey') !== null,
        openai: this.opts.secrets.read('openaiApiKey') !== null,
      },
      checks: Object.fromEntries(
        Object.entries(checks).map(([p, c]) => [
          p,
          { checkedAt: c.checkedAt, error: c.error, models: c.models?.length ?? null },
        ]),
      ),
      tasks,
      // The steps that ask models today, each with the model tasks it uses now (Settings > AI
      // shows only these; other tasks stay saved until their step is built: WP20e, WP20f, the
      // upgrade pass).
      steps: [
        {
          id: META_SPEC.stage,
          name: 'Audiobook metadata (stage 5)',
          about:
            "Both models read every recording. A value is confirmed when the rules are sure or both models agree; otherwise the second model's answer is kept as the best guess, marked unconfirmed.",
          models: [
            { task: META_SPEC.tasks.primary, role: 'First model' },
            { task: META_SPEC.tasks.secondary, role: 'Second model' },
          ],
        },
        {
          // WP21f-1: the new arrivals' setup J (default): E, then the stronger pair.
          id: `${META_SPEC.stage}.upgrade`,
          name: 'New audiobooks: the second look (setup J)',
          about:
            'After both models above, two stronger models look again at what they decided or guessed, for the new audiobooks of the daily run only. A value both stronger models agree on is confirmed.',
          models: [
            { task: META_SPEC.tasks.upgradePrimary, role: 'First stronger model' },
            { task: META_SPEC.tasks.upgradeSecondary, role: 'Second stronger model' },
          ],
        },
        {
          id: STAGE4_SPEC.stage,
          name: 'Calibre online sources (stage 4)',
          about:
            "Both models read every book. A value is confirmed when the rules are sure or both models agree; otherwise the second model's answer is kept as the best guess, marked unconfirmed.",
          models: [
            { task: STAGE4_SPEC.tasks.primary, role: 'First model' },
            { task: STAGE4_SPEC.tasks.secondary, role: 'Second model' },
          ],
        },
        {
          id: STAGE5_SPEC.stage,
          name: 'Calibre genres and tags (stage 5)',
          about:
            'Both models read every book. A genre or tag is applied only when both models give it; RanobeDB and the store categories add theirs, and every book of a series gets what any of its volumes has.',
          models: [
            { task: STAGE5_SPEC.tasks.primary, role: 'First model' },
            { task: STAGE5_SPEC.tasks.secondary, role: 'Second model' },
          ],
        },
      ],
      batchTests: this.ai.batchTests(),
    };
  }

  /** Settings > AI "Test batch": one tiny question to the model as a batch. */
  async testBatch(model: string) {
    const s = getSettings(this.db);
    if (!Object.values(s.models).includes(model))
      throw new Error('Not one of the configured models');
    await this.ai.testBatch(model);
    return this.aiStatus();
  }

  /** Settings: Check models (reads each provider's model list with the stored key). */
  async checkModels() {
    await this.ai.checkModels();
    void this.tick();
    return this.aiStatus();
  }

  /** Stage 4's lists (paged). */
  online(
    list: string,
    opts: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const p = this.stage4?.progress();
    if (!this.stage4 || !p) return { total: 0, items: [] };
    return onlineList(this.db, p, list, opts);
  }

  /**
   * "Ask again" for an audio site: its given-up requests go back to the queue, and every unit
   * not matched automatically is looked up again (its answered steps come from the cache).
   */
  retryOnlineSite(site: string): { requests: number; units: number } {
    if (!(AUDIO_FETCH_SITES as readonly string[]).includes(site)) throw new Error('No such site');
    if (!this.opts.fetchQueue) throw new Error('The fetch container is not set up');
    const requests = this.opts.fetchQueue.retryFailed(site);
    const p = this.stage4?.progress();
    let units = 0;
    if (p && this.stage4 && requests > 0) {
      if (p.phase === 'done') this.stage4.redecide();
      else {
        units = this.db
          .prepare(
            `UPDATE audio_online_units SET state = 'ready', updated_at = ?
             WHERE analysis_id = ? AND kind = 'lookup' AND (state = 'error' OR (state = 'decided' AND class <> 'auto'))`,
          )
          .run(Date.now(), p.analysisId).changes;
      }
    }
    void this.tick();
    return { requests, units };
  }

  // -------------------------------------------------------------------------------------------
  // Stage 3's lists, decisions and clips

  private copyView(c: LoadedCopy) {
    const f = this.stage3!.factsOf(c);
    return {
      id: c.id,
      key: c.key,
      kind: c.kind,
      name: c.name,
      paths: c.files
        .slice(0, 20)
        .map((x) => `${x.root === 'library' ? 'library' : 'torrents'}/${x.rel}`),
      fileIds: c.files.map((x) => x.id),
      files: c.files.length,
      seconds: c.seconds,
      codec: f.codec,
      bitrate: f.bitrate === null ? null : Math.round(f.bitrate),
      sampleRate: f.sampleRate,
      chapters: f.chapters.length,
      cover: f.hasCover,
      asins: c.asins,
      absAsins: c.absAsins,
      ai: c.ai,
      damage: f.damage,
      damageDetail: f.damageDetail ?? null,
      excluded: c.excluded,
    };
  }

  /** Stage 3's lists (paged): groups and review items with their copies side by side. */
  dups(
    list: string,
    { offset = 0, limit = 50 }: { offset?: number; limit?: number } = {},
  ): { total: number; items: Record<string, unknown>[] } {
    const p = this.stage3?.progress();
    if (!this.stage3 || !p) return { total: 0, items: [] };
    const copies = this.stage3.loadCopies(p.analysisId);
    if (list === 'gate') {
      const results = p.gate?.results ?? [];
      return {
        total: results.length,
        items: results.slice(offset, offset + limit) as unknown as Record<string, unknown>[],
      };
    }
    if (list === 'excluded' || list === 'different') {
      if (list === 'excluded') {
        const all = [...copies.values()].filter((c) => c.excluded);
        return {
          total: all.length,
          items: all.slice(offset, offset + limit).map((c) => this.copyView(c)),
        };
      }
      const where = `analysis_id = ? AND verdict = 'different'`;
      const total = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM audio_dup_pairs WHERE ${where}`)
          .get(p.analysisId) as { n: number }
      ).n;
      const rows = this.db
        .prepare(`SELECT * FROM audio_dup_pairs WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`)
        .all(p.analysisId, limit, offset) as Record<string, unknown>[];
      return {
        total,
        items: rows.map((r) => ({
          id: r.id,
          test: r.test,
          verdict: r.verdict,
          scores: r.scores_json ? JSON.parse(r.scores_json as string) : null,
          lengthDiff: r.length_diff,
          detail: r.detail,
          copies: [copies.get(r.a_id as number), copies.get(r.b_id as number)]
            .filter((c): c is LoadedCopy => !!c)
            .map((c) => this.copyView(c)),
        })),
      };
    }
    let where: string;
    const params: unknown[] = [p.analysisId];
    if (list === 'review') where = `g.analysis_id = ? AND g.outcome = 'review'`;
    else if (list === 'auto')
      where = `g.analysis_id = ? AND g.outcome = 'auto' AND g.kind = 'group'`;
    else if (list === 'unsure')
      where = `g.analysis_id = ? AND g.outcome = 'review' AND g.kind = 'unsure'`;
    else if (list === 'damaged') where = `g.analysis_id = ? AND g.damaged = 1`;
    else if (list.startsWith('test:')) {
      where = `g.analysis_id = ? AND g.first_test = ? AND g.kind = 'group'`;
      params.push(list.slice(5));
    } else throw new Error('No such list');
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM audio_dup_groups g WHERE ${where}`)
        .get(...params) as { n: number }
    ).n;
    const groups = this.db
      .prepare(`SELECT g.* FROM audio_dup_groups g WHERE ${where} ORDER BY g.id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, unknown>[];
    const members = this.db.prepare(
      'SELECT copy_id, rank, role, against_json FROM audio_dup_members WHERE group_id = ? ORDER BY rank',
    );
    const pairBetween = this.db.prepare(
      `SELECT a_id, b_id, test, verdict, fp_verdict, scores_json, length_diff, detail FROM audio_dup_pairs
       WHERE analysis_id = ? AND a_id = ? AND b_id = ?`,
    );
    const decision = this.db.prepare(
      'SELECT decision, decided_by, decided_at FROM audio_dup_decisions WHERE group_key = ?',
    );
    const items = groups.map((g) => {
      const ms = members.all(g.id) as {
        copy_id: number;
        rank: number;
        role: string;
        against_json: string | null;
      }[];
      const ids = ms.map((m) => m.copy_id);
      const pairs: Record<string, unknown>[] = [];
      for (let i = 0; i < ids.length && pairs.length < 10; i++)
        for (let j = i + 1; j < ids.length && pairs.length < 10; j++) {
          const r = pairBetween.get(
            p.analysisId,
            Math.min(ids[i], ids[j]),
            Math.max(ids[i], ids[j]),
          ) as Record<string, unknown> | undefined;
          if (r)
            pairs.push({
              ...r,
              scores: r.scores_json ? JSON.parse(r.scores_json as string) : null,
              scores_json: undefined,
            });
        }
      return {
        id: g.id,
        groupKey: g.group_key,
        kind: g.kind,
        firstTest: g.first_test,
        tests: JSON.parse(g.tests_json as string),
        rule: g.rule,
        outcome: g.outcome,
        reviewReason: g.review_reason,
        damaged: g.damaged === 1,
        bestCopyId: g.best_copy_id,
        decision: decision.get(g.group_key) ?? null,
        copies: ms
          .map((m) => {
            const c = copies.get(m.copy_id);
            return c ? { ...this.copyView(c), rank: m.rank, role: m.role } : null;
          })
          .filter(Boolean),
        pairs,
      };
    });
    return { total, items };
  }

  /** Records the user's choice for a group (WP21e applies it); 'clear' forgets it. */
  decideDup(groupId: number, decision: DupDecision): void {
    const p = this.stage3?.progress();
    if (!this.stage3 || !p) throw new Error('Stage 3 has not run');
    const g = this.db
      .prepare('SELECT id, group_key FROM audio_dup_groups WHERE id = ? AND analysis_id = ?')
      .get(groupId, p.analysisId) as { id: number; group_key: string } | undefined;
    if (!g) throw new Error('No such group in the current analysis');
    const copies = this.stage3.loadCopies(p.analysisId);
    const keys = (
      this.db.prepare('SELECT copy_id FROM audio_dup_members WHERE group_id = ?').all(g.id) as {
        copy_id: number;
      }[]
    ).map((m) => copies.get(m.copy_id)?.key ?? String(m.copy_id));
    if (decision === 'clear') {
      this.db.prepare('DELETE FROM audio_dup_decisions WHERE group_key = ?').run(g.group_key);
      return;
    }
    if (
      decision !== 'keep_all' &&
      !(decision.startsWith('keep:') && keys.includes(decision.slice(5)))
    ) {
      throw new Error('decision must be keep_all, keep:<a copy of this group> or clear');
    }
    this.db
      .prepare(
        `INSERT INTO audio_dup_decisions (group_key, member_keys, decision, decided_by, decided_at)
         VALUES (?, ?, ?, 'you', ?)
         ON CONFLICT(group_key) DO UPDATE SET member_keys = excluded.member_keys,
           decision = excluded.decision, decided_by = 'you', decided_at = excluded.decided_at`,
      )
      .run(g.group_key, JSON.stringify(keys), decision, Date.now());
  }

  /**
   * A few seconds from the start or the end of a copy (mp3), for the review page. Waits like
   * every audiobook read: while a Calibre job uses the disk it is refused (AudioBusyError) and
   * the page tries again (decided with the user, 2026-11-18).
   */
  async clip(copyId: number, at: 'start' | 'end'): Promise<Buffer> {
    const p = this.stage3?.progress();
    if (!this.stage3 || !p || !this.opts.roots) throw new Error('Stage 3 has not run');
    const c = this.stage3.loadCopies(p.analysisId).get(copyId);
    if (!c || c.files.length === 0) throw new Error('No such copy');
    if (this.opts.lock.calibreBusy()) {
      throw new AudioBusyError(
        'The Calibre cleanup is using the disk; the clip plays when it is free',
      );
    }
    const f = at === 'start' ? c.files[0] : c.files[c.files.length - 1];
    const s = getSettings(this.db).audiobooks;
    const buf = await cutClip(insideRoot(this.opts.roots[f.root], f.rel, f.raw), this.opts.tools, {
      at,
      seconds: s.dupClipSeconds,
      timeoutMs: s.toolTimeoutSeconds * 1000,
    });
    if (!buf) throw new Error('The clip could not be cut from this file');
    return buf;
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

/** Audiobookshelf before vs after (WP21e-1): libraries, their folders, item counts, progress. */
export function compareAbsSnapshots(
  a: AbsSnapshotData | null,
  b: AbsSnapshotData | null,
): { same: boolean; detail: string } {
  if (!a || !b) return { same: false, detail: 'A snapshot is missing' };
  const libs = (d: AbsSnapshotData) =>
    JSON.stringify(
      d.libraries
        .map((l) => ({
          id: l.id,
          name: l.name,
          folders: [...l.folders].sort(),
          items: l.itemCount,
        }))
        .sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
  const progress = (d: AbsSnapshotData) =>
    JSON.stringify(
      d.progress
        .map((p) => [p.user, p.libraryItemId, p.isFinished, p.inAbs])
        .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)),
    );
  const diffs: string[] = [];
  if (libs(a) !== libs(b)) diffs.push('libraries, folders or item counts changed');
  if (progress(a) !== progress(b)) diffs.push('listening progress entries changed');
  const items = b.libraries.reduce((n, l) => n + (l.itemCount ?? 0), 0);
  return {
    same: diffs.length === 0,
    detail: diffs.length
      ? diffs.join('; ')
      : `${b.libraries.length} libraries, ${items} items, ${b.progress.length} progress entries: the same`,
  };
}
