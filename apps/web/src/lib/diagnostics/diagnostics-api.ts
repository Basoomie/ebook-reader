/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { SubtitleJob } from '$lib/audio/audio-types';
import type { AudiobookJob } from '$lib/audio/tts-types';
import { errorFrom, send } from '$lib/library/api';

/** Settings > Diagnostics (Season 2 §7): the server's GET /api/v1/diagnostics. */

export interface DiagnosticsDevice {
  id: string;
  /** '' when the device never sent a name. */
  name: string;
  /** When the device was first paired (tells devices with the same name apart). */
  createdAt: number;
  /**
   * The last time the device synced (register, push or pull), server time. The server
   * lists only devices that synced at least once (not its own pseudo-devices).
   */
  lastSeenAt: number | null;
  /** The device this token belongs to. */
  current: boolean;
}

export type DiagnosticsPcWorker =
  | { available: false }
  | {
      available: true;
      online: boolean;
      paused: boolean;
      lastSeenAt: number | null;
      problem: string | null;
      version: string | null;
      currentJob: SubtitleJob | AudiobookJob | null;
      waiting: number;
    };

export type DiagnosticsCleanupHelper =
  | { available: false }
  | { available: true; online: boolean; lastSeenAt: number | null };

/** Notifications N1: what is still wrong, and what was sent. */
export interface DiagnosticsOpenProblem {
  event: string;
  label: string;
  summary: string | null;
  /** Longer text (e.g. the Calibre indexer's whole warning). */
  detail: string | null;
  since: number;
  noticedAt: number | null;
}

export interface DiagnosticsNotificationLog {
  id: number;
  at: number;
  createdAt: number;
  channel: 'discord' | 'email';
  kind: 'now' | 'digest' | 'test';
  event: string;
  label: string;
  text: string;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  error: string | null;
}

export type DiagnosticsNotifications =
  | { available: false }
  | {
      available: true;
      channels: { discord: boolean; email: boolean };
      secretsUnreadable: boolean;
      openProblems: DiagnosticsOpenProblem[];
      log: DiagnosticsNotificationLog[];
    };

export interface DiagnosticsResponse {
  serverTime: number;
  server: { version: string; builtAt: number | null; schemaVersion: number };
  devices: DiagnosticsDevice[];
  pcWorker: DiagnosticsPcWorker;
  cleanupHelper: DiagnosticsCleanupHelper;
  /** Missing from a server before notifications. */
  notifications?: DiagnosticsNotifications;
}

export async function fetchDiagnostics(
  connection: { serverUrl: string; token: string },
  timeoutSeconds = 0,
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): Promise<DiagnosticsResponse> {
  const response = await send(
    fetchImpl,
    `${connection.serverUrl}/api/v1/diagnostics`,
    { method: 'GET', headers: { Authorization: `Bearer ${connection.token}` } },
    { timeoutSeconds }
  );
  if (!response.ok) throw await errorFrom(response);
  return response.json() as Promise<DiagnosticsResponse>;
}
