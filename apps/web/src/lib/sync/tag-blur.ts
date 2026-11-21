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

/**
 * Cover blur rules for an author, a series or a collection (2026-11-21): record kind
 * "blur-rule", id "author:<name>", "series:<name>" or "collection:<id>", data { blur: true }.
 * Removing the record removes the rule.
 */
export const BLUR_RULE_KIND = 'blur-rule';

type RuleTarget = 'author' | 'series' | 'collection';
const RULE_TARGETS: readonly RuleTarget[] = ['author', 'series', 'collection'];

export interface CoverRuleSets {
  tags: Set<string>;
  authors: Set<string>;
  series: Set<string>;
  collections: Set<string>;
}

export function coverRulesFrom(
  tagRecords: readonly LocalRecord[],
  ruleRecords: readonly LocalRecord[]
): CoverRuleSets {
  const out: CoverRuleSets = {
    tags: tagBlurRulesFrom(tagRecords),
    authors: new Set(),
    series: new Set(),
    collections: new Set()
  };
  for (const r of ruleRecords) {
    if (r.kind !== BLUR_RULE_KIND || r.deletedAt !== null || r.data?.blur !== true) continue;
    const colon = r.id.indexOf(':');
    const target = r.id.slice(0, colon) as RuleTarget;
    const name = r.id.slice(colon + 1);
    if (colon <= 0 || !RULE_TARGETS.includes(target) || !name) continue;
    if (target === 'author') out.authors.add(name);
    else if (target === 'series') out.series.add(name);
    else out.collections.add(name);
  }
  return out;
}

export async function getCoverRules(engine: SyncEngine): Promise<CoverRuleSets> {
  const [tags, rules] = await Promise.all([
    engine.getAll(TAG_BLUR_KIND),
    engine.getAll(BLUR_RULE_KIND)
  ]);
  return coverRulesFrom(tags, rules);
}

/** Switches a tag's, author's, series' or collection's rule on or off. Throws when not saved. */
export async function setCoverRule(
  engine: SyncEngine,
  target: 'tag' | RuleTarget,
  name: string,
  blur: boolean
): Promise<void> {
  if (target === 'tag') {
    await setTagBlur(engine, name, blur);
    return;
  }
  const id = `${target}:${name}`;
  const ok = blur
    ? await engine.put(BLUR_RULE_KIND, id, { blur: true }, { bookId: null })
    : await engine.remove(BLUR_RULE_KIND, id);
  if (!ok) throw new Error(`Could not save the cover rule for "${name}"`);
}
