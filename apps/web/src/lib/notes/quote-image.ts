/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { fileTitle, localStamp } from '$lib/functions/download-blob';
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
 * portrait, horizontal or vertical (縦書き) text, preset or custom backgrounds (one is the
 * book's cover, blurred and darkened), an optional frame (a line or a card), a quote mark
 * (a rule, “, 「 or none), the quote's size and every colour automatic or picked, and the
 * title, author and note each optional. Drawn on a canvas with the app's bundled fonts;
 * the dialog shows the same drawing at half size.
 */

export type QuoteDirection = 'horizontal' | 'vertical';
export type QuoteAlign = 'start' | 'center';
export type QuoteSize = 'square' | 'portrait';
export type QuoteBackground = 'paper' | 'white' | 'navy' | 'ink' | 'tint' | 'cover' | 'custom';
export type QuoteMark = 'line' | 'quotes' | 'corner' | 'none';
export type QuoteFrame = 'none' | 'line' | 'card';

export interface QuoteImageOptions {
  direction: QuoteDirection;
  align: QuoteAlign;
  size: QuoteSize;
  background: QuoteBackground;
  /** The colour of the "custom" background (#rrggbb). */
  customBackground: string;
  /** The quote's font size in px at full size; null fits it automatically. */
  quoteSize: number | null;
  /** null: dark or light to suit the background (or the card). */
  textColor: string | null;
  mark: QuoteMark;
  /** null: the highlight's colour. */
  markColor: string | null;
  frame: QuoteFrame;
  /** The frame's line; null: a faint line to suit the background. */
  frameColor: string | null;
  /** The card's fill (frame "card"); null: a lighter (or darker) shade of the background. */
  cardColor: string | null;
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
  customBackground: '#e8f3ec',
  quoteSize: null,
  textColor: null,
  mark: 'line',
  markColor: null,
  frame: 'none',
  frameColor: null,
  cardColor: null,
  showTitle: true,
  showAuthor: true,
  showNote: false
};

export const QUOTE_SIZES: Record<QuoteSize, { width: number; height: number }> = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 }
};

/** The quote size slider's range (px at full size). */
export const QUOTE_SIZE_MIN = 24;
export const QUOTE_SIZE_MAX = 140;

export const QUOTE_BACKGROUNDS: QuoteBackground[] = [
  'paper',
  'white',
  'navy',
  'ink',
  'tint',
  'cover',
  'custom'
];

export const QUOTE_BACKGROUND_NAMES: Record<QuoteBackground, string> = {
  paper: 'Paper',
  white: 'White',
  navy: 'Navy',
  ink: 'Ink',
  tint: 'Highlight colour',
  cover: 'Book cover',
  custom: 'Your colour'
};

export const QUOTE_MARK_NAMES: Record<QuoteMark, string> = {
  line: 'Line',
  quotes: '“ ”',
  corner: '「 」',
  none: 'None'
};

export const QUOTE_FRAME_NAMES: Record<QuoteFrame, string> = {
  none: 'None',
  line: 'Line',
  card: 'Card'
};

export interface QuotePalette {
  bg: string;
  ink: string;
  muted: string;
  accent: string;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

function rgbOf(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function toHex(rgb: number[]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** `hex` moved toward `other` by `t` (0-1), as #rrggbb. */
export function mixColors(hex: string, other: string, t: number): string {
  const a = rgbOf(hex);
  const b = rgbOf(other);
  return toHex(a.map((v, i) => v + (b[i] - v) * t));
}

/** Relative luminance (WCAG), 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Dark text on light colours, light text on dark ones. */
function inkFor(hex: string): { ink: string; muted: string } {
  return luminance(hex) > 0.35
    ? { ink: '#1a2233', muted: '#545c6b' }
    : { ink: '#f3ede0', muted: '#c9cfdb' };
}

export function quotePalette(
  background: QuoteBackground,
  color: HighlightColor,
  custom = DEFAULT_QUOTE_OPTIONS.customBackground
): QuotePalette {
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
        bg: mixColors(solid, '#ffffff', 0.78),
        ink: '#1a2233',
        muted: '#3b4354',
        accent: '#1a2233'
      };
    case 'cover':
      return { bg: '#111111', ink: '#ffffff', muted: 'rgba(255, 255, 255, 0.8)', accent: solid };
    case 'custom': {
      const bg = isHexColor(custom) ? custom : DEFAULT_QUOTE_OPTIONS.customBackground;
      return { bg, ...inkFor(bg), accent: solid };
    }
    default:
      return { bg: '#f3ede0', ink: '#1a2233', muted: '#545c6b', accent: solid };
  }
}

/** Every colour the drawing uses, after the automatic ones are worked out. */
export interface QuoteColors {
  bg: string;
  /** The card's fill, or null without a card. */
  card: string | null;
  frame: string;
  ink: string;
  muted: string;
  mark: string;
}

export function quoteColors(
  options: QuoteImageOptions,
  color: HighlightColor,
  background: QuoteBackground = options.background
): QuoteColors {
  const palette = quotePalette(background, color, options.customBackground);
  const onCover = background === 'cover';
  // The base the automatic colours are worked out from (the cover is darkened to near ink).
  const base = onCover ? '#111111' : palette.bg;
  let card: string | null = null;
  let { ink, muted } = palette;

  if (options.frame === 'card') {
    if (isHexColor(options.cardColor)) {
      card = options.cardColor;
      ({ ink, muted } = inkFor(card));
    } else if (onCover) {
      card = 'rgba(10, 14, 24, 0.55)';
    } else {
      card =
        luminance(base) > 0.35 ? mixColors(base, '#ffffff', 0.6) : mixColors(base, '#ffffff', 0.08);
    }
  }

  if (isHexColor(options.textColor)) {
    ink = options.textColor;
    muted = withAlpha(options.textColor, 0.72);
  }

  const surface = card && isHexColor(card) ? card : base;
  const frame = isHexColor(options.frameColor)
    ? options.frameColor
    : luminance(surface) > 0.35
      ? 'rgba(26, 34, 51, 0.16)'
      : 'rgba(255, 255, 255, 0.24)';
  const mark = isHexColor(options.markColor) ? options.markColor : palette.accent;

  return { bg: palette.bg, card, frame, ink, muted, mark };
}

const MARGIN = 96;
/** With a frame: the frame sits this far in, the content further in. */
const FRAME_INSET = 56;
const FRAMED_MARGIN = FRAME_INSET + 72;
const FRAME_RADIUS = 44;
const AUTO_MAX = 84;
const AUTO_MIN = 28;
/** Room the quote mark takes above the quote. */
const MARK_SPACE: Record<QuoteMark, number> = { line: 64, quotes: 104, corner: 124, none: 8 };

export interface QuoteLayout {
  margin: number;
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

function fitLines(
  ctx: Ctx,
  text: string,
  size: number,
  direction: QuoteDirection,
  box: QuoteLayout['box']
) {
  if (direction === 'vertical') {
    const step = size * 1.08;
    const advance = size * 1.7;
    const lines = breakLines(text, box.height, (s) => [...s].length * step);
    return { lines, step, advance, fits: lines.length * advance <= box.width };
  }
  const advance = size * 1.65;
  ctx.font = `500 ${size}px ${MINCHO}`;
  const lines = breakLines(text, box.width, (s) => ctx.measureText(s).width);
  return { lines, step: 0, advance, fits: lines.length * advance <= box.height };
}

/** Where everything goes (pure apart from measuring text). */
export function layoutQuote(
  ctx: Ctx,
  content: QuoteContent,
  options: QuoteImageOptions
): QuoteLayout {
  const { width, height } = QUOTE_SIZES[options.size];
  const margin = options.frame === 'none' ? MARGIN : FRAMED_MARGIN;
  const inner = width - margin * 2;

  // Footer: title over author, from the bottom margin up.
  const title = options.showTitle ? content.title.trim() : '';
  const author = options.showAuthor ? content.author.trim() : '';
  const footerLines = (title ? 1 : 0) + (author ? 1 : 0);
  const footerTop = height - margin - (footerLines ? footerLines * 46 + 8 : 0);

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

  const top = margin + MARK_SPACE[options.mark];
  const box = {
    left: margin,
    top,
    width: inner,
    height: Math.max(80, noteTop - 48 - top)
  };
  const text = content.text.trim();

  let size: number;
  let fit: ReturnType<typeof fitLines>;
  if (options.quoteSize) {
    // A chosen size: kept, and what doesn't fit is cut with an ellipsis.
    size = Math.min(QUOTE_SIZE_MAX, Math.max(QUOTE_SIZE_MIN, Math.round(options.quoteSize)));
    fit = fitLines(ctx, text, size, options.direction, box);
  } else {
    size = AUTO_MAX;
    fit = fitLines(ctx, text, size, options.direction, box);
    while (!fit.fits && size > AUTO_MIN) {
      size -= 2;
      fit = fitLines(ctx, text, size, options.direction, box);
    }
  }
  let lines = fit.lines;
  if (!fit.fits) {
    const room = options.direction === 'vertical' ? box.width : box.height;
    lines = clampLines(lines, Math.max(1, Math.floor(room / fit.advance)));
  }

  return {
    margin,
    lines,
    size,
    advance: fit.advance,
    step: fit.step,
    box,
    note,
    noteTop,
    footer: { title, author }
  };
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

/** A rounded rectangle path (arcTo works in every canvas). */
function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawFrame(ctx: Ctx, options: QuoteImageOptions, colors: QuoteColors) {
  if (options.frame === 'none') return;
  const { width, height } = QUOTE_SIZES[options.size];
  const w = width - FRAME_INSET * 2;
  const h = height - FRAME_INSET * 2;
  roundedRect(ctx, FRAME_INSET, FRAME_INSET, w, h, FRAME_RADIUS);
  if (options.frame === 'card' && colors.card) {
    ctx.fillStyle = colors.card;
    ctx.fill();
  }
  ctx.strokeStyle = colors.frame;
  ctx.lineWidth = options.frame === 'line' ? 4 : 3;
  ctx.stroke();
}

function drawMark(ctx: Ctx, options: QuoteImageOptions, colors: QuoteColors, margin: number) {
  ctx.fillStyle = colors.mark;
  if (options.mark === 'line') {
    roundedRect(ctx, margin, margin, 140, 10, 5);
    ctx.fill();
  } else if (options.mark === 'quotes' || options.mark === 'corner') {
    ctx.font = `700 ${options.mark === 'quotes' ? 170 : 120}px ${MINCHO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(options.mark === 'quotes' ? '“' : '「', margin - 8, margin - 16);
  }
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
  const colors = quoteColors(options, content.color, background);
  const layout = layoutQuote(ctx, content, options);
  const { box, size, margin } = layout;

  ctx.save();
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  if (background === 'cover' && cover) drawCover(ctx, cover, width, height);
  drawFrame(ctx, options, colors);
  drawMark(ctx, options, colors, margin);

  const font = `500 ${size}px ${MINCHO}`;
  if (options.direction === 'vertical') {
    const blockWidth = layout.lines.length * layout.advance;
    const right =
      options.align === 'center' ? box.left + box.width / 2 + blockWidth / 2 : box.left + box.width;
    layout.lines.forEach((column, i) => {
      const x = right - layout.advance * i - layout.advance / 2;
      const length = [...column].length * layout.step;
      const y = options.align === 'center' ? box.top + (box.height - length) / 2 : box.top;
      drawVerticalColumn(ctx, column, x, y, size, layout.step, font, colors.ink);
    });
  } else {
    const blockHeight = layout.lines.length * layout.advance;
    const y0 = box.top + (box.height - blockHeight) / 2;
    ctx.font = font;
    ctx.fillStyle = colors.ink;
    ctx.textAlign = options.align === 'center' ? 'center' : 'left';
    ctx.textBaseline = 'middle';
    const x = options.align === 'center' ? width / 2 : box.left;
    layout.lines.forEach((line, i) => {
      ctx.fillText(line, x, y0 + layout.advance * i + layout.advance / 2);
    });
  }

  // The note, small, with a rule on its left.
  if (layout.note.length) {
    ctx.fillStyle = colors.mark;
    ctx.fillRect(margin, layout.noteTop, 4, layout.note.length * 44 - 8);
    layout.note.forEach((line, i) => {
      drawText(
        ctx,
        line,
        margin + 28,
        layout.noteTop + 30 + i * 44,
        `400 30px ${SANS}`,
        colors.muted
      );
    });
  }

  // Footer: title and author on the left, the app's mark on the right.
  const footerWidth = width - margin * 2 - 140;
  let y = height - margin;
  if (layout.footer.author) {
    ctx.font = `400 28px ${SANS}`;
    drawText(
      ctx,
      ellipsized(ctx, layout.footer.author, footerWidth),
      margin,
      y,
      ctx.font,
      colors.muted
    );
    y -= 46;
  }
  if (layout.footer.title) {
    ctx.font = `700 32px ${SANS}`;
    drawText(
      ctx,
      ellipsized(ctx, layout.footer.title, footerWidth),
      margin,
      y,
      ctx.font,
      colors.ink
    );
  }
  drawText(
    ctx,
    'ッツ',
    width - margin,
    height - margin,
    `700 34px ${MINCHO}`,
    colors.muted,
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

/** `ttsu-quote-<title>-2026-11-11-0725.png` (without a title when there is none). */
export function quoteImageFileName(now: Date, title?: string): string {
  const stamp = localStamp(now, true);
  const name = fileTitle(title);
  return name ? `ttsu-quote-${name}-${stamp}.png` : `ttsu-quote-${stamp}.png`;
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

const colorOrNull = (value: unknown) => (isHexColor(value) ? value : null);

export function loadQuoteOptions(
  storage: Storage | undefined = defaultStorage()
): QuoteImageOptions {
  try {
    const raw = storage?.getItem(QUOTE_OPTIONS_KEY);
    const v = (raw ? JSON.parse(raw) : {}) as Partial<Record<keyof QuoteImageOptions, unknown>>;
    const d = DEFAULT_QUOTE_OPTIONS;
    const size = Number(v.quoteSize);
    return {
      direction: pick(v.direction, ['horizontal', 'vertical'], d.direction),
      align: pick(v.align, ['start', 'center'], d.align),
      size: pick(v.size, ['square', 'portrait'], d.size),
      background: pick(v.background, QUOTE_BACKGROUNDS, d.background),
      customBackground: isHexColor(v.customBackground) ? v.customBackground : d.customBackground,
      quoteSize:
        v.quoteSize !== null &&
        Number.isFinite(size) &&
        size >= QUOTE_SIZE_MIN &&
        size <= QUOTE_SIZE_MAX
          ? size
          : null,
      textColor: colorOrNull(v.textColor),
      mark: pick(v.mark, ['line', 'quotes', 'corner', 'none'], d.mark),
      markColor: colorOrNull(v.markColor),
      frame: pick(v.frame, ['none', 'line', 'card'], d.frame),
      frameColor: colorOrNull(v.frameColor),
      cardColor: colorOrNull(v.cardColor),
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
