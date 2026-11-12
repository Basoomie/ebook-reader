/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { AnkiConnectError, type AnkiConnect, type NoteInfo } from './anki-connect';
import { mergeField } from './field-merge';
import { ENRICH_ROLES, ROLE_LABELS, type EnrichMapping, type EnrichRole } from './mapping';
import type { Sentence } from './sentence';

/**
 * WP14 "Enrich last card": adds what the book has to the most recently added note in
 * Anki. Always the book-title tag; then, as the note type's mapping says, the sentence,
 * sentence audio, cover and link. Fields are filled if empty or appended to, never
 * overwritten. Media is only fetched and stored when its field will change.
 */

export interface MediaFile {
  fileName: string;
  /** Base64 of the file's bytes. */
  load: () => Promise<string>;
}

/** A piece that can't be added, with the reason shown to the user. */
export interface Unavailable {
  skip: string;
}

export interface EnrichInput {
  /** Library title (Calibre), falling back to the book's own title. */
  title: string;
  tagPrefix: string;
  sentence: Sentence | null;
  /** Why there is no sentence (shown when the sentence field is mapped). */
  noSentenceReason?: string;
  link: string | Unavailable;
  /** Resolved only when the note type maps a cover field. */
  cover: () => Promise<MediaFile | Unavailable>;
  /** Resolved only when the note type maps a sentence-audio field and there is a sentence. */
  audio: (sentence: Sentence) => Promise<MediaFile | Unavailable>;
  /** Days back to look for the newest note. */
  days: number;
  mapping: EnrichMapping;
  titleTag: (title: string, prefix: string) => string | null;
}

export interface EnrichResult {
  noteId: number;
  noteType: string;
  /** The note's first field as text, to say which card was changed. */
  word: string;
  added: string[];
  /** Already there (fill-if-empty on a filled field, or the same value appended before). */
  kept: string[];
  skipped: { what: string; reason: string }[];
  /** The note type has nothing mapped: only the tag was added. */
  unmapped: boolean;
  android: boolean;
}

export class EnrichError extends Error {
  constructor(
    message: string,
    readonly kind: 'no-note' | 'anki'
  ) {
    super(message);
  }
}

function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\[sound:[^\]]*\]/g, '')
    .trim();
}

export function noteWord(note: NoteInfo): string {
  const first = Object.values(note.fields).sort((a, b) => a.order - b.order)[0];
  const text = plain(first?.value ?? '');
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

function isUnavailable(value: unknown): value is Unavailable {
  return !!value && typeof value === 'object' && 'skip' in value;
}

export async function enrichLastCard(anki: AnkiConnect, input: EnrichInput): Promise<EnrichResult> {
  let note: NoteInfo | null;

  try {
    note = await anki.newestNote(input.days);
  } catch (error) {
    throw new EnrichError((error as Error).message, 'anki');
  }

  if (!note) {
    throw new EnrichError(
      input.days === 1
        ? 'No note was added to Anki today.'
        : `No note was added to Anki in the last ${input.days} days.`,
      'no-note'
    );
  }

  const result: EnrichResult = {
    noteId: note.noteId,
    noteType: note.modelName,
    word: noteWord(note),
    added: [],
    kept: [],
    skipped: [],
    unmapped: false,
    android: anki.isAndroid
  };
  const mapping = input.mapping[note.modelName] ?? {};
  const roles = ENRICH_ROLES.filter((role) => mapping[role]);
  result.unmapped = roles.length === 0;

  // What each mapped role would put in (media are resolved by name; bytes come later).
  const wanted = new Map<EnrichRole, { value: string; file?: MediaFile }>();

  for (const role of roles) {
    const label = ROLE_LABELS[role].toLowerCase();

    try {
      if (role === 'sentence') {
        if (input.sentence) wanted.set(role, { value: input.sentence.html });
        else result.skipped.push({ what: label, reason: input.noSentenceReason ?? 'no sentence' });
      } else if (role === 'link') {
        if (isUnavailable(input.link))
          result.skipped.push({ what: label, reason: input.link.skip });
        else wanted.set(role, { value: input.link });
      } else if (role === 'cover') {
        const cover = await input.cover();
        if (isUnavailable(cover)) result.skipped.push({ what: label, reason: cover.skip });
        else wanted.set(role, { value: `<img src="${cover.fileName}">`, file: cover });
      } else if (role === 'sentenceAudio') {
        if (!input.sentence) {
          result.skipped.push({ what: label, reason: input.noSentenceReason ?? 'no sentence' });
          continue;
        }

        const audio = await input.audio(input.sentence);
        if (isUnavailable(audio)) result.skipped.push({ what: label, reason: audio.skip });
        else wanted.set(role, { value: `[sound:${audio.fileName}]`, file: audio });
      }
    } catch (error) {
      result.skipped.push({ what: label, reason: (error as Error)?.message ?? String(error) });
    }
  }

  // Which fields change. Running values, so two roles mapped to one field both land.
  const plan = () => {
    const values = new Map(Object.entries(note!.fields).map(([k, v]) => [k, v.value]));
    const updates: Record<string, string> = {};
    const added: EnrichRole[] = [];
    const kept: EnrichRole[] = [];
    const missing: EnrichRole[] = [];

    for (const [role, { value }] of wanted) {
      const target = mapping[role]!;

      if (!values.has(target.field)) {
        missing.push(role);
        continue;
      }

      const next = mergeField(values.get(target.field) ?? '', value, target.mode);

      if (next === null) {
        kept.push(role);
      } else {
        values.set(target.field, next);
        updates[target.field] = next;
        added.push(role);
      }
    }

    return { updates, added, kept, missing };
  };

  // Store the media whose field changes; a file that can't be stored is left out.
  for (const role of plan().added) {
    const file = wanted.get(role)?.file;

    if (!file) continue;

    try {
      await anki.storeMedia(file.fileName, await file.load());
    } catch (error) {
      wanted.delete(role);
      result.skipped.push({
        what: ROLE_LABELS[role].toLowerCase(),
        reason: (error as Error)?.message ?? String(error)
      });
    }
  }

  const { updates, added, kept, missing } = plan();
  const label = (role: EnrichRole) => ROLE_LABELS[role].toLowerCase();
  result.added.push(...added.map(label));
  result.kept.push(...kept.map(label));

  for (const role of missing) {
    result.skipped.push({
      what: label(role),
      reason: `the note type has no field "${mapping[role]!.field}"`
    });
  }

  const tag = input.titleTag(input.title, input.tagPrefix);
  const addTag = !!tag && !note.tags.includes(tag);

  if (!tag) {
    result.skipped.push({ what: 'tag', reason: 'the book has no title' });
  } else if (!addTag) {
    result.kept.push('tag');
  }

  // Anki's editor keeps the note it shows and saves it back, so a Browse window showing the
  // note is moved off it for the fields and the tag both, and put back afterwards.
  const selection =
    Object.keys(updates).length || addTag ? await anki.releaseNote(note.noteId) : null;

  try {
    if (Object.keys(updates).length) {
      try {
        await anki.updateFields(note.noteId, updates);
      } catch (error) {
        throw new EnrichError(
          `Anki didn't take the changes: ${(error as Error)?.message ?? error}`,
          'anki'
        );
      }
    }

    if (addTag && tag) {
      try {
        await anki.addTags(note.noteId, tag);
        result.added.unshift('tag');
      } catch (error) {
        result.skipped.push({
          what: 'tag',
          reason:
            anki.isAndroid && error instanceof AnkiConnectError
              ? 'AnkiConnect Android did not add it'
              : ((error as Error)?.message ?? String(error))
        });
      }
    }
  } finally {
    await anki.restoreSelection(selection);
  }

  return result;
}

/** The banner text for a result. */
export function describeResult(result: EnrichResult): string {
  const name = result.word ? `「${result.word}」` : 'the last card';
  const parts: string[] = [];

  if (result.added.length) {
    parts.push(`Added ${result.added.join(', ')} to ${name}.`);
  } else {
    parts.push(`Nothing new to add to ${name}.`);
  }

  if (result.kept.length) {
    parts.push(`Already there: ${result.kept.join(', ')}.`);
  }

  for (const s of result.skipped) {
    parts.push(`No ${s.what}: ${s.reason}.`);
  }

  if (result.unmapped) {
    parts.push(`No fields are set up for the note type "${result.noteType}" (Settings > Anki).`);
  }

  return parts.join(' ');
}
