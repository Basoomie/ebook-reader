/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * Downloaded audiobooks (Season 2 Phase 9, "Offline audio"): a book's linked audio file
 * kept on this device so whispersync plays it without the server.
 *
 * Its own IndexedDB database (as `ttsu-library-offline` and `ttsu-fonts`), so an older
 * build never meets a schema it doesn't know. IndexedDB because it is the only storage a
 * page has over plain http too (no OPFS, Cache Storage or service worker there; downloads
 * are offered only at an https address, but the code path is the same everywhere).
 *
 * The file is stored in pieces of `PIECE_SIZE` bytes, one Range request each, so a stopped
 * download continues from the last stored piece and memory stays at one piece. Playback
 * joins the pieces into one Blob (they stay on disk) and plays its blob: URL.
 */
export const AUDIO_OFFLINE_DB_NAME = 'ttsu-audio-offline';

/** 8 MiB: a 2 GB audiobook is 256 pieces; a stop loses at most one piece. */
export const PIECE_SIZE = 8 * 1024 * 1024;

/** Why a download stopped without finishing (shown on the book page). */
export type AudioCopyError =
  /** The connection was lost, or the server stopped answering (continues by itself). */
  | 'network'
  /** The file on the server changed since the download began (409). */
  | 'changed'
  /** The file can't be found on the server any more (404, 410, or no playable link). */
  | 'missing'
  /** The device has no room for the rest. */
  | 'space'
  /** Any other answer from the server. */
  | 'server';

export interface StoredSubtitle {
  /** The link's subtitle path when it was stored. */
  relPath: string;
  name: string;
  blob: Blob;
}

/** One downloaded (or partly downloaded) audio file. Keyed by library book id. */
export interface AudioCopy {
  bookId: string;
  /** The link the copy was made from: folder, file and the file's version on the server. */
  folderRelPath: string;
  fileName: string;
  version: string;
  size: number;
  contentType: string;
  pieceSize: number;
  /** Pieces 0..piecesDone-1 are stored. */
  piecesDone: number;
  bytesDone: number;
  complete: boolean;
  /** How the last run ended without finishing (null: running, finished or never stopped). */
  stoppedBy: 'user' | 'error' | null;
  error: AudioCopyError | null;
  /** 'space': the bytes that were still missing. */
  bytesNeeded: number | null;
  /** The linked subtitle file, so whispersync follows the text without the server too. */
  subtitle: StoredSubtitle | null;
  startedAt: number;
  completedAt: number | null;
}

interface AudioOfflineSchema extends DBSchema {
  files: { key: string; value: AudioCopy };
  /** Key [bookId, piece index]. */
  pieces: { key: [string, number]; value: Blob };
}

export function createAudioOfflineDb(name = AUDIO_OFFLINE_DB_NAME) {
  return openDB<AudioOfflineSchema>(name, 1, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('files', { keyPath: 'bookId' });
        db.createObjectStore('pieces');
      }
    }
  });
}

function piecesOf(bookId: string): IDBKeyRange {
  return IDBKeyRange.bound([bookId, 0], [bookId, Infinity]);
}

export class AudioOfflineStore {
  private dbPromise: Promise<IDBPDatabase<AudioOfflineSchema>> | undefined;

  constructor(private readonly open: () => Promise<IDBPDatabase<AudioOfflineSchema>>) {}

  private get db() {
    this.dbPromise ??= this.open();
    return this.dbPromise;
  }

  async get(bookId: string): Promise<AudioCopy | undefined> {
    return (await this.db).get('files', bookId);
  }

  async getAll(): Promise<AudioCopy[]> {
    return (await this.db).getAll('files');
  }

  async put(copy: AudioCopy): Promise<void> {
    await (await this.db).put('files', copy);
  }

  /** Stores piece `index` and the record that counts it, in one transaction. */
  async putPiece(copy: AudioCopy, index: number, piece: Blob): Promise<void> {
    const tx = (await this.db).transaction(['files', 'pieces'], 'readwrite');
    await Promise.all([
      tx.objectStore('pieces').put(piece, [copy.bookId, index]),
      tx.objectStore('files').put(copy),
      tx.done
    ]);
  }

  /** The stored pieces in order (Blobs backed by the browser's files, not loaded). */
  async pieces(bookId: string): Promise<Blob[]> {
    return (await this.db).getAll('pieces', piecesOf(bookId));
  }

  /** The record and every piece of the book. */
  async delete(bookId: string): Promise<void> {
    const tx = (await this.db).transaction(['files', 'pieces'], 'readwrite');
    await Promise.all([
      tx.objectStore('pieces').delete(piecesOf(bookId)),
      tx.objectStore('files').delete(bookId),
      tx.done
    ]);
  }

  /** Pieces stored without a record that counts them (a write cut short); test aid. */
  async pieceCount(bookId: string): Promise<number> {
    return (await this.db).count('pieces', piecesOf(bookId));
  }
}

let shared: AudioOfflineStore | undefined;

/** The app's store of downloaded audio (browser only). */
export function getAudioOfflineStore(): AudioOfflineStore {
  shared ??= new AudioOfflineStore(() => createAudioOfflineDb());
  return shared;
}
