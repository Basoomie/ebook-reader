/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Recently viewed: when a book's details page counts as a view. Only time while the page
 * is visible counts, so a page left in a background tab never counts; leaving the page (or
 * moving to another book) before the time is up records nothing. Each book counts once per
 * visit of its page.
 */

export interface ViewTimerDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  visible(): boolean;
  /** Called once per visit, when the time is up. */
  record(bookId: string): void;
}

export class ViewTimer {
  private bookId = '';
  private needMs = 0;
  /** Visible time collected before the current visible stretch. */
  private collectedMs = 0;
  /** When the current visible stretch began (null while hidden). */
  private since: number | null = null;
  private handle: unknown = null;
  private done = true;

  constructor(private readonly deps: ViewTimerDeps) {}

  /** A book's page is shown (a new book restarts the count). */
  start(bookId: string, seconds: number): void {
    // The same book again (the page reloading it) is the same visit.
    if (!bookId || bookId === this.bookId) return;
    this.stop();
    this.bookId = bookId;
    this.needMs = Math.max(0, seconds) * 1000;
    this.collectedMs = 0;
    this.done = false;
    this.since = null;
    if (this.deps.visible()) this.resume();
  }

  /** The tab became visible or hidden. */
  visibilityChanged(): void {
    if (this.done || !this.bookId) return;
    if (this.deps.visible()) this.resume();
    else this.pause();
  }

  /** The page is left: nothing more is recorded for this visit. */
  stop(): void {
    this.clear();
    this.bookId = '';
    this.done = true;
    this.since = null;
  }

  private resume() {
    if (this.since !== null) return;
    this.since = this.deps.now();
    const left = this.needMs - this.collectedMs;
    if (left <= 0) {
      this.finish();
      return;
    }
    this.handle = this.deps.setTimeout(() => this.finish(), left);
  }

  private pause() {
    if (this.since === null) return;
    this.collectedMs += this.deps.now() - this.since;
    this.since = null;
    this.clear();
  }

  private finish() {
    if (this.done) return;
    this.clear();
    this.done = true;
    this.deps.record(this.bookId);
  }

  private clear() {
    if (this.handle !== null) this.deps.clearTimeout(this.handle);
    this.handle = null;
  }
}
