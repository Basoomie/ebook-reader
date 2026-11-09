/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { errorFrom, send } from '$lib/library/api';
import type { CatalogBook as BookSummary } from '$lib/library/types';

/** Client for the storage server's WP5 routes (/api/v1/migration). */

export type LegacyState = 'linked' | 'needs_user' | 'deferred';
export type LinkMethod = 'calibre-link' | 'fingerprint' | 'user';
export type NeedsReason =
  | 'several'
  | 'unverified'
  | 'no_candidate'
  | 'no_book_file'
  | 'damaged'
  | 'conflict'
  | 'unlinked';

export interface Candidate {
  bookId: string;
  fingerprinted: boolean;
  titleMatches?: boolean;
  imagesMatched?: number;
  imagesTotal?: number;
  missingSpineIds?: number;
  verified?: boolean;
  error?: string;
  book: BookSummary | null;
}

export interface FolderDetails {
  characters: number | null;
  bookFiles: number;
  progress: { charPos: number; progress: number | null; at: number } | null;
  stats: { days: number; characters: number; seconds: number; lastDay: string | null } | null;
  audioBook: boolean;
  subtitles: boolean;
  error?: string;
  conflictBookIds?: string[];
}

export interface LegacyBookView {
  folder: string;
  title: string;
  state: LegacyState;
  reason: NeedsReason | null;
  method: LinkMethod | null;
  bookId: string | null;
  book: BookSummary | null;
  candidates: Candidate[];
  details: FolderDetails;
  scannedAt: number;
  decidedAt: number | null;
  importedAt: number | null;
}

export interface ScanStatus {
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  done: number;
  total: number;
  error: string | null;
}

export interface MigrationOverview {
  scan: ScanStatus;
  lastScanAt: number | null;
  lastImportAt: number | null;
  lastSnapshot: string | null;
  importDeviceId: string | null;
  calibreAvailable: boolean;
  legacySyncEnabled: boolean;
  settingsSourceDeviceId: string | null;
  books: LegacyBookView[];
  devices: {
    id: string;
    name: string;
    lastSeenAt: number | null;
    reportedAt: number | null;
    calibreLinks: number;
    localOnlyTitles: string[];
  }[];
}

export interface ImportResult {
  books: number;
  positions: number;
  statDays: number;
  snapshot: string;
}

export interface StatTotals {
  days: number;
  characters: number;
  seconds: number;
  completed: string | null;
}

export interface CheckBook {
  folder: string;
  title: string;
  bookId: string;
  importedAt: number | null;
  error: string | null;
  position: {
    old: { charPos: number; progress: number | null; at: number } | null;
    new: {
      charPos: number;
      progress: number | null;
      at: number;
      deviceId: string;
      deviceName: string | null;
    } | null;
    match: boolean;
  };
  stats: {
    old: StatTotals;
    new: StatTotals;
    days: {
      dateKey: string;
      old: { characters: number; seconds: number } | null;
      new: { characters: number; seconds: number } | null;
    }[];
    match: boolean;
  };
  positionsByDevice: { deviceId: string; charPos: number; at: number }[];
  match: boolean;
}

export interface CheckResult {
  generatedAt: number;
  allMatch: boolean;
  differences: number;
  books: CheckBook[];
  notMigrated: { folder: string; title: string; state: LegacyState; reason: NeedsReason | null }[];
  audioOnOldSync: { folder: string; title: string }[];
}

export interface DeviceReport {
  calibreLinks: { title: string; bookId: string; calibreUuid: string }[];
  localTitles: { title: string; hasBookmark: boolean; statDays: number }[];
}

export class MigrationApi {
  constructor(
    readonly serverUrl: string,
    private readonly token: string,
    readonly timeoutSeconds = 0,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)
  ) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await send(
      this.fetchImpl,
      `${this.serverUrl}/api/v1${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { timeoutSeconds: this.timeoutSeconds }
    );
    if (!response.ok) throw await errorFrom(response);
    return response.json() as Promise<T>;
  }

  overview(): Promise<MigrationOverview> {
    return this.request('GET', '/migration');
  }

  scan(): Promise<{ scan: ScanStatus }> {
    return this.request('POST', '/migration/scan', {});
  }

  report(report: DeviceReport): Promise<{ ok: true }> {
    return this.request('POST', '/migration/report', report);
  }

  link(folder: string, bookId: string): Promise<{ ok: true }> {
    return this.request('POST', '/migration/resolve', { folder, action: 'link', bookId });
  }

  defer(folder: string): Promise<{ ok: true }> {
    return this.request('POST', '/migration/resolve', { folder, action: 'defer' });
  }

  unlink(folder: string): Promise<{ ok: true }> {
    return this.request('POST', '/migration/resolve', { folder, action: 'unlink' });
  }

  import(): Promise<ImportResult> {
    return this.request('POST', '/migration/import', {});
  }

  check(): Promise<CheckResult> {
    return this.request('GET', '/migration/check');
  }
}
