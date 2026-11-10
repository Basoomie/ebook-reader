/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writable } from 'svelte/store';
import {
  buildBookTextIndex,
  matchRange,
  type BookTextIndex
} from '$lib/components/book-reader/book-search';
import {
  anchorOfRange,
  locateExact,
  placeAnchor,
  type Placement,
  type TextAnchor
} from '$lib/notes/anchor';
import {
  emptyBookNotes,
  HIGHLIGHT_COLORS,
  type BookNotes,
  type HighlightColor,
  type HighlightItem
} from '$lib/notes/highlights';
import type { Undo } from '$lib/notes/notes-service';
import { PAGE_CHANGE } from '$lib/data/events';
import type { NotesApi } from '$lib/sync/sync-service';
import { HighlightGesture } from './highlight-gesture';

/**
 * WP11a: highlights in the open book. Keeps the book's highlights and notes (from the local
 * mirror), places them in this device's copy of the book, paints them with the CSS Custom
 * Highlight API (no DOM changes, so whispersync's line spans, the bookmark calculators and
 * the counter never see them), and runs the highlight bar for selections the user made.
 *
 * Everything here is isolated: failures are logged and reading goes on unchanged.
 */

export type BarMode = 'hidden' | 'new' | 'existing' | 'unavailable' | 'removed';

export interface BarState {
  mode: BarMode;
  /** Colors of the highlights under the selection ("existing"). */
  colors: HighlightColor[];
  message: string;
}

export interface HighlightsView {
  notes: BookNotes;
  /** Where each highlight sits in this device's copy; null = couldn't place it. */
  places: Map<string, number | null>;
}

export interface ReaderHighlightsHost {
  /** The page's `.book-content` element. */
  root(): Element | null;
  /** Counted characters before the part of the book on the page. */
  base(): number;
  /** The whole book's text index (detached, the search index). */
  wholeIndex(): BookTextIndex;
  chapterAt(position: number): string | null;
  resolveBookId(): Promise<string | null>;
  api(): Promise<NotesApi>;
  refindChars(): number;
  anySelection(): boolean;
  lastColor(): HighlightColor;
  setLastColor(color: HighlightColor): void;
  /** Opens the note editor for a highlight. */
  editNote(highlight: HighlightItem): void;
  warn(message: string): void;
}

const HIDDEN: BarState = { mode: 'hidden', colors: [], message: '' };

export const HIGHLIGHT_NAMES = HIGHLIGHT_COLORS.map((c) => `ttu-hl-${c}`);
export const NOTE_HIGHLIGHT_NAME = 'ttu-hl-note';

type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => unknown;

function highlightApi(
  win: Window
): { registry: HighlightRegistry; Ctor: HighlightCtor } | undefined {
  const g = win as any;
  const registry = g.CSS?.highlights as HighlightRegistry | undefined;
  const Ctor = g.Highlight as HighlightCtor | undefined;
  return registry && Ctor ? { registry, Ctor } : undefined;
}

/** Whether this browser can color highlights on the page (CSS Custom Highlight API). */
export function canPaintHighlights(win: Window) {
  return !!highlightApi(win);
}

export class ReaderHighlights {
  readonly bar = writable<BarState>(HIDDEN);

  readonly view = writable<HighlightsView>({ notes: emptyBookNotes(), places: new Map() });

  readonly supported: boolean;

  bookId: string | null = null;

  private notes: BookNotes = emptyBookNotes();

  private places = new Map<string, number | null>();

  private placementCache = new WeakMap<BookTextIndex, Map<string, Placement>>();

  private gesture = new HighlightGesture();

  private anchor: TextAnchor | undefined;

  private under: HighlightItem[] = [];

  private undo: Undo | undefined;

  private live: { root: Element; index: BookTextIndex } | undefined;

  private observer: MutationObserver | undefined;

  private observedRoot: Element | null = null;

  private repaintTimer: ReturnType<typeof setTimeout> | undefined;

  private updateTimer: ReturnType<typeof setTimeout> | undefined;

  private stops: (() => void)[] = [];

  private destroyed = false;

  private barMode: BarMode = 'hidden';

  constructor(
    private host: ReaderHighlightsHost,
    private win: Window = window
  ) {
    this.supported = canPaintHighlights(win);
    this.bar.subscribe((state) => {
      this.barMode = state.mode;
    });
  }

  /** Resolves the catalog book, loads its highlights and starts listening. */
  async start() {
    this.listen();

    try {
      this.bookId = await this.host.resolveBookId();

      if (!this.bookId || this.destroyed) {
        return;
      }

      const api = await this.host.api();
      const bookId = this.bookId;
      const off = await api.onChanged((books) => {
        if (books.has(bookId)) void this.reload();
      });

      if (this.destroyed) {
        off();
        return;
      }

      this.stops.push(off);
      await this.reload();
    } catch (error) {
      this.warn(error);
    }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.repaintTimer);
    clearTimeout(this.updateTimer);
    this.observer?.disconnect();
    this.stops.forEach((stop) => stop());
    this.stops = [];
    this.clearPaint();
  }

  /** The reader's page element changed (book opened, reader reopened for a layout change). */
  attach(root: Element | null) {
    if (root === this.observedRoot) {
      return;
    }

    this.observer?.disconnect();
    this.observedRoot = root;
    this.live = undefined;

    if (root && typeof MutationObserver !== 'undefined') {
      // Paginated mode replaces the page's HTML on every section change; whispersync
      // rewrites it after a match. Ranges must then be built again.
      this.observer = new MutationObserver(() => {
        this.live = undefined;
        this.scheduleRepaint();
      });
      this.observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    this.scheduleRepaint();
  }

  /** Where a highlight sits on this device (its own position when it couldn't be placed). */
  positionOf(item: Pick<HighlightItem, 'id' | 'start'>) {
    return this.places.get(item.id) ?? item.start;
  }

  /** The live DOM range of a highlight on the page, if it is on the page. */
  rangeOf(id: string): Range | undefined {
    try {
      const item = this.notes.highlights.find((h) => h.id === id);
      const place = item ? this.places.get(id) : null;

      if (!item || place === null || place === undefined) {
        return undefined;
      }

      return this.liveRange(place, item.text);
    } catch (error) {
      this.warn(error);
      return undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Highlights and their places

  private async reload() {
    if (!this.bookId || this.destroyed) {
      return;
    }

    try {
      const api = await this.host.api();
      this.notes = await api.ofBook(this.bookId);
      this.placeAll();
      this.view.set({ notes: this.notes, places: new Map(this.places) });
      this.scheduleRepaint(0);

      if (this.barMode === 'new' || this.barMode === 'existing') {
        this.scheduleUpdate();
      }
    } catch (error) {
      this.warn(error);
    }
  }

  private placeAll() {
    this.places = new Map();

    if (!this.notes.highlights.length) {
      if (this.bookId) void this.host.api().then((api) => api.setUnplaced(this.bookId!, []));
      return;
    }

    const index = this.host.wholeIndex();
    let cache = this.placementCache.get(index);

    if (!cache) {
      cache = new Map();
      this.placementCache.set(index, cache);
    }

    const unplaced: string[] = [];
    const maxDistance = Math.max(0, Number(this.host.refindChars()) || 0);

    for (const item of this.notes.highlights) {
      let placement = cache.get(item.id);

      if (!placement) {
        placement = placeAnchor(index, item, maxDistance);
        cache.set(item.id, placement);
      }

      if (placement.status === 'unplaced') {
        this.places.set(item.id, null);
        unplaced.push(item.id);
      } else {
        this.places.set(item.id, placement.start);
      }
    }

    if (this.bookId) {
      const bookId = this.bookId;
      void this.host.api().then((api) => api.setUnplaced(bookId, unplaced));
    }
  }

  // ---------------------------------------------------------------------------
  // Painting

  private liveIndex() {
    const root = this.host.root();

    if (!root) {
      return undefined;
    }

    if (this.live?.root !== root) {
      this.live = { root, index: buildBookTextIndex(root, true) };
    }

    return this.live;
  }

  private liveRange(place: number, text: string) {
    const live = this.liveIndex();

    if (!live) {
      return undefined;
    }

    const span = locateExact(live.index, { start: place, text }, this.host.base());
    return span
      ? matchRange(live.index, { position: place, ...span }, live.root.ownerDocument)
      : undefined;
  }

  private scheduleRepaint(delay = 100) {
    clearTimeout(this.repaintTimer);
    this.repaintTimer = setTimeout(() => this.repaint(), delay);
  }

  repaint() {
    const api = highlightApi(this.win);

    if (!api || this.destroyed) {
      return;
    }

    try {
      const byColor = new Map<HighlightColor, Range[]>();
      const withNote: Range[] = [];

      for (const item of this.notes.highlights) {
        const place = this.places.get(item.id);

        if (place === null || place === undefined) {
          continue;
        }

        const range = this.liveRange(place, item.text);

        if (!range) {
          continue;
        }

        byColor.set(item.color, [...(byColor.get(item.color) ?? []), range]);

        if (item.note) {
          withNote.push(range);
        }
      }

      for (const color of HIGHLIGHT_COLORS) {
        const ranges = byColor.get(color) ?? [];
        const name = `ttu-hl-${color}`;

        if (ranges.length) {
          api.registry.set(name, new api.Ctor(...ranges));
        } else {
          api.registry.delete(name);
        }
      }

      if (withNote.length) {
        api.registry.set(NOTE_HIGHLIGHT_NAME, new api.Ctor(...withNote));
      } else {
        api.registry.delete(NOTE_HIGHLIGHT_NAME);
      }
    } catch (error) {
      this.warn(error);
    }
  }

  private clearPaint() {
    const api = highlightApi(this.win);

    if (!api) {
      return;
    }

    for (const name of [...HIGHLIGHT_NAMES, NOTE_HIGHLIGHT_NAME]) {
      api.registry.delete(name);
    }
  }

  // ---------------------------------------------------------------------------
  // Selections and the bar

  private listen() {
    const doc = this.win.document;
    const passive = { capture: true, passive: true };
    const isElement = (t: EventTarget | null): t is Element =>
      !!t && typeof (t as Element).closest === 'function';
    const inBar = (t: EventTarget | null) => isElement(t) && !!t.closest('[data-highlight-bar]');
    const inReader = (t: EventTarget | null) => {
      const root = this.host.root();
      return !!root && t instanceof Node && root.contains(t);
    };

    const onDown = (ev: PointerEvent) => {
      this.gesture.note({
        type: 'pointerdown',
        pointerType: ev.pointerType,
        inReader: inReader(ev.target),
        inBar: inBar(ev.target)
      });
    };
    const onUp = (ev: PointerEvent) => {
      if (
        this.gesture.note({
          type: 'pointerup',
          pointerType: ev.pointerType,
          selectionInReader: !!this.selectedRange()
        })
      ) {
        this.scheduleUpdate();
      }
    };
    const onContextMenu = (ev: Event) => {
      if (this.gesture.note({ type: 'contextmenu', inReader: inReader(ev.target) })) {
        this.scheduleUpdate();
      }
    };
    const onClick = (ev: MouseEvent) => {
      const pointerType = (ev as PointerEvent).pointerType || 'mouse';

      if (
        this.gesture.note({
          type: 'click',
          inReader: inReader(ev.target),
          detail: ev.detail,
          pointerType
        })
      ) {
        this.scheduleUpdate();
      }
    };
    const onSelection = () => this.scheduleUpdate();
    const onPageChange = (ev: Event) => {
      if (typeof (ev as CustomEvent).detail?.exploredCharCount !== 'number') {
        return;
      }

      // A paginated section change replaces the page; its start count may settle after it.
      this.scheduleRepaint(150);

      if (this.barMode !== 'hidden' && !this.gesture.pressOnBar) {
        this.hideBar();
      }
    };

    doc.addEventListener('pointerdown', onDown, passive);
    doc.addEventListener('pointerup', onUp, passive);
    doc.addEventListener('contextmenu', onContextMenu, passive);
    doc.addEventListener('click', onClick, passive);
    doc.addEventListener('selectionchange', onSelection);
    doc.addEventListener(PAGE_CHANGE, onPageChange);
    this.stops.push(() => {
      doc.removeEventListener('pointerdown', onDown, passive);
      doc.removeEventListener('pointerup', onUp, passive);
      doc.removeEventListener('contextmenu', onContextMenu, passive);
      doc.removeEventListener('click', onClick, passive);
      doc.removeEventListener('selectionchange', onSelection);
      doc.removeEventListener(PAGE_CHANGE, onPageChange);
    });
  }

  /** The selection's range when it is a non-empty selection inside the book. */
  private selectedRange() {
    const selection = this.win.getSelection();
    const root = this.host.root();

    if (!selection || selection.isCollapsed || !selection.rangeCount || !root) {
      return undefined;
    }

    const range = selection.getRangeAt(0);
    return root.contains(range.commonAncestorContainer) ? range : undefined;
  }

  private scheduleUpdate() {
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.update(), 120);
  }

  private hideBar() {
    this.anchor = undefined;
    this.under = [];
    this.bar.set(HIDDEN);
  }

  /** Shows, updates or hides the bar for the current selection. */
  private update() {
    if (this.destroyed) {
      return;
    }

    try {
      const range = this.selectedRange();

      if (!range) {
        // Tapping the bar may clear the selection first: the bar keeps its anchor then.
        if (!this.gesture.pressOnBar && this.barMode !== 'removed') {
          this.hideBar();
          this.gesture.note({ type: 'done' });
        }

        return;
      }

      if (!this.gesture.shows(!!this.host.anySelection())) {
        return;
      }

      const live = this.liveIndex();
      const anchor = live && anchorOfRange(live.index, range, this.host.base());

      if (!anchor) {
        this.hideBar();
        return;
      }

      this.anchor = anchor;

      if (!this.bookId) {
        this.bar.set({
          mode: 'unavailable',
          colors: [],
          message: 'Highlights need this book in the library.'
        });
        return;
      }

      this.under = this.notes.highlights.filter((h) => {
        const place = this.places.get(h.id);

        if (place === null || place === undefined) {
          return false;
        }

        const end = place + (h.end - h.start);
        return place < anchor.end && anchor.start < Math.max(end, place + 1);
      });
      this.bar.set(
        this.under.length
          ? { mode: 'existing', colors: [...new Set(this.under.map((h) => h.color))], message: '' }
          : { mode: 'new', colors: [], message: '' }
      );
    } catch (error) {
      this.warn(error);
    }
  }

  private finish() {
    this.gesture.note({ type: 'done' });
    this.win.getSelection()?.removeAllRanges();
    this.hideBar();
  }

  private async create(color: HighlightColor) {
    if (!this.bookId || !this.anchor) {
      return undefined;
    }

    const api = await this.host.api();
    const item = await api.addHighlight(
      this.bookId,
      this.anchor,
      color,
      this.host.chapterAt(this.anchor.start)
    );
    this.host.setLastColor(color);
    return item;
  }

  /** A color button (or 1-5 while the bar is open). */
  async chooseColor(color: HighlightColor) {
    try {
      if (this.barMode === 'new') {
        await this.create(color);
      } else if (this.barMode === 'existing') {
        const api = await this.host.api();

        for (const item of this.under) {
          await api.setColor(item.id, color);
        }

        this.host.setLastColor(color);
      } else {
        return;
      }

      this.finish();
    } catch (error) {
      this.fail(error);
    }
  }

  /** "Note": highlights the selection with the last color (if new), then edits its note. */
  async chooseNote() {
    try {
      let item: HighlightItem | undefined;

      if (this.barMode === 'new') {
        item = await this.create(this.host.lastColor());
      } else if (this.barMode === 'existing') {
        item = this.under[0];
      }

      this.finish();

      if (item) {
        this.host.editNote(item);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  /** "Remove": removes the highlights under the selection; the bar then offers Undo. */
  async chooseRemove() {
    if (this.barMode !== 'existing') {
      return;
    }

    try {
      const api = await this.host.api();
      const undos: Undo[] = [];

      for (const item of this.under) {
        undos.push(await api.removeHighlight(item.id));
      }

      this.undo = async () => {
        for (const undo of undos) await undo();
      };
      this.gesture.note({ type: 'done' });
      this.win.getSelection()?.removeAllRanges();
      this.anchor = undefined;
      this.under = [];
      this.bar.set({
        mode: 'removed',
        colors: [],
        message: undos.length === 1 ? 'Highlight removed.' : `${undos.length} highlights removed.`
      });
    } catch (error) {
      this.fail(error);
    }
  }

  async chooseUndo() {
    const undo = this.undo;
    this.undo = undefined;
    this.hideBar();

    try {
      await undo?.();
    } catch (error) {
      this.fail(error);
    }
  }

  close() {
    this.undo = undefined;
    this.finish();
  }

  /** `H`: highlights the selection with the last color. Returns whether it did anything. */
  async highlightSelection() {
    try {
      const range = this.selectedRange();
      const live = range && this.liveIndex();
      const anchor = live && anchorOfRange(live.index, range, this.host.base());

      if (!anchor) {
        return false;
      }

      this.anchor = anchor;
      this.gesture.note({ type: 'contextmenu', inReader: true });
      this.update();

      if (this.barMode !== 'new') {
        return this.barMode !== 'hidden';
      }

      await this.chooseColor(this.host.lastColor());
      return true;
    } catch (error) {
      this.fail(error);
      return true;
    }
  }

  get barOpen() {
    return this.barMode !== 'hidden';
  }

  private fail(error: unknown) {
    this.warn(error);
    this.bar.set({
      mode: 'unavailable',
      colors: [],
      message: (error as Error)?.message || 'Could not save the highlight.'
    });
  }

  private warn(error: unknown) {
    this.host.warn(`Highlights: ${(error as Error)?.message ?? error}`);
  }
}
