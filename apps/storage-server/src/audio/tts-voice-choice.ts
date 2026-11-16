/**
 * Season 2 Phase 12: the voice and model the PC reads with (decided with the user,
 * 2026-11-14/15). One choice for every book (Settings > Anki, "Sentence audio from the PC";
 * none = off) and an optional one per book (the book page's Audiobook section). Enrich's
 * sentence audio for a book without an audiobook uses the book's choice, else the global
 * one; "Make an audiobook on the PC" starts from the same choice.
 *
 * Stored in ttsu.db (tts_voice_choices) like the pronunciation fixes: every device sees the
 * same choice, and changing it needs the server, which the PC voices need anyway.
 */
import type Database from 'better-sqlite3';
import type { VoiceService, Voice } from '../voices/voice-service';
import { JobRequestError } from './subtitle-jobs';
import type { TtsModel, TtsModelService } from './tts-models';

export interface VoiceChoice {
  voiceId: string;
  modelId: number;
  updatedAt: number;
}

/** A choice with what it names now (null when the voice or the model is gone). */
export interface ChoiceView extends VoiceChoice {
  voiceName: string | null;
  modelLabel: string | null;
  /** Why it can't be used now (the voice deleted, the model removed or can't copy a voice). */
  problem: string | null;
}

export interface BookChoices {
  book: ChoiceView | null;
  global: ChoiceView | null;
  /** The one the PC uses for this book (the book's, else the global one), or null = off. */
  effective: (ChoiceView & { from: 'book' | 'global' }) | null;
}

export class VoiceChoiceService {
  constructor(
    private readonly db: Database.Database,
    private readonly voices: VoiceService | null,
    private readonly models: TtsModelService,
    private readonly now: () => number = Date.now,
  ) {}

  private row(userId: string, bookId: string | null): VoiceChoice | null {
    const r = (
      bookId === null
        ? this.db
            .prepare('SELECT * FROM tts_voice_choices WHERE user_id = ? AND book_id IS NULL')
            .get(userId)
        : this.db
            .prepare('SELECT * FROM tts_voice_choices WHERE user_id = ? AND book_id = ?')
            .get(userId, bookId)
    ) as { voice_id: string; model_id: number; updated_at: number } | undefined;
    return r ? { voiceId: r.voice_id, modelId: r.model_id, updatedAt: r.updated_at } : null;
  }

  private view(userId: string, c: VoiceChoice | null): ChoiceView | null {
    if (!c) return null;
    const voice = this.voices?.get(userId, c.voiceId) ?? null;
    const model = this.models.get(c.modelId);
    const present = model && model.removedAt === null ? model : null;
    let problem: string | null = null;
    if (!voice) problem = 'the chosen voice was deleted';
    else if (!present) problem = 'the chosen model was removed';
    else if (present.supportsClip === false) problem = `${present.label} can't copy a voice preset`;
    return {
      ...c,
      voiceName: voice?.name ?? null,
      modelLabel: present?.label ?? null,
      problem,
    };
  }

  global(userId: string): ChoiceView | null {
    return this.view(userId, this.row(userId, null));
  }

  forBook(userId: string, bookId: string): BookChoices {
    const book = this.view(userId, this.row(userId, bookId));
    const global = this.global(userId);
    const effective = book
      ? { ...book, from: 'book' as const }
      : global
        ? { ...global, from: 'global' as const }
        : null;
    return { book, global, effective };
  }

  /** The voice and model to read with, or why not (409); null = off for this book. */
  resolve(userId: string, bookId: string): { voice: Voice; model: TtsModel } | null {
    const { effective } = this.forBook(userId, bookId);
    if (!effective) return null;
    const where = effective.from === 'book' ? "on the book's page" : 'in Settings > Anki';
    if (effective.problem) {
      throw new JobRequestError(
        409,
        'bad_choice',
        `${capital(effective.problem)}: choose again ${where}`,
      );
    }
    return {
      voice: this.voices!.get(userId, effective.voiceId)!,
      model: this.models.get(effective.modelId)!,
    };
  }

  /** Saves a choice (null book = every book). Refuses a voice or model that can't be used. */
  set(userId: string, bookId: string | null, input: { voiceId?: unknown; modelId?: unknown }) {
    if (!this.voices) {
      throw new JobRequestError(503, 'voices_off', 'Voice presets are off on this server');
    }
    const voice = typeof input.voiceId === 'string' ? this.voices.get(userId, input.voiceId) : null;
    if (!voice) throw new JobRequestError(400, 'no_voice', 'Choose a voice');
    const model = typeof input.modelId === 'number' ? this.models.get(input.modelId) : null;
    if (!model || model.removedAt !== null) {
      throw new JobRequestError(400, 'no_model', 'Choose a model from the list');
    }
    if (model.supportsClip === false) {
      throw new JobRequestError(400, 'model_no_clip', `${model.label} can't copy a voice preset`);
    }
    const now = this.now();
    this.db.transaction(() => {
      this.clear(userId, bookId);
      this.db
        .prepare(
          'INSERT INTO tts_voice_choices (user_id, book_id, voice_id, model_id, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(userId, bookId, voice.id, model.id, now);
    })();
  }

  /** Removes a choice: the global one switches PC sentence audio off; a book's uses Settings. */
  clear(userId: string, bookId: string | null): void {
    if (bookId === null) {
      this.db
        .prepare('DELETE FROM tts_voice_choices WHERE user_id = ? AND book_id IS NULL')
        .run(userId);
    } else {
      this.db
        .prepare('DELETE FROM tts_voice_choices WHERE user_id = ? AND book_id = ?')
        .run(userId, bookId);
    }
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
