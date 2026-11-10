/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { LocalRecord } from '$lib/sync/sync-db';
import type { SyncEngine } from '$lib/sync/sync-engine';

/**
 * Cover blur rules per tag (WP7a): record kind "tag-blur", id = the tag name as Calibre
 * spells it, data { blur: true }. Removing the record removes the rule. Synced like
 * every other record; the book's own blur setting overrides a rule (cover-blur.ts).
 */
export const TAG_BLUR_KIND = 'tag-blur';

export function tagBlurRulesFrom(records: readonly LocalRecord[]): Set<string> {
  return new Set(
    records
      .filter((r) => r.kind === TAG_BLUR_KIND && r.deletedAt === null && r.data?.blur === true)
      .map((r) => r.id)
  );
}

export async function getTagBlurRules(engine: SyncEngine): Promise<Set<string>> {
  return tagBlurRulesFrom(await engine.getAll(TAG_BLUR_KIND));
}

/** Switches a tag's rule on or off. Throws when it could not be saved. */
export async function setTagBlur(engine: SyncEngine, tag: string, blur: boolean): Promise<void> {
  const ok = blur
    ? await engine.put(TAG_BLUR_KIND, tag, { blur: true }, { bookId: null })
    : await engine.remove(TAG_BLUR_KIND, tag);
  if (!ok) throw new Error(`Could not save the cover rule for "${tag}"`);
}
