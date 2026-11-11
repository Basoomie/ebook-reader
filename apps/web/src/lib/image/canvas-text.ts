/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Canvas helpers shared by the Stats image (WP12d) and quote images (WP19d): text, fonts,
 * covers, PNG output, and Japanese line breaking for horizontal and vertical text (a canvas
 * has no writing-mode, so vertical text is laid out one character at a time).
 */

export type Ctx = CanvasRenderingContext2D;
export type CoverImage = CanvasImageSource | null;

export const SANS = "'Noto Sans JP', system-ui, sans-serif";
export const MINCHO = "'Shippori Mincho', 'Noto Serif JP', serif";

export function drawText(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = 'left'
): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(value, x, y);
}

/** Shrinks the font until the text fits `maxWidth`; returns the font. */
export function fittedFont(
  ctx: Ctx,
  value: string,
  size: number,
  weight: number,
  maxWidth: number,
  family = SANS
): string {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 12 && ctx.measureText(value).width > maxWidth) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return `${weight} ${s}px ${family}`;
}

/** The text cut to `maxWidth` with an ellipsis (font already set). */
export function ellipsized(ctx: Ctx, value: string, maxWidth: number): string {
  if (ctx.measureText(value).width <= maxWidth) return value;
  const chars = [...value];
  while (chars.length && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
  return `${chars.join('')}…`;
}

/** Waits for the bundled fonts the images use (where the Font Loading API exists). */
export async function loadImageFonts(doc: Document = document): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return;
  await Promise.all(
    [
      `400 28px 'Noto Sans JP'`,
      `500 28px 'Noto Sans JP'`,
      `700 28px 'Noto Sans JP'`,
      `400 28px 'Shippori Mincho'`,
      `500 28px 'Shippori Mincho'`,
      `700 44px 'Shippori Mincho'`
    ].map((f) => fonts.load(f, 'ッツ読書記録0123あア漢「」').catch(() => []))
  );
}

/** Loads a cover for drawing; null when it can't be loaded in time. */
export function loadCover(url: string | null, timeoutMs = 6000): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

/** The canvas as a PNG; rejects for a canvas made unreadable by a cover without CORS. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('No image data'))),
        'image/png'
      );
    } catch (error) {
      reject(error);
    }
  });
}

// ---- Japanese line breaking -------------------------------------------------------------

/** Never at the start of a line (closing brackets, punctuation, small kana, long vowel). */
export const NO_LINE_START = new Set([
  ...'、。，．,.・：；:;！？!?）」』】〕〉》｝］)]}ー〜～…‥ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶゝゞヽヾ々'
]);
/** Never at the end of a line (opening brackets). */
export const NO_LINE_END = new Set([...'（「『【〔〈《｛［([{']);
/** May hang past the end of a line (small punctuation and closing brackets). */
const HANGING = new Set([...'、。，．,.）」』】〕〉》｝］)]}']);

/**
 * Breaks text into lines no wider than `max` (by `measure`), keeping line breaks in the
 * text. Simple kinsoku: 、。 and closing brackets that may not start a line hang on the
 * line before (one character past `max`, as Japanese books do); other characters that may
 * not start a line (small kana, ー, ！？) take the last character of the line with them to
 * the next one, so nothing else runs past `max`; an opening bracket moves to the next line
 * with what it opens.
 */
export function breakLines(text: string, max: number, measure: (line: string) => number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line: string[] = [];

    for (const ch of paragraph) {
      if (line.length && measure([...line, ch].join('')) > max) {
        if (HANGING.has(ch)) {
          // Hang it on this line.
          line.push(ch);
          lines.push(line.join(''));
          line = [];
          continue;
        }
        const carry: string[] = [];
        if (NO_LINE_START.has(ch) && line.length > 1) {
          // Push the last character down with it (and anything that can't start a line).
          carry.unshift(line.pop() as string);
          while (line.length > 1 && NO_LINE_START.has(carry[0])) {
            carry.unshift(line.pop() as string);
          }
        }
        while (line.length > 1 && NO_LINE_END.has(line[line.length - 1])) {
          carry.unshift(line.pop() as string);
        }
        lines.push(line.join(''));
        line = carry;
      }
      line.push(ch);
    }
    lines.push(line.join(''));
  }

  return lines;
}

/** Cuts lines to `maxLines`, ending the last one with an ellipsis. */
export function clampLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  const last = [...kept[kept.length - 1]];
  if (last.length > 1) last.pop();
  kept[kept.length - 1] = `${last.join('')}…`;
  return kept;
}

// ---- Vertical text ------------------------------------------------------------------------

/** Turned 90° in vertical text (brackets, long vowel, dashes, ellipses, Latin). */
const ROTATED = new Set([
  ...'ー〜～…‥―－-—–~=（）「」『』【】〔〕〈〉《》［］｛｝()[]{}<>＜＞：；:;'
]);
/** Set in the top right of their square in vertical text. */
const TOP_RIGHT = new Set([...'、。，．,.']);
/** Small kana sit a little up and right. */
const SMALL = new Set([...'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ']);

export type VerticalPlacement = 'upright' | 'rotated' | 'top-right' | 'small';

export function verticalPlacement(ch: string): VerticalPlacement {
  if (TOP_RIGHT.has(ch)) return 'top-right';
  if (SMALL.has(ch)) return 'small';
  if (ROTATED.has(ch)) return 'rotated';
  // Latin letters and digits lie on their side in Japanese vertical text.
  if (/^[\x21-\x7e]$/.test(ch)) return 'rotated';
  return 'upright';
}

/**
 * Draws one column of vertical text, top to bottom from (x, y): `x` is the column's
 * centre, each character takes `step` px.
 */
export function drawVerticalColumn(
  ctx: Ctx,
  column: string,
  x: number,
  y: number,
  size: number,
  step: number,
  font: string,
  color: string
): void {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  [...column].forEach((ch, i) => {
    const cy = y + i * step + step / 2;
    const placement = verticalPlacement(ch);
    if (placement === 'rotated') {
      ctx.save();
      ctx.translate(x, cy);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    } else if (placement === 'top-right') {
      ctx.fillText(ch, x + size * 0.6, cy - size * 0.55);
    } else if (placement === 'small') {
      ctx.fillText(ch, x + size * 0.1, cy - size * 0.1);
    } else {
      ctx.fillText(ch, x, cy);
    }
  });
}
