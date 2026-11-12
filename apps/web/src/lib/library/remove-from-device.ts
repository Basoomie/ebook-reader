/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { confirmDestructive } from '$lib/confirm/confirm';
import { removeFromDeviceCopy } from '$lib/confirm/confirm-copy';
import { database } from '$lib/data/store';
import { localIdsOfBook } from '$lib/library/device-books';
import { getLibraryStore } from '$lib/library/library-db';

/**
 * WP15e "Remove from this device" (a book's ⋮ menu and its details page; replaces the
 * old Book Manager's delete). Asks first, then removes the book's copy on this device
 * with its bookmark and whispersync's rows (database.removeBookFromDevice) and updates
 * this device's list for "On this device". The library link is kept: opening the book
 * again downloads a fresh copy (decide-open treats a link without its copy as stale).
 * Nothing on the server changes.
 */

/** Whether a library book has a copy on this device. Never rejects. */
export async function isOnThisDevice(bookId: string): Promise<boolean> {
  try {
    const [links, keys] = await Promise.all([
      getLibraryStore().getAllLinks(),
      database.db.then((db) => db.getAllKeys('data'))
    ]);
    return localIdsOfBook(links, new Set(keys), bookId).length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolves to true when the copy was removed, false when there was none or the user
 * said no. Rejects when the removal failed (the caller shows the message).
 */
export async function removeFromThisDevice(book: { id: string; title: string }): Promise<boolean> {
  const [links, keys] = await Promise.all([
    getLibraryStore().getAllLinks(),
    database.db.then((db) => db.getAllKeys('data'))
  ]);
  const localIds = localIdsOfBook(links, new Set(keys), book.id);
  if (!localIds.length) return false;

  const confirmed = await confirmDestructive({
    ...removeFromDeviceCopy(book.title),
    testid: 'remove-device-confirm',
    confirmTestid: 'remove-device-confirm-button'
  });
  if (!confirmed) return false;

  for (const localId of localIds) {
    await database.removeBookFromDevice(localId);
  }
  // Before the caller reloads a list that uses on:device (publishDeviceBooks never rejects).
  try {
    const { publishDeviceBooks } = await import('$lib/sync/sync-service');
    await publishDeviceBooks();
  } catch {
    // The next app start publishes the list again.
  }
  return true;
}
