/**
 * Rule text shared by every stage's prompt (WP21d). A stage's system prompt is
 * `[INTRO of the stage, ...SHARED_RULES, ...the stage's own rules, the answer format]`.
 *
 * Fixed before production (library-cleanup-plan.md section 6 "Before production"): the
 * katakana-name rule joins the parts with ・ (the decided name form), and the (上)/(下) example
 * applies only to a work in two or three parts, never inside a long series (the bake-off's
 * prompt turned 終物語(中) into 2 and レンタルマギカ (上) into 1). The Calibre cleanup's bonus N.1
 * and omnibus rules are Calibre's: they go in WP20e's own block, not here.
 */

export const NAME_FORM_RULE =
  '- Names (authors, narrators, illustrators): Japanese names without spaces (伏見つかさ, ' +
  'not 伏見 つかさ); full-width and half-width letters and digits unified; foreign names in ' +
  'katakana join their parts with ・ (ウィリアム・シェークスピア, not ウィリアム シェークスピア).';

export const VOLUME_MARKER_RULE =
  '- Volume markers: (上)/(中)/(下) and 前編/後編 give positions 1/2/3 only when the work itself ' +
  'is published in two or three parts. Inside a longer series they mark a part of one volume ' +
  'and never replace the volume number (終物語(中) is not volume 2; レンタルマギカ (上) is ' +
  'not volume 1). Prefer the printed volume number.';

export const NEVER_INVENT_RULE =
  '- Never invent: every value must come from the evidence (names, titles and series as they ' +
  'appear there, cleaned by the rules above). If a value cannot be determined from the ' +
  'evidence, answer null (or [] where the format says a list) with confidence "low".';

export const CONFIDENCE_RULE =
  '- For each field give confidence "high" only if the evidence clearly supports it; ' +
  'otherwise "low".';

export const SOURCES_MAY_BE_WRONG =
  'Lookup results may belong to a DIFFERENT work (another volume, another edition, another ' +
  'reading, an unrelated product). Decide what is true for THIS item.';

export const SHARED_RULES: readonly string[] = [
  NAME_FORM_RULE,
  VOLUME_MARKER_RULE,
  NEVER_INVENT_RULE,
  CONFIDENCE_RULE,
];

/** Joins a system prompt from its parts. */
export function systemPrompt(parts: {
  intro: string;
  rules: readonly string[];
  answerFormat: string;
}): string {
  return [
    parts.intro.trim(),
    SOURCES_MAY_BE_WRONG,
    '',
    'Rules:',
    ...SHARED_RULES,
    ...parts.rules,
    '',
    parts.answerFormat.trim(),
  ].join('\n');
}
