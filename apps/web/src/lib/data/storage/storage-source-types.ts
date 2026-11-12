/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Shapes of the old sync's storage sources, as the IndexedDB schema (books-db v4-v6)
 * declares them. WP15e removed the old sync and its storage-source manager; the schema
 * and any rows already stored stay as they are, so only the types remain here.
 */

export interface FsHandle {
  directoryHandle: FileSystemDirectoryHandle;
  fsPath: string;
}

export interface RemoteContext {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
}
