/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Built-in collections (decisions.md "Library UI"): fixed searches, shown on the
 * Collections page before your own and also offered as Library chips. They can't be
 * renamed or deleted. The server has the same list (storage-server
 * src/collections/cards.ts); the two-device test checks they agree. "On this device"
 * (WP15e) is the same search on every device; the server answers it with the books of
 * the device that asks.
 */
export interface BuiltinCollection {
  id: string;
  name: string;
  query: string;
}

export const BUILTIN_COLLECTIONS: readonly BuiltinCollection[] = [
  { id: 'reading', name: 'Reading', query: 'status:reading' },
  { id: 'completed', name: 'Completed', query: 'status:completed' },
  { id: 'dropped', name: 'Dropped', query: 'status:dropped' },
  { id: 'unread', name: 'Unread', query: 'status:unread' },
  { id: 'favorites', name: 'Favorites', query: 'favorite:yes' },
  { id: 'on-device', name: 'On this device', query: 'on:device' }
];

export function builtinCollection(id: string): BuiltinCollection | null {
  return BUILTIN_COLLECTIONS.find((b) => b.id === id) ?? null;
}
