/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { CalibreLink } from '$lib/library/library-db';
import {
  findPromptCandidates,
  updateHandled,
  type PromptCandidate
} from '$lib/sync/position-prompt';
import { resolveLinkedBookId } from '$lib/sync/record-position';
import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * "Continue from...?" (WP9): reads other devices' positions from the local
 * mirror (so it works offline) and remembers which versions were answered.
 * Never touches the network; the reader runs the sync separately.
 */

export interface PositionPromptDeps {
  getEngine(): Promise<SyncEngine>;
  linksForLocalId(localId: number): Promise<CalibreLink[]>;
  /** WP5: the migrated link of a title without a Calibre link. */
  legacyBookId?(title: string): Promise<string | null>;
  /** Prompt setting on, record sync on, and a server connection. */
  isActive(): Promise<boolean>;
  minChars(): number;
  warn(message: string): void;
}

export interface PromptRow extends PromptCandidate {
  /** updatedAt on this device's clock (records carry server time). */
  localAt: number;
}

export interface PositionPrompt {
  bookId: string;
  rows: PromptRow[];
  /** Last successful sync on this device's clock, or null. */
  lastSyncAt: number | null;
  /** Error of the last sync attempt (shown so old information is recognisable). */
  lastError: string | null;
}

export interface PromptPlace {
  /** This device's place for other devices' records (the live position). */
  localPos: number;
  /** Characters in this device's copy. */
  localTotal: number;
  /** The place restored on open; set only on open (offers this device's own record). */
  ownBaseline?: number | null;
}

/** The server book id when the prompt applies to this book, else null. */
export async function promptBookId(
  localId: number,
  title: string,
  deps: PositionPromptDeps
): Promise<string | null> {
  if (!(await deps.isActive())) return null;
  return resolveLinkedBookId(localId, title, deps.linksForLocalId, deps.warn, deps.legacyBookId);
}

function positions(records: LocalRecord[]): LocalRecord[] {
  return records.filter((r) => r.kind === 'position');
}

/** What to offer for this book now, or null. Never throws. */
export async function findPositionPrompt(
  bookId: string,
  place: PromptPlace,
  deps: PositionPromptDeps
): Promise<PositionPrompt | null> {
  try {
    if (!(await deps.isActive())) return null;
    const engine = await deps.getEngine();
    const [records, meta] = await Promise.all([engine.getForBook(bookId), engine.getMeta()]);

    const deviceNames: Record<string, string | undefined> = {};
    for (const record of positions(records)) {
      const deviceId = record.id.split(':')[1];
      if (!deviceId || deviceId in deviceNames) continue;
      const device = await engine.get('device', deviceId);
      const name = device && device.deletedAt === null ? device.data?.name : undefined;
      deviceNames[deviceId] = typeof name === 'string' ? name : undefined;
    }

    const candidates = findPromptCandidates({
      records: positions(records),
      ownDeviceId: engine.deviceId,
      localPos: place.localPos,
      localTotal: place.localTotal,
      ownBaseline: place.ownBaseline ?? null,
      minChars: deps.minChars(),
      handled: meta.positionPromptHandled ?? {},
      deviceNames
    });
    if (!candidates.length) return null;

    return {
      bookId,
      rows: candidates.map((c) => ({ ...c, localAt: c.updatedAt - (meta.clockOffsetMs || 0) })),
      lastSyncAt: meta.lastSyncAt ?? null,
      lastError: meta.lastError ?? null
    };
  } catch (error) {
    deps.warn(
      `Sync: could not check other devices' positions: ${(error as Error)?.message ?? error}`
    );
    return null;
  }
}

/** Remembers that these versions were answered (either way). Never throws. */
export async function markPositionPromptHandled(
  bookId: string,
  answered: { recordId: string; updatedAt: number }[],
  deps: Pick<PositionPromptDeps, 'getEngine' | 'warn'>
): Promise<void> {
  try {
    const engine = await deps.getEngine();
    const records = await engine.getForBook(bookId);
    await engine.updateMeta((meta) => {
      meta.positionPromptHandled = updateHandled(
        meta.positionPromptHandled ?? {},
        bookId,
        records,
        answered
      );
    });
  } catch (error) {
    deps.warn(`Sync: could not save the answer: ${(error as Error)?.message ?? error}`);
  }
}

/**
 * Calls back when a sync in this tab brings position records for the book.
 * Returns an unsubscribe function. Never throws.
 */
export async function onPositionsChanged(
  bookId: string,
  callback: () => void,
  deps: Pick<PositionPromptDeps, 'getEngine' | 'warn'>
): Promise<() => void> {
  try {
    const engine = await deps.getEngine();
    return engine.onRemoteChange((records) => {
      if (records.some((r) => r.kind === 'position' && r.bookId === bookId)) callback();
    });
  } catch (error) {
    deps.warn(`Sync: ${(error as Error)?.message ?? error}`);
    return () => {};
  }
}
