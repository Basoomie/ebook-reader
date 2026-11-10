/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { LibraryApiError, type LibraryApi } from './api';
import type { CatalogBook, DuplicateMatch, StagedUpload } from './types';

/**
 * Uploading EPUBs (WP7b, decided with the user): the library is asked on every upload
 * (by the page, before this runs); each file is sent, checked for duplicates on the
 * server and then added, or, when it looks like a book already in the library, the
 * user decides: use the library copy (the upload is dropped), add it as a separate
 * book, or cancel. Nothing is ever merged automatically.
 */

export type UploadDecision = 'use' | 'add' | 'cancel';

export type UploadResult =
  | { name: string; status: 'added'; book: CatalogBook }
  | { name: string; status: 'used-copy'; book: CatalogBook }
  | { name: string; status: 'cancelled' }
  | { name: string; status: 'failed'; message: string };

export interface UploadFlowDeps {
  api: Pick<LibraryApi, 'uploadEpub' | 'addUpload' | 'discardUpload'>;
  /** The server's limit (0 = unknown: the server decides). */
  maxBytes: number;
  askDuplicate(staged: StagedUpload): Promise<UploadDecision>;
  onProgress(index: number, name: string, loaded: number, total: number): void;
  signal: AbortSignal;
}

export const MATCH_LABELS: Record<DuplicateMatch, string> = {
  'same-file': 'The same file',
  fingerprint: 'The same book (contents match)',
  'title-author': 'Same title and author'
};

export function isEpubFile(file: { name: string; type: string }): boolean {
  return /\.epub$/i.test(file.name) || file.type === 'application/epub+zip';
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function failure(error: unknown): string {
  if (error instanceof LibraryApiError) {
    if (error.kind === 'unreachable' || error.kind === 'timeout') {
      return "The library server can't be reached.";
    }
    if (error.code === 'bad_epub') return "This file can't be read as an EPUB.";
    if (error.code === 'too_large') return "It's larger than the server's upload limit.";
    if (error.code === 'library_disabled') return 'That library is switched off.';
    if (error.code === 'upload_expired') return 'The server forgot this upload; upload it again.';
  }
  return (error as Error).message;
}

function aborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof LibraryApiError && error.kind === 'aborted');
}

export async function uploadFiles(
  files: readonly File[],
  libraryId: string,
  deps: UploadFlowDeps
): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (const [index, file] of files.entries()) {
    const name = file.name;
    if (deps.signal.aborted) {
      results.push({ name, status: 'cancelled' });
      continue;
    }
    if (!isEpubFile(file)) {
      results.push({ name, status: 'failed', message: 'Only EPUB files can be uploaded.' });
      continue;
    }
    if (deps.maxBytes > 0 && file.size > deps.maxBytes) {
      results.push({
        name,
        status: 'failed',
        message: `It's larger than the server's upload limit (${megabytes(deps.maxBytes)}).`
      });
      continue;
    }
    let staged: StagedUpload;
    try {
      deps.onProgress(index, name, 0, file.size);
      staged = await deps.api.uploadEpub(file, name, libraryId, {
        signal: deps.signal,
        onProgress: (loaded, total) => deps.onProgress(index, name, loaded, total)
      });
    } catch (error) {
      results.push(
        aborted(error, deps.signal)
          ? { name, status: 'cancelled' }
          : { name, status: 'failed', message: failure(error) }
      );
      continue;
    }
    try {
      const decision = staged.duplicates.length ? await deps.askDuplicate(staged) : 'add';
      if (decision === 'add') {
        const { book } = await deps.api.addUpload(staged.uploadId);
        results.push({ name, status: 'added', book });
      } else {
        await deps.api.discardUpload(staged.uploadId).catch(() => {
          // Left for the server's clean-up of staged files.
        });
        results.push(
          decision === 'use'
            ? { name, status: 'used-copy', book: staged.duplicates[0].book }
            : { name, status: 'cancelled' }
        );
      }
    } catch (error) {
      results.push({ name, status: 'failed', message: failure(error) });
    }
  }
  return results;
}
