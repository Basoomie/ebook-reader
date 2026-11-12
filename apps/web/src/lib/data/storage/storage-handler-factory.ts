/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { StorageKey } from '$lib/data/storage/storage-types';
import { BrowserStorageHandler } from '$lib/data/storage/handler/browser-handler';
import { MergeMode } from '$lib/data/merge-mode';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';

/**
 * This browser's book storage (IndexedDB). WP15e removed the old sync's other storages
 * (self-hosted server, Google Drive, OneDrive, a local folder, backup zips); only the
 * browser one is left, used to open and save books.
 */
let browserStorageHandler: BrowserStorageHandler;

export function getBrowserStorageHandler(
  window: Window,
  saveBehavior = ReplicationSaveBehavior.NewOnly
): BrowserStorageHandler {
  browserStorageHandler =
    browserStorageHandler || new BrowserStorageHandler(window, StorageKey.BROWSER);
  browserStorageHandler.updateSettings(
    window,
    true,
    saveBehavior,
    MergeMode.MERGE,
    MergeMode.MERGE
  );

  return browserStorageHandler;
}
