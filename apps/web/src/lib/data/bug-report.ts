/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { redactValue } from '$lib/data/redact';
import type { RecentServerLogs } from '$lib/library/api';

/**
 * The bug-report bundle (WP18): this device's report (browser, settings, log, sync state)
 * plus the server's recent log lines, as one file the user downloads. Tokens and pairing
 * codes are always removed. Nothing is sent anywhere; the server's lines are only read.
 */

export const BUG_REPORT_FORMAT = 'ttsu-bug-report';
export const BUG_REPORT_FORMAT_VERSION = 1;

export type ServerPart =
  | ({ included: true } & RecentServerLogs)
  | { included: false; reason: string };

export interface BugReportDeps {
  /** What the dialog was opened with. */
  title: string;
  message: string;
  /** Browser, screen and settings of this device. */
  device: () => unknown;
  /** This device's log (`logger.history`). */
  log: () => unknown;
  /** Sync state: device id, last sync, pending and refused changes; null without sync. */
  sync: () => Promise<unknown>;
  /** The server's recent lines; null when this device isn't connected. */
  serverLogs: (signal: AbortSignal) => Promise<RecentServerLogs | null>;
  /** Exact values to remove (this device's stored tokens). */
  secrets: () => Promise<(string | null | undefined)[]>;
  /** How long to wait for the server (seconds; 0 = no limit). */
  serverTimeoutSeconds: number;
  now?: () => Date;
}

const message = (error: unknown) => (error as Error)?.message ?? String(error);

async function serverPart(deps: BugReportDeps): Promise<ServerPart> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ServerPart>((resolve) => {
    if (!(deps.serverTimeoutSeconds > 0)) return;
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        included: false,
        reason: `The library server did not answer within ${deps.serverTimeoutSeconds} seconds`
      });
    }, deps.serverTimeoutSeconds * 1000);
  });
  const read = (async (): Promise<ServerPart> => {
    try {
      const logs = await deps.serverLogs(controller.signal);
      if (!logs) return { included: false, reason: 'This device is not connected to a server' };
      return { included: true, ...logs };
    } catch (error) {
      return { included: false, reason: `Could not read the server's log: ${message(error)}` };
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function safely<T>(part: () => T | Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await part();
  } catch (error) {
    return { unavailable: message(error) };
  }
}

/** Builds the redacted bundle. Never throws; a part that fails says why instead. */
export async function buildBugReport(deps: BugReportDeps): Promise<Record<string, unknown>> {
  const now = (deps.now ?? (() => new Date()))();
  const [device, log, sync, server, secrets] = await Promise.all([
    safely(deps.device),
    safely(deps.log),
    safely(deps.sync),
    serverPart(deps),
    deps.secrets().catch(() => [] as string[])
  ]);
  const report = {
    format: BUG_REPORT_FORMAT,
    formatVersion: BUG_REPORT_FORMAT_VERSION,
    createdAt: now.toISOString(),
    about:
      "This device's report and the server's recent log. Tokens and pairing codes were " +
      'removed. Nothing was sent anywhere; you choose who gets this file.',
    title: deps.title,
    message: deps.message,
    device,
    sync,
    log,
    server
  };
  return redactValue(report, { secrets });
}
