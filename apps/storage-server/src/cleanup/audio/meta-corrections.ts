/**
 * One-off corrections of store errors (WP21d follow-up, 2026-11-20): values written as the
 * user's own (`ai_values.source = 'user'`) after each stage-5 pass, only where the user has no
 * value yet, so no later pass, rules change or model answer overwrites them. Keyed by the store
 * record's id ("audible:B0…", "audiobookjp:90310"). Every entry is researched and approved by
 * the user before it is added; the evidence is in `decisions.md`, "WP21d follow-up".
 */
export interface Correction {
  /** The store record the recording was matched to. */
  record: string;
  field: 'authors' | 'narrators' | 'multi_narr';
  value: string[] | boolean;
}

export const CORRECTIONS: Correction[] = [];
