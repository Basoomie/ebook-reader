/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { AudioLink } from '$lib/audio/audio-types';
import { copyFitsLink } from './audio-identity';
import type { AudioCopy } from './audio-offline-db';

/**
 * What whispersync plays and which subtitles it gets (Season 2 Phase 9). Pure.
 *
 * - The link could be read: the downloaded copy when it is the linked file (same folder,
 *   file and version), otherwise the link streams as before. A copy of an earlier link
 *   (relinked, replaced file, unlinked) is never played; it stays until it is removed.
 * - The link couldn't be read (offline, server down, timeout): the downloaded copy if
 *   there is a finished one, else nothing, as before. The device can't know about a
 *   change made meanwhile, so it plays the copy it has, with the subtitles kept with it.
 */
export type LinkAnswer = { ok: true; link: AudioLink | null } | { ok: false };

export type SourceChoice = 'copy' | 'stream' | 'none';

export function chooseSource(answer: LinkAnswer, copy: AudioCopy | null): SourceChoice {
  if (answer.ok) {
    if (copyFitsLink(copy, answer.link)) return 'copy';
    return answer.link?.playUrl ? 'stream' : 'none';
  }
  return copy?.complete ? 'copy' : 'none';
}

export type SubtitleChoice = 'server' | 'copy' | 'none';

export function chooseSubtitle(answer: LinkAnswer, copy: AudioCopy | null): SubtitleChoice {
  if (answer.ok) {
    const link = answer.link;
    return link && link.subtitleState === 'linked' && link.subtitleStatus === 'ok'
      ? 'server'
      : 'none';
  }
  return copy?.complete && copy.subtitle ? 'copy' : 'none';
}

/**
 * Whether the subtitle file just fetched from the server should be kept with the copy:
 * the copy is the linked file and holds no subtitles, or those of another subtitle file.
 */
export function shouldKeepSubtitle(link: AudioLink | null, copy: AudioCopy | null): boolean {
  return (
    !!link?.subtitleRelPath &&
    copyFitsLink(copy, link) &&
    copy!.subtitle?.relPath !== link.subtitleRelPath
  );
}
