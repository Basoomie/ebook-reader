/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { LibraryApiError } from '$lib/library/api';
import {
  describeError,
  firstLine,
  logKindText,
  logStatusText,
  secretStateText,
  WAIT_FIELDS
} from './notifications-text';

describe('notifications text', () => {
  it('says whether a secret is saved, never what it is', () => {
    expect(secretStateText(undefined)).toBe('Not saved yet');
    expect(secretStateText({ set: false, updatedAt: null })).toBe('Not saved yet');
    expect(secretStateText({ set: true, updatedAt: null })).toBe('Saved');
    expect(secretStateText({ set: true, updatedAt: Date.UTC(2026, 10, 18) })).toMatch(/^Saved .+/);
    expect(secretStateText({ set: false, updatedAt: null, unreadable: true })).toMatch(
      /enter it again/
    );
  });

  it('describes the log rows', () => {
    expect(logStatusText({ status: 'sent', attempts: 1, error: null })).toBe('Sent');
    expect(logStatusText({ status: 'pending', attempts: 0, error: null })).toBe('Waiting to send');
    expect(logStatusText({ status: 'pending', attempts: 1, error: 'Discord answered 500' })).toBe(
      'Waiting to try again (1 try so far): Discord answered 500'
    );
    expect(logStatusText({ status: 'failed', attempts: 3, error: 'Discord answered 500' })).toBe(
      'Failed after 3 tries: Discord answered 500'
    );
    expect(logKindText('now')).toBe('Alert');
    expect(logKindText('digest')).toBe('Daily summary');
    expect(firstLine('A failed\nBook\nhttp://x')).toBe('A failed');
    expect(firstLine('ッツ Reader: daily summary\n• one\n• two\n• three')).toBe(
      '• one (and 2 more)'
    );
  });

  it('has the five wait times with the server’s limits', () => {
    expect(WAIT_FIELDS.map((w) => w.key)).toEqual([
      'pcWaitingHours',
      'pcProblemMinutes',
      'applyHelperMinutes',
      'fetchHelperMinutes',
      'refusalQuietHours'
    ]);
  });

  it('turns errors into plain words', () => {
    expect(describeError(new LibraryApiError('unreachable', 'x'))).toMatch(/cannot be reached/);
    expect(describeError(new LibraryApiError('server', 'x', 404, 'not_found'))).toMatch(
      /update it/
    );
    expect(describeError(new LibraryApiError('server', 'x', 503, 'notifications_off'))).toBe(
      'Notifications are off on the server.'
    );
    expect(describeError(new Error('The digest time must look like 08:00'))).toBe(
      'The digest time must look like 08:00'
    );
  });
});
