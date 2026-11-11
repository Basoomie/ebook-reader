/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  STAT_SESSION_FIX_KIND,
  STAT_SESSION_KIND,
  statSessionId,
  type StatSessionData,
  type StatSessionSource
} from '$lib/stats/stat-records';

/**
 * Records the tracker's reading as `stat-session` records (WP12). One recorder
 * per open book. The tracker keeps all its rules (ticks, idle, skips, day split)
 * and hands over what it counted; this turns it into sessions.
 *
 * - add(day, seconds, chars, at) adds to the open session; a different day seals
 *   it and opens a new one. A session's numbers never go below 0: going back
 *   further than the open session read is kept as a debt that later reading pays
 *   off first (net progress, as the old per-day rows counted it).
 * - flush() writes the open session (and sealed ones not written yet). Writes run
 *   one after another and always write the newest numbers.
 * - seal() writes the open session as closed; the server refuses changes after.
 * - revert() applies a tracker-history revert; for a session already sealed in
 *   this visit it writes a `stat-session-fix` with the corrected numbers.
 * - addCompletion() writes a sealed completion session (characters only).
 *
 * Never throws: every failure is reported through `warn` and as `false`.
 */

export interface SessionTarget {
  bookId: string;
  deviceId: string;
}

export interface SessionRecorderDeps {
  /** The book's catalog id and this device's id; null = the book can't be recorded. */
  resolveTarget(): Promise<SessionTarget | null>;
  /** The book's current read-through id (null = the first). */
  readThroughId(bookId: string): Promise<string | null>;
  put(kind: string, id: string, data: Record<string, unknown>, bookId: string): Promise<boolean>;
  newId(): string;
  warn(message: string): void;
}

interface Session {
  sessionId: string;
  day: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  chars: number;
  lookups: number;
  source: StatSessionSource;
  closed: boolean;
  /** Undefined until the first write looked it up. */
  readThroughId: string | null | undefined;
  /** Changed since it was last written. */
  dirty: boolean;
  /** A correction to write for it (sealed sessions only). */
  fix: { seconds: number; chars: number } | null;
  /** Its closed version reached the local store (it can't be written again). */
  sealedWritten: boolean;
}

/** The parts of the deps that reach the records (loaded lazily by the reader). */
export type RecordSideDeps = Pick<SessionRecorderDeps, 'resolveTarget' | 'readThroughId' | 'put'>;

/**
 * Deps whose record side loads on first use: the reader creates its recorder at
 * once (so the first seconds count) without importing the sync module up front.
 * A failed load is retried on the next use.
 */
export function lazyRecorderDeps(
  load: () => Promise<RecordSideDeps>,
  newId: () => string,
  warn: (message: string) => void
): SessionRecorderDeps {
  let loading: Promise<RecordSideDeps> | null = null;
  const get = () => {
    if (!loading) {
      loading = load().catch((error) => {
        loading = null;
        throw error;
      });
    }
    return loading;
  };
  return {
    resolveTarget: async () => (await get()).resolveTarget(),
    readThroughId: async (bookId) => (await get()).readThroughId(bookId),
    put: async (kind, id, data, bookId) => (await get()).put(kind, id, data, bookId),
    newId,
    warn
  };
}

function finite(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

export class SessionRecorder {
  private open: Session | null = null;
  /** Sessions sealed during this visit, newest last (for reverts and retries). */
  private sealed: Session[] = [];
  private charDebt = 0;
  private secondDebt = 0;
  private debtDay: string | null = null;
  private target: Promise<SessionTarget | null> | null = null;
  private chain: Promise<boolean> = Promise.resolve(true);
  private unavailableWarned = false;

  constructor(private readonly deps: SessionRecorderDeps) {}

  /** Whether the book can be recorded (resolves the target once). */
  async available(): Promise<boolean> {
    return !!(await this.resolve());
  }

  /** The open session's numbers, for display. */
  get openSession(): Readonly<
    Pick<Session, 'day' | 'seconds' | 'chars' | 'lookups' | 'startedAt'>
  > | null {
    return this.open;
  }

  add(day: string, seconds: number, chars: number, at: number): void {
    try {
      const s = finite(Math.round(seconds));
      const c = finite(Math.round(chars));
      if (!s && !c) return;
      if (this.open && this.open.day !== day) this.sealOpen(at);
      if (this.debtDay !== day) {
        this.charDebt = 0;
        this.secondDebt = 0;
        this.debtDay = day;
      }
      if (!this.open) {
        // Only reading opens a session (a pure backwards move doesn't).
        if (s <= 0 && c <= 0) {
          this.charDebt += Math.max(0, -c);
          this.secondDebt += Math.max(0, -s);
          return;
        }
        this.open = {
          sessionId: this.deps.newId(),
          day,
          startedAt: at - Math.max(0, s) * 1000,
          endedAt: at,
          seconds: 0,
          chars: 0,
          lookups: 0,
          source: 'tracker',
          closed: false,
          readThroughId: undefined,
          dirty: true,
          fix: null,
          sealedWritten: false
        };
      }
      const session = this.open;
      [session.seconds, this.secondDebt] = SessionRecorder.apply(
        session.seconds,
        s,
        this.secondDebt
      );
      [session.chars, this.charDebt] = SessionRecorder.apply(session.chars, c, this.charDebt);
      session.endedAt = Math.max(session.endedAt, at);
      session.dirty = true;
    } catch (error) {
      this.deps.warn(`Stats: could not count reading: ${(error as Error)?.message ?? error}`);
    }
  }

  /** value + delta, never below 0; a shortfall becomes debt and later gains pay it first. */
  private static apply(value: number, delta: number, debt: number): [number, number] {
    if (delta >= 0) {
      const paid = Math.min(debt, delta);
      return [value + delta - paid, debt - paid];
    }
    const next = value + delta;
    return next >= 0 ? [next, debt] : [0, debt - next];
  }

  /** Whether a session id was made by this recorder (counted in memory by the tracker). */
  ownsSession(sessionId: string): boolean {
    return this.open?.sessionId === sessionId || this.sealed.some((s) => s.sessionId === sessionId);
  }

  /** A dictionary popup opened: counted on the open session, if any. */
  addLookup(): void {
    if (!this.open) return;
    this.open.lookups += 1;
    this.open.dirty = true;
  }

  /** Undo or redo a tracker-history entry of `day` (deltas as the history item gives them). */
  revert(day: string, seconds: number, chars: number, at: number): void {
    try {
      if (this.open && this.open.day === day) {
        this.add(day, seconds, chars, at);
        return;
      }
      const target = [...this.sealed].reverse().find((s) => s.day === day);
      if (!target) {
        this.deps.warn(`Stats: nothing to revert on ${day}`);
        return;
      }
      const base = target.fix ?? { seconds: target.seconds, chars: target.chars };
      target.fix = {
        seconds: Math.max(0, base.seconds + finite(Math.round(seconds))),
        chars: Math.max(0, base.chars + finite(Math.round(chars)))
      };
      target.dirty = true;
    } catch (error) {
      this.deps.warn(`Stats: could not revert: ${(error as Error)?.message ?? error}`);
    }
  }

  /** Writes what changed. Resolves true when everything was written. */
  flush(): Promise<boolean> {
    this.chain = this.chain.then(
      () => this.writeAll(),
      () => this.writeAll()
    );
    return this.chain;
  }

  /** Closes the open session (if any) and writes it. */
  seal(at = Date.now()): Promise<boolean> {
    if (this.open) this.sealOpen(at);
    return this.flush();
  }

  /** "Complete Book" adding the characters left: a sealed session with characters only. */
  addCompletion(day: string, chars: number, at: number): Promise<boolean> {
    const c = finite(Math.round(chars));
    if (c > 0) {
      this.sealed.push({
        sessionId: this.deps.newId(),
        day,
        startedAt: at,
        endedAt: at,
        seconds: 0,
        chars: c,
        lookups: 0,
        source: 'completion',
        closed: true,
        readThroughId: undefined,
        dirty: true,
        fix: null,
        sealedWritten: false
      });
    }
    return this.flush();
  }

  private sealOpen(at: number) {
    const session = this.open;
    if (!session) return;
    session.closed = true;
    session.endedAt = Math.max(session.startedAt, Math.min(session.endedAt, at));
    session.dirty = true;
    this.sealed.push(session);
    this.open = null;
  }

  private resolve(): Promise<SessionTarget | null> {
    if (!this.target) {
      this.target = this.deps.resolveTarget().catch((error) => {
        this.deps.warn(`Stats: could not find the book: ${(error as Error)?.message ?? error}`);
        this.target = null;
        return null;
      });
    }
    return this.target;
  }

  private async writeAll(): Promise<boolean> {
    try {
      const pending = [
        ...this.sealed.filter((s) => s.dirty),
        ...(this.open?.dirty ? [this.open] : [])
      ];
      if (!pending.length) return true;
      const target = await this.resolve();
      if (!target) {
        if (!this.unavailableWarned) {
          this.unavailableWarned = true;
          this.deps.warn('Stats: this book has no library id; its reading is not recorded');
        }
        for (const s of pending) s.dirty = false;
        return true;
      }
      let ok = true;
      for (const s of pending) {
        // Taken before the write: anything added meanwhile marks it dirty again.
        s.dirty = false;
        if (!(await this.writeOne(target, s))) {
          s.dirty = true;
          ok = false;
        }
      }
      return ok;
    } catch (error) {
      this.deps.warn(`Stats: could not save reading: ${(error as Error)?.message ?? error}`);
      return false;
    }
  }

  private async writeOne(target: SessionTarget, s: Session): Promise<boolean> {
    if (s.readThroughId === undefined) {
      try {
        s.readThroughId = await this.deps.readThroughId(target.bookId);
      } catch {
        s.readThroughId = null;
      }
    }
    const id = statSessionId(target.bookId, target.deviceId, s.sessionId);
    if (!s.sealedWritten) {
      if (!(await this.writeSession(id, target, s))) return false;
      if (s.closed) s.sealedWritten = true;
    }
    if (s.fix && s.closed) {
      // A sealed session can't change: its correction is a separate record.
      return this.deps.put(
        STAT_SESSION_FIX_KIND,
        id,
        { seconds: s.fix.seconds, chars: s.fix.chars },
        target.bookId
      );
    }
    return true;
  }

  private writeSession(id: string, target: SessionTarget, s: Session): Promise<boolean> {
    const data: StatSessionData = {
      day: s.day,
      startedAt: Math.round(s.startedAt),
      endedAt: Math.round(Math.max(s.startedAt, s.endedAt)),
      seconds: s.seconds,
      chars: s.chars,
      lookups: s.lookups,
      readThroughId: s.readThroughId ?? null,
      source: s.source,
      closed: s.closed
    };
    return this.deps.put(STAT_SESSION_KIND, id, { ...data }, target.bookId);
  }
}
