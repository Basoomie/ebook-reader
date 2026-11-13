/**
 * WP17: the TTS models offered for generated audiobooks (Settings > Audiobooks > "Models on
 * the PC"). Decided with the user (2026-11-12): the model is chosen per book; the list is
 * editable. A model is a Hugging Face repo (optionally `/subfolder` for one variant of a
 * repo), pinned to the revision (commit) recorded when it was added, so it can't change
 * under a book later. Removing a model hides it; the PC then deletes its files. Audiobooks
 * already made keep their record of the model and revision they were made with.
 *
 * Only `model.safetensors` and tokenizer files are ever downloaded by the PC (no code).
 */
import type Database from 'better-sqlite3';

export interface TtsModel {
  id: number;
  /** `owner/name` or `owner/name/subfolder`. */
  source: string;
  revision: string;
  label: string;
  note: string | null;
  /** null = not known yet (the PC reports it on first use). */
  supportsDescription: boolean | null;
  supportsClip: boolean | null;
  isDefault: boolean;
  addedAt: number;
  removedAt: number | null;
}

interface ModelRow {
  id: number;
  source: string;
  revision: string;
  label: string;
  note: string | null;
  supports_description: number | null;
  supports_clip: number | null;
  is_default: number;
  added_at: number;
  removed_at: number | null;
}

const flag = (v: number | null) => (v === null ? null : v === 1);

function toModel(r: ModelRow): TtsModel {
  return {
    id: r.id,
    source: r.source,
    revision: r.revision,
    label: r.label,
    note: r.note,
    supportsDescription: flag(r.supports_description),
    supportsClip: flag(r.supports_clip),
    isDefault: r.is_default === 1,
    addedAt: r.added_at,
    removedAt: r.removed_at,
  };
}

/** `owner/name[/sub/folders]`: Hugging Face name characters only, no `..`. */
const SOURCE_PATTERN = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*(\/[A-Za-z0-9][\w.-]*)*$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

export class ModelRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parseSource(raw: unknown): string {
  const source =
    typeof raw === 'string'
      ? raw
          .trim()
          .replace(/^https?:\/\/huggingface\.co\//i, '')
          .replace(/\/+$/, '')
      : '';
  if (!SOURCE_PATTERN.test(source) || source.split('/').some((p) => p === '..' || p === '.')) {
    throw new ModelRequestError(
      400,
      'invalid_model',
      'Enter a Hugging Face model name like Aratako/Irodori-TTS-v4.1-Small',
    );
  }
  return source;
}

/** The repo part of a source (`owner/name`). */
export const repoOf = (source: string) => source.split('/').slice(0, 2).join('/');

/** The folder the PC keeps a model in: `<owner>--<name>[--<sub>]/<revision>`. */
export function modelDirName(source: string, revision: string): string {
  return `${source.split('/').join('--')}/${revision}`;
}

/** Looks up a repo's current revision (commit) on Hugging Face. */
export type RevisionLookup = (repo: string) => Promise<string>;

export const huggingFaceRevision: RevisionLookup = async (repo) => {
  const res = await fetch(`https://huggingface.co/api/models/${repo}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404 || res.status === 401) {
    throw new ModelRequestError(404, 'model_not_found', `Hugging Face has no model ${repo}`);
  }
  if (!res.ok) {
    throw new ModelRequestError(502, 'lookup_failed', `Hugging Face answered ${res.status}`);
  }
  const body = (await res.json()) as { sha?: unknown; gated?: unknown };
  if (body.gated && body.gated !== false) {
    throw new ModelRequestError(
      409,
      'gated',
      `${repo} needs a Hugging Face account to download; it can't be added`,
    );
  }
  if (typeof body.sha !== 'string' || !REVISION_PATTERN.test(body.sha)) {
    throw new ModelRequestError(502, 'lookup_failed', 'Hugging Face gave no revision');
  }
  return body.sha;
};

export class TtsModelService {
  constructor(
    private readonly db: Database.Database,
    private readonly lookup: RevisionLookup = huggingFaceRevision,
    private readonly now: () => number = Date.now,
  ) {}

  /** The models offered, the default first. */
  list(): TtsModel[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM tts_models WHERE removed_at IS NULL ORDER BY is_default DESC, added_at, id',
        )
        .all() as ModelRow[]
    ).map(toModel);
  }

  /** Models removed from the list (the PC deletes their files). */
  removed(): TtsModel[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tts_models m WHERE removed_at IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM tts_models k WHERE k.removed_at IS NULL
               AND k.source = m.source AND k.revision = m.revision)`,
        )
        .all() as ModelRow[]
    ).map(toModel);
  }

  get(id: number): TtsModel | null {
    const row = this.db.prepare('SELECT * FROM tts_models WHERE id = ?').get(id) as
      | ModelRow
      | undefined;
    return row ? toModel(row) : null;
  }

  /** The model to use when none is chosen. */
  defaultModel(): TtsModel | null {
    return this.list()[0] ?? null;
  }

  async add(input: { source?: unknown; label?: unknown }): Promise<TtsModel> {
    const source = parseSource(input.source);
    const exists = this.db
      .prepare('SELECT 1 FROM tts_models WHERE source = ? AND removed_at IS NULL')
      .get(source);
    if (exists) throw new ModelRequestError(409, 'exists', 'This model is in the list already');
    const revision = await this.lookup(repoOf(source));
    const label =
      typeof input.label === 'string' && input.label.trim() !== ''
        ? input.label.trim().slice(0, 80)
        : source.split('/').slice(1).join(' ');
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO tts_models (source, revision, label, is_default, added_at)
           VALUES (?, ?, ?, 0, ?)`,
        )
        .run(source, revision, label, this.now()).lastInsertRowid,
    );
    if (this.list().length === 1) this.setDefault(id);
    return this.get(id)!;
  }

  remove(id: number): boolean {
    const model = this.get(id);
    if (!model || model.removedAt !== null) return false;
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE tts_models SET removed_at = ?, is_default = 0 WHERE id = ?')
        .run(this.now(), id);
      if (model.isDefault) {
        const next = this.db
          .prepare(
            'SELECT id FROM tts_models WHERE removed_at IS NULL ORDER BY added_at, id LIMIT 1',
          )
          .get() as { id: number } | undefined;
        if (next) this.db.prepare('UPDATE tts_models SET is_default = 1 WHERE id = ?').run(next.id);
      }
    })();
    return true;
  }

  setDefault(id: number): boolean {
    const model = this.get(id);
    if (!model || model.removedAt !== null) return false;
    this.db.transaction(() => {
      this.db.prepare('UPDATE tts_models SET is_default = 0').run();
      this.db.prepare('UPDATE tts_models SET is_default = 1 WHERE id = ?').run(id);
    })();
    return true;
  }

  /** What the PC found out on first use (whether the model takes descriptions / clips). */
  recordCapabilities(
    source: string,
    revision: string,
    caps: { description: boolean; clip: boolean },
  ) {
    this.db
      .prepare(
        `UPDATE tts_models SET supports_description = ?, supports_clip = ?
         WHERE source = ? AND revision = ?`,
      )
      .run(caps.description ? 1 : 0, caps.clip ? 1 : 0, source, revision);
  }
}
