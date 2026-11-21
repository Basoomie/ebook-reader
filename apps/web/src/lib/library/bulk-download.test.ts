/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import { largeDownloadCopy } from '$lib/confirm/confirm-copy';
import { needsSizeConfirm, progressView, totalSizeLabel } from './bulk-download';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

describe('select mode downloads', () => {
  it('labels a total, marking unknown sizes with +', () => {
    expect(totalSizeLabel({ count: 0, bytes: 0, unknown: 0 })).toBe('');
    expect(totalSizeLabel({ count: 3, bytes: 12.4 * MB, unknown: 0 })).toBe('12.4 MB');
    expect(totalSizeLabel({ count: 3, bytes: 7.25 * GB, unknown: 1 })).toBe('7.3 GB+');
    expect(totalSizeLabel({ count: 2, bytes: 0, unknown: 2 })).toBe('');
  });

  it('asks first only above the threshold (0 = never)', () => {
    expect(needsSizeConfirm(5 * GB, 5)).toBe(false);
    expect(needsSizeConfirm(5 * GB + 1, 5)).toBe(true);
    expect(needsSizeConfirm(100 * GB, 0)).toBe(false);
    expect(needsSizeConfirm(2 * GB, 1.5)).toBe(true);
    expect(needsSizeConfirm(2 * GB, Number('x'))).toBe(false);
  });

  it('shows the time left only once there is a pace', () => {
    const start = 1_000_000;
    expect(progressView(0, 10, start, start + 5000)).toEqual({ percent: 0, timeLeft: '' });
    expect(progressView(5, 10, start, start + 1000)).toEqual({ percent: 50, timeLeft: '' });
    expect(progressView(1, 10, start, start + 20_000)).toEqual({
      percent: 10,
      timeLeft: '3 min left'
    });
    expect(progressView(10, 10, start, start + 20_000)).toEqual({ percent: 100, timeLeft: '' });
  });

  it('says what a large download is before it starts', () => {
    const copy = largeDownloadCopy({ what: 'audiobooks', count: 12, size: '7.3 GB', zip: true });
    expect(copy.title).toBe('Download 7.3 GB?');
    expect(copy.message[0]).toBe('12 audiobooks, 7.3 GB in all. They arrive as one ZIP file.');
    expect(copy.confirmLabel).toBe('Download 7.3 GB');
    expect(copy.danger).toBe(false);
  });
});
