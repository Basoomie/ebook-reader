/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import {
  isOPFType,
  type EpubContent,
  type EpubMetadataMeta,
  type EpubOPFContent
} from '$lib/functions/file-loaders/epub/types';
import { blobImageSize } from './image-size';
import {
  illustrationCandidates,
  pickIllustrations,
  type Illustration,
  type ImageSize
} from './pick-illustrations';

/**
 * The book's illustrations from its imported HTML and stored images: sizes are read only
 * for the candidates (from each file's header), then `pickIllustrations` decides.
 */
export async function collectIllustrations(
  root: ParentNode,
  blobs: Record<string, Blob>,
  coverKey: string | null
): Promise<Illustration[]> {
  const keys = new Set(Object.keys(blobs));
  const sizes = new Map<string, ImageSize | null>();
  for (const candidate of illustrationCandidates(root)) {
    if (!candidate || sizes.has(candidate.key) || !keys.has(candidate.key)) continue;
    if (candidate.key === coverKey) continue;
    sizes.set(candidate.key, await blobImageSize(blobs[candidate.key]).catch(() => null));
  }
  return pickIllustrations(root, { keys, coverKey, sizeOf: (key) => sizes.get(key) ?? null });
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

/**
 * The cover image's key as the OPF names it: the `cover-image` item, else the item of
 * `<meta name="cover">`; the same order the import uses (get-epub-cover-image-filename.ts),
 * without its browser-only check that the image loads (an image that doesn't load shows
 * nothing either way).
 */
export function opfCoverKey(
  contents: EpubContent | EpubOPFContent,
  keys: ReadonlySet<string>
): string | null {
  const items = asArray(
    isOPFType(contents)
      ? contents['opf:package']['opf:manifest']['opf:item']
      : contents.package.manifest.item
  );
  const byProperty = items.find((item) => item['@_properties'] === 'cover-image');
  if (byProperty && keys.has(byProperty['@_href'])) return byProperty['@_href'];

  const metas = asArray<EpubMetadataMeta>(
    isOPFType(contents)
      ? contents['opf:package']['opf:metadata']?.['opf:meta']
      : contents.package.metadata?.meta
  );
  const id = metas.find((m) => m['@_name'] === 'cover')?.['@_content'];
  const href = id ? items.find((item) => item['@_id'] === id)?.['@_href'] : undefined;
  return href && keys.has(href) ? href : null;
}

/**
 * The cover's key on a device, where the import stored the cover Blob itself
 * (`coverImage`) but not its key: the stored image with the same bytes.
 */
export async function storedCoverKey(
  blobs: Record<string, Blob>,
  cover: Blob | string | undefined
): Promise<string | null> {
  if (!(cover instanceof Blob)) return null;
  const sameSize = Object.entries(blobs).filter(([, blob]) => blob.size === cover.size);
  if (sameSize.length === 1) return sameSize[0][0];
  if (!sameSize.length) return null;
  const want = new Uint8Array(await cover.arrayBuffer());
  for (const [key, blob] of sameSize) {
    const got = new Uint8Array(await blob.arrayBuffer());
    if (got.every((b, i) => b === want[i])) return key;
  }
  return null;
}
