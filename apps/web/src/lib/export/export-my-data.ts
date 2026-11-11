/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { localStamp } from '$lib/functions/download-blob';
import { LibraryApiError } from '$lib/library/api';

/**
 * "Export my data" (WP18). The server holds everything synced for the user, so the file
 * comes from there as it is (a device's own copy may be behind). Nothing is written on
 * this device.
 */

export interface ExportDeps {
  /** The API client for this device's connection, or null when not connected. */
  api: () => Promise<{ exportMyData(options?: { signal?: AbortSignal }): Promise<string> } | null>;
  save: (blob: Blob, fileName: string) => void;
  now?: () => Date;
  signal?: AbortSignal;
}

export type ExportResult =
  | { ok: true; fileName: string; records: number; bytes: number }
  | { ok: false; message: string };

export async function exportMyData(deps: ExportDeps): Promise<ExportResult> {
  let api;
  try {
    api = await deps.api();
  } catch {
    api = null;
  }
  if (!api) {
    return {
      ok: false,
      message:
        'This device is not connected to the library server. Connect it on the Library page first.'
    };
  }
  let text: string;
  try {
    text = await api.exportMyData({ signal: deps.signal });
  } catch (error) {
    if (error instanceof LibraryApiError && error.kind === 'unauthorized') {
      return {
        ok: false,
        message: 'The library server no longer accepts this device. Pair it again.'
      };
    }
    return { ok: false, message: `Could not get your data: ${(error as Error)?.message ?? error}` };
  }
  let records = 0;
  try {
    const parsed = JSON.parse(text) as { format?: string; records?: Record<string, unknown[]> };
    if (parsed.format !== 'ttsu-reader-export' || !parsed.records) throw new Error('format');
    records = Object.values(parsed.records).reduce((n, list) => n + list.length, 0);
  } catch {
    return { ok: false, message: 'The library server sent something that is not an export.' };
  }
  const fileName = `ttsu-export-${localStamp((deps.now ?? (() => new Date()))())}.json`;
  const blob = new Blob([text], { type: 'application/json' });
  deps.save(blob, fileName);
  return { ok: true, fileName, records, bytes: blob.size };
}
