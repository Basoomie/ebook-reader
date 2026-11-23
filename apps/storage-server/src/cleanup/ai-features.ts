/**
 * The cleanup's AI features in the shared spending record (src/ai/ledger.ts): the Calibre
 * cleanup (stages calibre4, calibre5) and the audiobook cleanup (audio5). One queue in
 * cleanup.db serves both (`source` "cleanup").
 */
export const CLEANUP_AI_SOURCE = 'cleanup';

export const CLEANUP_AI_FEATURES = {
  'calibre-cleanup': 'Calibre cleanup',
  'audiobook-cleanup': 'Audiobook cleanup',
} as const;

/** The feature a cleanup stage's spending counts for. */
export function cleanupFeatureOf(stage: string): keyof typeof CLEANUP_AI_FEATURES {
  return stage.startsWith('audio') ? 'audiobook-cleanup' : 'calibre-cleanup';
}

/** The model tasks of the steps that ask models today, by the names /cleanup shows them. */
export const CLEANUP_AI_TASK_NAMES: Record<string, string> = {
  'audio5.primary': 'Audiobook metadata (stage 5), first model',
  'audio5.secondary': 'Audiobook metadata (stage 5), second model',
  'audio5.upgradePrimary': 'New audiobooks: the second look, first stronger model',
  'audio5.upgradeSecondary': 'New audiobooks: the second look, second stronger model',
  'stage4.primary': 'Calibre online sources (stage 4), first model',
  'stage4.secondary': 'Calibre online sources (stage 4), second model',
  'stage5.primary': 'Calibre genres and tags (stage 5), first model',
  'stage5.secondary': 'Calibre genres and tags (stage 5), second model',
  'stage4.upgradePrimary': 'New Calibre books: the second look (setup J), first stronger model',
  'stage4.upgradeSecondary': 'New Calibre books: the second look (setup J), second stronger model',
  'stage5.upgradePrimary': 'New Calibre books: genres and tags, first model',
  'stage5.upgradeSecondary': 'New Calibre books: genres and tags, second model',
};
