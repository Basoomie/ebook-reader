/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP14 "Enrich last card": how a value goes into an Anki field. Decided with the user:
 * each mapped field is "fill if empty" (default) or "append"; a field is never
 * overwritten. Append adds nothing that is already in the field, so a second tap on the
 * same card adds nothing twice.
 */

export type FieldMode = 'fill-if-empty' | 'append';

export const FIELD_MODES: readonly FieldMode[] = ['fill-if-empty', 'append'];

export function isFieldMode(value: unknown): value is FieldMode {
  return value === 'fill-if-empty' || value === 'append';
}

/** Separator between an existing value and an appended one. */
export const APPEND_SEPARATOR = '<br>';

/**
 * Whether a field counts as empty: no media and no visible text once tags, `&nbsp;`,
 * zero-width characters and whitespace are taken out (Anki's editor often leaves `<br>`
 * or `&nbsp;` in a field that looks empty).
 */
export function isEmptyField(html: string): boolean {
  if (/<img\b/i.test(html) || /\[sound:[^\]]+\]/i.test(html)) {
    return false;
  }

  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, ' ')
    .replace(/&#8203;|&#x0*200b;|\u200b|\ufeff/gi, '')
    .trim();

  return text === '';
}

/**
 * The field's new value, or null when it stays as it is (fill-if-empty on a filled field,
 * or append of a value the field already contains).
 */
export function mergeField(existing: string, value: string, mode: FieldMode): string | null {
  if (!value) {
    return null;
  }

  if (isEmptyField(existing)) {
    return value;
  }

  if (mode === 'fill-if-empty') {
    return null;
  }

  if (existing.includes(value)) {
    return null;
  }

  return `${existing}${APPEND_SEPARATOR}${value}`;
}
