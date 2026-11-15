/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { AudioLink } from '$lib/audio/audio-types';
import type { AudioCopy } from './audio-offline-db';

/**
 * Which file a downloaded copy is (Season 2 Phase 9). A copy is the linked file when the
 * folder, the file name and the file's version on the server (size and modified time, the
 * play URL's `v`) are the same. A file replaced under the same name gets a new version, so
 * its old copy no longer fits; so does any copy after a relink, an unlink or "No audiobook".
 */
export interface LinkedFileIdentity {
  folderRelPath: string;
  fileName: string;
  version: string;
  size: number;
}

/**
 * The file a link plays, or null when there is nothing to download: no link, "No
 * audiobook", a folder of several files, a missing or changed file, or a server too old to
 * say the file's version.
 */
export function linkedFile(link: AudioLink | null | undefined): LinkedFileIdentity | null {
  if (!link || link.state !== 'linked' || !link.playable || !link.playUrl) return null;
  const file = link.file;
  if (!link.folderRelPath || !link.fileName || !file || typeof file.version !== 'string') {
    return null;
  }
  return {
    folderRelPath: link.folderRelPath,
    fileName: link.fileName,
    version: file.version,
    size: file.size
  };
}

/** Whether the copy (finished or not) is of this file. */
export function copyIsOf(copy: AudioCopy, file: LinkedFileIdentity | null): boolean {
  return (
    !!file &&
    copy.folderRelPath === file.folderRelPath &&
    copy.fileName === file.fileName &&
    copy.version === file.version &&
    copy.size === file.size
  );
}

/** Whether whispersync should play this copy for the link (finished and of its file). */
export function copyFitsLink(copy: AudioCopy | undefined | null, link: AudioLink | null): boolean {
  return !!copy && copy.complete && copyIsOf(copy, linkedFile(link));
}
