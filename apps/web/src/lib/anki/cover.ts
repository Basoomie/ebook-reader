/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP14: the book cover for a card, as JPEG (longest side at most MAX_SIDE px). From the
 * EPUB's own cover on this device, else the library server's thumbnail. Stored in Anki
 * under one name per book, so every card of a book shares the file.
 */

export const MAX_SIDE = 800;

export function coverFileName(bookKey: string): string {
  return `ttsu-cover-${bookKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'book'}.jpg`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('could not read the cover'));
    reader.readAsDataURL(blob);
  });
}

async function loadImage(
  blob: Blob
): Promise<{ img: CanvasImageSource; w: number; h: number; done: () => void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob);
    return { img: bitmap, w: bitmap.width, h: bitmap.height, done: () => bitmap.close?.() };
  }

  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('the cover image could not be read'));
    img.src = url;
  });
  return { img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
}

/** Base64 JPEG of an image blob, scaled down to MAX_SIDE. */
export async function coverJpegBase64(blob: Blob): Promise<string> {
  const { img, w, h, done } = await loadImage(blob);

  try {
    if (!w || !h) throw new Error('the cover image is empty');

    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');

    if (!ctx) throw new Error('this browser cannot draw the cover');

    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const jpeg = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85)
    );

    if (!jpeg) throw new Error('the cover could not be converted');

    return blobToBase64(jpeg);
  } finally {
    done();
  }
}
