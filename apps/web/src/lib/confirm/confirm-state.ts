/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Confirmations before destructive actions (WP19). The words of one confirmation: a
 * question naming the object ("Delete 3 books?"), what goes, where and what stays, and an
 * action button that repeats the verb ("Delete 3 books"), never "OK" or "Confirm".
 */
export interface ConfirmCopy {
  title: string;
  /** Paragraphs under the title. */
  message: string[];
  confirmLabel: string;
  cancelLabel?: string;
  /** Adds "This can't be undone." as the last paragraph. */
  irreversible?: boolean;
  /** false for a confirmation that removes nothing (Complete book): the plain filled button. */
  danger?: boolean;
}

export interface ConfirmOptions extends ConfirmCopy {
  testid?: string;
  confirmTestid?: string;
}

export const IRREVERSIBLE_NOTE = "This can't be undone.";

/** The paragraphs as shown, with the "can't be undone" note last when it applies. */
export function confirmParagraphs(copy: Pick<ConfirmCopy, 'message' | 'irreversible'>): string[] {
  const paragraphs = copy.message.filter((p) => p.trim() !== '');
  return copy.irreversible ? [...paragraphs, IRREVERSIBLE_NOTE] : paragraphs;
}

/**
 * Answers a confirmation once. Every way a dialog can go away (Cancel, Esc, a backdrop tap,
 * another dialog replacing it) ends in `answer`; only the first counts, so a double tap
 * can't act twice and a dialog closed from outside still resolves (as "no").
 */
export function answerOnce(resolver: (confirmed: boolean) => void) {
  let answered = false;
  return {
    answer(confirmed: boolean): boolean {
      if (answered) return false;
      answered = true;
      resolver(confirmed);
      return true;
    },
    get answered() {
      return answered;
    }
  };
}

/**
 * Focus kept inside a dialog: the index to focus after Tab (or Shift+Tab) from `current`
 * among `count` focusable elements, wrapping at both ends. -1 when there is nothing to focus.
 */
export function nextFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return backwards ? (current - 1 + count) % count : (current + 1) % count;
}

export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
