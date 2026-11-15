/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { timeAgo } from '$lib/audio/audio-link';
import { workerJobTitle } from '$lib/audio/tts-text';
import { LibraryApiError } from '$lib/library/api';
import type { DiagnosticsPcWorker } from './diagnostics-api';

/** Settings > Diagnostics (Season 2 §7): the page's words, as plain functions. */

/** Storage figures and persistent storage exist only in a secure context (https). */
export const NOT_OVER_HTTP =
  'Not available over http: the browser shows this only at an https address.';

export const NOT_CONNECTED = "This device isn't connected to a library server.";

/** Keeps "42 %" on one line. */
const NBSP = String.fromCharCode(0xa0);

/** "0 B", "980 KB", "1.2 GB", "54 GB" (1024-based, as browsers and file managers count). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${units[unit]}`;
}

/** "1.2 GB of 54 GB"; null when the browser gave no figures. */
export function storageUsedText(estimate: { usage?: number; quota?: number }): string | null {
  const { usage, quota } = estimate;
  if (typeof usage !== 'number' || typeof quota !== 'number' || quota <= 0) return null;
  return `${formatBytes(usage)} of ${formatBytes(quota)}`;
}

/**
 * The time a build was made, from SvelteKit's build version (its build time in ms) or
 * the server's build time; null for anything that isn't one.
 */
export function buildDate(version: string | number | null | undefined): Date | null {
  const ms =
    typeof version === 'number' ? version : /^\d+$/.test(version ?? '') ? Number(version) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

export function deviceName(name: string | null | undefined): string {
  return name?.trim() || 'Unnamed device';
}

/** "5 min ago"; "Never" when there is no time. */
export function lastSeenText(at: number | null | undefined, now: number): string {
  return at ? timeAgo(at, now) : 'Never';
}

/** On, Off, Paused or not set up, with the problem the PC reported (as Settings > Audiobooks). */
export function pcWorkerStateText(w: DiagnosticsPcWorker): string {
  if (!w.available) return 'Not set up on the server (no audiobooks folder).';
  if (w.paused) return 'Paused: the PC takes no new jobs.';
  if (!w.online) return w.lastSeenAt ? 'Off.' : 'Not set up yet: no PC has checked in.';
  if (w.problem) return `On, but: ${w.problem.replace(/\.$/, '')}.`;
  return 'On.';
}

/** "“羊と鋼の森” · 42 %"; "None" when nothing runs. */
export function currentJobText(w: DiagnosticsPcWorker): string {
  if (!w.available || !w.currentJob) return 'None';
  const job = w.currentJob;
  const progress =
    typeof job.progress === 'number'
      ? ` · ${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}${NBSP}%`
      : '';
  return `“${workerJobTitle(job)}”${progress}`;
}

/** Why the server's figures couldn't be read. */
export function serverErrorText(err: unknown): string {
  if (err instanceof LibraryApiError) {
    if (err.kind === 'unreachable' || err.kind === 'timeout') {
      return "The library server can't be reached (offline, or the server is down).";
    }
    if (err.kind === 'unauthorized') {
      return "The library server didn't accept this device. Connect it again in Settings > Data.";
    }
    if (err.status === 404) {
      return "The library server doesn't have this page yet (it runs an older version).";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
