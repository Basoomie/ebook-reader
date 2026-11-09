/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BehaviorSubject } from 'rxjs';
import { StorageDataType } from '$lib/data/storage/storage-types';
import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * The old file sync's switch (WP5 decision 4). One synced record
 * (`migration` / `legacy-sync`) that every device obeys after its next pull.
 * No record means on. Only the user's tap on the migration page writes it;
 * the program never turns the old sync off by itself.
 *
 * Off stops the old sync for the data the new sync now carries: position,
 * statistics and reading goals (plus the reader's automatic rename of the
 * stored book file on open). Whispersync keeps using the old sync until WP15
 * (decided with the user): audiobook position, subtitles, and book files,
 * which carry whispersync's matched HTML (its "save match" uploads them, and
 * a reset reaches other devices through a later manual book-data sync).
 * Book files are only ever written to the old sync by such explicit actions.
 */

export const LEGACY_SYNC_RECORD = { kind: 'migration', id: 'legacy-sync' } as const;

/** Data the switch stops. DATA (book files), AUDIOBOOK and SUBTITLE are not in it. */
export const LEGACY_READING_TYPES: readonly StorageDataType[] = [
  StorageDataType.PROGRESS,
  StorageDataType.STATISTICS,
  StorageDataType.READING_GOALS
];

export function legacySyncEnabledFrom(record: LocalRecord | undefined | null): boolean {
  if (!record || record.deletedAt !== null) return true;
  return record.data.enabled !== false;
}

/** true once this tab knows the user switched the old sync off. */
export const legacyReadingSyncOff$ = new BehaviorSubject<boolean>(false);

/** The data types still allowed to the old sync. */
export function allowedLegacyTypes<T extends StorageDataType>(types: T[], off: boolean): T[] {
  return off ? types.filter((t) => !LEGACY_READING_TYPES.includes(t)) : types;
}

export function isLegacyReadingType(type: StorageDataType): boolean {
  return LEGACY_READING_TYPES.includes(type);
}
