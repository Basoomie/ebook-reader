/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { AnkiConnect, NoteInfo } from './anki-connect';
import { APPEND_SEPARATOR, isEmptyField, mergeField, type FieldMode } from './field-merge';
import { ENRICH_ROLES, ROLE_LABELS, type EnrichMapping, type EnrichRole } from './mapping';
import type { Sentence } from './sentence';

/**
 * WP14 "Enrich last card": adds what the book has to the most recently added note in
 * Anki. Always the book-title tag; then, as the note type's mapping says, the sentence,
 * sentence audio, cover and link. Each field is filled if empty, appended to, or
 * overwritten (Phase 8), as its mode says. Media is only fetched and stored when its field
 * will change.
 *
 * Overwrite (decided with the user, 2026-11-15): the field gets exactly what this tap has
 * for it. A media field gets only the new sound or picture; the old file is never deleted
 * (it stays in Anki's media folder until Check Media). When the field already shows the
 * same file (also as AnkiConnect Android's renamed copy), that copy is used and nothing is
 * stored. When there is nothing new for the field, it stays as it is and the reason is
 * shown.
 *
 * AnkiConnect Android: fields name the media as it stored them (it renames every file), and
 * the tag is left out with the reason (it can't add tags to an existing note).
 *
 * Enrich while offline (Season 2 §3): when the sentence audio can't be made now (the
 * library server can't be reached), it waits: its field stays as it is, the result says so
 * (`waiting`), and the caller keeps it for later (`pending/`). The field's mode is applied
 * when the clip is added.
 */

export const ANDROID_NO_TAG = "AnkiConnect Android can't add tags to a card that already exists";

export interface MediaFile {
  fileName: string;
  /** Base64 of the file's bytes. */
  load: () => Promise<string>;
}

/** A piece that can't be added, with the reason shown to the user. */
export interface Unavailable {
  skip: string;
}

/** A piece that will be added later, with when (shown as "… will be added <wait>."). */
export interface Waiting {
  wait: string;
}

/** Thrown by a MediaFile's `load` when the piece should wait instead of being left out. */
export class WaitError extends Error {
  constructor(readonly wait: string) {
    super(wait);
  }
}

/** The sentence audio waits: what the clip is added to later. */
export interface WaitingClip {
  field: string;
  mode: FieldMode;
  /** The field's value after this tap's write. */
  fieldAtTap: string;
  /** Overwrite of a field other roles fill too: their values, in role order. */
  shared?: { before: string[]; after: string[] };
  wait: string;
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
  /**
   * Resolved only when the note type maps a sentence-audio field and there is a sentence.
   * Waiting (or a `load` that throws WaitError): the clip is added later.
   */
  audio: (sentence: Sentence) => Promise<MediaFile | Unavailable | Waiting>;
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
  /** Overwritten: the field had something else, which this tap replaced. */
  replaced: string[];
  /** Already there (fill-if-empty on a filled field, or the same value appended before). */
  kept: string[];
  skipped: { what: string; reason: string }[];
  /** The note type has nothing mapped: only the tag was added. */
  unmapped: boolean;
  android: boolean;
  /** The sentence audio waits (only set then). */
  waiting?: WaitingClip;
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

function isWaiting(value: unknown): value is Waiting {
  return !!value && typeof value === 'object' && 'wait' in value;
}

type MediaKind = 'image' | 'sound';

/** The field value that shows or plays a stored media file. */
function mediaValue(kind: MediaKind, fileName: string): string {
  return kind === 'image' ? `<img src="${fileName}">` : `[sound:${fileName}]`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a field already shows or plays this file: under the asked-for name, or under the
 * name AnkiConnect Android stores it as. AnkiConnect Android passes the name without its
 * extension to AnkiDroid, which stores `<name>_<random number>.<ext>` on every store.
 */
export function holdsMedia(html: string, kind: MediaKind, fileName: string): boolean {
  return heldMediaName(html, kind, fileName) !== null;
}

/** The name under which a field shows or plays this file (see `holdsMedia`), or null. */
export function heldMediaName(html: string, kind: MediaKind, fileName: string): string | null {
  const dot = fileName.indexOf('.');
  const stem = escapeRegExp(dot < 0 ? fileName : fileName.slice(0, dot));
  const ext = dot < 0 ? '' : escapeRegExp(fileName.slice(dot));
  const name = `(${stem}(?:_\\d+)?${ext})`;
  const pattern =
    kind === 'image'
      ? new RegExp(`<img\\b[^>]*\\ssrc="${name}"`, 'i')
      : new RegExp(`\\[sound:${name}\\]`);

  return pattern.exec(html)?.[1] ?? null;
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

  return enrichNote(anki, note, input);
}

/**
 * Enrich's work on one given note (the newest for the button; a card just made with
 * Yomitan for automatic enrichment, Phase 8).
 */
export async function enrichNote(
  anki: AnkiConnect,
  note: NoteInfo,
  input: Omit<EnrichInput, 'days'>
): Promise<EnrichResult> {
  // Tells AnkiConnect Android apart (media names, no tag), as finding the newest note does.
  try {
    await anki.connect();
  } catch (error) {
    throw new EnrichError((error as Error).message, 'anki');
  }

  const result: EnrichResult = {
    noteId: note.noteId,
    noteType: note.modelName,
    word: noteWord(note),
    added: [],
    replaced: [],
    kept: [],
    skipped: [],
    unmapped: false,
    android: anki.isAndroid
  };
  const mapping = input.mapping[note.modelName] ?? {};
  const roles = ENRICH_ROLES.filter((role) => mapping[role]);
  result.unmapped = roles.length === 0;

  // What each mapped role would put in (media are resolved by name; bytes come later).
  const wanted = new Map<EnrichRole, { value: string; file?: MediaFile; kind?: MediaKind }>();
  // The sentence audio can't be made now: when it will be.
  let audioWait: string | null = null;

  // A media role: overwrite reuses the copy the field already shows (nothing is stored).
  const media = (role: EnrichRole, kind: MediaKind, file: MediaFile) => {
    const target = mapping[role]!;
    const held =
      target.mode === 'overwrite'
        ? heldMediaName(note!.fields[target.field]?.value ?? '', kind, file.fileName)
        : null;

    wanted.set(
      role,
      held
        ? { value: mediaValue(kind, held), kind }
        : { value: mediaValue(kind, file.fileName), file, kind }
    );
  };

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
        else media(role, 'image', cover);
      } else if (role === 'sentenceAudio') {
        if (!input.sentence) {
          result.skipped.push({ what: label, reason: input.noSentenceReason ?? 'no sentence' });
          continue;
        }

        const audio = await input.audio(input.sentence);
        if (isUnavailable(audio)) result.skipped.push({ what: label, reason: audio.skip });
        else if (isWaiting(audio)) audioWait = audio.wait;
        else media(role, 'sound', audio);
      }
    } catch (error) {
      result.skipped.push({ what: label, reason: (error as Error)?.message ?? String(error) });
    }
  }

  // Which fields change. Running values, so two roles mapped to one field both land. A field
  // that any of its roles overwrites gets exactly this tap's values for it, in role order
  // (so a second tap finds it equal and changes nothing).
  const plan = () => {
    const values = new Map(Object.entries(note!.fields).map(([k, v]) => [k, v.value]));
    const updates: Record<string, string> = {};
    const added: EnrichRole[] = [];
    const replaced: EnrichRole[] = [];
    const kept: EnrichRole[] = [];
    const missing: EnrichRole[] = [];
    const rebuilt = new Map<string, EnrichRole[]>();
    const audioTarget = audioWait !== null ? mapping.sentenceAudio : undefined;

    for (const role of wanted.keys()) {
      const target = mapping[role]!;

      if (!values.has(target.field)) missing.push(role);
      else if (target.mode === 'overwrite') rebuilt.set(target.field, []);
    }

    // A waiting overwrite: the field's other roles still get exactly this tap's values.
    if (audioTarget) {
      if (!values.has(audioTarget.field)) missing.push('sentenceAudio');
      else if (audioTarget.mode === 'overwrite' && !rebuilt.has(audioTarget.field)) {
        rebuilt.set(audioTarget.field, []);
      }
    }

    for (const [role, { value, file, kind }] of wanted) {
      const target = mapping[role]!;

      if (!values.has(target.field)) continue;

      const overwritten = rebuilt.get(target.field);

      if (overwritten) {
        overwritten.push(role);
        continue;
      }

      const existing = values.get(target.field) ?? '';

      // The same file under the name AnkiConnect Android gave it is already there too.
      if (file && kind && holdsMedia(existing, kind, file.fileName)) {
        kept.push(role);
        continue;
      }

      const next = mergeField(existing, value, target.mode);

      if (next === null) {
        kept.push(role);
      } else {
        values.set(target.field, next);
        updates[target.field] = next;
        added.push(role);
      }
    }

    for (const [field, fieldRoles] of rebuilt) {
      const existing = values.get(field) ?? '';
      const next = mergeField(
        existing,
        fieldRoles.map((role) => wanted.get(role)!.value).join(APPEND_SEPARATOR),
        'overwrite'
      );

      if (next === null) {
        kept.push(...fieldRoles);
      } else {
        values.set(field, next);
        updates[field] = next;
        (isEmptyField(existing) ? added : replaced).push(...fieldRoles);
      }
    }

    // The waiting clip: fill if empty into a field that has something now adds nothing (an
    // online tap would have found it filled too); otherwise it waits for this field.
    let waiting: WaitingClip | undefined;

    if (audioTarget && values.has(audioTarget.field)) {
      const fieldAtTap = values.get(audioTarget.field) ?? '';

      if (audioTarget.mode === 'fill-if-empty' && !isEmptyField(fieldAtTap)) {
        kept.push('sentenceAudio');
      } else {
        waiting = {
          field: audioTarget.field,
          mode: audioTarget.mode,
          fieldAtTap,
          wait: audioWait!
        };

        const others = rebuilt.get(audioTarget.field);

        if (audioTarget.mode === 'overwrite' && others?.length) {
          const at = ENRICH_ROLES.indexOf('sentenceAudio');
          const valueOf = (role: EnrichRole) => wanted.get(role)!.value;
          waiting.shared = {
            before: others.filter((r) => ENRICH_ROLES.indexOf(r) < at).map(valueOf),
            after: others.filter((r) => ENRICH_ROLES.indexOf(r) > at).map(valueOf)
          };
        }
      }
    }

    const inRoleOrder = (list: EnrichRole[]) => ENRICH_ROLES.filter((role) => list.includes(role));

    return {
      updates,
      added: inRoleOrder(added),
      replaced: inRoleOrder(replaced),
      kept: inRoleOrder(kept),
      missing,
      waiting
    };
  };

  // Store the media whose field changes; a file that can't be stored is left out. The field
  // gets the name AnkiConnect stored the file under: desktop AnkiConnect keeps the name,
  // AnkiConnect Android renames every file it stores.
  const first = plan();

  for (const role of [...first.added, ...first.replaced]) {
    const entry = wanted.get(role);
    const file = entry?.file;

    if (!entry || !file || !entry.kind) continue;

    try {
      const stored = await anki.storeMedia(file.fileName, await file.load());
      entry.value = mediaValue(entry.kind, stored);
    } catch (error) {
      wanted.delete(role);

      if (role === 'sentenceAudio' && error instanceof WaitError) {
        audioWait = error.wait;
        continue;
      }

      result.skipped.push({
        what: ROLE_LABELS[role].toLowerCase(),
        reason: (error as Error)?.message ?? String(error)
      });
    }
  }

  const { updates, added, replaced, kept, missing, waiting } = plan();
  const label = (role: EnrichRole) => ROLE_LABELS[role].toLowerCase();
  result.added.push(...added.map(label));
  result.replaced.push(...replaced.map(label));
  result.kept.push(...kept.map(label));

  for (const role of missing) {
    result.skipped.push({
      what: label(role),
      reason: `the note type has no field "${mapping[role]!.field}"`
    });
  }

  const tag = input.titleTag(input.title, input.tagPrefix);
  const tagMissing = !!tag && !note.tags.includes(tag);
  // AnkiConnect Android has no action that adds tags to an existing note.
  const addTag = tagMissing && !anki.isAndroid;

  if (!tag) {
    result.skipped.push({ what: 'tag', reason: 'the book has no title' });
  } else if (!tagMissing) {
    result.kept.push('tag');
  } else if (!addTag) {
    result.skipped.push({ what: 'tag', reason: ANDROID_NO_TAG });
  }

  if (waiting) result.waiting = waiting;

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
        result.skipped.push({ what: 'tag', reason: (error as Error)?.message ?? String(error) });
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
  }

  if (result.replaced.length) {
    parts.push(`Replaced ${result.replaced.join(', ')} in ${name}.`);
  }

  if (!result.added.length && !result.replaced.length && !result.waiting) {
    parts.push(`Nothing new to add to ${name}.`);
  }

  if (result.waiting) {
    parts.push(`${ROLE_LABELS.sentenceAudio} will be added ${result.waiting.wait}.`);
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
