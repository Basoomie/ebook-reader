/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import srtParser2 from 'srt-parser-2';
import type { Cue } from './cue-match';

/**
 * WP14: subtitle cues for sentence audio, without touching whispersync (read-only use of
 * its data): its loaded lines when it has them, else its saved lines for this book, else
 * the linked subtitle file parsed here with the same parser whispersync uses (srt) or a
 * plain WebVTT reader. Padding as whispersync applies it: a line's own adjusted time, else
 * the original time plus the global padding (ms), never below 0.
 */

export interface Padding {
  startMs: number;
  endMs: number;
}

export interface SavedSubtitle {
  id: string;
  originalStartSeconds: number;
  originalEndSeconds: number;
  adjustedStartSeconds?: number;
  adjustedEndSeconds?: number;
  text: string;
}

export function cuesFromSaved(saved: SavedSubtitle[], padding: Padding): Cue[] {
  return saved.map((s) => ({
    id: String(s.id),
    start: Math.max(0, s.adjustedStartSeconds ?? s.originalStartSeconds + padding.startMs / 1000),
    end: Math.max(0, s.adjustedEndSeconds ?? s.originalEndSeconds + padding.endMs / 1000),
    text: s.text ?? ''
  }));
}

function vttSeconds(stamp: string): number {
  const parts = stamp.trim().split(':').map(Number);
  let seconds = 0;

  for (const p of parts) seconds = seconds * 60 + p;

  return Number.isFinite(seconds) ? seconds : NaN;
}

export function parseVtt(text: string): SavedSubtitle[] {
  const out: SavedSubtitle[] = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));

    if (at < 0) continue;

    const [a, b] = lines[at].split('-->');
    const start = vttSeconds(a);
    const end = vttSeconds((b ?? '').trim().split(/\s+/)[0] ?? '');

    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    out.push({
      id: String(out.length + 1),
      originalStartSeconds: start,
      originalEndSeconds: end,
      text: lines
        .slice(at + 1)
        .join('\n')
        .replace(/<[^>]*>/g, '')
        .trim()
    });
  }

  return out;
}

export function parseSrt(text: string): SavedSubtitle[] {
  const parser = new srtParser2();

  return parser.fromSrt(text).map((r) => ({
    id: r.id,
    originalStartSeconds: r.startSeconds,
    originalEndSeconds: r.endSeconds,
    text: r.text.trim()
  }));
}

/** Cues of a subtitle file (by its name: .vtt, else srt). */
export function cuesFromFile(name: string, text: string, padding: Padding): Cue[] {
  const saved = /\.vtt$/i.test(name) ? parseVtt(text) : parseSrt(text);

  return cuesFromSaved(saved, padding);
}
