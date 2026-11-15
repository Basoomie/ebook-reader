/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BlurMode } from '$lib/data/blur-mode';

/**
 * Season 2 §6: whether the book page blurs an illustration. The device's "Hide spoiler
 * images" setting decides (on/off and all/afterToc, as in the reader); a picture tapped to
 * reveal it, or "Show all", shows it until the page is left.
 */
export interface HiddenState {
  hideSpoilerImage: boolean;
  mode: BlurMode | string;
  /** Indexes revealed by a tap. */
  revealed: ReadonlySet<number>;
  allShown: boolean;
}

export function isHidden(item: { beforeToc: boolean }, index: number, state: HiddenState): boolean {
  if (!state.hideSpoilerImage || state.allShown || state.revealed.has(index)) return false;
  // As the reader (addSpoilerTags): any mode other than afterToc hides every picture.
  return state.mode !== BlurMode.AFTER_TOC || !item.beforeToc;
}

/** Whether any picture is still hidden ("Show all" is offered only then). */
export function anyHidden(items: readonly { beforeToc: boolean }[], state: HiddenState): boolean {
  return items.some((item, index) => isHidden(item, index, state));
}
