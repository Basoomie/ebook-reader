/**
 * The character counter bundle (WP3b, design R1): vendor/epub-count.cjs, built by
 * `pnpm build:server-counter` in apps/web from the reader's own EPUB import and
 * counting code. A web test fails when the committed file is out of date.
 */
import { closeSync, openSync, readSync } from 'fs';
import path from 'path';
import type { CountsConfig } from '../config';

/** From src/counts (ts-node) and dist/counts (Docker) alike: <package>/vendor. */
export const COUNTER_BUNDLE = path.resolve(__dirname, '..', '..', 'vendor', 'epub-count.cjs');

export interface CounterInfo {
  file: string;
  /** EPUB_COUNT_VERSION: the counting rules. Part of the spec; a change recounts every book. */
  version: number;
  /** Bundle build id, for diagnostics only. */
  build: string;
}

/** Reads the bundle's header without loading it (loading pulls in jsdom). */
export function readCounterInfo(file: string = COUNTER_BUNDLE): CounterInfo {
  const fd = openSync(file, 'r');
  let header: string;
  try {
    const buffer = Buffer.alloc(2048);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    header = buffer.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
  const version = /epub-count-version: (\d+)/.exec(header);
  const build = /build: ([0-9a-f]+)/.exec(header);
  if (!version || !build) throw new Error(`${file} has no counter header (rebuild it)`);
  return { file, version: Number(version[1]), build: build[1] };
}

/** The import settings the counter is given (the reader's EpubHtmlImportOptions). */
export interface CountImportOptions {
  importHTMLFixMode: CountsConfig['importFixMode'];
  restrictImportFixToAnchor: boolean;
}

export function countImportOptions(config: CountsConfig): CountImportOptions {
  return {
    importHTMLFixMode: config.importFixMode,
    restrictImportFixToAnchor: config.restrictFixToAnchor,
  };
}

/**
 * What a stored count was made with: counting rules plus import settings, e.g.
 * 'v1|Off|anchor'. A count with another spec is out of date.
 */
export function countSpec(version: number, config: CountsConfig): string {
  return `v${version}|${config.importFixMode}|${config.restrictFixToAnchor ? 'anchor' : 'all'}`;
}
