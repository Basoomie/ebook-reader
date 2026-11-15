/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { charsRange, PacerText, type PacerChar } from './pacer-text';
import { lineUnits, paragraphUnits, type LineBox } from './pacer-units';
import { PAINT_CLASSES, type PaintClass, type Spans } from './pacer-plan';

/**
 * Season 2 pacer: the live page. Finds the text on the screen (and the next screen, so a
 * page the pacer turns to is painted before it shows) and paints the pacer with the CSS
 * Custom Highlight API, like highlights and the search mark: the book's DOM is never
 * changed, so the reader's counting, whispersync and highlights don't see the pacer.
 */

export interface PacerPageHost {
  /** The reader's `.book-content` element. */
  root(): Element | null;
  /** Counted characters before the root's text (paginated: the section start). */
  base(): number;
  paginated(): boolean;
  vertical(): boolean;
}

export interface PacerSnapshot {
  /** The characters of the nodes on and next to the screen. */
  chars: PacerChar[];
  /** First and last character on the screen (-1: no text on the screen). */
  firstVisible: number;
  lastVisible: number;
  /** Paragraph number of each character. */
  paragraphs: number[];
  /** Changes with every page turn, scroll or new page content. */
  key: string;
}

type Highlights = { registry: Map<string, unknown>; Ctor: new (...r: Range[]) => any };

export function pacerHighlightApi(win: Window): Highlights | undefined {
  const g = win as any;
  const registry = g.CSS?.highlights as Map<string, unknown> | undefined;
  const Ctor = g.Highlight;
  return registry && Ctor ? { registry, Ctor } : undefined;
}

export const PACER_HIGHLIGHT_PRIORITY = 100;

const highlightName = (cls: PaintClass) => `ttu-pacer-${cls}`;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Geometry {
  box: Box;
  /** Page progression: along x or y, forwards (+1) or backwards (-1). */
  axis: 'x' | 'y';
  sign: 1 | -1;
}

/** -1 before the page, 0 on it, 1 after it; null without a box. */
type Place = -1 | 0 | 1 | null;

function span(rect: Box, geo: Geometry): [number, number] {
  if (geo.axis === 'x') {
    return geo.sign > 0 ? [rect.left, rect.right] : [-rect.right, -rect.left];
  }

  return geo.sign > 0 ? [rect.top, rect.bottom] : [-rect.bottom, -rect.top];
}

function placeOf(rects: Box[], geo: Geometry, extend = 0): Place {
  const [b0, b1raw] = span(geo.box, geo);
  const b1 = b1raw + extend * (b1raw - b0);
  let before = false;
  let after = false;
  let any = false;

  for (const r of rects) {
    if (r.right - r.left <= 0 && r.bottom - r.top <= 0) continue;
    any = true;
    const [s, e] = span(r, geo);

    if (e <= b0 + 0.5) before = true;
    else if (s >= b1 - 0.5) after = true;
    else return 0;
  }

  if (!any) return null;
  if (before && after) return 0;
  return before ? -1 : 1;
}

/**
 * The first index in [lo, hi) for which `test` is true, for a test that is false, then
 * true. A null test (no box: a collapsed space, hidden text) takes the next known answer.
 */
function firstTrue(lo: number, hi: number, test: (i: number) => boolean | null) {
  const resolve = (i: number) => {
    for (let j = i; j < hi; j++) {
      const t = test(j);
      if (t !== null) return t;
    }
    return true;
  };

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (resolve(mid)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  return lo;
}

function parseRgb(color: string): [number, number, number, number] | undefined {
  const m = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?/i);

  if (!m) return undefined;

  let alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (m[4]?.endsWith('%')) alpha /= 100;
  return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
}

export class PacerPage {
  readonly supported: boolean;

  private text: PacerText | undefined;

  private textDirty = true;

  private generation = 0;

  private observed: Element | null = null;

  private observer: MutationObserver | undefined;

  private style: HTMLStyleElement | undefined;

  private styleText = '';

  private painted = false;

  constructor(
    private host: PacerPageHost,
    private onChange: (immediate: boolean) => void,
    private win: Window = window
  ) {
    this.supported = !!pacerHighlightApi(win);
  }

  private get doc() {
    return this.win.document;
  }

  private watch(root: Element) {
    if (root === this.observed) return;

    this.observer?.disconnect();
    this.observed = root;
    this.textDirty = true;

    const Observer = (this.win as unknown as { MutationObserver?: typeof MutationObserver })
      .MutationObserver;

    if (Observer) {
      // Paginated mode replaces the page's HTML on a section change; whispersync rewrites
      // it after a match; a relayout or remount gives a new element.
      const observer = new Observer(() => {
        this.textDirty = true;
        this.onChange(true);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      this.observer = observer;
    }
  }

  private geometry(root: Element): Geometry {
    if (this.host.paginated()) {
      const r = root.getBoundingClientRect();
      return { box: r, axis: this.host.vertical() ? 'y' : 'x', sign: 1 };
    }

    const box = { left: 0, top: 0, right: this.win.innerWidth, bottom: this.win.innerHeight };
    return this.host.vertical() ? { box, axis: 'x', sign: -1 } : { box, axis: 'y', sign: 1 };
  }

  private nodeRects(node: Node): Box[] {
    if (node.nodeType !== 3) {
      return Array.from((node as Element).getClientRects());
    }

    const range = this.doc.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects());
  }

  private charRects(c: PacerChar): Box[] {
    if (c.gaiji) {
      return Array.from((c.node as Element).getClientRects());
    }

    const range = this.doc.createRange();
    range.setStart(c.node, c.offset);
    range.setEnd(c.node, c.offset + c.len);
    return Array.from(range.getClientRects());
  }

  private pageKey(root: Element) {
    const container = root.firstElementChild as HTMLElement | null;
    return [
      this.generation,
      Math.round(root.scrollLeft),
      Math.round(root.scrollTop),
      container?.style?.transform ?? '',
      Math.round(this.win.scrollX),
      Math.round(this.win.scrollY)
    ].join('|');
  }

  /** What is on the screen now; null without a reader page. */
  measure(): PacerSnapshot | null {
    const root = this.host.root();

    if (!root) {
      return null;
    }

    this.watch(root);

    if (!this.text || this.textDirty || this.text.root !== root) {
      this.text = new PacerText(root);
      this.textDirty = false;
      this.generation += 1;
    }

    const text = this.text;
    const geo = this.geometry(root);
    const n = text.nodes.length;
    const key = this.pageKey(root);
    const nodePlace = (i: number, extend = 0) =>
      placeOf(this.nodeRects(text.nodes[i]), geo, extend);
    // First node not before the screen; first node after the screen and the next one.
    const from = firstTrue(0, n, (i) => {
      const p = nodePlace(i);
      return p === null ? null : p !== -1;
    });
    const afterNext = firstTrue(from, n, (i) => {
      const p = nodePlace(i, 1);
      return p === null ? null : p === 1;
    });
    const chars = text.chars(from, afterNext, this.host.base());
    const charPlace = (i: number) => placeOf(this.charRects(chars[i]), geo);
    const firstVisible = firstTrue(0, chars.length, (i) => {
      const p = charPlace(i);
      return p === null ? null : p !== -1;
    });
    const afterVisible = firstTrue(firstVisible, chars.length, (i) => {
      const p = charPlace(i);
      return p === null ? null : p === 1;
    });
    const visible = firstVisible < afterVisible;

    return {
      chars,
      firstVisible: visible ? firstVisible : -1,
      lastVisible: visible ? afterVisible - 1 : -1,
      paragraphs: paragraphUnits(chars),
      key
    };
  }

  /** E-ink steps by line: the line number of each character (measures every character). */
  lineSteps(snapshot: PacerSnapshot): number[] {
    const vertical = this.host.vertical();
    const boxes: (LineBox | null)[] = snapshot.chars.map((c) => {
      const r = this.charRects(c).find((x) => x.right - x.left > 0 || x.bottom - x.top > 0);

      if (!r) return null;

      return vertical
        ? { center: (r.left + r.right) / 2, size: r.right - r.left }
        : { center: (r.top + r.bottom) / 2, size: r.bottom - r.top };
    });

    return lineUnits(snapshot.chars, boxes);
  }

  /**
   * Continuous mode: scrolls so the line of character `index` starts the screen. False when
   * the character has no box.
   */
  scrollToChar(snapshot: PacerSnapshot, index: number, smooth: boolean) {
    const c = snapshot.chars[index];
    const r = c && this.charRects(c).find((x) => x.right - x.left > 0);

    if (!r) return false;

    const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';

    if (this.host.vertical()) {
      const target = this.win.innerWidth * 0.92;
      this.win.scrollBy({ left: r.right - target, behavior });
    } else {
      const target = this.win.innerHeight * 0.08;
      this.win.scrollBy({ top: r.top - target, behavior });
    }

    return true;
  }

  private colorsCss(eink: boolean) {
    const root = this.host.root();
    const font = parseRgb(root ? this.win.getComputedStyle(root).color : '') ?? [0, 0, 0, 1];
    let bg: [number, number, number, number] | undefined;

    for (let el: Element | null = root; el && !bg; el = el.parentElement) {
      const c = parseRgb(this.win.getComputedStyle(el).backgroundColor);
      if (c && c[3] > 0) bg = c;
    }

    const [r, g, b] = font;
    const rgba = (a: number) => `rgba(${r}, ${g}, ${b}, ${a})`;
    const background = bg ? `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})` : 'transparent';
    const rules: Record<PaintClass, string> = {
      // E-ink: one light gray (decided with the user, 2026-11-15), no fades.
      dim: `color: ${eink ? 'rgb(170, 170, 170)' : rgba(0.3)};`,
      hide: `color: transparent; text-shadow: none; background-color: ${background};`,
      fade1: `color: ${rgba(0.7)};`,
      fade2: `color: ${rgba(0.45)};`,
      fade3: `color: ${rgba(0.2)};`
    };

    return PAINT_CLASSES.map((cls) => `::highlight(${highlightName(cls)}) { ${rules[cls]} }`).join(
      '\n'
    );
  }

  /** Paints the spans (indexes into the snapshot's characters). */
  paint(snapshot: PacerSnapshot, spans: Spans, eink: boolean) {
    const api = pacerHighlightApi(this.win);

    if (!api) return;

    const css = this.colorsCss(eink);

    if (css !== this.styleText || !this.style?.isConnected) {
      if (!this.style || !this.style.isConnected) {
        this.style = this.doc.createElement('style');
        this.style.id = 'ttu-pacer-style';
        this.doc.head.appendChild(this.style);
      }

      this.style.textContent = css;
      this.styleText = css;
    }

    for (const cls of PAINT_CLASSES) {
      const ranges = spans[cls]
        .map(([s, e]) => charsRange(snapshot.chars, s, e, this.doc))
        .filter((r): r is Range => !!r);

      if (ranges.length) {
        const highlight = new api.Ctor(...ranges);
        highlight.priority = PACER_HIGHLIGHT_PRIORITY;
        api.registry.set(highlightName(cls), highlight);
      } else {
        api.registry.delete(highlightName(cls));
      }
    }

    this.painted = true;
  }

  clear() {
    const api = pacerHighlightApi(this.win);

    if (api && this.painted) {
      for (const cls of PAINT_CLASSES) api.registry.delete(highlightName(cls));
    }

    this.painted = false;
  }

  destroy() {
    this.clear();
    this.observer?.disconnect();
    this.observer = undefined;
    this.observed = null;
    this.style?.remove();
    this.style = undefined;
    this.styleText = '';
  }
}
