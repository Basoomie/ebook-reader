/**
 * Season 2 Phase 12 session 5: a book's characters, its quotes' speakers and the user's
 * corrections (ttsu.db schema 24, migrations.ts).
 *
 * - Characters have a number in the book (`no`, C<no> in the model's prompts). A run starts
 *   from the stored list (`seeds`), so they keep their numbers, names and voices.
 * - Each quote row keeps the model's answer and the user's correction apart: a run writes
 *   only the model columns, so a correction is never overwritten. The speaker used is the
 *   user's when set, else the model's; a hidden character ("not a character") counts as none.
 * - Quote rows are keyed by their text (`SpeakerQuote.key`), so a book whose quotes were
 *   renumbered (a changed EPUB, a new dialogue rule) finds them again (`rekey`); a row whose
 *   quote is gone is kept as "no longer in the book" (lost).
 */
import type Database from 'better-sqlite3';
import type { Gender, MergedCharacter } from './speaker-merge';
import type { RunResult } from './speaker-run';
import type { SpeakerQuote } from './speaker-text';

export interface StoredCharacter {
  id: number;
  no: number;
  name: string;
  aliases: string[];
  firstPerson: string[];
  gender: Gender;
  narrator: boolean;
  voiceId: string | null;
  origin: 'model' | 'user';
  edited: boolean;
  hidden: boolean;
  /** How many quotes it speaks now (corrections counted, lost quotes not). */
  quotes: number;
}

export interface SpeakerBookRow {
  jobId: number | null;
  modelId: number | null;
  promptVersion: number | null;
  scriptVersion: number | null;
  dialogueRule: number | null;
  fileKey: string | null;
  quotes: number | null;
  finishedAt: number | null;
  narrationBy: 'narration' | 'narrator';
}

export interface StoredQuote {
  quote: number;
  key: string;
  text: string;
  paragraph: number | null;
  position: number | null;
  /** The speaker used: the user's correction, else the model's (null: none). */
  character: number | null;
  modelCharacter: number | null;
  modelP: number | null;
  modelUnknown: boolean;
  /** The user set this quote's speaker (`character` is theirs; null = "no speaker"). */
  corrected: boolean;
  lost: boolean;
}

export class SpeakerEditError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface CharacterRow {
  id: number;
  no: number;
  name: string;
  aliases: string;
  first_person: string;
  gender: Gender;
  narrator: number;
  voice_id: string | null;
  origin: 'model' | 'user';
  edited: number;
  hidden: number;
  quotes?: number;
}

interface QuoteRow {
  quote: number;
  quote_key: string;
  text: string;
  paragraph: number | null;
  position: number | null;
  model_character: number | null;
  model_p: number | null;
  model_unknown: number;
  user_set: number;
  user_character: number | null;
  lost: number;
}

const json = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

function toCharacter(r: CharacterRow): StoredCharacter {
  return {
    id: r.id,
    no: r.no,
    name: r.name,
    aliases: json(r.aliases),
    firstPerson: json(r.first_person),
    gender: r.gender,
    narrator: r.narrator === 1,
    voiceId: r.voice_id,
    origin: r.origin,
    edited: r.edited === 1,
    hidden: r.hidden === 1,
    quotes: r.quotes ?? 0,
  };
}

function toQuote(r: QuoteRow): StoredQuote {
  return {
    quote: r.quote,
    key: r.quote_key,
    text: r.text,
    paragraph: r.paragraph,
    position: r.position,
    character: r.user_set === 1 ? r.user_character : r.model_character,
    modelCharacter: r.model_character,
    modelP: r.model_p,
    modelUnknown: r.model_unknown === 1,
    corrected: r.user_set === 1,
    lost: r.lost === 1,
  };
}

const uniq = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))];

/** The speaker of a quote as SQL (the user's correction, else the model's). */
const SPEAKER_SQL = 'CASE WHEN q.user_set = 1 THEN q.user_character ELSE q.model_character END';

export const MAX_NAME = 40;

export interface RunRecord {
  jobId: number;
  modelId: number | null;
  promptVersion: number;
  scriptVersion: number;
  dialogueRule: number;
  fileKey: string;
}

export class SpeakerStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  book(userId: string, bookId: string): SpeakerBookRow | null {
    const r = this.db
      .prepare('SELECT * FROM speaker_books WHERE user_id = ? AND book_id = ?')
      .get(userId, bookId) as
      | {
          job_id: number | null;
          model_id: number | null;
          prompt_version: number | null;
          script_version: number | null;
          dialogue_rule: number | null;
          file_key: string | null;
          quotes: number | null;
          finished_at: number | null;
          narration_by: 'narration' | 'narrator';
        }
      | undefined;
    if (!r) return null;
    return {
      jobId: r.job_id,
      modelId: r.model_id,
      promptVersion: r.prompt_version,
      scriptVersion: r.script_version,
      dialogueRule: r.dialogue_rule,
      fileKey: r.file_key,
      quotes: r.quotes,
      finishedAt: r.finished_at,
      narrationBy: r.narration_by,
    };
  }

  characters(userId: string, bookId: string): StoredCharacter[] {
    return (
      this.db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM speaker_quotes q
              WHERE q.user_id = c.user_id AND q.book_id = c.book_id AND q.lost = 0
                AND ${SPEAKER_SQL} = c.id) AS quotes
           FROM speaker_characters c WHERE c.user_id = ? AND c.book_id = ? ORDER BY c.no`,
        )
        .all(userId, bookId) as CharacterRow[]
    ).map(toCharacter);
  }

  character(userId: string, bookId: string, id: number): StoredCharacter | null {
    return this.characters(userId, bookId).find((c) => c.id === id) ?? null;
  }

  /** The list a new run starts from: numbers, names and the user's edits kept. */
  seeds(userId: string, bookId: string): MergedCharacter[] {
    return this.characters(userId, bookId).map((c) => ({
      id: c.no,
      name: c.name,
      aliases: c.aliases,
      firstPerson: c.firstPerson,
      gender: c.gender,
      // The run finds where each character appears again.
      windows: [],
      narrator: c.narrator,
      fixed: c.edited || c.origin === 'user',
      hidden: c.hidden,
    }));
  }

  quotes(userId: string, bookId: string): StoredQuote[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM speaker_quotes WHERE user_id = ? AND book_id = ? ORDER BY lost, quote`,
        )
        .all(userId, bookId) as QuoteRow[]
    ).map(toQuote);
  }

  /** Saves a finished run: characters by number, the model's answer per quote. */
  saveRun(
    userId: string,
    bookId: string,
    run: RunRecord,
    result: RunResult,
    bookQuotes: SpeakerQuote[],
  ): void {
    const now = this.now();
    this.db.transaction(() => {
      const existing = new Map(
        (
          this.db
            .prepare('SELECT * FROM speaker_characters WHERE user_id = ? AND book_id = ?')
            .all(userId, bookId) as CharacterRow[]
        ).map((r) => [r.no, r]),
      );
      const idOfNo = new Map<number, number>();
      for (const c of result.characters) {
        const row = existing.get(c.id);
        if (row) {
          const keepName = row.edited === 1 || row.origin === 'user';
          const name = keepName ? row.name : c.name.slice(0, MAX_NAME);
          const aliases = uniq([...(keepName ? json(row.aliases) : []), ...c.aliases]).filter(
            (a) => a !== name,
          );
          this.db
            .prepare(
              `UPDATE speaker_characters SET name = ?, aliases = ?, first_person = ?, gender = ?,
                 narrator = ?, windows = ?, updated_at = ? WHERE id = ?`,
            )
            .run(
              name,
              JSON.stringify(aliases.slice(0, 30)),
              JSON.stringify(uniq([...json(row.first_person), ...c.firstPerson]).slice(0, 10)),
              row.gender !== '不明' && keepName ? row.gender : c.gender,
              c.narrator ? 1 : 0,
              c.windows.length,
              now,
              row.id,
            );
          idOfNo.set(c.id, row.id);
        } else {
          const id = Number(
            this.db
              .prepare(
                `INSERT INTO speaker_characters (user_id, book_id, no, name, aliases, first_person,
                   gender, narrator, origin, windows, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'model', ?, ?, ?)`,
              )
              .run(
                userId,
                bookId,
                c.id,
                c.name.slice(0, MAX_NAME),
                JSON.stringify(uniq(c.aliases).slice(0, 30)),
                JSON.stringify(uniq(c.firstPerson).slice(0, 10)),
                c.gender,
                c.narrator ? 1 : 0,
                c.windows.length,
                now,
                now,
              ).lastInsertRowid,
          );
          idOfNo.set(c.id, id);
        }
      }
      const answers = new Map(result.quotes.map((q) => [q.quote, q]));
      const upsert = this.db.prepare(
        `INSERT INTO speaker_quotes (user_id, book_id, quote_key, quote, text, paragraph, position,
           model_character, model_p, model_unknown, lost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (user_id, book_id, quote_key) DO UPDATE SET quote = excluded.quote,
           text = excluded.text, paragraph = excluded.paragraph, position = excluded.position,
           model_character = excluded.model_character, model_p = excluded.model_p,
           model_unknown = excluded.model_unknown, lost = 0`,
      );
      for (const q of bookQuotes) {
        const a = answers.get(q.quote);
        upsert.run(
          userId,
          bookId,
          q.key,
          q.quote,
          q.text,
          q.paragraph,
          q.position,
          a?.character != null ? (idOfNo.get(a.character) ?? null) : null,
          a?.p ?? null,
          a?.unknown ? 1 : 0,
        );
      }
      this.markLost(userId, bookId, bookQuotes);
      this.db
        .prepare(
          `INSERT INTO speaker_books (user_id, book_id, job_id, model_id, prompt_version,
             script_version, dialogue_rule, file_key, quotes, finished_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, book_id) DO UPDATE SET job_id = excluded.job_id,
             model_id = excluded.model_id, prompt_version = excluded.prompt_version,
             script_version = excluded.script_version, dialogue_rule = excluded.dialogue_rule,
             file_key = excluded.file_key, quotes = excluded.quotes,
             finished_at = excluded.finished_at, updated_at = excluded.updated_at`,
        )
        .run(
          userId,
          bookId,
          run.jobId,
          run.modelId,
          run.promptVersion,
          run.scriptVersion,
          run.dialogueRule,
          run.fileKey,
          bookQuotes.length,
          now,
          now,
        );
    })();
  }

  /** Rows whose quote is not among the book's quotes now: kept, marked lost. */
  private markLost(userId: string, bookId: string, bookQuotes: SpeakerQuote[]): void {
    const keys = new Set(bookQuotes.map((q) => q.key));
    const rows = this.db
      .prepare('SELECT quote_key, lost FROM speaker_quotes WHERE user_id = ? AND book_id = ?')
      .all(userId, bookId) as { quote_key: string; lost: number }[];
    const mark = this.db.prepare(
      'UPDATE speaker_quotes SET lost = ? WHERE user_id = ? AND book_id = ? AND quote_key = ?',
    );
    for (const r of rows) {
      const lost = keys.has(r.quote_key) ? 0 : 1;
      if (lost !== r.lost) mark.run(lost, userId, bookId, r.quote_key);
    }
  }

  /**
   * The book's quotes were renumbered (its EPUB or the dialogue rule changed): every row
   * whose text is still in the book gets its new number; the rest are lost.
   */
  rekey(
    userId: string,
    bookId: string,
    bookQuotes: SpeakerQuote[],
    current: { fileKey: string; scriptVersion: number; dialogueRule: number },
  ): void {
    this.db.transaction(() => {
      const set = this.db.prepare(
        `UPDATE speaker_quotes SET quote = ?, paragraph = ?, position = ?, lost = 0
         WHERE user_id = ? AND book_id = ? AND quote_key = ?`,
      );
      for (const q of bookQuotes) set.run(q.quote, q.paragraph, q.position, userId, bookId, q.key);
      this.markLost(userId, bookId, bookQuotes);
      this.db
        .prepare(
          `UPDATE speaker_books SET file_key = ?, script_version = ?, dialogue_rule = ?,
             quotes = ?, updated_at = ? WHERE user_id = ? AND book_id = ?`,
        )
        .run(
          current.fileKey,
          current.scriptVersion,
          current.dialogueRule,
          bookQuotes.length,
          this.now(),
          userId,
          bookId,
        );
    })();
  }

  // ---------------------------------------------------------------- the user's edits

  private mustGet(userId: string, bookId: string, id: number): CharacterRow {
    const row = this.db
      .prepare('SELECT * FROM speaker_characters WHERE id = ? AND user_id = ? AND book_id = ?')
      .get(id, userId, bookId) as CharacterRow | undefined;
    if (!row) throw new SpeakerEditError(404, 'not_found', 'No such character in this book');
    return row;
  }

  private checkName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > MAX_NAME || /[\r\n]/.test(name)) {
      throw new SpeakerEditError(
        400,
        'invalid_name',
        `A name is 1–${MAX_NAME} characters on one line`,
      );
    }
    return name;
  }

  addCharacter(userId: string, bookId: string, rawName: unknown): StoredCharacter {
    const name = this.checkName(rawName);
    const now = this.now();
    const id = this.db.transaction(() => {
      const no =
        ((
          this.db
            .prepare(
              'SELECT MAX(no) AS n FROM speaker_characters WHERE user_id = ? AND book_id = ?',
            )
            .get(userId, bookId) as { n: number | null }
        ).n ?? 0) + 1;
      return Number(
        this.db
          .prepare(
            `INSERT INTO speaker_characters (user_id, book_id, no, name, origin, edited, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'user', 1, ?, ?)`,
          )
          .run(userId, bookId, no, name, now, now).lastInsertRowid,
      );
    })();
    return this.character(userId, bookId, id)!;
  }

  /**
   * Renames, sets the voice, or hides a character. A new name keeps the old one as an alias,
   * so a later run still finds the character by it.
   */
  editCharacter(
    userId: string,
    bookId: string,
    id: number,
    input: { name?: unknown; voiceId?: unknown; hidden?: unknown },
    voiceExists: (voiceId: string) => boolean,
  ): StoredCharacter {
    const row = this.mustGet(userId, bookId, id);
    const now = this.now();
    if (input.name !== undefined) {
      const name = this.checkName(input.name);
      if (name !== row.name) {
        const aliases = uniq([...json(row.aliases), row.name]).filter((a) => a !== name);
        this.db
          .prepare(
            'UPDATE speaker_characters SET name = ?, aliases = ?, edited = 1, updated_at = ? WHERE id = ?',
          )
          .run(name, JSON.stringify(aliases.slice(0, 30)), now, id);
      }
    }
    if (input.voiceId !== undefined) {
      const voiceId = input.voiceId === null ? null : String(input.voiceId);
      if (voiceId !== null && !voiceExists(voiceId)) {
        throw new SpeakerEditError(400, 'bad_voice', 'No such voice preset');
      }
      this.db
        .prepare('UPDATE speaker_characters SET voice_id = ?, updated_at = ? WHERE id = ?')
        .run(voiceId, now, id);
    }
    if (input.hidden !== undefined) {
      this.db
        .prepare('UPDATE speaker_characters SET hidden = ?, updated_at = ? WHERE id = ?')
        .run(input.hidden === true ? 1 : 0, now, id);
    }
    return this.character(userId, bookId, id)!;
  }

  /**
   * Merges one character into another: its quotes (the model's and the user's), names and,
   * when the other has none, its voice. The merged one is deleted.
   */
  merge(userId: string, bookId: string, fromId: number, intoId: number): StoredCharacter {
    if (fromId === intoId) throw new SpeakerEditError(400, 'same', 'Choose another character');
    const from = this.mustGet(userId, bookId, fromId);
    const into = this.mustGet(userId, bookId, intoId);
    const now = this.now();
    this.db.transaction(() => {
      for (const col of ['model_character', 'user_character']) {
        this.db
          .prepare(
            `UPDATE speaker_quotes SET ${col} = ? WHERE user_id = ? AND book_id = ? AND ${col} = ?`,
          )
          .run(intoId, userId, bookId, fromId);
      }
      const aliases = uniq([...json(into.aliases), from.name, ...json(from.aliases)]).filter(
        (a) => a !== into.name,
      );
      this.db
        .prepare(
          `UPDATE speaker_characters SET aliases = ?, first_person = ?, voice_id = ?,
             narrator = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          JSON.stringify(aliases.slice(0, 30)),
          JSON.stringify(
            uniq([...json(into.first_person), ...json(from.first_person)]).slice(0, 10),
          ),
          into.voice_id ?? from.voice_id,
          into.narrator === 1 || from.narrator === 1 ? 1 : 0,
          now,
          intoId,
        );
      this.db.prepare('DELETE FROM speaker_characters WHERE id = ?').run(fromId);
    })();
    return this.character(userId, bookId, intoId)!;
  }

  /** The user's speaker for a quote (null: "no speaker"), or back to the model's (reset). */
  setQuoteSpeaker(
    userId: string,
    bookId: string,
    quote: number,
    input: { character?: unknown; reset?: unknown },
  ): StoredQuote {
    const row = this.db
      .prepare(
        'SELECT * FROM speaker_quotes WHERE user_id = ? AND book_id = ? AND quote = ? AND lost = 0',
      )
      .get(userId, bookId, quote) as QuoteRow | undefined;
    if (!row) throw new SpeakerEditError(404, 'not_found', 'No such quote in this book');
    if (input.reset === true) {
      this.db
        .prepare(
          `UPDATE speaker_quotes SET user_set = 0, user_character = NULL, user_at = NULL
           WHERE user_id = ? AND book_id = ? AND quote_key = ?`,
        )
        .run(userId, bookId, row.quote_key);
    } else {
      const character =
        input.character === null || input.character === undefined ? null : Number(input.character);
      if (character !== null) this.mustGet(userId, bookId, character);
      this.db
        .prepare(
          `UPDATE speaker_quotes SET user_set = 1, user_character = ?, user_at = ?
           WHERE user_id = ? AND book_id = ? AND quote_key = ?`,
        )
        .run(character, this.now(), userId, bookId, row.quote_key);
    }
    return toQuote(
      this.db
        .prepare('SELECT * FROM speaker_quotes WHERE user_id = ? AND book_id = ? AND quote_key = ?')
        .get(userId, bookId, row.quote_key) as QuoteRow,
    );
  }

  setNarrationBy(userId: string, bookId: string, by: unknown): 'narration' | 'narrator' {
    if (by !== 'narration' && by !== 'narrator') {
      throw new SpeakerEditError(
        400,
        'invalid',
        'Narration is read by the narration voice or the narrator',
      );
    }
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO speaker_books (user_id, book_id, narration_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, book_id) DO UPDATE SET narration_by = excluded.narration_by,
           updated_at = excluded.updated_at`,
      )
      .run(userId, bookId, by, now);
    return by;
  }

  /** Removes everything of a book (its characters, quotes, record). */
  forget(userId: string, bookId: string): void {
    this.db.transaction(() => {
      for (const t of ['speaker_quotes', 'speaker_characters', 'speaker_books']) {
        this.db.prepare(`DELETE FROM ${t} WHERE user_id = ? AND book_id = ?`).run(userId, bookId);
      }
    })();
  }
}
