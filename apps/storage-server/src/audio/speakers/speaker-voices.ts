/**
 * Season 2 Phase 12 session 5: character voices in what the PC reads (generated audiobooks,
 * previews, live read-aloud, Enrich's sentence clips).
 *
 * - `extend`: the book's characters that have a voice preset join the job's voice map v2 as
 *   keys `character:<no>` (as session 4 planned). When the book's narration is set to the
 *   narrator's voice (user, 2026-11-16) and the narrator has a voice, the narration role
 *   names that key.
 * - `assign`: each dialogue run gets the voice key of its quote's speaker. The quote is found
 *   by number *and* text: read-aloud numbers quotes on the device (its own copy), and a book
 *   may have been renumbered since its run, so a number whose text doesn't match looks for
 *   the nearest quote with that text. Not found, no speaker, a hidden character or a speaker
 *   without a voice: the dialogue voice, exactly as before.
 * - Unused character keys are dropped again (a preview or a clip loads only the clips it
 *   needs).
 */
import type { DialoguePart, ScriptSegment, VoiceMapV2 } from '../voice-map';
import { voiceRef } from '../tts-jobs';
import type { SpeakerStore, StoredCharacter, StoredQuote } from './speaker-store';

export interface VoiceLookup {
  byId(id: string): {
    id: string;
    name: string;
    kind: 'clip' | 'design';
    sha256: string;
    description: string | null;
  } | null;
}

export const characterKey = (no: number) => `character:${no}`;
const isCharacterKey = (key: string) => key.startsWith('character:');

const squeeze = (s: string) => s.normalize('NFKC').replace(/[\s「」『』]/gu, '');

/** How far (in quote numbers) a renumbered quote is looked for. */
const NEAR = 80;

interface BookSpeakers {
  characters: Map<number, StoredCharacter>;
  byNumber: Map<number, StoredQuote[]>;
  quotes: StoredQuote[];
  narrationBy: 'narration' | 'narrator';
  at: number;
}

export class SpeakerVoices {
  private readonly cache = new Map<string, BookSpeakers>();

  constructor(
    private readonly store: SpeakerStore,
    private readonly voices: VoiceLookup | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Forgets what was read for a book (after an edit). */
  changed(userId: string, bookId: string): void {
    this.cache.delete(`${userId}|${bookId}`);
  }

  private load(userId: string, bookId: string): BookSpeakers | null {
    const k = `${userId}|${bookId}`;
    const hit = this.cache.get(k);
    if (hit && this.now() - hit.at < 5_000) return hit;
    const book = this.store.book(userId, bookId);
    const characters = this.store.characters(userId, bookId);
    if (!book && !characters.length) {
      this.cache.delete(k);
      return null;
    }
    const quotes = this.store.quotes(userId, bookId).filter((q) => !q.lost);
    const byNumber = new Map<number, StoredQuote[]>();
    for (const q of quotes) {
      const list = byNumber.get(q.quote) ?? [];
      list.push(q);
      byNumber.set(q.quote, list);
    }
    const loaded: BookSpeakers = {
      characters: new Map(characters.map((c) => [c.id, c])),
      byNumber,
      quotes,
      narrationBy: book?.narrationBy ?? 'narration',
      at: this.now(),
    };
    this.cache.set(k, loaded);
    return loaded;
  }

  /** The stored quote a part of a sentence belongs to: by number, checked by its text. */
  private find(b: BookSpeakers, quote: number, partText: string): StoredQuote | null {
    const piece = squeeze(partText);
    const fits = (q: StoredQuote) => !piece || squeeze(q.text).includes(piece);
    const exact = (b.byNumber.get(quote) ?? []).find(fits);
    if (exact) return exact;
    if (!piece) return null;
    let best: StoredQuote | null = null;
    for (let d = 1; d <= NEAR && !best; d++) {
      for (const n of [quote - d, quote + d]) {
        const hit = (b.byNumber.get(n) ?? []).find(fits);
        if (hit) {
          best = hit;
          break;
        }
      }
    }
    return best;
  }

  private voiced(c: StoredCharacter | undefined): c is StoredCharacter & { voiceId: string } {
    return !!c && !c.hidden && !!c.voiceId && !!this.voices?.byId(c.voiceId);
  }

  /**
   * Adds the book's voiced characters to `map` (and the narrator's voice for the narration,
   * when chosen). Returns the voice presets added (read-aloud loads their clips).
   */
  extend(
    userId: string,
    bookId: string,
    map: VoiceMapV2,
  ): { key: string; voiceId: string; sha256: string }[] {
    const b = this.load(userId, bookId);
    if (!b || !this.voices) return [];
    const added: { key: string; voiceId: string; sha256: string }[] = [];
    for (const c of b.characters.values()) {
      if (!this.voiced(c)) continue;
      const v = this.voices.byId(c.voiceId)!;
      const key = characterKey(c.no);
      map.voices[key] = voiceRef(v, bookId);
      added.push({ key, voiceId: v.id, sha256: v.sha256 });
      if (c.narrator && b.narrationBy === 'narrator') map.roles.narration = key;
    }
    return added;
  }

  /**
   * Gives each dialogue run of `sentences` its speaker's voice key (when that key is in the
   * map). `prune`: character keys no run uses are dropped from the map. Records what it did
   * in `map.speakers`.
   */
  assign(
    userId: string,
    bookId: string,
    sentences: { text: string; parts?: DialoguePart[]; segments?: ScriptSegment[] }[],
    map: VoiceMapV2,
    { prune }: { prune: boolean },
  ): void {
    const b = this.load(userId, bookId);
    const used = new Set<string>();
    let quotes = 0;
    if (b) {
      const speaker = new Map<number, string | null>();
      for (const s of sentences) {
        for (const p of s.parts ?? []) {
          if (speaker.has(p.quote)) continue;
          const q = this.find(b, p.quote, s.text.slice(p.start, p.end));
          const c = q?.character != null ? b.characters.get(q.character) : undefined;
          const key = c && !c.hidden && c.voiceId ? characterKey(c.no) : null;
          speaker.set(p.quote, key && map.voices[key] ? key : null);
        }
      }
      const counted = new Set<number>();
      for (const s of sentences) {
        for (const seg of s.segments ?? []) {
          if (seg.role !== 'dialogue' || seg.quote === null) continue;
          const key = speaker.get(seg.quote);
          if (!key) continue;
          seg.voice = key;
          used.add(key);
          if (!counted.has(seg.quote)) {
            counted.add(seg.quote);
            quotes++;
          }
        }
      }
    }
    if (prune) {
      for (const key of Object.keys(map.voices)) {
        if (isCharacterKey(key) && !used.has(key) && !Object.values(map.roles).includes(key)) {
          delete map.voices[key];
        }
      }
    }
    const characters = Object.keys(map.voices).filter(isCharacterKey).length;
    if (characters || quotes) {
      map.speakers = {
        characters,
        quotes,
        narrator: isCharacterKey(map.roles.narration),
      };
    }
  }
}
