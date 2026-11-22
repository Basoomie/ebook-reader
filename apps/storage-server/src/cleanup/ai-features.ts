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
