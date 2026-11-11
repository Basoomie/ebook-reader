/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { readingSpeed, type StatEntry } from '$lib/stats/aggregate';

/**
 * Time left for the chapter and the book (WP12c, decided 2026-11-10): the recent speed
 * in this book, else the overall average. Pure.
 *
 * - Recent speed: the book's newest tracked reading (every device), taken newest first
 *   until `recentSeconds` of reading are collected (the last one counted whole).
 * - It is used when it holds at least `minSeconds`; else the overall speed of every
 *   tracked book; with less than `minSeconds` overall there is no estimate.
 * - Tracked reading = tracker sessions and frozen days; completion sessions and excluded
 *   sessions never count. Frozen days are older than every session (by their day).
 */

export interface SpeedEstimate {
  /** Characters per hour. */
  speed: number;
  source: 'book' | 'overall';
  seconds: number;
}

function tracked(e: StatEntry): boolean {
  return !e.excluded && e.source !== 'completion' && e.seconds > 0;
}

/** Newest first: by day, then by end time (frozen days have none and come last in a day). */
function newestFirst(a: StatEntry, b: StatEntry): number {
  if (a.day !== b.day) return a.day < b.day ? 1 : -1;
  return (b.endedAt ?? 0) - (a.endedAt ?? 0);
}

export function speedEstimate(
  bookId: string,
  entries: StatEntry[],
  recentSeconds: number,
  minSeconds: number
): SpeedEstimate | null {
  const min = Math.max(1, minSeconds);
  const book = entries.filter((e) => e.bookId === bookId && tracked(e)).sort(newestFirst);
  let seconds = 0;
  let chars = 0;
  for (const e of book) {
    if (seconds >= Math.max(1, recentSeconds)) break;
    seconds += e.seconds;
    chars += e.chars;
  }
  if (seconds >= min) {
    return {
      speed: readingSpeed({ speedSeconds: seconds, speedChars: chars }),
      source: 'book',
      seconds
    };
  }
  let allSeconds = 0;
  let allChars = 0;
  for (const e of entries) {
    if (!tracked(e)) continue;
    allSeconds += e.seconds;
    allChars += e.chars;
  }
  if (allSeconds < min) return null;
  return {
    speed: readingSpeed({ speedSeconds: allSeconds, speedChars: allChars }),
    source: 'overall',
    seconds: allSeconds
  };
}

/** Seconds to read `characters` at `estimate`, or null without an estimate. */
export function secondsLeft(characters: number, estimate: SpeedEstimate | null): number | null {
  if (!estimate || estimate.speed <= 0) return null;
  return Math.max(0, Math.round((Math.max(0, characters) * 3600) / estimate.speed));
}

/** "3 h 05 min", "12 min", "< 1 min". */
export function formatTimeLeft(seconds: number | null): string {
  if (seconds === null) return '–';
  if (seconds < 60) return '< 1 min';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
