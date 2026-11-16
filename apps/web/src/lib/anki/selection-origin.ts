/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Whether the page's selection was made by the user or set by a script (fix of 2026-11-15).
 *
 * Verified in Chrome: a selection the user makes (mouse drag) fires `selectstart` before its
 * `selectionchange`s; a selection set by a script (`addRange`, `setBaseAndExtent`, as
 * Yomitan's "Select matched text" does) fires only `selectionchange`. A new press or key
 * starts a new gesture, so a script's selection after the user's own is told apart.
 */
export class SelectionOrigin {
  private gestureSelects = false;
  private lastByUser = false;

  /** pointerdown / keydown: a new gesture, not (yet) a selection. */
  gesture(): void {
    this.gestureSelects = false;
  }

  /** selectstart: the user is selecting. */
  selectStart(): void {
    this.gestureSelects = true;
  }

  /** selectionchange: records who made the selection as it is now. */
  selectionChange(): void {
    this.lastByUser = this.gestureSelects;
  }

  /** Whether the last selection change came from the user's own gesture. */
  get byUser(): boolean {
    return this.lastByUser;
  }
}
