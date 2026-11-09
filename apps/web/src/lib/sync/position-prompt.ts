/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';

/**
 * "Continue from...?" (WP9): pure decision and formatting logic, free of
 * Svelte, DOM and IndexedDB so it can be unit tested.
 *
 * Positions are `position` records with id `<bookId>:<deviceId>` and data
 * `{charPos, progress, readThroughId}`, one per device (WP4). A record is a
 * candidate when it is further along than this device's place. Each record
 * version (id + updatedAt) is offered at most once: answering either way marks
 * it as handled until that device saves a newer position.
 */

/** Most rows the prompt shows. */
export const MAX_PROMPT_CANDIDATES = 3;

/** Record id -> updatedAt of the version that was already answered. */
export type HandledVersions = Record<string, number>;

export interface PromptCandidate {
  recordId: string;
  updatedAt: number;
  deviceId: string;
  /** From the device record; null when unknown. */
  deviceName: string | null;
  /** This device's own record (a place something else moved the bookmark away from). */
  isOwn: boolean;
  /** Where to jump in this device's copy of the book. */
  target: number;
  /** The other copy has a different character count; target was mapped by percent. */
  approximate: boolean;
}

export interface FindCandidatesInput {
  /** Records of the book (any kind; only live `position` records are used). */
  records: LocalRecord[];
  ownDeviceId: string;
  /** This device's place for other devices' records. */
  localPos: number;
  /** Characters in this device's copy (0 = unknown). */
  localTotal: number;
  /**
   * The place restored on open. When set, this device's own record is a
   * candidate if it is ahead of it (only on open; mid-session it is ignored).
   */
  ownBaseline?: number | null;
  /** How far ahead a position must be to be offered (at least 1). */
  minChars: number;
  handled: HandledVersions;
  deviceNames: Record<string, string | undefined>;
}

/** The device that owns a position record, from its id `<bookId>:<deviceId>`. */
export function positionOwner(recordId: string): string | null {
  const parts = recordId.split(':');
  return parts.length === 2 && parts[1] ? parts[1] : null;
}

/**
 * Maps a position from another copy of the book onto this one. The reader
 * stores `progress = charPos / characters of its copy`, so that copy's length
 * follows from the record. A different length means a different copy (WP6 lets
 * a device keep an existing copy with another count); then the place is
 * mapped by percent and marked approximate.
 */
export function mapPosition(
  charPos: number,
  progress: unknown,
  localTotal: number
): { target: number; approximate: boolean } {
  let target = charPos;
  let approximate = false;
  if (
    localTotal > 0 &&
    charPos > 0 &&
    typeof progress === 'number' &&
    Number.isFinite(progress) &&
    progress > 0 &&
    progress <= 1
  ) {
    const otherTotal = Math.round(charPos / progress);
    if (Math.abs(otherTotal - localTotal) > 1) {
      target = Math.round(progress * localTotal);
      approximate = true;
    }
  }
  if (localTotal > 0) target = Math.min(target, localTotal);
  return { target: Math.max(0, target), approximate };
}

export function findPromptCandidates(input: FindCandidatesInput): PromptCandidate[] {
  const minAhead = Math.max(1, Math.round(input.minChars) || 0);
  const candidates: PromptCandidate[] = [];

  for (const record of input.records) {
    if (record.kind !== 'position' || record.deletedAt !== null) continue;
    const deviceId = positionOwner(record.id);
    if (!deviceId) continue;
    if (input.handled[record.id] === record.updatedAt) continue;

    const charPos = record.data?.charPos;
    if (typeof charPos !== 'number' || !Number.isFinite(charPos) || charPos < 0) continue;

    const isOwn = deviceId === input.ownDeviceId;
    let baseline: number;
    if (isOwn) {
      if (input.ownBaseline === null || input.ownBaseline === undefined) continue;
      baseline = input.ownBaseline;
    } else {
      baseline = input.localPos;
    }

    const { target, approximate } = isOwn
      ? {
          target: input.localTotal > 0 ? Math.min(charPos, input.localTotal) : charPos,
          approximate: false
        }
      : mapPosition(charPos, record.data?.progress, input.localTotal);

    if (target - baseline < minAhead) continue;

    candidates.push({
      recordId: record.id,
      updatedAt: record.updatedAt,
      deviceId,
      deviceName: isOwn ? null : input.deviceNames[deviceId]?.trim() || null,
      isOwn,
      target,
      approximate
    });
  }

  return candidates.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PROMPT_CANDIDATES);
}

/**
 * The handled versions after answering for one book: drops this book's
 * entries that no longer match a live record (superseded or deleted), then
 * adds the answered ones. Other books' entries are kept as they are.
 */
export function updateHandled(
  handled: HandledVersions,
  bookId: string,
  bookRecords: LocalRecord[],
  answered: { recordId: string; updatedAt: number }[]
): HandledVersions {
  const live = new Map(
    bookRecords
      .filter((r) => r.kind === 'position' && r.deletedAt === null)
      .map((r) => [r.id, r.updatedAt])
  );
  const next: HandledVersions = {};
  for (const [id, updatedAt] of Object.entries(handled)) {
    if (!id.startsWith(`${bookId}:`) || live.get(id) === updatedAt) next[id] = updatedAt;
  }
  for (const { recordId, updatedAt } of answered) next[recordId] = updatedAt;
  return next;
}

export interface SectionLike {
  label?: string;
  startCharacter?: number;
  parentChapter?: string;
}

/** The label of the top-level chapter that contains `pos`, if the book has one. */
export function chapterLabelAt(sections: SectionLike[], pos: number): string | undefined {
  let label: string | undefined;
  for (const section of sections) {
    if (section.parentChapter || typeof section.startCharacter !== 'number') continue;
    if (section.startCharacter > pos) break;
    if (section.label?.trim()) label = section.label.trim();
  }
  return label;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function formatAge(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "today 21:40", "yesterday 21:40" or "Nov 3, 21:40", in local time. */
export function formatWhen(at: number, now: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const dayDiff = Math.round((startOfDay(new Date(now)) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `yesterday ${time}`;
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day}, ${time}`;
}

/** "「Chapter」 · 38.2% · 41,230 / 107,900" (parts left out when unknown). */
export function formatPlace(pos: number, total: number, chapter: string | undefined): string {
  const parts: string[] = [];
  if (chapter) parts.push(`「${chapter}」`);
  if (total > 0) parts.push(`${((pos / total) * 100).toFixed(1)}%`);
  parts.push(
    total > 0 ? `${pos.toLocaleString()} / ${total.toLocaleString()}` : pos.toLocaleString()
  );
  return parts.join(' · ');
}
