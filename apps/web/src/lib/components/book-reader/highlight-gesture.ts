/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP11a: when the highlight bar may appear for a text selection.
 *
 * The reader never intercepts taps, long-presses or `selectstart` on text, and never
 * clears a selection by itself; Yomitan, whispersync, ruby reveal and page-turn taps get
 * exactly what they got before. This only decides whether a selection was made by the
 * user (then the bar appears) or by a program (Yomitan's "select matched text",
 * whispersync), which must not show it.
 *
 * A selection counts as the user's after one of these on the book's text, until the next
 * press anywhere else:
 * - a touch long-press: the browser reports it as a `contextmenu` event before selecting;
 * - a mouse press and release on the text that left a selection (a drag);
 * - a mouse double or triple click (word or paragraph selection).
 * A tap never arms it. With "any selection" on, every selection in the book counts.
 *
 * Listeners using this are passive: they never call preventDefault.
 */
export type GestureEvent =
  | { type: 'pointerdown'; inReader: boolean; inBar: boolean; pointerType: string }
  | { type: 'pointerup'; pointerType: string; selectionInReader: boolean }
  | { type: 'contextmenu'; inReader: boolean }
  | { type: 'click'; inReader: boolean; detail: number; pointerType: string }
  | { type: 'done' };

export class HighlightGesture {
  /** The current selection may show the bar. */
  armed = false;

  /** The last press was on the bar itself (its buttons must not hide it). */
  pressOnBar = false;

  private pressInReader = false;

  note(event: GestureEvent): boolean {
    switch (event.type) {
      case 'pointerdown':
        this.pressOnBar = event.inBar;

        if (!event.inBar) {
          this.armed = false;
          this.pressInReader = event.inReader;
        }

        return false;
      case 'pointerup':
        if (event.pointerType === 'mouse' && this.pressInReader && event.selectionInReader) {
          this.armed = true;
          return true;
        }

        return false;
      case 'contextmenu':
        if (event.inReader) {
          this.armed = true;
          return true;
        }

        return false;
      case 'click':
        if (event.inReader && event.detail >= 2 && event.pointerType !== 'touch') {
          this.armed = true;
          return true;
        }

        return false;
      case 'done':
        this.armed = false;
        this.pressOnBar = false;
        return false;
      default:
        return false;
    }
  }

  /** Whether a (non-empty) selection in the book shows the bar. */
  shows(anySelection: boolean) {
    return anySelection || this.armed;
  }
}
