/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writable, type Readable } from 'svelte/store';
import type { AudioLink } from '$lib/audio/audio-types';
import { LibraryApiError } from '$lib/library/api';
import { copyIsOf, linkedFile, type LinkedFileIdentity } from './audio-identity';
import {
  PIECE_SIZE,
  type AudioCopy,
  type AudioCopyError,
  type AudioOfflineStore
} from './audio-offline-db';

/**
 * Downloading a book's linked audio to this device (Season 2 Phase 9).
 *
 * One Range request per piece (`PIECE_SIZE`) against the link's signed play URL, the same
 * URL whispersync streams. The URL carries the file's version, so a file replaced on the
 * server answers 409 and the download stops instead of mixing two files. Each piece and
 * the record counting it are stored in one transaction, so a stop (lost connection, the
 * app closed, the phone asleep) loses at most one piece and "Continue" goes on from there.
 *
 * Lives for the whole app session (not the book page), so a download keeps going while
 * the user moves around the app. Never deletes anything by itself: pieces go only on
 * "Remove audio from this device", "Start again" or "Download the current audio".
 */

export interface DownloadDeps {
  store: AudioOfflineStore;
  /** The book's current link, fresh from the server (throws when it can't be reached). */
  link(bookId: string): Promise<AudioLink | null>;
  /** The link's confirmed subtitle file, or null. */
  subtitle(bookId: string): Promise<File | null>;
  /** The server address in front of a relative play URL. */
  absolute(url: string): Promise<string>;
  fetch: typeof fetch;
  /** A piece fails when no bytes arrive for this long (the library request time; 0 = never). */
  stallSeconds(): number;
  /** Free room as the browser says, or null when it can't say (then writing finds out). */
  estimate(): Promise<{ quota: number; usage: number } | null>;
  /** Asks for persistent storage (the user's setting decides; never throws). */
  persist(): Promise<void>;
  /** After a copy finished or was removed: publish this device's list (on:audio). */
  published(): Promise<void>;
  now(): number;
  isOnline(): boolean;
  log(message: string): void;
  /** Tests only: a smaller piece size (default PIECE_SIZE). */
  pieceSize?: number;
}

export interface CopyView {
  /** What is stored (null: nothing). */
  copy: AudioCopy | null;
  /** A download of this book is running in this tab. */
  running: boolean;
  /** A problem before anything was stored (no record to keep it on). */
  problem: AudioCopyError | null;
}

export type StartMode =
  /** Download or continue the linked file; a copy of another file is left alone. */
  | 'continue'
  /** Remove what is stored (another file, or a download whose file changed), then start. */
  | 'replace';

const EMPTY: CopyView = { copy: null, running: false, problem: null };

class PieceError extends Error {
  constructor(readonly reason: AudioCopyError) {
    super(reason);
  }
}

const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;

function contentTypeFor(fileName: string, header: string | null): string {
  if (header && /^audio\//i.test(header)) return header;
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4b' || ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
  return header || 'application/octet-stream';
}

function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function errorFromLink(error: unknown): AudioCopyError {
  if (error instanceof LibraryApiError) {
    if (error.kind === 'unreachable' || error.kind === 'timeout') return 'network';
  }
  return 'server';
}

export class AudioDownloads {
  private readonly views$ = writable<Record<string, CopyView>>({});
  private readonly runs = new Map<string, { controller: AbortController; stop: boolean }>();
  /** Books whose download stopped because the connection was lost (continue when online). */
  private readonly networkStopped = new Set<string>();

  constructor(private readonly deps: DownloadDeps) {}

  /** Every book's view (the book page reads its own). */
  get views(): Readable<Record<string, CopyView>> {
    return this.views$;
  }

  private setView(bookId: string, view: Partial<CopyView>): void {
    this.views$.update((all) => ({ ...all, [bookId]: { ...(all[bookId] ?? EMPTY), ...view } }));
  }

  isRunning(bookId: string): boolean {
    return this.runs.has(bookId);
  }

  /** Reads what is stored for the book into its view. */
  async refresh(bookId: string): Promise<AudioCopy | null> {
    const copy = (await this.deps.store.get(bookId)) ?? null;
    this.setView(bookId, { copy, running: this.runs.has(bookId) });
    return copy;
  }

  /**
   * Downloads (or continues) the book's linked audio. Resolves when the run ends: finished,
   * stopped by the user, or stopped by a problem (kept on the record, or in `problem`).
   */
  async start(bookId: string, mode: StartMode = 'continue'): Promise<void> {
    if (this.runs.has(bookId)) return;
    const run = { controller: new AbortController(), stop: false };
    this.runs.set(bookId, run);
    this.networkStopped.delete(bookId);
    this.setView(bookId, { running: true, problem: null });
    try {
      await this.download(bookId, mode, run);
    } catch (error) {
      this.deps.log(`Offline audio: ${(error as Error)?.message ?? error}`);
    } finally {
      this.runs.delete(bookId);
      await this.refresh(bookId).catch(() => undefined);
    }
  }

  /** Stops a running download; what is stored stays ("Continue download"). */
  stop(bookId: string): void {
    const run = this.runs.get(bookId);
    if (!run) return;
    run.stop = true;
    run.controller.abort();
  }

  /** Removes the book's audio from this device (stops a running download first). */
  async remove(bookId: string): Promise<void> {
    this.networkStopped.delete(bookId);
    const run = this.runs.get(bookId);
    if (run) {
      this.stop(bookId);
      await this.waitFor(bookId);
    }
    const had = await this.deps.store.get(bookId);
    await this.deps.store.delete(bookId);
    this.setView(bookId, { copy: null, running: false, problem: null });
    if (had?.complete) await this.deps.published();
  }

  /** The connection is back: continue the downloads it stopped (not those the user stopped). */
  onOnline(): void {
    for (const bookId of [...this.networkStopped]) void this.start(bookId);
  }

  private async waitFor(bookId: string): Promise<void> {
    while (this.runs.has(bookId)) await new Promise((r) => setTimeout(r, 20));
  }

  private async stopWith(
    bookId: string,
    copy: AudioCopy | null,
    error: AudioCopyError,
    bytesNeeded: number | null = null
  ): Promise<void> {
    if (error === 'network') this.networkStopped.add(bookId);
    if (!copy) {
      this.setView(bookId, { problem: error });
      return;
    }
    await this.deps.store.put({ ...copy, stoppedBy: 'error', error, bytesNeeded });
  }

  private async download(
    bookId: string,
    mode: StartMode,
    run: { controller: AbortController; stop: boolean }
  ): Promise<void> {
    const { deps } = this;
    let stored = (await deps.store.get(bookId)) ?? null;
    if (!deps.isOnline()) return this.stopWith(bookId, stored, 'network');

    let link: AudioLink | null;
    try {
      link = await deps.link(bookId);
    } catch (error) {
      return this.stopWith(bookId, stored, errorFromLink(error));
    }
    const file = linkedFile(link);
    if (!link || !file || !link.playUrl) return this.stopWith(bookId, stored, 'missing');

    if (stored && (mode === 'replace' || !copyIsOf(stored, file))) {
      // 'continue' never replaces another file's copy (the page offers "Download the
      // current audio" for that, which asks first).
      if (mode !== 'replace') return;
      await deps.store.delete(bookId);
      stored = null;
    }
    if (stored?.complete) return;

    let copy: AudioCopy = stored ?? this.newCopy(bookId, file);
    copy = { ...copy, stoppedBy: null, error: null, bytesNeeded: null };

    const remaining = copy.size - copy.bytesDone;
    const room = await deps.estimate().catch(() => null);
    if (room && room.quota - room.usage < remaining) {
      await deps.store.put(copy);
      return this.stopWith(bookId, copy, 'space', remaining - Math.max(0, room.quota - room.usage));
    }
    await deps.persist().catch(() => undefined);
    copy = await this.keepSubtitle(copy, link);
    await deps.store.put(copy);
    this.setView(bookId, { copy });

    const url = await deps.absolute(link.playUrl);
    while (copy.bytesDone < copy.size) {
      if (run.stop) break;
      const start = copy.piecesDone * copy.pieceSize;
      const end = Math.min(start + copy.pieceSize, copy.size) - 1;
      let piece: { bytes: Uint8Array; contentType: string | null };
      try {
        piece = await this.fetchPiece(url, start, end, copy.size, run.controller.signal);
      } catch (error) {
        if (run.stop) break;
        const reason = error instanceof PieceError ? error.reason : 'network';
        return this.stopWith(bookId, copy, reason);
      }
      const next: AudioCopy = {
        ...copy,
        contentType:
          copy.piecesDone === 0
            ? contentTypeFor(copy.fileName, piece.contentType)
            : copy.contentType,
        piecesDone: copy.piecesDone + 1,
        bytesDone: copy.bytesDone + piece.bytes.byteLength
      };
      try {
        await deps.store.putPiece(
          next,
          copy.piecesDone,
          new Blob([piece.bytes as Uint8Array<ArrayBuffer>])
        );
      } catch (error) {
        if (isQuotaError(error))
          return this.stopWith(bookId, copy, 'space', copy.size - copy.bytesDone);
        throw error;
      }
      copy = next;
      this.setView(bookId, { copy });
    }

    if (run.stop) {
      await deps.store.put({ ...copy, stoppedBy: 'user' });
      return;
    }
    await deps.store.put({ ...copy, complete: true, completedAt: deps.now() });
    await deps.published();
  }

  private newCopy(bookId: string, file: LinkedFileIdentity): AudioCopy {
    return {
      bookId,
      folderRelPath: file.folderRelPath,
      fileName: file.fileName,
      version: file.version,
      size: file.size,
      contentType: contentTypeFor(file.fileName, null),
      pieceSize: this.deps.pieceSize ?? PIECE_SIZE,
      piecesDone: 0,
      bytesDone: 0,
      complete: false,
      stoppedBy: null,
      error: null,
      bytesNeeded: null,
      subtitle: null,
      startedAt: this.deps.now(),
      completedAt: null
    };
  }

  /** Keeps the link's confirmed subtitle file with the copy (whispersync needs it offline). */
  private async keepSubtitle(copy: AudioCopy, link: AudioLink): Promise<AudioCopy> {
    if (link.subtitleState !== 'linked' || link.subtitleStatus !== 'ok' || !link.subtitleRelPath) {
      return copy;
    }
    if (copy.subtitle?.relPath === link.subtitleRelPath) return copy;
    try {
      const file = await this.deps.subtitle(copy.bookId);
      if (!file) return copy;
      return { ...copy, subtitle: { relPath: link.subtitleRelPath, name: file.name, blob: file } };
    } catch (error) {
      this.deps.log(`Offline audio: subtitles not kept: ${(error as Error)?.message ?? error}`);
      return copy;
    }
  }

  private async fetchPiece(
    url: string,
    start: number,
    end: number,
    size: number,
    outer: AbortSignal
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    outer.addEventListener('abort', abort);
    const stallMs = Math.max(0, this.deps.stallSeconds()) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (!stallMs) return;
      clearTimeout(timer);
      timer = setTimeout(abort, stallMs);
    };
    try {
      arm();
      const response = await this.deps.fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller.signal,
        cache: 'no-store'
      });
      if (response.status === 409) throw new PieceError('changed');
      if (response.status === 404 || response.status === 410) throw new PieceError('missing');
      if (response.status !== 206) throw new PieceError('server');
      const range = CONTENT_RANGE.exec(response.headers.get('Content-Range') ?? '');
      if (!range || +range[1] !== start || +range[2] !== end || +range[3] !== size) {
        throw new PieceError(range && +range[3] !== size ? 'changed' : 'server');
      }
      const length = end - start + 1;
      const bytes = new Uint8Array(length);
      let offset = 0;
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          if (offset + value.byteLength > length) throw new PieceError('server');
          bytes.set(value, offset);
          offset += value.byteLength;
        }
      } else {
        const all = new Uint8Array(await response.arrayBuffer());
        if (all.byteLength > length) throw new PieceError('server');
        bytes.set(all);
        offset = all.byteLength;
      }
      // A body cut short is a lost connection: the piece is fetched again on Continue.
      if (offset !== length) throw new PieceError('network');
      return { bytes, contentType: response.headers.get('Content-Type') };
    } finally {
      clearTimeout(timer);
      outer.removeEventListener('abort', abort);
    }
  }
}
