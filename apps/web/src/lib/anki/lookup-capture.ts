/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  buildBookTextIndex,
  findMatches,
  type BookTextIndex
} from '$lib/components/book-reader/book-search';
import { spanOfRange } from '$lib/notes/anchor';
import { sharedPopupWatch, type PopupChange } from '$lib/dictionary/popup-watch';
import { sentenceAt, sentenceFromText, type Sentence } from './sentence';

/**
 * WP14: remembers the sentence of the last dictionary lookup in the open book, for
 * "Enrich last card".
 *
 * A lookup is a Yomitan (or jpdb) popup appearing, or moving to a new word while shown, as
 * the shared popup watch sees it (`lib/dictionary/popup-watch.ts`: the popup element, or
 * Yomitan's word selection when its secure container hides the element). The looked-up
 * place is Yomitan's own selection when it selects the matched text, else the character
 * under the last pointer position on the page. The sentence and its position are worked
 * out at once, so later page turns don't matter.
 *
 * Isolated like the stats code: every failure is caught and only loses the lookup.
 */

export interface LookupSentence extends Sentence {
  /** whispersync line ids inside the sentence (a matched book), for exact audio. */
  cueIds: string[];
  at: number;
}

/**
 * One lookup (Phase 8, automatic enrichment): from the popup shown on a word until it is
 * hidden or moves on to another word. `sentence` is filled in once it is worked out (or
 * stays null when the place isn't in the book's text).
 */
export interface LookupRecord {
  id: number;
  /** When the popup showed this word (`Date.now()`). */
  startedAt: number;
  /** When it was hidden or moved on, or null while it is shown. */
  endedAt: number | null;
  sentence: LookupSentence | null;
}

export type LookupListener = (lookup: LookupRecord, change: 'start' | 'end') => void;

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
  private lastAt = 0;
  /** The selection the last lookup was taken from, or null (taken from the pointer). */
  private lastRange: Range | null = null;
  private pointer: { x: number; y: number } | null = null;
  /** The character under the pointer, found once per frame while it moves over the book. */
  private caret: Range | null = null;
  private frame: number | null = null;
  private live: { root: Element; index: BookTextIndex } | null = null;
  private contentObserver: MutationObserver | null = null;
  private releasePopups: (() => void) | null = null;
  private stopPopups: (() => void) | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** The lookup shown now. */
  private current: { lookup: LookupRecord } | null = null;
  private nextLookupId = 1;
  private readonly listeners = new Set<LookupListener>();

  constructor(
    private readonly doc: Document,
    private readonly host: LookupHost,
    private readonly warn: (message: string) => void = () => {}
  ) {}

  /** The sentence of the last lookup since the book opened, or null. */
  get lastLookup(): LookupSentence | null {
    return this.last;
  }

  /** Calls `listener` when a lookup starts and when it ends. Returns the unsubscribe. */
  onLookup(listener: LookupListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** When the last lookup was recorded (`Date.now()`), or 0. */
  get lastLookupAt(): number {
    return this.last ? this.lastAt : 0;
  }

  /**
   * Whether `range` is the selection the last lookup was taken from (Yomitan's "select
   * matched text" selects the word it looked up), so it is the lookup, not a selection of
   * the user's own.
   */
  isLookupSelection(range: Range): boolean {
    const own = this.lastRange;

    try {
      return (
        !!this.last &&
        !!own &&
        own.startContainer.isConnected &&
        range.compareBoundaryPoints(Range.START_TO_START, own) === 0 &&
        range.compareBoundaryPoints(Range.END_TO_END, own) === 0
      );
    } catch {
      return false;
    }
  }

  start(): void {
    try {
      const Observer = this.doc.defaultView?.MutationObserver;

      if (!Observer || !this.doc.body) return;

      this.doc.addEventListener('pointermove', this.onPointer, { capture: true, passive: true });
      this.doc.addEventListener('pointerdown', this.onPointer, { capture: true, passive: true });
      this.contentObserver = new Observer(() => {
        this.live = null;
      });
      const { watch, release } = sharedPopupWatch(this.doc, this.warn);
      this.releasePopups = release;
      this.stopPopups = watch.subscribe(this.onPopup);
    } catch (error) {
      this.fail(error);
    }
  }

  stop(): void {
    this.endLookup();
    this.listeners.clear();
    this.stopped = true;
    this.doc.removeEventListener('pointermove', this.onPointer, { capture: true });
    this.doc.removeEventListener('pointerdown', this.onPointer, { capture: true });
    this.stopPopups?.();
    this.releasePopups?.();
    this.stopPopups = null;
    this.releasePopups = null;
    this.contentObserver?.disconnect();
    this.live = null;
    if (this.pending) clearTimeout(this.pending);
    if (this.frame !== null) this.doc.defaultView?.cancelAnimationFrame(this.frame);
  }

  /** Forgets the last lookup (another book was opened). */
  reset(): void {
    this.last = null;
    this.lastRange = null;
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
      this.lastAt = Date.now();
      this.lastRange = boldWord ? range : null;
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

  /**
   * A card's own sentence (the one Yomitan put on it) placed in the book's loaded text: its
   * occurrence nearest to `near` (a reader position), with its whispersync lines. Matched as
   * in-book search matches (spaces and ruby readings left out). Null when it isn't there.
   */
  findSentence(text: string, near: number): LookupSentence | null {
    try {
      const root = this.host.root();

      if (!root) return null;

      const live = this.liveIndex(root);
      const { matches } = findMatches(live, text, 100);

      if (!matches.length) return null;

      const base = this.host.base();
      const distance = (position: number) => Math.abs(base + position - near);
      const best = matches.reduce((a, b) => (distance(b.position) < distance(a.position) ? b : a));
      const position = base + best.position;
      const sentence = sentenceFromText(text, position);

      return sentence
        ? { ...sentence, at: position, cueIds: cueIdsIn(live, best.displayStart, best.displayEnd) }
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

  /**
   * A popup shown, or moved while shown (a new word), is a lookup. Hidden, or moved on, it
   * ends (Phase 8).
   */
  private readonly onPopup = ({ kind }: PopupChange) => {
    try {
      this.endLookup();
      if (kind !== 'close' && !this.stopped) this.schedule(this.startLookup());
    } catch (error) {
      this.fail(error);
    }
  };

  private startLookup(): LookupRecord {
    const lookup: LookupRecord = {
      id: this.nextLookupId++,
      startedAt: Date.now(),
      endedAt: null,
      sentence: null
    };
    this.current = { lookup };
    this.emit(lookup, 'start');
    return lookup;
  }

  private endLookup() {
    const current = this.current;

    if (!current) return;

    this.current = null;
    current.lookup.endedAt = Date.now();
    this.emit(current.lookup, 'end');
  }

  private emit(lookup: LookupRecord, change: 'start' | 'end') {
    for (const listener of this.listeners) {
      try {
        listener(lookup, change);
      } catch (error) {
        this.fail(error);
      }
    }
  }

  /** After the popup's own work (Yomitan selects the word before or as it shows the popup). */
  private schedule(lookup: LookupRecord) {
    if (this.pending) clearTimeout(this.pending);

    this.pending = setTimeout(() => {
      this.pending = null;
      if (!this.stopped) lookup.sentence = this.capture();
    }, 30);
  }

  private capture(): LookupSentence | null {
    try {
      const selection = this.doc.getSelection();
      const root = this.host.root();

      if (
        selection &&
        selection.rangeCount &&
        !selection.isCollapsed &&
        root?.contains(selection.getRangeAt(0).startContainer)
      ) {
        const selected = this.captureRange(selection.getRangeAt(0).cloneRange(), {
          boldWord: true
        });
        if (selected) return selected;
      }

      // The character under the pointer now, else the last one it passed over.
      const now = this.pointer ? characterAtPoint(this.doc, this.pointer.x, this.pointer.y) : null;
      const atPointer = now ? this.captureRange(now) : null;

      if (atPointer) return atPointer;

      return this.caret?.startContainer.isConnected ? this.captureRange(this.caret) : null;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  private fail(error: unknown) {
    this.warn(`Anki: lookup not recorded: ${(error as Error)?.message ?? error}`);
  }
}
