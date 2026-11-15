/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/** GET /books/:id/illustrations (storage server, api/illustration-routes.ts). */
export type ServerIllustrationList =
  | {
      status: 'ready';
      items: {
        n: number;
        width: number | null;
        height: number | null;
        beforeToc: boolean;
        /** Signed, relative to the server. */
        thumbUrl: string;
        url: string;
      }[];
    }
  | { status: 'preparing' }
  | { status: 'failed'; message: string };

/** One picture as the book page shows it, from this device's copy or from the server. */
export interface GalleryPicture {
  beforeToc: boolean;
  width: number | null;
  height: number | null;
  /** For the strip (a thumbnail from the server, the file itself on this device). */
  thumbSrc: string;
  /** For the expanded view. */
  fullSrc: string;
}
