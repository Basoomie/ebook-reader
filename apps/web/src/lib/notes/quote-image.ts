/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { localStamp } from '$lib/functions/download-blob';
import {
  breakLines,
  canvasToPng,
  clampLines,
  drawText,
  drawVerticalColumn,
  ellipsized,
  loadCover,
  loadImageFonts,
  MINCHO,
  SANS,
  type CoverImage,
  type Ctx
} from '$lib/image/canvas-text';
import type { HighlightColor } from './highlights';
import { HIGHLIGHT_SOLIDS } from './swatch';

/**
 * WP19d: a highlight as an image to keep or share (decisions.md "WP19d"). Square or
 * portrait, horizontal or vertical (縦書き) text, six backgrounds (one is the book's cover,
 * blurred and darkened), the title, author and note each optional. Drawn on a canvas with
 * the app's bundled fonts; the dialog shows the same drawing at half size.
 */

export type QuoteDirection = 'horizontal' | 'vertical';
export type QuoteAlign = 'start' | 'center';
export type QuoteSize = 'square' | 'portrait';
export type QuoteBackground = 'paper' | 'white' | 'navy' | 'ink' | 'tint' | 'cover';

export interface QuoteImageOptions {
  direction: QuoteDirection;
  align: QuoteAlign;
  size: QuoteSize;
  background: QuoteBackground;
  showTitle: boolean;
  showAuthor: boolean;
  showNote: boolean;
}

export interface QuoteContent {
  text: string;
  note: string | null;
  title: string;
  author: string;
  color: HighlightColor;
  /** A cover image URL (CORS-readable for saving), or null. */
  coverUrl: string | null;
}

export const DEFAULT_QUOTE_OPTIONS: QuoteImageOptions = {
  direction: 'horizontal',
  align: 'start',
  size: 'square',
  background: 'paper',
  showTitle: true,
  showAuthor: true,
  showNote: false
};

export const QUOTE_SIZES: Record<QuoteSize, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 }
};

export const QUOTE_BACKGROUNDS: QuoteBackground[] = [
  'paper',
  'white',
  'navy',
  'ink',
  'tint',
  'cover'
];

export const QUOTE_BACKGROUND_NAMES: Record<QuoteBackground, string> = {
  paper: 'Paper',
  white: 'White',
  navy: 'Navy',
  ink: 'Ink',
  tint: 'Highlight colour',
  cover: 'Book cover'
};

export interface QuotePalette {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
}

function mix(hex: string, other: string, t: number): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = parse(hex);
  const b = parse(other);
  const [r, g, bl] = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${r}, ${g}, ${bl})`;
}

export function quotePalette(background: QuoteBackground, color: HighlightColor): QuotePalette {
  const solid = HIGHLIGHT_SOLIDS[color];
  switch (background) {
    case 'white':
      return { bg: '#ffffff', ink: '#111111', muted: '#5f6470', accent: solid };
    case 'navy':
      return { bg: '#1a2233', ink: '#f3ede0', muted: '#c9cfdb', accent: solid };
    case 'ink':
      return { bg: '#111111', ink: '#f2f2f2', muted: '#a6a6a6', accent: solid };
    case 'tint':
      return {
        bg: mix(solid, '#ffffff', 0.78),
        ink: '#1a2233',
        muted: '#3b4354',
        accent: '#1a2233'
      };
    case 'cover':
      return { bg: '#111111', ink: '#ffffff', muted: 'rgba(255, 255, 255, 0.8)', accent: solid };
    default:
      return { bg: '#f3ede0', ink: '#1a2233', muted: '#545c6b', accent: solid };
  }
}

const MARGIN = 96;
const MAX_SIZE = 84;
const MIN_SIZE = 28;

export interface QuoteLayout {
  /** Horizontal: lines; vertical: columns (right to left). */
  lines: string[];
  size: number;
  /** Horizontal: line height; vertical: column width. */
  advance: number;
  /** Vertical: the height of one character. */
  step: number;
  box: { left: number; top: number; width: number; height: number };
  note: string[];
  noteTop: number;
  footer: { title: string; author: string };
}

/** Where everything goes (pure apart from measuring text). */
export function layoutQuote(
  ctx: Ctx,
  content: QuoteContent,
  options: QuoteImageOptions
): QuoteLayout {
  const { width, height } = QUOTE_SIZES[options.size];
  const inner = width - MARGIN * 2;

  // Footer: title over author, from the bottom margin up.
  const title = options.showTitle ? content.title.trim() : '';
  const author = options.showAuthor ? content.author.trim() : '';
  const footerLines = (title ? 1 : 0) + (author ? 1 : 0);
  const footerTop = height - MARGIN - (footerLines ? footerLines * 46 + 8 : 0);

  // Note: up to four lines of small text above the footer.
  let note: string[] = [];
  let noteTop = footerTop;
  const noteBody = options.showNote ? (content.note ?? '').trim() : '';
  if (noteBody) {
    ctx.font = `400 30px ${SANS}`;
    note = clampLines(
      breakLines(noteBody, inner - 32, (s) => ctx.measureText(s).width),
      options.size === 'portrait' ? 5 : 4
    );
    noteTop = footerTop - 40 - note.length * 44;
  }

  const top = MARGIN + 8 + 56;
  const box = {
    left: MARGIN,
    top,
    width: inner,
    height: Math.max(80, noteTop - 48 - top)
  };
  const text = content.text.trim();

  let size = MAX_SIZE;
  let lines: string[] = [];
  let advance = 0;
  let step = 0;
  for (; size >= MIN_SIZE; size -= 2) {
    if (options.direction === 'vertical') {
      step = size * 1.08;
      advance = size * 1.7;
      lines = breakLines(text, box.height, (s) => [...s].length * step);
      if (lines.length * advance <= box.width) break;
    } else {
      advance = size * 1.65;
      ctx.font = `500 ${size}px ${MINCHO}`;
      lines = breakLines(text, box.width, (s) => ctx.measureText(s).width);
      if (lines.length * advance <= box.height) break;
    }
  }
  if (size < MIN_SIZE) {
    size = MIN_SIZE;
    const fit =
      options.direction === 'vertical'
        ? Math.floor(box.width / advance)
        : Math.floor(box.height / advance);
    lines = clampLines(lines, Math.max(1, fit));
  }

  return { lines, size, advance, step, box, note, noteTop, footer: { title, author } };
}

function drawCover(ctx: Ctx, cover: CanvasImageSource, width: number, height: number) {
  const iw = (cover as { width?: number }).width || width;
  const ih = (cover as { height?: number }).height || height;
  // Fill the image (a little past the edges, so the blur has no light rim).
  const bleed = 80;
  const scale = Math.max((width + bleed * 2) / iw, (height + bleed * 2) / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.save();
  if ('filter' in ctx) ctx.filter = 'blur(28px)';
  ctx.drawImage(cover, (width - dw) / 2, (height - dh) / 2, dw, dh);
  if ('filter' in ctx) ctx.filter = 'none';
  ctx.restore();
  ctx.fillStyle = 'rgba(10, 14, 24, 0.62)';
  ctx.fillRect(0, 0, width, height);
}

/** Draws the image at full size (callers scale the context for a preview). */
export function drawQuoteImage(
  ctx: Ctx,
  content: QuoteContent,
  options: QuoteImageOptions,
  cover: CoverImage
): void {
  const { width, height } = QUOTE_SIZES[options.size];
  const background = options.background === 'cover' && !cover ? 'ink' : options.background;
  const palette = quotePalette(background, content.color);
  const layout = layoutQuote(ctx, content, options);
  const { box, size } = layout;

  ctx.save();
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);
  if (background === 'cover' && cover) drawCover(ctx, cover, width, height);

  // The highlight's colour as a short rule at the top.
  ctx.fillStyle = palette.accent;
  ctx.fillRect(MARGIN, MARGIN, 120, 8);

  const font = `500 ${size}px ${MINCHO}`;
  if (options.direction === 'vertical') {
    const blockWidth = layout.lines.length * layout.advance;
    const right =
      options.align === 'center' ? box.left + box.width / 2 + blockWidth / 2 : box.left + box.width;
    layout.lines.forEach((column, i) => {
      const x = right - layout.advance * i - layout.advance / 2;
      const length = [...column].length * layout.step;
      const y = options.align === 'center' ? box.top + (box.height - length) / 2 : box.top;
      drawVerticalColumn(ctx, column, x, y, size, layout.step, font, palette.ink);
    });
  } else {
    const blockHeight = layout.lines.length * layout.advance;
    const y0 = box.top + (box.height - blockHeight) / 2;
    ctx.font = font;
    ctx.fillStyle = palette.ink;
    ctx.textAlign = options.align === 'center' ? 'center' : 'left';
    ctx.textBaseline = 'middle';
    const x = options.align === 'center' ? width / 2 : box.left;
    layout.lines.forEach((line, i) => {
      ctx.fillText(line, x, y0 + layout.advance * i + layout.advance / 2);
    });
  }

  // The note, small, with a rule on its left.
  if (layout.note.length) {
    ctx.fillStyle = palette.accent;
    ctx.fillRect(MARGIN, layout.noteTop, 4, layout.note.length * 44 - 8);
    layout.note.forEach((line, i) => {
      drawText(
        ctx,
        line,
        MARGIN + 28,
        layout.noteTop + 30 + i * 44,
        `400 30px ${SANS}`,
        palette.muted
      );
    });
  }

  // Footer: title and author on the left, the app's mark on the right.
  const footerWidth = width - MARGIN * 2 - 140;
  let y = height - MARGIN;
  if (layout.footer.author) {
    ctx.font = `400 28px ${SANS}`;
    drawText(
      ctx,
      ellipsized(ctx, layout.footer.author, footerWidth),
      MARGIN,
      y,
      ctx.font,
      palette.muted
    );
    y -= 46;
  }
  if (layout.footer.title) {
    ctx.font = `700 32px ${SANS}`;
    drawText(
      ctx,
      ellipsized(ctx, layout.footer.title, footerWidth),
      MARGIN,
      y,
      ctx.font,
      palette.ink
    );
  }
  drawText(
    ctx,
    'ッツ',
    width - MARGIN,
    height - MARGIN,
    `700 34px ${MINCHO}`,
    palette.muted,
    'right'
  );
  ctx.restore();
}

/**
 * The PNG at full size. If the cover made the canvas unreadable (served without CORS), it
 * is drawn again without it (the dark background instead).
 */
export async function renderQuoteImage(
  content: QuoteContent,
  options: QuoteImageOptions,
  doc: Document = document,
  cover?: CoverImage
): Promise<Blob> {
  await loadImageFonts(doc);
  const image =
    options.background === 'cover'
      ? cover !== undefined
        ? cover
        : await loadCover(content.coverUrl)
      : null;
  const draw = (c: CoverImage) => {
    const canvas = doc.createElement('canvas');
    canvas.width = QUOTE_SIZES[options.size].width;
    canvas.height = QUOTE_SIZES[options.size].height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the image');
    drawQuoteImage(ctx, content, options, c);
    return canvas;
  };
  try {
    return await canvasToPng(draw(image));
  } catch {
    return canvasToPng(draw(null));
  }
}

export function quoteImageFileName(now: Date): string {
  return `ttsu-quote-${localStamp(now, true)}.png`;
}

// ---- Remembered choices (this device only) --------------------------------------------------

export const QUOTE_OPTIONS_KEY = 'ttu-quote-image';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function loadQuoteOptions(
  storage: Storage | undefined = defaultStorage()
): QuoteImageOptions {
  try {
    const raw = storage?.getItem(QUOTE_OPTIONS_KEY);
    const v = (raw ? JSON.parse(raw) : {}) as Partial<Record<keyof QuoteImageOptions, unknown>>;
    const d = DEFAULT_QUOTE_OPTIONS;
    return {
      direction: pick(v.direction, ['horizontal', 'vertical'], d.direction),
      align: pick(v.align, ['start', 'center'], d.align),
      size: pick(v.size, ['square', 'portrait'], d.size),
      background: pick(v.background, QUOTE_BACKGROUNDS, d.background),
      showTitle: typeof v.showTitle === 'boolean' ? v.showTitle : d.showTitle,
      showAuthor: typeof v.showAuthor === 'boolean' ? v.showAuthor : d.showAuthor,
      showNote: typeof v.showNote === 'boolean' ? v.showNote : d.showNote
    };
  } catch {
    return { ...DEFAULT_QUOTE_OPTIONS };
  }
}

export function saveQuoteOptions(
  options: QuoteImageOptions,
  storage: Storage | undefined = defaultStorage()
): void {
  try {
    storage?.setItem(QUOTE_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // Not remembered on this device.
  }
}
