/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Whether a dictionary popup (Yomitan, Yomichan, jpdb) is open, for the lookup count, the
 * tracker's and whispersync's auto-pause and the pacer (fix of 2026-11-15). One instance per
 * document (`sharedPopupWatch`), so every feature sees the same lookups.
 *
 * Two signals, never counted twice:
 *
 * 1. The popup element (Yomitan with "Use a secure container around popups" off, Yomichan,
 *    jpdb): a body child matching DICTIONARY_POPUP_SELECTOR or #jpdb-popup, shown unless
 *    `visibility: hidden` (jpdb: `opacity: 0`); a new left/top while shown is a new word.
 * 2. Yomitan's word selection, for its default secure container (a closed shadow root the page
 *    can't look into). Verified in Yomitan 26.7.29's source and in Chrome: "Select matched
 *    text" (on by default) selects each looked-up word by script and clears the selection when
 *    the popup closes. A selection the user makes appears while a mouse button or finger is
 *    down (drag, long-press) or by keyboard; Yomitan's appears with nothing pressed (hover, or
 *    after a tap has ended). Yomitan doesn't select while the user has a selection of their
 *    own, so those lookups can't be seen.
 *
 * Once a popup element has been seen in the page, only the element counts; a lookup the
 * selection opened just before the element first showed is taken over by it.
 *
 * Isolated like the stats code: every failure is caught and only loses the signal.
 */

export const DICTIONARY_POPUP_SELECTOR =
  '.yomichan-popup,.yomichan-float,.yomitan-popup,.yomitan-float';
export const JPDB_POPUP_ID = 'jpdb-popup';

export function isPopupShown(element: HTMLElement): boolean {
  if (element.id === JPDB_POPUP_ID) return element.style.opacity !== '0';
  return element.style.visibility !== 'hidden';
}

export type PopupChangeKind = 'open' | 'move' | 'close';
export type PopupSource = 'element' | 'selection';

export interface PopupChange {
  /** open: a popup appeared; move: it shows another word; close: it was hidden. */
  kind: PopupChangeKind;
  source: PopupSource;
}

export type PopupListener = (change: PopupChange) => void;

/** Keys that select text from the keyboard (Shift alone is Yomitan's scan key). */
function selectsByKey(event: KeyboardEvent): boolean {
  if (event.shiftKey && /^(Arrow|Home$|End$|Page)/.test(event.key)) return true;
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a';
}

const KEY_SELECTION_MS = 500;

export class DictionaryPopupWatch {
  private readonly listeners = new Set<PopupListener>();
  private current: { source: PopupSource; popup: HTMLElement | null } | null = null;
  private running = false;

  // The popup element.
  private readonly watched = new Set<HTMLElement>();
  private readonly styleOf = new WeakMap<HTMLElement, string>();
  private bodyObserver: MutationObserver | null = null;
  private popupObserver: MutationObserver | null = null;
  private elementSeen = false;

  // Yomitan's word selection.
  private readonly pressed = new Set<number>();
  private keySelectionUntil = 0;
  private owner: 'none' | 'user' | 'script' = 'none';
  private lastRange: Range | null = null;

  constructor(
    private readonly doc: Document,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /** Whether a dictionary popup is open now. */
  get shown(): boolean {
    return this.current !== null;
  }

  /** Calls `listener` on each change. Returns the unsubscribe. */
  subscribe(listener: PopupListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;

    try {
      const Observer = this.doc.defaultView?.MutationObserver;

      if (!Observer || !this.doc.body) return;

      this.running = true;
      this.popupObserver = new Observer((mutations) => {
        for (const m of mutations) this.checkElement(m.target as HTMLElement);
      });
      this.bodyObserver = new Observer(() => this.scan());
      this.bodyObserver.observe(this.doc.body, { childList: true });

      const listen = { capture: true, passive: true };
      this.doc.addEventListener('pointerdown', this.onPointerDown, listen);
      this.doc.addEventListener('pointerup', this.onPointerUp, listen);
      this.doc.addEventListener('pointercancel', this.onPointerUp, listen);
      this.doc.addEventListener('keydown', this.onKeyDown, listen);
      this.doc.addEventListener('selectionchange', this.onSelectionChange, listen);
      this.doc.defaultView?.addEventListener('blur', this.onBlur, listen);
      this.scan();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stops watching; an open popup is reported closed. */
  stop(): void {
    if (!this.running) return;

    this.running = false;
    this.bodyObserver?.disconnect();
    this.popupObserver?.disconnect();
    this.bodyObserver = null;
    this.popupObserver = null;
    this.watched.clear();
    const listen = { capture: true };
    this.doc.removeEventListener('pointerdown', this.onPointerDown, listen);
    this.doc.removeEventListener('pointerup', this.onPointerUp, listen);
    this.doc.removeEventListener('pointercancel', this.onPointerUp, listen);
    this.doc.removeEventListener('keydown', this.onKeyDown, listen);
    this.doc.removeEventListener('selectionchange', this.onSelectionChange, listen);
    this.doc.defaultView?.removeEventListener('blur', this.onBlur, listen);
    this.pressed.clear();
    this.owner = 'none';
    this.lastRange = null;

    if (this.current) {
      const { source } = this.current;
      this.current = null;
      this.emit({ kind: 'close', source });
    }
  }

  // ------------------------------------------------------------------ the popup element

  private scan() {
    try {
      const popups = [
        ...Array.from(this.doc.querySelectorAll<HTMLElement>(DICTIONARY_POPUP_SELECTOR)),
        ...[this.doc.getElementById(JPDB_POPUP_ID)].filter((e): e is HTMLElement => !!e)
      ];

      for (const popup of popups) {
        if (this.watched.has(popup)) continue;
        this.watched.add(popup);
        this.elementSeen = true;
        this.popupObserver?.observe(popup, { attributes: true, attributeFilter: ['style'] });
        this.checkElement(popup);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  private checkElement(popup: HTMLElement) {
    try {
      const style = isPopupShown(popup) ? `${popup.style.left}|${popup.style.top}` : '';
      const before = this.styleOf.get(popup) ?? '';
      this.styleOf.set(popup, style);

      if (style && style !== before) {
        const current = this.current;

        if (current?.source === 'selection' && !before) {
          // The first lookup with the element: the selection opened it a moment earlier.
          this.current = { source: 'element', popup };
          return;
        }

        const kind: PopupChangeKind = current?.popup === popup && before ? 'move' : 'open';
        this.current = { source: 'element', popup };
        this.emit({ kind, source: 'element' });
      } else if (!style && before && this.current?.popup === popup) {
        this.current = null;
        this.emit({ kind: 'close', source: 'element' });
      }
    } catch (error) {
      this.fail(error);
    }
  }

  // ------------------------------------------------------------------ Yomitan's selection

  private readonly onPointerDown = (event: PointerEvent) => {
    this.pressed.add(event.pointerId);
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    this.pressed.delete(event.pointerId);
  };

  private readonly onBlur = (event: Event) => {
    // The window itself lost focus: a release outside it may never arrive. (Elements' blurs
    // reach this capturing listener too; the reader moves focus on a press.)
    const Node = this.doc.defaultView?.Node;
    if (Node && !(event.target instanceof Node)) this.pressed.clear();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (selectsByKey(event)) this.keySelectionUntil = Date.now() + KEY_SELECTION_MS;
  };

  private readonly onSelectionChange = () => {
    try {
      const selection = this.doc.getSelection();
      const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;

      if (!range || range.collapsed) {
        if (this.owner === 'script' && this.current?.source === 'selection') {
          this.current = null;
          this.emit({ kind: 'close', source: 'selection' });
        }

        this.owner = 'none';
        this.lastRange = null;
        this.keySelectionUntil = 0;
        return;
      }

      // The user's own selection stays theirs until it is cleared (handles, extending it).
      if (this.owner === 'user') return;

      if (this.pressed.size || Date.now() < this.keySelectionUntil) {
        this.owner = 'user';

        if (this.current?.source === 'selection') {
          this.current = null;
          this.emit({ kind: 'close', source: 'selection' });
        }

        return;
      }

      const before = this.lastRange;
      this.owner = 'script';
      this.lastRange = range.cloneRange();

      // Once the popup element is in the page it is the signal.
      if (this.elementSeen) return;

      if (this.current?.source === 'selection') {
        if (!before || !sameRange(before, range)) this.emit({ kind: 'move', source: 'selection' });
      } else if (!this.current) {
        this.current = { source: 'selection', popup: null };
        this.emit({ kind: 'open', source: 'selection' });
      }
    } catch (error) {
      this.fail(error);
    }
  };

  // ------------------------------------------------------------------

  private emit(change: PopupChange) {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private fail(error: unknown) {
    this.warn(`Dictionary popup: ${(error as Error)?.message ?? error}`);
  }
}

function sameRange(a: Range, b: Range): boolean {
  try {
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset
    );
  } catch {
    return false;
  }
}

const shared = new WeakMap<Document, { watch: DictionaryPopupWatch; users: number }>();

/**
 * The document's one watch, started on first use. Call `release` when done; the last release
 * stops it.
 */
export function sharedPopupWatch(
  doc: Document,
  warn: (message: string) => void = () => {}
): { watch: DictionaryPopupWatch; release: () => void } {
  let entry = shared.get(doc);

  if (!entry) {
    entry = { watch: new DictionaryPopupWatch(doc, warn), users: 0 };
    shared.set(doc, entry);
  }

  const own = entry;
  own.users += 1;
  own.watch.start();
  let released = false;

  return {
    watch: own.watch,
    release: () => {
      if (released) return;
      released = true;
      own.users -= 1;

      if (own.users <= 0) {
        own.watch.stop();
        shared.delete(doc);
      }
    }
  };
}
