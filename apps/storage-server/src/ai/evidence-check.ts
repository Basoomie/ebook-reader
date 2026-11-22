/**
 * Never invent (WP21d): a model's string counts only when it is in the item's evidence. The
 * comparison form ignores width, case, spaces and punctuation. Shared by every feature: the
 * cleanup drops a model's value that is not in its evidence; the book summaries check each
 * item's quote against the book's text.
 */

/** Characters ignored when looking for a model's string in the evidence. */
const IGNORED =
  /[\s\u3000・･.,，、。:：;；!！?？'"‘’“”「」『』【】〈〉《》<>＜＞()（）[\]［］{}｛｝~～〜\-‐–—―ー_＿/／\\＼|｜*＊#＃&＆+＋=＝]/g;

/** The never-invent comparison form: NFKC, lower case, punctuation and spaces removed. */
export function evidenceForm(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(IGNORED, '');
}

/**
 * True when every string of the value appears in the evidence (already in `evidenceForm`). A
 * string that is not found whole counts when each of its parts (split at spaces and
 * punctuation, at least 2 characters each, or the whole string when it has no parts) is found:
 * a title the model joined from the record's title and subtitle, a name the model wrote with ・.
 */
export function inEvidence(strings: string[], evidence: string): boolean {
  for (const s of strings) {
    const whole = evidenceForm(s);
    if (whole === '') continue;
    if (evidence.includes(whole)) continue;
    const parts = s
      .normalize('NFKC')
      .split(IGNORED)
      .map((x) => evidenceForm(x))
      .filter((x) => x.length >= 2);
    if (parts.length < 2 || !parts.every((x) => evidence.includes(x))) return false;
  }
  return true;
}
