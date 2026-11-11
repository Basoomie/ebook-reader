/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Display helpers for the Stats page (WP12b). Pure. */

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** "2 h 05 min", "12 min", "40 s", "0 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return s ? `${s} s` : '0 min';
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** "21:40" on this device's clock. */
export function formatClock(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "Thu 12 Nov" (year added when it isn't `currentYear`). */
export function formatDay(day: string, currentYear: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const text = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC'
  });
  return String(y) === currentYear ? text : `${text} ${y}`;
}

/** Whole, non-negative number from a form field, or null. */
export function parseCount(value: string): number | null {
  const n = Number(value.trim().replace(/[,_\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
