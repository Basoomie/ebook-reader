/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BehaviorSubject } from 'rxjs';
import type { SyncTransport } from '$lib/sync/sync-api';
import type { SyncEngine, SyncReport } from '$lib/sync/sync-engine';

/**
 * Runs the sync engine in the background (WP4): after local changes
 * (debounced), when the browser comes online, when the tab becomes visible,
 * periodically, and on "Sync now". Nothing in the reader ever waits for it;
 * every failure is caught and shown in the status only.
 */

export type RunnerState = 'idle' | 'syncing' | 'off' | 'disconnected' | 'error';

export interface RunnerStatus {
  state: RunnerState;
  deviceId: string | null;
  pending: number;
  rejected: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export interface RunnerSettings {
  enabled(): boolean;
  debounceSeconds(): number;
  intervalMinutes(): number;
}

export interface RunnerEnv {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Subscribes to online / visible events; returns an unsubscribe function. */
  onWake(listener: () => void): () => void;
  isVisible(): boolean;
  /** Web Locks (secure context only); runs fn with or without the lock. */
  withLock?<T>(fn: () => Promise<T>): Promise<T | null>;
}

export interface RunnerDeps {
  getEngine(): Promise<SyncEngine>;
  /** The transport for the current connection, or null when not connected. */
  getTransport(): Promise<SyncTransport | null>;
  /** Runs before each cycle (e.g. publishing this device's settings). Errors are logged. */
  beforeSync?: (engine: SyncEngine) => Promise<void>;
  settings: RunnerSettings;
  env: RunnerEnv;
  warn?: (message: string) => void;
}

const FIRST_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

function isAuthError(error: unknown): boolean {
  return (error as { kind?: string } | null)?.kind === 'unauthorized';
}

export class SyncRunner {
  readonly status$ = new BehaviorSubject<RunnerStatus>({
    state: 'idle',
    deviceId: null,
    pending: 0,
    rejected: 0,
    lastSyncAt: null,
    lastError: null
  });

  private timer: unknown = null;
  private timerDue = Infinity;
  private failures = 0;
  /** Set after an auth error: no automatic retries until the connection changes. */
  private halted = false;
  private started = false;
  private running: Promise<SyncReport | null> | null = null;
  private rerun = false;
  private unsubscribers: (() => void)[] = [];
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: RunnerDeps) {
    this.warn = deps.warn ?? ((message) => console.warn(message));
  }

  /** Starts listening; runs a first sync right away. Safe to call twice. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const engine = await this.deps.getEngine();
      this.unsubscribers.push(engine.onLocalWrite(() => this.onLocalWrite()));
    } catch (error) {
      this.warn(`Sync: could not open local sync data: ${(error as Error)?.message ?? error}`);
      return;
    }
    this.unsubscribers.push(this.deps.env.onWake(() => this.schedule(0)));
    await this.refreshStatus();
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    this.clearTimer();
  }

  /** After connecting, disconnecting or re-pairing. */
  connectionChanged(): void {
    this.halted = false;
    this.failures = 0;
    this.schedule(0);
  }

  /** "Sync now": ignores the backoff; resolves when the cycle is done (never rejects). */
  syncNow(): Promise<SyncReport | null> {
    this.halted = false;
    this.failures = 0;
    this.clearTimer();
    return this.run();
  }

  private onLocalWrite(): void {
    void this.refreshStatus();
    if (this.halted || this.failures > 0) return; // the backoff timer runs next
    this.schedule(Math.max(0, this.deps.settings.debounceSeconds()) * 1000);
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    const due = Date.now() + delayMs;
    if (this.timer !== null && this.timerDue <= due) return;
    this.clearTimer();
    this.timerDue = due;
    this.timer = this.deps.env.setTimeout(() => {
      this.timer = null;
      this.timerDue = Infinity;
      void this.run();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.env.clearTimeout(this.timer);
    this.timer = null;
    this.timerDue = Infinity;
  }

  private scheduleNext(): void {
    if (this.halted) return;
    if (this.failures > 0) {
      const delay = Math.min(FIRST_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
      this.schedule(delay);
      return;
    }
    // Periodic syncs only while the app is visible (becoming visible syncs at
    // once); local changes still sync while hidden.
    const minutes = this.deps.settings.intervalMinutes();
    if (minutes > 0 && this.deps.env.isVisible()) this.schedule(minutes * 60_000);
  }

  private run(): Promise<SyncReport | null> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.runOnce().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(0);
      } else {
        this.scheduleNext();
      }
    });
    return this.running;
  }

  private async runOnce(): Promise<SyncReport | null> {
    try {
      if (!this.deps.settings.enabled()) {
        this.setState('off');
        return null;
      }
      const transport = await this.deps.getTransport();
      if (!transport) {
        this.setState('disconnected');
        return null;
      }
      const engine = await this.deps.getEngine();
      this.setState('syncing');
      if (this.deps.beforeSync) {
        try {
          await this.deps.beforeSync(engine);
        } catch (error) {
          this.warn(`Sync: preparing the sync failed: ${(error as Error)?.message ?? error}`);
        }
      }
      const cycle = () => engine.sync(transport);
      const report = this.deps.env.withLock ? await this.deps.env.withLock(cycle) : await cycle();
      this.failures = 0;
      await this.refreshStatus('idle');
      return report;
    } catch (error) {
      if (isAuthError(error)) {
        this.halted = true;
      } else {
        this.failures += 1;
      }
      this.warn(`Sync failed: ${(error as Error)?.message ?? error}`);
      await this.refreshStatus('error', (error as Error)?.message ?? String(error));
      return null;
    }
  }

  private setState(state: RunnerState): void {
    this.status$.next({ ...this.status$.getValue(), state });
  }

  private async refreshStatus(state?: RunnerState, error?: string): Promise<void> {
    try {
      const engine = await this.deps.getEngine();
      const s = await engine.status();
      const previous = this.status$.getValue();
      this.status$.next({
        state: state ?? previous.state,
        deviceId: s.deviceId,
        pending: s.pending,
        rejected: s.rejected,
        lastSyncAt: s.lastSyncAt,
        lastError: error ?? s.lastError
      });
    } catch {
      if (state) this.setState(state);
    }
  }
}
