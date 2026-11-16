/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { sharedPopupWatch } from '$lib/dictionary/popup-watch';

/**
 * Dictionary-lookup count (WP12): total popup openings, as decided (repeated lookups of the
 * same word count; moving to another word while the popup stays open doesn't). The popup is
 * seen by the shared watch (`lib/dictionary/popup-watch.ts`): the popup element, or Yomitan's
 * word selection when its secure container hides the element. Risk R4: these depend on the
 * extensions, so a change in an extension only loses the count.
 */
export class LookupCounter {
  private release: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly doc: Document,
    private readonly onLookup: () => void,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  start(): void {
    if (this.release) return;

    try {
      const { watch, release } = sharedPopupWatch(this.doc, this.warn);
      this.release = release;
      this.unsubscribe = watch.subscribe(({ kind }) => {
        if (kind === 'open') this.onLookup();
      });
    } catch (error) {
      this.warn(`Stats: lookup count unavailable: ${(error as Error)?.message ?? error}`);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.release?.();
    this.unsubscribe = null;
    this.release = null;
  }
}
