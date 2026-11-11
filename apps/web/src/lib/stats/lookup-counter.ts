/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Dictionary-lookup count (WP12): total popup openings, as decided (repeated
 * lookups of the same word count). Uses the same signals as the tracker's
 * popup auto-pause: Yomitan/Yomichan popups (by class, shown unless
 * `visibility: hidden`) and the jpdb popup (`#jpdb-popup`, shown unless
 * `opacity: 0`). Risk R4: these depend on the extensions' markup, so the
 * selectors live here only; a change in an extension only loses the count.
 */

export const DICTIONARY_POPUP_SELECTOR =
  '.yomichan-popup,.yomichan-float,.yomitan-popup,.yomitan-float';
export const JPDB_POPUP_ID = 'jpdb-popup';

export function isPopupShown(element: HTMLElement): boolean {
  if (element.id === JPDB_POPUP_ID) return element.style.opacity !== '0';
  return element.style.visibility !== 'hidden';
}

/**
 * Calls `onLookup` each time a dictionary popup goes from hidden (or absent) to
 * shown. Watches the body's children for new popups and each popup's style.
 * Never throws; `stop()` disconnects everything.
 */
export class LookupCounter {
  private readonly shown = new WeakMap<HTMLElement, boolean>();
  private readonly watched = new Set<HTMLElement>();
  private bodyObserver: MutationObserver | null = null;
  private popupObserver: MutationObserver | null = null;

  constructor(
    private readonly doc: Document,
    private readonly onLookup: () => void,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  start(): void {
    try {
      const Observer = this.doc.defaultView?.MutationObserver;
      if (!Observer || !this.doc.body) return;
      this.popupObserver = new Observer((mutations) => {
        for (const m of mutations) this.check(m.target as HTMLElement);
      });
      this.bodyObserver = new Observer(() => this.scan());
      this.bodyObserver.observe(this.doc.body, { childList: true });
      this.scan();
    } catch (error) {
      this.warn(`Stats: lookup count unavailable: ${(error as Error)?.message ?? error}`);
    }
  }

  stop(): void {
    this.bodyObserver?.disconnect();
    this.popupObserver?.disconnect();
    this.bodyObserver = null;
    this.popupObserver = null;
    this.watched.clear();
  }

  private scan() {
    try {
      const popups = [
        ...Array.from(this.doc.querySelectorAll<HTMLElement>(DICTIONARY_POPUP_SELECTOR)),
        ...[this.doc.getElementById(JPDB_POPUP_ID)].filter((e): e is HTMLElement => !!e)
      ];
      for (const popup of popups) {
        if (this.watched.has(popup)) continue;
        this.watched.add(popup);
        this.popupObserver?.observe(popup, { attributes: true, attributeFilter: ['style'] });
        this.check(popup);
      }
    } catch (error) {
      this.warn(`Stats: lookup count: ${(error as Error)?.message ?? error}`);
    }
  }

  private check(popup: HTMLElement) {
    try {
      const now = isPopupShown(popup);
      const before = this.shown.get(popup) ?? false;
      this.shown.set(popup, now);
      if (now && !before) this.onLookup();
    } catch (error) {
      this.warn(`Stats: lookup count: ${(error as Error)?.message ?? error}`);
    }
  }
}
