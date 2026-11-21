/**
 * The stages that write fields of a book (stage 2: the files' metadata; stage 4: the online
 * sources, WP20e) as opposed to the ones that remove copies (1 and 3). Both go through the
 * field-write path (stage2-batches.ts) and the sidecar's per-book verify / written.
 */
export const FIELD_STAGES: readonly number[] = [2, 4, 5];

export const isFieldStage = (stage: number): boolean => FIELD_STAGES.includes(stage);
