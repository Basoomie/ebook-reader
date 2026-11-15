/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { database } from '$lib/data/store';
import { localIdsOfBook } from '$lib/library/device-books';
import { getLibraryStore } from '$lib/library/library-db';
import { collectIllustrations, storedCoverKey } from './collect';
import type { GalleryPicture } from './types';

/**
 * Season 2 §6: a book's illustrations from the copy stored on this device (the reader's
 * own `data` row: its imported HTML and images), online and offline alike. The pictures
 * are object URLs of the stored images: call `release()` when the page is left.
 */
export interface LocalGallery {
  pictures: GalleryPicture[];
  /** The stored cover image, for the expanded view; null when the book has none. */
  coverSrc: string | null;
  release(): void;
}

/** Same type rule as the reader (BaseStorageHandler.getImageMimeTypeFromExtension). */
function imageType(key: string): string {
  const extension = key.split('.').pop()?.toLowerCase() || '';
  if (extension === 'svg') return 'image/svg+xml';
  if (['png', 'gif', 'bmp', 'webp'].includes(extension)) return `image/${extension}`;
  return 'image/jpeg';
}

/** The local copy's gallery, or null when the book isn't stored on this device. */
export async function localGallery(bookId: string): Promise<LocalGallery | null> {
  const [links, keys] = await Promise.all([
    getLibraryStore().getAllLinks(),
    database.db.then((db) => db.getAllKeys('data'))
  ]);
  const [localId] = localIdsOfBook(links, new Set(keys), bookId);
  if (localId === undefined) return null;
  const data = await database.getData(localId);
  if (!data) return null;

  // An inert document: nothing in it loads or runs.
  const doc = new DOMParser().parseFromString('<!DOCTYPE html><body></body>', 'text/html');
  const root = doc.createElement('div');
  root.innerHTML = data.elementHtml;
  const blobs = data.blobs ?? {};
  const coverKey = await storedCoverKey(blobs, data.coverImage);
  const items = await collectIllustrations(root, blobs, coverKey);

  const urls: string[] = [];
  const urlOf = (blob: Blob, key: string) => {
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: imageType(key) }));
    urls.push(url);
    return url;
  };
  const pictures = items.map((item) => {
    const src = urlOf(blobs[item.key], item.key);
    return {
      beforeToc: item.beforeToc,
      width: item.width,
      height: item.height,
      thumbSrc: src,
      fullSrc: src
    };
  });
  const coverSrc = data.coverImage instanceof Blob ? urlOf(data.coverImage, coverKey ?? '') : null;

  return {
    pictures,
    coverSrc,
    release: () => urls.forEach((url) => URL.revokeObjectURL(url))
  };
}
