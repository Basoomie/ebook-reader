/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { ImageSize } from './pick-illustrations';

/**
 * Pixel size of a JPEG, PNG, GIF or WebP from the start of its file, without decoding it.
 * `null` when the format isn't one of these, or when the bytes end before the size (a
 * JPEG's size comes after its metadata segments: read more and ask again).
 */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const b = bytes;
  const n = b.length;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const ascii = (i: number, s: string) =>
    i + s.length <= n && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;

  // PNG: signature, then the IHDR chunk.
  if (n >= 24 && b[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) {
    return size(u32be(16), u32be(20));
  }
  // GIF87a / GIF89a: logical screen size.
  if (n >= 10 && ascii(0, 'GIF8')) return size(u16le(6), u16le(8));
  // WebP: RIFF....WEBP and its first chunk.
  if (n >= 30 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) {
    if (ascii(12, 'VP8 ')) return size(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (ascii(12, 'VP8L') && b[20] === 0x2f) {
      const b1 = b[22];
      const b2 = b[23];
      const b3 = b[24];
      return size(
        1 + (((b1 & 0x3f) << 8) | b[21]),
        1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      );
    }
    if (ascii(12, 'VP8X')) return size(1 + u24le(24), 1 + u24le(27));
    return null;
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < n) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const isFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return i + 8 < n ? size(u16be(i + 7), u16be(i + 5)) : null;
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  return null;
}

/** Whether `imageSize` returned null only because the bytes ended too soon (a JPEG). */
export function needsMoreBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8 && imageSize(bytes) === null;
}

/** Bytes read first; a JPEG whose size comes later is read in full. */
export const IMAGE_HEADER_BYTES = 64 * 1024;

/** `imageSize` of a Blob: its first bytes, or all of it for a JPEG with long metadata. */
export async function blobImageSize(blob: Blob): Promise<ImageSize | null> {
  const head = new Uint8Array(await blob.slice(0, IMAGE_HEADER_BYTES).arrayBuffer());
  if (blob.size > IMAGE_HEADER_BYTES && needsMoreBytes(head)) {
    return imageSize(new Uint8Array(await blob.arrayBuffer()));
  }
  return imageSize(head);
}
