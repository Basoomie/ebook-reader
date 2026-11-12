/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { isFieldMode, type FieldMode } from './field-merge';

/**
 * WP14: which field of a note type gets what. One mapping per note type, the same on
 * every device (a global setting). A role without a field is not used.
 */
export type EnrichRole = 'sentence' | 'sentenceAudio' | 'cover' | 'link';

export const ENRICH_ROLES: readonly EnrichRole[] = ['sentence', 'sentenceAudio', 'cover', 'link'];

export const ROLE_LABELS: Record<EnrichRole, string> = {
  sentence: 'Sentence',
  sentenceAudio: 'Sentence audio',
  cover: 'Cover',
  link: 'Link to the passage'
};

export interface FieldTarget {
  field: string;
  mode: FieldMode;
}

export type NoteTypeMapping = Partial<Record<EnrichRole, FieldTarget>>;

/** Note type name → its mapping. */
export type EnrichMapping = Record<string, NoteTypeMapping>;

function isRole(value: string): value is EnrichRole {
  return (ENRICH_ROLES as readonly string[]).includes(value);
}

/** A stored mapping, keeping only well-formed entries (a bad value never breaks enriching). */
export function parseMapping(value: unknown): EnrichMapping {
  const out: EnrichMapping = {};

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return out;
  }

  for (const [noteType, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }

    const mapping: NoteTypeMapping = {};

    for (const [role, target] of Object.entries(raw as Record<string, unknown>)) {
      const t = target as Partial<FieldTarget> | null;

      if (isRole(role) && t && typeof t.field === 'string' && t.field !== '') {
        mapping[role] = { field: t.field, mode: isFieldMode(t.mode) ? t.mode : 'fill-if-empty' };
      }
    }

    out[noteType] = mapping;
  }

  return out;
}

/** The mapping with one role of one note type set (or removed with `target` null). */
export function withTarget(
  mapping: EnrichMapping,
  noteType: string,
  role: EnrichRole,
  target: FieldTarget | null
): EnrichMapping {
  const current = { ...(mapping[noteType] ?? {}) };

  if (target) {
    current[role] = target;
  } else {
    delete current[role];
  }

  return { ...mapping, [noteType]: current };
}

/** Whether a note type has at least one role mapped. */
export function hasMapping(mapping: EnrichMapping, noteType: string): boolean {
  return Object.keys(mapping[noteType] ?? {}).length > 0;
}
