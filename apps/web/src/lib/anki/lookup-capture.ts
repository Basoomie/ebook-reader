/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { buildBookTextIndex, type BookTextIndex } from '$lib/components/book-reader/book-search';
import { spanOfRange } from '$lib/notes/anchor';
import { DICTIONARY_POPUP_SELECTOR, isPopupShown, JPDB_POPUP_ID } from '$lib/stats/lookup-counter';
import { sentenceAt, sentenceFromText, type Sentence } from './sentence';

/**
 * WP14: remembers the sentence of the last dictionary lookup in the open book, for
 * "Enrich last card".
 *
 * A lookup is a Yomitan (or jpdb) popup appearing, or moving to a new word while shown
 * (the same popup signals as the lookup count; needs Yomitan's Secure Container off). The
 * looked-up place is Yomitan's own selection when it selects the matched text, else the
 * character under the last pointer position on the page. The sentence and its position
 * are worked out at once, so later page turns don't matter.
 *
 * Isolated like the stats code: every failure is caught and only loses the lookup.
 */

export interface LookupSentence extends Sentence {
  /** whispersync line ids inside the sentence (a matched book), for exact audio. */
  cueIds: string[];
  at: number;
}

export interface LookupHost {
  /** The book's content element (.book-content). */
  root(): Element | null;
  /** Characters before the content element's first character (paginated: the section start). */
  base(): number;
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

const WHISPERSYNC_LINE = 'ttu-whispersync-line-highlight-';

/** The range of the one character at a point, or null when the point isn't on text. */
export function characterAtPoint(doc: Document, x: number, y: number): Range | null {
  const caretDoc = doc as CaretDocument;
  let node: Node | null = null;
  let offset = 0;

  if (caretDoc.caretPositionFromPoint) {
    const p = caretDoc.caretPositionFromPoint(x, y);
    node = p?.offsetNode ?? null;
    offset = p?.offset ?? 0;
  } else if (caretDoc.caretRangeFromPoint) {
    const r = caretDoc.caretRangeFromPoint(x, y);
    node = r?.startContainer ?? null;
    offset = r?.startOffset ?? 0;
  }

  if (!node || node.nodeType !== Node.TEXT_NODE) {
    return null;
  }

  const length = node.textContent?.length ?? 0;

  if (!length) return null;

  const range = doc.createRange();
  const start = Math.min(offset, length - 1);
  range.setStart(node, start);
  range.setEnd(node, start + 1);
  return range;
}

/** whispersync line ids of the spans holding display characters [from, to). */
export function cueIdsIn(index: BookTextIndex, from: number, to: number): string[] {
  const ids = new Set<string>();

  for (let i = from; i < to; i += 1) {
    let el: Node | null = index.nodeAt[i];

    while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;

    for (let e = el as Element | null; e; e = e.parentElement) {
      if (e.tagName === 'SPAN') {
        for (const cls of Array.from(e.classList)) {
          if (cls.startsWith(WHISPERSYNC_LINE)) ids.add(cls.slice(WHISPERSYNC_LINE.length));
        }
      }

      if (e.classList?.contains('book-content')) break;
    }
  }

  return [...ids];
}

export class LookupCapture {
  private last: LookupSentence | null = null;
  private pointer: { x: number; y: number } | null = null;
  /** The character under the pointer, found once per frame while it moves over the book. */
  private caret: Range | null = null;
  private frame: number | null = null;
  private live: { root: Element; index: BookTextIndex } | null = null;
  private contentObserver: MutationObserver | null = null;
  private bodyObserver: MutationObserver | null = null;
  private popupObserver: MutationObserver | null = null;
  private readonly watched = new Set<HTMLElement>();
  private readonly shown = new WeakMap<HTMLElement, string>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly doc: Document,
    private readonly host: LookupHost,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /** The sentence of the last lookup since the book opened, or null. */
  get lastLookup(): LookupSentence | null {
    return this.last;
  }

  start(): void {
    try {
      const Observer = this.doc.defaultView?.MutationObserver;

      if (!Observer || !this.doc.body) return;

      this.doc.addEventListener('pointermove', this.onPointer, { capture: true, passive: true });
      this.doc.addEventListener('pointerdown', this.onPointer, { capture: true, passive: true });
      this.popupObserver = new Observer((mutations) => {
        for (const m of mutations) this.check(m.target as HTMLElement);
      });
      this.bodyObserver = new Observer(() => this.scan());
      this.bodyObserver.observe(this.doc.body, { childList: true });
      this.contentObserver = new Observer(() => {
        this.live = null;
      });
      this.scan();
    } catch (error) {
      this.fail(error);
    }
  }

  stop(): void {
    this.stopped = true;
    this.doc.removeEventListener('pointermove', this.onPointer, { capture: true });
    this.doc.removeEventListener('pointerdown', this.onPointer, { capture: true });
    this.bodyObserver?.disconnect();
    this.popupObserver?.disconnect();
    this.contentObserver?.disconnect();
    this.watched.clear();
    this.live = null;
    if (this.pending) clearTimeout(this.pending);
    if (this.frame !== null) this.doc.defaultView?.cancelAnimationFrame(this.frame);
  }

  /** Forgets the last lookup (another book was opened). */
  reset(): void {
    this.last = null;
    this.live = null;
  }

  /**
   * Records the lookup at `range` now (also used for tests and the jpdb/selection case).
   * Returns the sentence, or null when the range isn't in the book's text.
   */
  captureRange(range: Range, { boldWord = false } = {}): LookupSentence | null {
    try {
      const root = this.host.root();

      if (!root || !root.contains(range.startContainer)) return null;

      const live = this.liveIndex(root);
      const span = spanOfRange(live, range);

      if (!span) return null;

      const sentence = sentenceAt(live, span.displayStart, span.displayEnd, {
        base: this.host.base(),
        boldWord
      });

      if (!sentence) return null;

      const shown = sentence.display ?? { start: span.displayStart, end: span.displayEnd };
      const lookup: LookupSentence = {
        ...sentence,
        at: this.host.base() + (live.countBefore[span.displayStart] ?? 0),
        cueIds: cueIdsIn(live, shown.start, shown.end)
      };
      this.last = lookup;
      return lookup;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /**
   * The current selection as the sentence (when there was no lookup): its text as
   * selected, its position and its whispersync lines. Not remembered.
   */
  selectionSentence(range: Range): LookupSentence | null {
    try {
      const root = this.host.root();

      if (!root || !root.contains(range.startContainer)) return null;

      const live = this.liveIndex(root);
      const span = spanOfRange(live, range);

      if (!span) return null;

      const text = live.display.slice(span.displayStart, span.displayEnd).join('');
      const position = this.host.base() + (live.countBefore[span.displayStart] ?? 0);
      const sentence = sentenceFromText(text, position);

      return sentence
        ? {
            ...sentence,
            at: position,
            cueIds: cueIdsIn(live, span.displayStart, span.displayEnd)
          }
        : null;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  private liveIndex(root: Element): BookTextIndex {
    if (this.live?.root !== root) {
      this.contentObserver?.disconnect();
      this.live = { root, index: buildBookTextIndex(root, true) };
      this.contentObserver?.observe(root, { childList: true, subtree: true, characterData: true });
    }

    return this.live.index;
  }

  private readonly onPointer = (event: PointerEvent) => {
    this.pointer = { x: event.clientX, y: event.clientY };

    // Remembered before the popup appears: it may then cover the word.
    if (this.frame === null && this.doc.defaultView) {
      this.frame = this.doc.defaultView.requestAnimationFrame(() => {
        this.frame = null;
        this.noteCaret();
      });
    }
  };

  private noteCaret() {
    try {
      const root = this.host.root();

      if (!this.pointer || !root) return;

      const range = characterAtPoint(this.doc, this.pointer.x, this.pointer.y);

      if (range && root.contains(range.startContainer)) this.caret = range;
    } catch {
      // Only this position is lost.
    }
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
      this.fail(error);
    }
  }

  /** A popup shown, or moved while shown (a new word), is a lookup. */
  private check(popup: HTMLElement) {
    try {
      const style = isPopupShown(popup) ? `${popup.style.left}|${popup.style.top}` : '';
      const before = this.shown.get(popup) ?? '';
      this.shown.set(popup, style);

      if (style && style !== before) this.schedule();
    } catch (error) {
      this.fail(error);
    }
  }

  /** After the popup's own work (Yomitan selects the word before or as it shows the popup). */
  private schedule() {
    if (this.pending) clearTimeout(this.pending);

    this.pending = setTimeout(() => {
      this.pending = null;
      if (!this.stopped) this.capture();
    }, 30);
  }

  private capture() {
    try {
      const selection = this.doc.getSelection();
      const root = this.host.root();

      if (
        selection &&
        selection.rangeCount &&
        !selection.isCollapsed &&
        root?.contains(selection.getRangeAt(0).startContainer)
      ) {
        if (this.captureRange(selection.getRangeAt(0).cloneRange(), { boldWord: true })) return;
      }

      // The character under the pointer now, else the last one it passed over.
      const now = this.pointer ? characterAtPoint(this.doc, this.pointer.x, this.pointer.y) : null;

      if (now && this.captureRange(now)) return;

      if (this.caret?.startContainer.isConnected) this.captureRange(this.caret);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown) {
    this.warn(`Anki: lookup not recorded: ${(error as Error)?.message ?? error}`);
  }
}
