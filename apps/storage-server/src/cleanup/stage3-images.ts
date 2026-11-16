/**
 * Stage 3 (WP20c): the facts that compare two copies' pictures (plan P5): a 64-bit
 * perceptual hash (DCT of a 32×32 greyscale image, the 8×8 lowest frequencies against their
 * median), the longest side, and for a JPEG the mean of its luminance quantization table
 * (read from the DQT marker, no decoding; lower = less compressed).
 *
 * Read-only: images come out of the EPUB through ZipFile and source-fs.
 */
import sharp from 'sharp';
import { openSourceFile } from '../calibre/source-fs';
import { ZipFile } from '../migration/zip-read';
import type { ImageFact } from './stage3-rules';

/** Largest single image read (larger ones are skipped). */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

const N = 32;
const COS: Float64Array = (() => {
  const t = new Float64Array(N * N);
  for (let u = 0; u < N; u++) {
    for (let x = 0; x < N; x++) t[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  }
  return t;
})();

/** pHash of 32×32 greyscale pixels (row-major), as 16 hex digits. */
export function phashOfPixels(px: Uint8Array | Buffer): string {
  // Only the 8×8 lowest frequencies are needed.
  const coef = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let y = 0; y < N; y++) {
        const cy = COS[v * N + y];
        for (let x = 0; x < N; x++) sum += px[y * N + x] * COS[u * N + x] * cy;
      }
      coef[v * 8 + u] = sum;
    }
  }
  // Median of the 63 coefficients after the DC term.
  const rest = Array.from(coef.subarray(1)).sort((a, b) => a - b);
  const median = rest[31];
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let k = 0; k < 4; k++) nibble = (nibble << 1) | (coef[i + k] > median ? 1 : 0);
    hex += nibble.toString(16);
  }
  return hex;
}

/** Mean of the first luminance (id 0) quantization table of a JPEG, or null. */
export function jpegQuantization(bytes: Buffer): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = bytes.readUInt16BE(p + 2);
    if (marker === 0xdb) {
      let q = p + 4;
      const end = p + 2 + len;
      while (q < end && q < bytes.length) {
        const precision = bytes[q] >> 4;
        const id = bytes[q] & 0x0f;
        const size = precision ? 128 : 64;
        if (q + 1 + size > bytes.length) return null;
        if (id === 0) {
          let sum = 0;
          for (let k = 0; k < 64; k++) {
            sum += precision ? bytes.readUInt16BE(q + 1 + 2 * k) : bytes[q + 1 + k];
          }
          return sum / 64;
        }
        q += 1 + size;
      }
    }
    p += 2 + len;
  }
  return null;
}

/** The facts of one image, or null when sharp can't read it. */
export async function imageFactOf(bytes: Buffer): Promise<ImageFact | null> {
  try {
    const img = sharp(bytes, { failOn: 'none', limitInputPixels: 100_000_000 });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) return null;
    const { data } = await sharp(bytes, { failOn: 'none', limitInputPixels: 100_000_000 })
      .greyscale()
      .resize(N, N, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      phash: phashOfPixels(data),
      side: Math.max(meta.width, meta.height),
      quant: meta.format === 'jpeg' ? jpegQuantization(bytes) : null,
    };
  } catch {
    return null;
  }
}

/**
 * The facts of the named image entries of an EPUB (unreadable ones left out). `counted`
 * gets the bytes read, for pacing.
 */
export async function epubImageFacts(
  file: string,
  entries: string[],
  counted?: { bytes: number },
): Promise<ImageFact[]> {
  const zip = await ZipFile.open(file, openSourceFile);
  try {
    const out: ImageFact[] = [];
    for (const name of entries) {
      const entry = zip.get(name);
      if (!entry || entry.size === 0 || entry.size > MAX_IMAGE_BYTES) continue;
      const bytes = await zip.readBytes(entry, MAX_IMAGE_BYTES);
      if (counted) counted.bytes += bytes.length;
      const fact = await imageFactOf(bytes);
      if (fact) out.push(fact);
    }
    return out;
  } finally {
    await zip.close();
  }
}
