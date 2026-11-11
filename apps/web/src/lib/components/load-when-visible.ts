/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Loads the next page when the end of a list comes near (WP19a). Put it on an element
 * after the list: `use:loadWhenVisible={{ enabled, onVisible }}`.
 *
 * `enabled` should be false while a page is loading, when there is no next page and after
 * an error; each change re-observes, so a list that still doesn't fill the screen after a
 * page loads keeps loading. Without IntersectionObserver (`canLoadWhenVisible()` false) it
 * does nothing and the page shows its "Load more" button instead.
 */

export interface LoadWhenVisibleOptions {
  enabled: boolean;
  onVisible: () => void;
  /** How far before the end to start (default: one screen height). */
  rootMargin?: string;
}

export const LOAD_AHEAD_MARGIN = '0px 0px 100% 0px';

export function canLoadWhenVisible(): boolean {
  return typeof IntersectionObserver !== 'undefined';
}

export function loadWhenVisible(node: Element, initial: LoadWhenVisibleOptions) {
  let options = initial;
  let observer: IntersectionObserver | undefined;

  function observe() {
    observer?.disconnect();
    observer = undefined;
    if (!options.enabled || !canLoadWhenVisible()) return;
    observer = new IntersectionObserver(
      (entries) => {
        if (options.enabled && entries.some((e) => e.isIntersecting)) options.onVisible();
      },
      { rootMargin: options.rootMargin ?? LOAD_AHEAD_MARGIN }
    );
    observer.observe(node);
  }

  observe();
  return {
    update(next: LoadWhenVisibleOptions) {
      const changed = next.enabled !== options.enabled || next.rootMargin !== options.rootMargin;
      options = next;
      // Re-observing makes the observer report the current state once more.
      if (changed) observe();
    },
    destroy() {
      observer?.disconnect();
    }
  };
}
