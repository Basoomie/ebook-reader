/**
 * Season 2 Phase 12 session 4: the voice map v2 and the sentence parts the PC reads with
 * different voices (decided with the user, 2026-11-16; decisions.md "Narration and dialogue
 * voices").
 *
 * - A job records its voices by key (`voices`: 'narration', 'dialogue'; per-character voices
 *   will add 'character:<id>') and which key reads each role (`roles`). One voice: the
 *   dialogue role names 'narration'. Each voice has its own seed (`seedFor(book, sha)`, so
 *   a v2 narration sounds like the same voice in v1).
 * - Jobs made before (v1: one `narrator`) are read through `normalizeVoiceMap`; stored rows
 *   are never rewritten.
 * - The book script (book-script.ts, v3) marks a sentence's dialogue runs (`parts`). When a
 *   job is queued, each such sentence gets `segments`: its runs in order, with the reading
 *   of each (the book's furigana and the pronunciation fixes kept), and the role and quote.
 *   The PC gets them as `{ reading, voice }` with the voice key; consecutive runs read by the
 *   same voice are joined, so a book read by one voice reaches the PC exactly as before.
 * - The PC never knows roles: it reads each segment with the named voice and keeps one cue
 *   per sentence (subtitles, whispersync, read-aloud's highlight and Enrich's cut unchanged).
 */
import { buildReading, type FixHit, type RubyRun } from '../pronunciation/fix-rules';
import type { FixSummary } from '../pronunciation/fix-service';

export interface Pauses {
  sentenceMs: number;
  paragraphMs: number;
  chapterMs: number;
  /** Between a sentence's narration and dialogue runs (session 4). */
  dialogueMs: number;
}

export const DEFAULT_PAUSES: Pauses = {
  sentenceMs: 300,
  paragraphMs: 700,
  chapterMs: 2000,
  dialogueMs: 150,
};

/** The dialogue rule the book script's `parts` follow (book-script.ts DIALOGUE_RULE_VERSION). */
export const DIALOGUE_RULE = 1;

export interface VoiceRef {
  voiceId: string | null;
  name: string;
  kind: 'clip' | 'design' | 'description';
  sha256: string | null;
  description: string | null;
  seed: number;
}

export interface ModelRef {
  id: number;
  source: string;
  revision: string;
  label: string;
}

/** The voice map, v1: one narrator (jobs queued before session 4). */
export interface VoiceMapV1 {
  mapVersion: 1;
  narrator: Omit<VoiceRef, 'seed'>;
  model: ModelRef;
  seed: number;
  pauses: Omit<Pauses, 'dialogueMs'> & { dialogueMs?: number };
  /** Preview: the chapter read. */
  chapterIndex?: number;
  chapterTitle?: string;
  /** Season 2 Phase 12: the pronunciation fixes used (absent: made before them, none). */
  fixes?: FixSummary;
}

export type Role = 'narration' | 'dialogue';

/** The voice map, v2: voices by key, and the key that reads each role. */
export interface VoiceMapV2 {
  mapVersion: 2;
  voices: Record<string, VoiceRef>;
  roles: Record<Role, string>;
  /** The dialogue rule of the script the job read. */
  dialogueRule: number;
  model: ModelRef;
  pauses: Pauses;
  chapterIndex?: number;
  chapterTitle?: string;
  fixes?: FixSummary;
  /**
   * Session 5 (per-character voices): the character voices the job uses (keys
   * 'character:<no>' in `voices`), how many quotes they read, and whether the narrator's
   * voice reads the narration.
   */
  speakers?: { characters: number; quotes: number; narrator: boolean };
}

export type StoredVoiceMap = VoiceMapV1 | VoiceMapV2;

/** Any stored voice map as v2 (null: none, or a version this server doesn't know). */
export function normalizeVoiceMap(raw: unknown): VoiceMapV2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as StoredVoiceMap;
  if (m.mapVersion === 2) {
    return { ...m, pauses: { ...DEFAULT_PAUSES, ...m.pauses } };
  }
  if (m.mapVersion === 1) {
    return {
      mapVersion: 2,
      voices: { narration: { ...m.narrator, seed: m.seed } },
      roles: { narration: 'narration', dialogue: 'narration' },
      dialogueRule: 0,
      model: m.model,
      pauses: { ...DEFAULT_PAUSES, ...m.pauses },
      ...(m.chapterIndex !== undefined ? { chapterIndex: m.chapterIndex } : {}),
      ...(m.chapterTitle !== undefined ? { chapterTitle: m.chapterTitle } : {}),
      ...(m.fixes ? { fixes: m.fixes } : {}),
    };
  }
  return null;
}

/** The voice that reads narration. */
export function narrationVoice(map: VoiceMapV2): VoiceRef {
  return map.voices[map.roles.narration];
}

/** The dialogue voice when it differs from the narration voice, else null. */
export function dialogueVoice(map: VoiceMapV2): VoiceRef | null {
  if (map.roles.dialogue === map.roles.narration) return null;
  return map.voices[map.roles.dialogue] ?? null;
}

/** The voice keys a job reads with: its roles' and its character voices (session 5). */
export function usedKeys(map: VoiceMapV2): Set<string> {
  return new Set([
    ...Object.values(map.roles),
    ...Object.keys(map.voices).filter((k) => k.startsWith('character:')),
  ]);
}

/** Whether the job reads with more than one voice (the PC needs worker 1.3.0). */
export function usesSeveralVoices(map: VoiceMapV2): boolean {
  return usedKeys(map).size > 1;
}

/** "voice A" or "voice A, dialogue voice B" (the m4b comment, logs). */
export function voicesLabel(map: VoiceMapV2): string {
  const d = dialogueVoice(map);
  const n = narrationVoice(map);
  const base = d ? `voice "${n.name}", dialogue voice "${d.name}"` : `voice "${n.name}"`;
  const c = map.speakers?.characters ?? 0;
  return c ? `${base}, voices for ${c} ${c === 1 ? 'character' : 'characters'}` : base;
}

/** A dialogue run of a sentence (book-script.ts v3). */
export interface DialoguePart {
  start: number;
  end: number;
  role: 'dialogue';
  quote: number;
}

/** One run of a sentence as the job keeps it: its reading, role and quote. */
export interface ScriptSegment {
  reading: string;
  role: Role;
  /** The quote's number in the book (dialogue only). */
  quote: number | null;
  /** Session 5: the voice key of the quote's speaker (none: the role's voice). */
  voice?: string;
}

const GAIJI_MARK = /〓/gu;

/**
 * A sentence's runs in order (narration and dialogue), each with its own reading: the
 * furigana runs and fix hits go to the run they start in, so the readings joined are exactly
 * the sentence's reading (`buildReading`). Undefined when the sentence has no dialogue runs.
 * A run whose reading is empty is left out.
 */
export function sentenceSegments(
  sentence: { text: string; reading: string; ruby?: RubyRun[]; parts?: DialoguePart[] },
  hits: FixHit[],
): ScriptSegment[] | undefined {
  const parts = sentence.parts ?? [];
  if (!parts.length) return undefined;
  const text = sentence.text;
  const pieces: { start: number; end: number; role: Role; quote: number | null }[] = [];
  let at = 0;
  for (const p of parts) {
    if (p.start > at) pieces.push({ start: at, end: p.start, role: 'narration', quote: null });
    pieces.push({ start: p.start, end: p.end, role: 'dialogue', quote: p.quote });
    at = p.end;
  }
  if (at < text.length)
    pieces.push({ start: at, end: text.length, role: 'narration', quote: null });

  const items = [
    ...(sentence.ruby ?? []).map((r) => ({ start: r.start, end: r.end, say: r.rt })),
    ...hits.map((h) => ({ start: h.start, end: h.end, say: h.reading })),
  ].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let item = 0;
  const out: ScriptSegment[] = [];
  for (const piece of pieces) {
    let reading = '';
    while (cursor < piece.end) {
      const next = items[item];
      if (next && next.start < piece.end) {
        reading += text.slice(cursor, next.start).replace(GAIJI_MARK, '') + next.say;
        cursor = Math.max(cursor, next.end);
        item += 1;
      } else {
        reading += text.slice(cursor, piece.end).replace(GAIJI_MARK, '');
        cursor = piece.end;
      }
    }
    if (reading) out.push({ reading, role: piece.role, quote: piece.quote });
  }
  return out.length > 1 || out[0]?.role === 'dialogue' ? out : undefined;
}

/** The reading of a sentence without fixes, from its runs (checks `sentenceSegments`). */
export function readingOf(sentence: { text: string; ruby?: RubyRun[] }): string {
  return buildReading({ text: sentence.text, reading: '', ruby: sentence.ruby }, []);
}

/** What the PC reads for one sentence: its runs by voice key (none: `reading` by narration). */
export interface WorkerSegment {
  reading: string;
  voice: string;
}

/**
 * A sentence's segments for the PC: each run's voice key from the map's roles, consecutive
 * runs of the same voice joined. Undefined when the whole sentence is read by narration's
 * voice (the PC then reads `reading`, as before session 4).
 */
export function workerSegments(
  segments: ScriptSegment[] | undefined,
  map: VoiceMapV2,
): WorkerSegment[] | undefined {
  if (!segments?.length) return undefined;
  const out: WorkerSegment[] = [];
  for (const s of segments) {
    // Session 5: a quote's speaker reads it in their own voice.
    const voice =
      s.voice && map.voices[s.voice] ? s.voice : (map.roles[s.role] ?? map.roles.narration);
    const last = out[out.length - 1];
    if (last && last.voice === voice) last.reading += s.reading;
    else out.push({ reading: s.reading, voice });
  }
  if (out.length === 1 && out[0].voice === map.roles.narration) return undefined;
  return out;
}

/** The voices the PC needs for a map: key → clip and seed (the roles' and the characters'). */
export function workerVoices(map: VoiceMapV2): Record<string, { sha256: string; seed: number }> {
  const out: Record<string, { sha256: string; seed: number }> = {};
  for (const key of usedKeys(map)) {
    const v = map.voices[key];
    if (v?.sha256) out[key] = { sha256: v.sha256, seed: v.seed };
  }
  return out;
}
