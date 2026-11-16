/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { isElementGaiji } from '$lib/functions/is-element-gaiji';

/**
 * Season 2 §6: which of a book's images the book page shows as illustrations, in book
 * order. Works on the imported HTML (`elementHtml`, as the reader stores it): one top-level
 * `div#ttu-<spine id>` per part, images referenced by blob key through the import's dummy
 * URLs. Used by the device (its stored copy) and by the server (the counter bundle runs the
 * same import), so both answer with the same pictures.
 *
 * Candidates are exactly the images the reader blurs as spoilers (`addSpoilerTags` in
 * format-book-data-html.ts): `<img>` without a gaiji class, and the `<image>` of an `<svg>`.
 * `beforeToc` follows the reader's afterToc rule: the parts up to and including the first
 * part with more than one link (the table of contents) are before it; when no part has more
 * than one link, or that part is the last one, no image counts as before it.
 */

/** Pictures smaller than this on their shorter side are left out (logos, ornaments). */
export const MIN_ILLUSTRATION_SIDE = 300;

/** Bump when the rule changes: the server's cached lists are made again. */
export const ILLUSTRATIONS_RULE_VERSION = 1;

export interface ImageSize {
  width: number;
  height: number;
}

export interface IllustrationCandidate {
  /** Blob key (the image's path in the EPUB, relative to the OPF folder). */
  key: string;
  beforeToc: boolean;
}

export interface Illustration extends IllustrationCandidate {
  /** Pixel size from the file's header; null when the format wasn't recognised. */
  width: number | null;
  height: number | null;
}

const DUMMY_PREFIX = 'data:image/gif;ttu:';
const DUMMY_SUFFIX = ';base64,';

/** The blob key an imported `src`/`href` points at, or null (an image the EPUB lacks). */
export function imageKeyOf(value: string | null): string | null {
  if (!value) return null;
  if (value.startsWith(DUMMY_PREFIX)) {
    const end = value.lastIndexOf(DUMMY_SUFFIX);
    return end > DUMMY_PREFIX.length ? value.slice(DUMMY_PREFIX.length, end) : null;
  }
  if (value.startsWith('ttu:')) return value.slice(4) || null;
  return null;
}

function keyOfElement(el: Element): string | null {
  if (el.tagName.toLowerCase() === 'img') return imageKeyOf(el.getAttribute('src'));
  for (const name of el.getAttributeNames()) {
    if (name.endsWith('href')) {
      const key = imageKeyOf(el.getAttribute(name));
      if (key) return key;
    }
  }
  return null;
}

/** The index of the first part after the table of contents, or 0 when there is none. */
function firstPartAfterToc(parts: Element[]): number {
  const after = parts.findIndex((part) => part.getElementsByTagName('a').length > 1) + 1;
  return after > 0 && after < parts.length ? after : 0;
}

/**
 * Every image the reader treats as a spoiler image, in document order, with its blob key.
 * Repeats and images without a key are kept (the parity test compares occurrences).
 */
export function illustrationCandidates(root: ParentNode): (IllustrationCandidate | null)[] {
  const parts = Array.from(root.children);
  const after = firstPartAfterToc(parts);
  const out: (IllustrationCandidate | null)[] = [];

  parts.forEach((part, index) => {
    const beforeToc = index < after;
    for (const el of Array.from(part.querySelectorAll('img, image'))) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'img') {
        if (isElementGaiji(el as HTMLImageElement)) continue;
      } else if (!el.closest('svg')) {
        continue;
      }
      const key = keyOfElement(el);
      out.push(key ? { key, beforeToc } : null);
    }
  });

  return out;
}

export interface PickOptions {
  /** Keys the book stores (an image the book lacks is left out). */
  keys: ReadonlySet<string>;
  /** The cover's key, left out of the illustrations. */
  coverKey?: string | null;
  sizeOf: (key: string) => ImageSize | null;
  minSide?: number;
}

/**
 * The book's illustrations in book order: candidates without the cover, missing images,
 * repeats (the first place counts) and pictures under `minSide` on their shorter side.
 */
export function pickIllustrations(root: ParentNode, options: PickOptions): Illustration[] {
  const minSide = options.minSide ?? MIN_ILLUSTRATION_SIDE;
  const seen = new Set<string>();
  const out: Illustration[] = [];

  for (const candidate of illustrationCandidates(root)) {
    if (!candidate) continue;
    const { key } = candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!options.keys.has(key) || key === options.coverKey) continue;
    const size = options.sizeOf(key);
    if (size && Math.min(size.width, size.height) < minSide) continue;
    out.push({ ...candidate, width: size?.width ?? null, height: size?.height ?? null });
  }

  return out;
}
