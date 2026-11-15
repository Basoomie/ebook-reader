/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * The book the reader in this tab has open (its local id). The update of a changed library
 * file (file-updates.ts) leaves that book alone until the reader is closed: the reader keeps
 * the text it loaded and saves its place in that text's numbers.
 */
let openLocalId: number | null = null;

export function setOpenInReader(localId: number | null): void {
  openLocalId = localId;
}

export function isOpenInReader(localId: number): boolean {
  return openLocalId === localId;
}
