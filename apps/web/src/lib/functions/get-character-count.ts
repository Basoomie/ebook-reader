/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { isNodeGaiji } from './is-node-gaiji';

export function getCharacterCount(node: Node) {
  return isNodeGaiji(node) ? 1 : getRawCharacterCount(node);
}

/** Stands for a gaiji image in counted text (it counts as one character). */
export const GAIJI_CHARACTER = '〓';

/**
 * The characters getCharacterCount counts, as text (Phase 6 stage 3 fingerprints books by
 * the reader's own text). A gaiji image is GAIJI_CHARACTER, so the text's length in code
 * points equals the count.
 */
export function getCountedText(node: Node) {
  if (isNodeGaiji(node)) return GAIJI_CHARACTER;
  if (!node.textContent) return '';
  return node.textContent.replace(isNotJapaneseRegex, '');
}

const isNotJapaneseRegex =
  /[^0-9A-Z○◯々-〇〻ぁ-ゖゝ-ゞァ-ヺー０-９Ａ-Ｚｦ-ﾝ\p{Radical}\p{Unified_Ideograph}]+/gimu;

function getRawCharacterCount(node: Node) {
  if (!node.textContent) return 0;
  return countUnicodeCharacters(node.textContent.replace(isNotJapaneseRegex, ''));
}

/**
 * Because '𠮟る'.length = 3
 * Reference: https://dmitripavlutin.com/what-every-javascript-developer-should-know-about-unicode/#length-and-surrogate-pairs
 */
function countUnicodeCharacters(s: string) {
  return Array.from(s).length;
}
