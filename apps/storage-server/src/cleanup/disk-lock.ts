/**
 * One disk-heavy job at a time across the Calibre and the audiobook cleanups (WP21a; design
 * section 8: disk1 is the NAS's single data disk). Hashing, full decodes and Calibre's book
 * reading take this lock; small header reads don't.
 *
 * When both sides wait, Calibre goes first (decided by the user). A Calibre holder is never
 * interrupted; an audiobook holder sees `shouldYield()` turn true as soon as a Calibre job
 * waits and gives the lock back at once (the file it was reading is read again later).
 *
 * Process-local: both cleanups run inside the storage server.
 */
export type DiskSide = 'calibre' | 'audio';

export interface DiskLockState {
  holder: { owner: string; side: DiskSide; since: number } | null;
  waiting: { owner: string; side: DiskSide; since: number }[];
  /** A Calibre batch being applied (its own disk work): audiobook jobs wait meanwhile. */
  calibreApplying: string | null;
}

/** How long the answer of the "Calibre is applying" check is reused (it reads cleanup.db). */
const BUSY_CACHE_MS = 1000;

const POLL_MS = 250;

export class DiskLock {
  private holder: { owner: string; side: DiskSide; since: number } | null = null;
  private readonly waiters = new Map<string, { side: DiskSide; since: number }>();
  private busyCheck: () => string | null = () => null;
  private busyAt = 0;
  private busyValue: string | null = null;

  constructor(private readonly pollMs = POLL_MS) {}

  /**
   * The Calibre cleanup's applying of a batch (the sidecar exports and removes through Calibre)
   * also has the disk first (user, 2026-11-17: nothing may hold up Calibre stage 3): while it
   * names a batch, no audiobook job takes the lock and a holder gives it back.
   */
  setCalibreApplying(check: () => string | null): void {
    this.busyCheck = check;
    this.busyAt = 0;
  }

  private calibreApplying(now = Date.now()): string | null {
    if (now - this.busyAt >= BUSY_CACHE_MS) {
      try {
        this.busyValue = this.busyCheck();
      } catch {
        this.busyValue = null;
      }
      this.busyAt = now;
    }
    return this.busyValue;
  }

  /** Takes the lock if the rules allow it now (the same owner may take it again). */
  tryAcquire(owner: string, side: DiskSide, now = Date.now()): boolean {
    if (this.holder) return this.holder.owner === owner;
    if (side === 'audio' && [...this.waiters.values()].some((w) => w.side === 'calibre')) {
      return false;
    }
    if (side === 'audio' && this.calibreApplying(now) !== null) return false;
    if (side === 'calibre') {
      // Calibre jobs among themselves: the one waiting longest first.
      const first = [...this.waiters.entries()]
        .filter(([, w]) => w.side === 'calibre')
        .sort((a, b) => a[1].since - b[1].since)[0];
      if (first && first[0] !== owner) return false;
    }
    this.waiters.delete(owner);
    this.holder = { owner, side, since: now };
    return true;
  }

  /**
   * Waits for the lock. Returns false when `shouldStop` turned true while waiting (nothing is
   * held then).
   */
  async acquire(
    owner: string,
    side: DiskSide,
    shouldStop: () => boolean = () => false,
  ): Promise<boolean> {
    if (this.tryAcquire(owner, side)) return true;
    if (!this.waiters.has(owner)) this.waiters.set(owner, { side, since: Date.now() });
    try {
      for (;;) {
        if (shouldStop()) return false;
        await new Promise((r) => setTimeout(r, this.pollMs));
        if (this.tryAcquire(owner, side)) return true;
      }
    } finally {
      if (this.holder?.owner !== owner) this.waiters.delete(owner);
    }
  }

  release(owner: string): void {
    if (this.holder?.owner === owner) this.holder = null;
    this.waiters.delete(owner);
  }

  /**
   * True while a Calibre job uses the disk: it holds the lock, waits for it, or applies a batch.
   * Audiobook work that doesn't take the lock (listing the folders, file checks) gives way then.
   */
  calibreBusy(): boolean {
    return (
      this.calibreApplying() !== null ||
      this.holder?.side === 'calibre' ||
      [...this.waiters.values()].some((w) => w.side === 'calibre')
    );
  }

  holds(owner: string): boolean {
    return this.holder?.owner === owner;
  }

  /** True for an audiobook holder while a Calibre job waits: it must give the lock back now. */
  shouldYield(owner: string): boolean {
    if (this.holder?.owner !== owner || this.holder.side !== 'audio') return false;
    return (
      [...this.waiters.values()].some((w) => w.side === 'calibre') ||
      this.calibreApplying() !== null
    );
  }

  state(): DiskLockState {
    return {
      holder: this.holder ? { ...this.holder } : null,
      waiting: [...this.waiters.entries()]
        .map(([owner, w]) => ({ owner, side: w.side, since: w.since }))
        .sort((a, b) => a.since - b.since),
      calibreApplying: this.calibreApplying(),
    };
  }
}

/** The owner names shown on /cleanup. */
export const DISK_OWNERS = {
  calibre1: 'Calibre stage 1 (identical files)',
  calibre2: 'Calibre stage 2 (metadata from the files)',
  calibre3: 'Calibre stage 3 (content duplicates)',
  audio1: 'Audiobooks stage 1 (identity)',
} as const;
