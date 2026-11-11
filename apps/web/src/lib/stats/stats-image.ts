/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  canvasToPng,
  drawText,
  fittedFont,
  loadCover,
  loadImageFonts,
  MINCHO,
  SANS,
  type CoverImage,
  type Ctx
} from '$lib/image/canvas-text';
import type { StatsImageModel } from '$lib/stats/stats-image-model';

export { loadCover, loadImageFonts, type CoverImage };

/**
 * Draws the Stats image (WP12d) on a canvas: portrait 1080 × 1350, black on white (it reads
 * the same on e-ink), the app's bundled Noto Sans JP and Shippori Mincho, "ッツ READER" in
 * the header, 読書記録 down the right edge, the completed books' covers at the bottom
 * (draft approved by the user, 2026-11-11). A cover that can't load, or that would make
 * the canvas unreadable (no CORS), is drawn as a plain card with its title instead.
 */

export const IMAGE_WIDTH = 1080;
export const IMAGE_HEIGHT = 1350;

const INK = '#111111';
const PAPER = '#ffffff';
const GREY = '#6b6b6b';
const LIGHT = '#d4d4d4';
const LEFT = 72;
const RIGHT = 1008;

function text(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  font: string,
  color = INK,
  align: CanvasTextAlign = 'left'
) {
  drawText(ctx, value, x, y, font, color, align);
}

/** Shrinks the font until the text fits `maxWidth`. */
function fitted(ctx: Ctx, value: string, size: number, weight: number, maxWidth: number) {
  return fittedFont(ctx, value, size, weight, maxWidth, SANS);
}

/** Upright vertical text, one character per line (canvas has no writing-mode). */
function vertical(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  size: number,
  font: string,
  step = size * 1.15
) {
  ctx.font = `${font}`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  [...value].forEach((ch, i) => ctx.fillText(ch, x, y + i * step));
}

function coverCard(ctx: Ctx, title: string, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  vertical(ctx, [...title].slice(0, 5).join(''), x + w / 2, y + 12, 17, `500 17px ${MINCHO}`, 20);
}

/** Draws the image. `covers[i]` is the loaded image of `model.covers[i]`, or null. */
export function drawStatsImage(ctx: Ctx, model: StatsImageModel, covers: CoverImage[]): void {
  ctx.save();
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);

  // Header
  ctx.save();
  ctx.font = `700 28px ${SANS}`;
  // Not in every browser (or TypeScript's DOM types); without it the header is just tighter.
  (ctx as Ctx & { letterSpacing?: string }).letterSpacing = '2px';
  text(ctx, model.header, LEFT, 108, `700 28px ${SANS}`);
  ctx.restore();
  text(ctx, model.period, RIGHT, 108, `400 28px ${SANS}`, INK, 'right');
  ctx.fillStyle = INK;
  ctx.fillRect(LEFT, 128, RIGHT - LEFT, 3);
  if (model.filter)
    text(ctx, model.filter, LEFT, 170, fitted(ctx, model.filter, 24, 400, 860), GREY);

  // 読書記録 down the right edge
  vertical(ctx, '読書記録', 990, 170, 44, `700 44px ${MINCHO}`, 54);

  // Characters
  text(ctx, 'Characters read', LEFT, 236, `400 30px ${SANS}`, GREY);
  text(ctx, model.chars, LEFT - 6, 372, fitted(ctx, model.chars, 148, 700, 860));

  // Six numbers
  const stats: [string, string][] = [
    ['Reading time', model.time],
    ['Speed', model.speed],
    ['Days read', model.daysRead],
    ['Books completed', model.completed],
    ['Dictionary lookups', model.lookups],
    ['Books read', model.booksRead]
  ];
  stats.forEach(([label, value], i) => {
    const x = LEFT + (i % 3) * 312;
    const y = 452 + Math.floor(i / 3) * 128;
    text(ctx, label, x, y, `400 26px ${SANS}`, GREY);
    text(ctx, value, x, y + 58, fitted(ctx, value, 50, 500, 290));
  });
  ctx.fillStyle = LIGHT;
  ctx.fillRect(LEFT, 690, RIGHT - LEFT, 1);

  // Chart
  const chart = model.chart;
  if (chart && chart.values.length) {
    text(ctx, chart.title, LEFT, 740, `400 26px ${SANS}`, GREY);
    const max = Math.max(...chart.values);
    if (max > 0)
      text(
        ctx,
        `best ${max.toLocaleString('en-US')}`,
        RIGHT,
        740,
        `400 22px ${SANS}`,
        GREY,
        'right'
      );
    const base = 960;
    const maxH = 180;
    const n = chart.values.length;
    const gap = n > 10 ? Math.max(2, Math.min(8, 240 / n)) : 24;
    const w = (RIGHT - LEFT - gap * (n - 1)) / n;
    chart.values.forEach((value, i) => {
      const x = LEFT + i * (w + gap);
      const h = max > 0 && value > 0 ? Math.max(4, (value / max) * maxH) : 0;
      ctx.fillStyle = h ? INK : LIGHT;
      if (h) ctx.fillRect(x, base - h, w, h);
      else ctx.fillRect(x, base - 2, w, 2);
      if (chart.labels[i])
        text(ctx, chart.labels[i], x + w / 2, base + 36, `400 22px ${SANS}`, GREY, 'center');
    });
  }

  // Goals (two with covers, three without)
  const goals = model.goals.slice(0, model.covers.length ? 2 : 3);
  if (goals.length) {
    let y = 1052;
    text(ctx, 'Goals', LEFT, y, `400 26px ${SANS}`, GREY);
    for (const goal of goals) {
      y += 50;
      text(ctx, goal.title, LEFT, y, fitted(ctx, goal.title, 28, 500, 620));
      text(ctx, goal.result, RIGHT, y, `400 26px ${SANS}`, INK, 'right');
      if (goal.dots) {
        const r = goal.dots.length > 10 ? 9 : 13;
        const step = goal.dots.length > 10 ? 23 : 36;
        const x0 = RIGHT - step * goal.dots.length + step / 2;
        y += 34;
        goal.dots.forEach((state, i) => {
          ctx.beginPath();
          ctx.arc(x0 + i * step, y - 8, r, 0, Math.PI * 2);
          ctx.fillStyle = state === 'met' ? INK : PAPER;
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = state === 'none' || state === 'current' ? LIGHT : INK;
          ctx.stroke();
        });
      }
    }
  }

  // Covers of the completed books
  if (model.covers.length) {
    const y = 1206;
    model.covers.forEach((cover, i) => {
      const x = LEFT + i * 112;
      const image = covers[i];
      if (image) {
        ctx.fillStyle = PAPER;
        ctx.fillRect(x, y, 96, 120);
        // Fit inside 96 × 120, keeping the cover's shape.
        const iw = (image as { width?: number }).width ?? 96;
        const ih = (image as { height?: number }).height ?? 120;
        const scale = Math.min(96 / iw, 120 / ih);
        const dw = iw * scale;
        const dh = ih * scale;
        ctx.drawImage(image, x + (96 - dw) / 2, y + (120 - dh) / 2, dw, dh);
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + (96 - dw) / 2, y + (120 - dh) / 2, dw, dh);
      } else {
        coverCard(ctx, cover.title, x, y, 96, 120);
      }
    });
    const label = model.covers.length === 1 ? 'completed' : `${model.covers.length} completed`;
    text(ctx, label, LEFT + model.covers.length * 112 + 8, 1276, `400 24px ${SANS}`, GREY);
  }
  ctx.restore();
}

/**
 * The PNG of the image. If a cover made the canvas unreadable (served without CORS), the
 * image is drawn again with plain cards for the covers.
 */
export async function renderStatsImage(
  model: StatsImageModel,
  doc: Document = document
): Promise<Blob> {
  await loadImageFonts(doc);
  const covers = await Promise.all(model.covers.map((c) => loadCover(c.url)));
  const draw = (images: CoverImage[]) => {
    const canvas = doc.createElement('canvas');
    canvas.width = IMAGE_WIDTH;
    canvas.height = IMAGE_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the image');
    drawStatsImage(ctx, model, images);
    return canvas;
  };
  try {
    return await canvasToPng(draw(covers));
  } catch {
    // A tainted canvas stays tainted: draw a fresh one without the cover images.
    return canvasToPng(draw(model.covers.map(() => null)));
  }
}
