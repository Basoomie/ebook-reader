/**
 * The stages that write fields of a book (stage 2: the files' metadata; stage 4: the online
 * sources, WP20e; stage 5: tags, WP20f; and the user's own edits from the reader, EDIT_STAGE) as
 * opposed to the ones that remove copies (1 and 3). All go through the field-write path
 * (stage2-batches.ts) and the sidecar's per-book verify / written.
 */
export const EDIT_STAGE = 10;

export const FIELD_STAGES: readonly number[] = [2, 4, 5, EDIT_STAGE];

export const isFieldStage = (stage: number): boolean => FIELD_STAGES.includes(stage);

/** The sidecar version that writes the user's edits (pubdate and rating, the edit claim). */
export const EDIT_SIDECAR_VERSION = '1.5.0';

/**
 * Manga part A (manga-library.md): the batches that move books to another Calibre library
 * (export, add there with every field, check, remove the usual way). Neither a field stage nor
 * a removal stage: their items have their own steps (move/move-batches.ts).
 */
export const MOVE_STAGE = 11;

/** The sidecar version that moves books and uses each batch's own library (1.6.0). */
export const MOVE_SIDECAR_VERSION = '1.6.0';

/**
 * Books without an EPUB (non-epub-books.md): the batches that add an EPUB made for a book to its
 * own record (add_format), or fold a proven copy into its EPUB twin (its file added there, the
 * copy removed the stage-1 way). Their items have their own steps (formats/format-batches.ts).
 */
export const FORMATS_STAGE = 12;

/** The sidecar version that converts books and runs add_format / remove_format (1.8.0). */
export const FORMATS_SIDECAR_VERSION = '1.8.0';

/**
 * The sidecar version whose conversions follow the pass's rules 2 (formats/pass.ts
 * FORMATS_RULES_VERSION: mokuro archives made as picture books, or listed without pictures).
 * An older sidecar is handed no conversion job.
 */
export const FORMATS_CONVERT_SIDECAR_VERSION = '1.8.1';
