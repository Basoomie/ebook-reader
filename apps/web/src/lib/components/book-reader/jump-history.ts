/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP10b: back/forward over the places you jumped away from, browser-style. Places are
 * character positions (`exploredCharCount`) of the open book; nothing is stored.
 *
 * - A jump (search, TOC, bookmark, Jump to Position, "Continue there") records where you
 *   were and clears the forward list.
 * - Back returns to the last recorded place and keeps your current place for Forward;
 *   Forward does the reverse.
 * - At most `getLimit()` places are kept on each side (oldest dropped first).
 */
export class JumpHistory {
  private backStack: number[] = [];

  private forwardStack: number[] = [];

  constructor(private getLimit: () => number) {}

  get canGoBack() {
    return this.backStack.length > 0;
  }

  get canGoForward() {
    return this.forwardStack.length > 0;
  }

  /** Records the place a jump leaves from. */
  push(from: number) {
    if (!Number.isFinite(from) || from < 0) {
      return;
    }

    if (this.backStack[this.backStack.length - 1] !== from) {
      this.backStack.push(from);
      this.trim(this.backStack);
    }

    this.forwardStack = [];
  }

  /** The place to go back to (skipping places equal to `current`), or undefined. */
  back(current: number) {
    const target = this.popDifferent(this.backStack, current);

    if (target !== undefined) {
      this.pushTo(this.forwardStack, current);
    }

    return target;
  }

  /** The place to go forward to (skipping places equal to `current`), or undefined. */
  forward(current: number) {
    const target = this.popDifferent(this.forwardStack, current);

    if (target !== undefined) {
      this.pushTo(this.backStack, current);
    }

    return target;
  }

  clear() {
    this.backStack = [];
    this.forwardStack = [];
  }

  private popDifferent(stack: number[], current: number) {
    while (stack.length) {
      const target = stack.pop() as number;

      if (target !== current) {
        return target;
      }
    }

    return undefined;
  }

  private pushTo(stack: number[], place: number) {
    if (stack[stack.length - 1] !== place) {
      stack.push(place);
      this.trim(stack);
    }
  }

  private trim(stack: number[]) {
    const limit = Math.max(1, Math.floor(this.getLimit() || 0));

    if (stack.length > limit) {
      stack.splice(0, stack.length - limit);
    }
  }
}
