/**
 * Season 2 Phase 12 session 5: the speaker models offered (Settings > Audiobooks, "Speaker
 * models on the PC"; an editable list, user 2026-11-16). A model is one GGUF file of a
 * Hugging Face repo, pinned to the revision current when it was added, with the file's size
 * and sha256 (Hugging Face's LFS record) so the PC can check its download. Removing a model
 * hides it; the PC deletes its folder. Seeded with the model picked in step A (2026-11-17):
 * unsloth/gemma-4-26B-A4B-it-GGUF, gemma-4-26B-A4B-it-UD-IQ4_XS.gguf.
 */
import type Database from 'better-sqlite3';
import { ModelRequestError, huggingFaceRevision, type RevisionLookup } from '../tts-models';

export interface SpeakerModel {
  id: number;
  repo: string;
  file: string;
  revision: string;
  size: number | null;
  sha256: string | null;
  label: string;
  isDefault: boolean;
  addedAt: number;
  removedAt: number | null;
}

interface Row {
  id: number;
  repo: string;
  file: string;
  revision: string;
  size: number | null;
  sha256: string | null;
  label: string;
  is_default: number;
  added_at: number;
  removed_at: number | null;
}

const toModel = (r: Row): SpeakerModel => ({
  id: r.id,
  repo: r.repo,
  file: r.file,
  revision: r.revision,
  size: r.size,
  sha256: r.sha256,
  label: r.label,
  isDefault: r.is_default === 1,
  addedAt: r.added_at,
  removedAt: r.removed_at,
});

const REPO_PATTERN = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
const FILE_PATTERN = /^[A-Za-z0-9][\w.+-]*\.gguf$/;

/** The folder the PC keeps a model in: `<owner>--<name>/<revision>`. */
export function speakerModelDir(m: { repo: string; revision: string }): string {
  return `${m.repo.split('/').join('--')}/${m.revision}`;
}

/** Looks up a file of a repo at a revision: its size and sha256. */
export type FileLookup = (
  repo: string,
  revision: string,
  file: string,
) => Promise<{ size: number; sha256: string | null }>;

export const huggingFaceFile: FileLookup = async (repo, revision, file) => {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/paths-info/${revision}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [file] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new ModelRequestError(502, 'lookup_failed', `Hugging Face answered ${res.status}`);
  }
  const list = (await res.json()) as { path?: string; size?: number; lfs?: { oid?: string } }[];
  const entry = Array.isArray(list) ? list.find((e) => e.path === file) : undefined;
  if (!entry || typeof entry.size !== 'number') {
    throw new ModelRequestError(404, 'file_not_found', `${repo} has no file ${file}`);
  }
  const sha = entry.lfs?.oid;
  return {
    size: entry.size,
    sha256: typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
  };
};

export class SpeakerModelService {
  constructor(
    private readonly db: Database.Database,
    private readonly lookupRevision: RevisionLookup = huggingFaceRevision,
    private readonly lookupFile: FileLookup = huggingFaceFile,
    private readonly now: () => number = Date.now,
  ) {}

  list(): SpeakerModel[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM speaker_models WHERE removed_at IS NULL ORDER BY is_default DESC, added_at, id',
        )
        .all() as Row[]
    ).map(toModel);
  }

  /** Removed models whose files the PC should delete (no listed model shares the folder). */
  removed(): SpeakerModel[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM speaker_models m WHERE removed_at IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM speaker_models k WHERE k.removed_at IS NULL
               AND k.repo = m.repo AND k.revision = m.revision)`,
        )
        .all() as Row[]
    ).map(toModel);
  }

  get(id: number): SpeakerModel | null {
    const r = this.db.prepare('SELECT * FROM speaker_models WHERE id = ?').get(id) as
      | Row
      | undefined;
    return r ? toModel(r) : null;
  }

  defaultModel(): SpeakerModel | null {
    return this.list()[0] ?? null;
  }

  async add(input: { repo?: unknown; file?: unknown; label?: unknown }): Promise<SpeakerModel> {
    const repo =
      typeof input.repo === 'string'
        ? input.repo
            .trim()
            .replace(/^https?:\/\/huggingface\.co\//i, '')
            .replace(/\/+$/, '')
        : '';
    if (!REPO_PATTERN.test(repo)) {
      throw new ModelRequestError(
        400,
        'invalid_model',
        'Enter a Hugging Face repo like unsloth/gemma-4-26B-A4B-it-GGUF',
      );
    }
    const file = typeof input.file === 'string' ? input.file.trim() : '';
    if (!FILE_PATTERN.test(file)) {
      throw new ModelRequestError(
        400,
        'invalid_file',
        'Enter the name of one .gguf file of the repo',
      );
    }
    const exists = this.db
      .prepare('SELECT 1 FROM speaker_models WHERE repo = ? AND file = ? AND removed_at IS NULL')
      .get(repo, file);
    if (exists) throw new ModelRequestError(409, 'exists', 'This model is in the list already');
    const revision = await this.lookupRevision(repo);
    const { size, sha256 } = await this.lookupFile(repo, revision, file);
    const label =
      typeof input.label === 'string' && input.label.trim()
        ? input.label.trim().slice(0, 80)
        : file.replace(/\.gguf$/, '');
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO speaker_models (repo, file, revision, size, sha256, label, is_default, added_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(repo, file, revision, size, sha256, label, this.now()).lastInsertRowid,
    );
    if (this.list().length === 1) this.setDefault(id);
    return this.get(id)!;
  }

  remove(id: number): boolean {
    const m = this.get(id);
    if (!m || m.removedAt !== null) return false;
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE speaker_models SET removed_at = ?, is_default = 0 WHERE id = ?')
        .run(this.now(), id);
      if (m.isDefault) {
        const next = this.db
          .prepare(
            'SELECT id FROM speaker_models WHERE removed_at IS NULL ORDER BY added_at, id LIMIT 1',
          )
          .get() as { id: number } | undefined;
        if (next)
          this.db.prepare('UPDATE speaker_models SET is_default = 1 WHERE id = ?').run(next.id);
      }
    })();
    return true;
  }

  setDefault(id: number): boolean {
    const m = this.get(id);
    if (!m || m.removedAt !== null) return false;
    this.db.transaction(() => {
      this.db.prepare('UPDATE speaker_models SET is_default = 0').run();
      this.db.prepare('UPDATE speaker_models SET is_default = 1 WHERE id = ?').run(id);
    })();
    return true;
  }
}
