/**
 * Custom fonts (WP13): upload a font once from any device; every device gets it
 * through its "font" sync record and downloads the file. Which font a device uses
 * stays a per-device setting (decided 2026-11-10).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { SyncStore } from '../sync/store';
import { fontRecordData } from '../sync/kinds';
import { fontNameProblem, type FontFormat, MAX_FONT_FILE_NAME } from './font-format';
import { FontStore, FontTooLargeError, NotAFontError, type ReceivedFont } from './font-store';

export const FONT_KIND = 'font';

export class FontError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface StoredFont {
  id: string;
  userId: string;
  name: string;
  fileName: string;
  format: FontFormat;
  size: number;
  sha256: string;
  filePath: string;
  createdAt: number;
}

export interface FontServiceOptions {
  db: Database.Database;
  store: FontStore;
  sync: SyncStore;
  /** Largest accepted font file (FONT_MAX_MB). */
  maxBytes: number;
  log?: (message: string) => void;
}

interface FontDbRow {
  id: string;
  user_id: string;
  name: string;
  file_name: string;
  format: FontFormat;
  size: number;
  sha256: string;
  file_path: string;
  created_at: number;
}

function toFont(row: FontDbRow): StoredFont {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    fileName: row.file_name,
    format: row.format,
    size: row.size,
    sha256: row.sha256,
    filePath: row.file_path,
    createdAt: row.created_at,
  };
}

/** The file name as shown in the list: its last path part, at most 200 characters. */
export function cleanFileName(raw: string, format: FontFormat): string {
  const base = raw.split(/[\\/]/).pop()?.trim() ?? '';
  const chars = Array.from(base);
  return chars.length ? chars.slice(0, MAX_FONT_FILE_NAME).join('') : `font.${format}`;
}

export class FontService {
  readonly store: FontStore;
  readonly maxBytes: number;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: FontServiceOptions) {
    this.store = opts.store;
    this.maxBytes = opts.maxBytes;
    this.log = opts.log ?? console.log;
  }

  /** The user's fonts that are not deleted, by their sync records. */
  liveFonts(userId: string): StoredFont[] {
    const rows = this.opts.db
      .prepare(
        `SELECT f.* FROM fonts f
           JOIN sync_records r ON r.user_id = f.user_id AND r.kind = ? AND r.id = f.id
          WHERE f.user_id = ? AND r.deleted_at IS NULL
          ORDER BY f.created_at`,
      )
      .all(FONT_KIND, userId) as FontDbRow[];
    return rows.map(toFont);
  }

  /** One of the user's fonts (deleted or not), or null. */
  getFont(userId: string, fontId: string): StoredFont | null {
    const row = this.opts.db
      .prepare('SELECT * FROM fonts WHERE id = ? AND user_id = ?')
      .get(fontId, userId) as FontDbRow | undefined;
    return row ? toFont(row) : null;
  }

  /** Every font on the server, for the CLI. */
  static listAll(db: Database.Database): (StoredFont & { deleted: boolean })[] {
    const rows = db
      .prepare(
        `SELECT f.*, r.deleted_at FROM fonts f
           LEFT JOIN sync_records r ON r.user_id = f.user_id AND r.kind = ? AND r.id = f.id
          ORDER BY f.created_at`,
      )
      .all(FONT_KIND) as (FontDbRow & { deleted_at: number | null })[];
    return rows.map((r) => ({ ...toFont(r), deleted: r.deleted_at !== null }));
  }

  /** Throws FontError when the name can't be used for a new font of this user. */
  checkName(userId: string, name: string): void {
    const problem = fontNameProblem(name);
    if (problem) throw new FontError(400, 'invalid_name', problem);
    const lower = name.toLowerCase();
    if (this.liveFonts(userId).some((f) => f.name.toLowerCase() === lower)) {
      throw new FontError(409, 'name_taken', `There is already a font called "${name}"`);
    }
  }

  /**
   * Stores an uploaded font and writes its sync record as the uploading device.
   * The same bytes as one of the user's fonts give that font back (`existing`).
   */
  async upload(
    userId: string,
    deviceId: string,
    name: string,
    fileName: string,
    body: NodeJS.ReadableStream,
    now = Date.now(),
  ): Promise<{ font: StoredFont; existing: boolean }> {
    let received: ReceivedFont;
    try {
      received = await this.store.receive(body, this.maxBytes);
    } catch (err) {
      if (err instanceof FontTooLargeError) {
        throw new FontError(
          413,
          'too_large',
          `The file is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB`,
        );
      }
      if (err instanceof NotAFontError) {
        throw new FontError(
          422,
          'not_a_font',
          "This file isn't a font the reader can use (woff2, woff, ttf or otf)",
        );
      }
      throw err;
    }

    const same = this.liveFonts(userId).find((f) => f.sha256 === received.sha256);
    if (same) {
      await this.store.discard(received);
      return { font: same, existing: true };
    }
    try {
      this.checkName(userId, name);
    } catch (err) {
      await this.store.discard(received);
      throw err;
    }

    const id = randomUUID();
    const font: StoredFont = {
      id,
      userId,
      name,
      fileName: cleanFileName(fileName, received.format),
      format: received.format,
      size: received.size,
      sha256: received.sha256,
      filePath: FontStore.fontPath(id, received.format),
      createdAt: now,
    };
    await this.store.commit(received, id);
    try {
      this.opts.db.transaction(() => {
        this.opts.db
          .prepare(
            `INSERT INTO fonts (id, user_id, name, file_name, format, size, sha256, file_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            font.id,
            userId,
            font.name,
            font.fileName,
            font.format,
            font.size,
            font.sha256,
            font.filePath,
            font.createdAt,
          );
        const result = this.opts.sync.writeAs(
          userId,
          deviceId,
          {
            kind: FONT_KIND,
            id,
            updatedAt: now,
            data: fontRecordData({
              name: font.name,
              file_name: font.fileName,
              format: font.format,
              size: font.size,
              sha256: font.sha256,
              created_at: font.createdAt,
            }),
          },
          now,
        );
        if (result.status !== 'applied') {
          throw new Error(`writing the font record: ${result.status}`);
        }
      })();
    } catch (err) {
      await this.store.uncommit(font.filePath);
      throw err;
    }
    this.log(`Fonts: added "${font.name}" (${font.id}, ${font.size} bytes)`);
    return { font, existing: false };
  }
}
