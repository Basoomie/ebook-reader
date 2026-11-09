/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { PositionPrompt, PromptPlace, PromptRow } from '$lib/sync/position-prompt-service';

/**
 * "Continue from...?" (WP9) for one open book: decides when to check and
 * keeps checks from overlapping. Free of Svelte and DOM; the reader supplies
 * the hooks. Every failure is swallowed: reading must never be affected.
 *
 * - On open: right away from the local mirror, then again after the opening
 *   sync. Both offer this device's own record too (a place the legacy sync
 *   moved the bookmark back from).
 * - While open: when the tab becomes visible again and when a sync in this
 *   tab brings positions for the book (other devices only).
 * - One prompt at a time, never over another dialog (checked again once it
 *   closes). Every version shown is marked as answered, whichever button.
 */

export interface PromptApi {
  /** Server book id when the prompt applies to this book (Calibre link, sync on). */
  bookId(localId: number, title: string): Promise<string | null>;
  find(bookId: string, place: PromptPlace): Promise<PositionPrompt | null>;
  markHandled(bookId: string, answered: { recordId: string; updatedAt: number }[]): Promise<void>;
  onChanged(bookId: string, callback: () => void): Promise<() => void>;
  /** The opening sync; resolves when done (never rejects). */
  syncSoon(): Promise<unknown>;
}

export interface ReaderHooks {
  livePos(): number;
  total(): number;
  /** Another dialog is open; don't prompt over it. */
  otherDialogOpen(): boolean;
  /** Calls back whenever the dialogs close; returns an unsubscribe function. */
  onDialogsClosed(callback: () => void): () => void;
  /** Calls back when the tab becomes visible again; returns an unsubscribe function. */
  onVisible(callback: () => void): () => void;
  /** Shows the prompt; resolves with the chosen row, or null for "Stay here". */
  ask(prompt: PositionPrompt): Promise<PromptRow | null>;
  /** Moves the reader to the chosen place. */
  jump(row: PromptRow): void;
  warn(message: string): void;
}

export class ReaderPositionPrompt {
  private bookId: string | null = null;
  private restoredPos = 0;
  private openPhase = true;
  private destroyed = false;
  private checking = false;
  private pending = false;
  private pendingOpen = false;
  private unsubscribers: (() => void)[] = [];
  private cancelAsk: (() => void) | null = null;

  constructor(
    private readonly api: PromptApi,
    private readonly hooks: ReaderHooks
  ) {}

  /** Call once the saved place has been restored. Never rejects. */
  async start(localId: number, title: string, restoredPos: number): Promise<void> {
    try {
      this.restoredPos = Math.max(0, restoredPos || 0);
      const bookId = await this.api.bookId(localId, title);
      if (!bookId || this.destroyed) return;
      this.bookId = bookId;

      this.unsubscribers.push(this.hooks.onVisible(() => void this.check(false)));
      this.unsubscribers.push(this.hooks.onDialogsClosed(() => this.retryPending()));
      const offChanged = await this.api.onChanged(bookId, () => void this.check(false));
      if (this.destroyed) {
        offChanged();
        return;
      }
      this.unsubscribers.push(offChanged);

      // The mirror first (offline works); the opening sync runs meanwhile, even
      // while that prompt is open, and is checked again when it is done (a
      // check that finds a prompt open is queued and runs after the answer).
      const first = this.check(true);
      await this.api.syncSoon();
      await this.check(true);
      await first;
    } catch (error) {
      this.hooks.warn(`Position prompt: ${(error as Error)?.message ?? error}`);
    } finally {
      this.openPhase = false;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribers.forEach((u) => {
      try {
        u();
      } catch {
        // ignore
      }
    });
    this.unsubscribers = [];
    this.cancelAsk?.();
  }

  private retryPending(): void {
    if (!this.pending || this.checking) return;
    const open = this.pendingOpen;
    this.pending = false;
    this.pendingOpen = false;
    void this.check(open);
  }

  /** `open`: part of the open checks (offers this device's own record). */
  async check(open: boolean): Promise<void> {
    const bookId = this.bookId;
    if (!bookId || this.destroyed) return;
    const isOpen = open && this.openPhase;
    if (this.checking || this.hooks.otherDialogOpen()) {
      this.pending = true;
      this.pendingOpen ||= isOpen;
      return;
    }
    this.checking = true;
    try {
      const live = Math.max(0, this.hooks.livePos() || 0);
      const prompt = await this.api.find(bookId, {
        // On open the reader may report the page start, a little before the saved place.
        localPos: isOpen ? Math.max(live, this.restoredPos) : live,
        localTotal: this.hooks.total() || 0,
        ownBaseline: isOpen ? this.restoredPos : null
      });
      if (!prompt || this.destroyed) return;
      if (this.hooks.otherDialogOpen()) {
        this.pending = true;
        this.pendingOpen ||= isOpen;
        return;
      }

      const choice = await new Promise<PromptRow | null | undefined>((resolve) => {
        this.cancelAsk = () => resolve(undefined);
        this.hooks.ask(prompt).then(resolve, (error) => {
          this.hooks.warn(`Position prompt: ${(error as Error)?.message ?? error}`);
          resolve(undefined);
        });
      });
      this.cancelAsk = null;
      if (choice === undefined || this.destroyed) return; // closed without an answer

      await this.api.markHandled(
        bookId,
        prompt.rows.map((r) => ({ recordId: r.recordId, updatedAt: r.updatedAt }))
      );
      if (choice) this.hooks.jump(choice);
    } catch (error) {
      this.hooks.warn(`Position prompt: ${(error as Error)?.message ?? error}`);
    } finally {
      this.checking = false;
      if (this.pending && !this.destroyed && !this.hooks.otherDialogOpen()) this.retryPending();
    }
  }
}
