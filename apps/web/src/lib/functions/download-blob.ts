/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** Saves a Blob as a file through a temporary link (works over plain http). */
export function downloadBlob(blob: Blob, fileName: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers read the URL after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `2026-11-10` and `2026-11-10-1405` in local time, for file names. */
export function localStamp(now: Date, withTime = false): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return withTime ? `${day}-${pad(now.getHours())}${pad(now.getMinutes())}` : day;
}
