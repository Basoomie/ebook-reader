/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP19d: dates on the Notes page. `locale` is the browser's when left out (tests pass
 * one so results don't depend on the machine).
 */

/** "Nov 11, 2026, 7:25 AM" (date and time of a highlight or note). */
export function formatWhen(ms: number, locale?: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Nov 11, 2026" (a book's last change). */
export function formatDate(ms: number, locale?: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleDateString(locale, { dateStyle: 'medium' });
}

/** "2026-11-11 07:25" in local time (CSV: sorts as text, read as a date by spreadsheets). */
export function formatCsvDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
