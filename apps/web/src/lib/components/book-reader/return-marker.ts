/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP11b: the return marker, "where you were reading" (decided with the user). The first
 * recorded jump of an excursion (Continue there, Return to saved place, Jump to Position,
 * the TOC, search, a highlight or bookmark) keeps the place it left from. It stays through
 * page turns and further jumps, in memory for the open book like the jump history, until
 * you go back there (the marker, or Back/Forward landing on it) or close it.
 *
 * It is not the saved place: Auto Save Place moves that on the next page turn after a jump.
 */
export class ReturnMarker {
  private place: number | undefined;

  get position() {
    return this.place;
  }

  /** A recorded jump leaves `from`; only the first one of an excursion sets the marker. */
  noteJump(from: number) {
    if (this.place === undefined && Number.isFinite(from)) {
      this.place = from;
    }
  }

  /** A Back/Forward jump landed at `at`: back where you were reading ends the excursion. */
  noteArrived(at: number) {
    if (this.place !== undefined && at === this.place) {
      this.place = undefined;
    }
  }

  clear() {
    this.place = undefined;
  }
}
