/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { LibraryApiError } from '$lib/library/api';
import { formatWhen } from '$lib/notes/notes-format';
import type {
  NotificationChannel,
  NotificationSecretInfo,
  NotificationWaits
} from './notifications-api';

/** Settings > Notifications and its Diagnostics sections: the words. */

export const CHANNEL_NAMES: Record<NotificationChannel, string> = {
  discord: 'Discord',
  email: 'Email'
};

export function secretStateText(info: NotificationSecretInfo | undefined): string {
  if (info?.unreadable) return 'Saved, but it can’t be read on the server any more: enter it again';
  if (!info?.set) return 'Not saved yet';
  return info.updatedAt ? `Saved ${formatWhen(info.updatedAt)}` : 'Saved';
}

export const WAIT_FIELDS: {
  key: keyof NotificationWaits;
  label: string;
  unit: 'hours' | 'minutes';
  min: number;
  max: number;
}[] = [
  {
    key: 'pcWaitingHours',
    label: 'Jobs waiting while the PC is off or paused',
    unit: 'hours',
    min: 1,
    max: 168
  },
  {
    key: 'pcProblemMinutes',
    label: 'A Docker problem on the PC while it is on',
    unit: 'minutes',
    min: 1,
    max: 1440
  },
  {
    key: 'applyHelperMinutes',
    label: 'The cleanup’s apply helper offline',
    unit: 'minutes',
    min: 1,
    max: 1440
  },
  {
    key: 'fetchHelperMinutes',
    label: 'The fetch helper offline or with a problem while stage 4 has work',
    unit: 'minutes',
    min: 1,
    max: 1440
  },
  {
    key: 'refusalQuietHours',
    label: 'Refused changes count as over after this long without another',
    unit: 'hours',
    min: 1,
    max: 168
  }
];

export function describeError(err: unknown): string {
  if (err instanceof LibraryApiError) {
    if (err.kind === 'unreachable' || err.kind === 'timeout') {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    if (err.status === 404) return 'The library server is too old for notifications: update it.';
    if (err.code === 'notifications_off') return 'Notifications are off on the server.';
  }
  return (err as Error).message;
}

/** The log's status column: "Sent", "Waiting to send (try 2)", "Failed after 3 tries: …". */
export function logStatusText(row: {
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  error: string | null;
}): string {
  if (row.status === 'sent') return 'Sent';
  if (row.status === 'pending') {
    return row.attempts > 0
      ? `Waiting to try again (${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'} so far): ${row.error ?? ''}`
      : 'Waiting to send';
  }
  return `Failed after ${row.attempts} ${row.attempts === 1 ? 'try' : 'tries'}${row.error ? `: ${row.error}` : ''}`;
}

/** A message's first line (what happened); a daily summary's first item after its title. */
export function firstLine(text: string): string {
  const lines = text.split('\n');
  return lines[0] === 'ッツ Reader: daily summary' && lines[1]
    ? `${lines[1]}${lines.length > 2 ? ` (and ${lines.length - 2} more)` : ''}`
    : lines[0];
}

/** The log's kind column. */
export function logKindText(kind: 'now' | 'digest' | 'test' | 'report'): string {
  if (kind === 'report') return 'Stats';
  return kind === 'now' ? 'Alert' : kind === 'digest' ? 'Daily summary' : 'Test';
}
