/**
 * Custom fonts (WP13): upload a font once from any device; every device gets it
 * through its "font" sync record and downloads the file. Which font a device uses
 * stays a per-device setting (decided 2026-11-10).
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import type { SyncStore } from '../sync/store';
import { fontFaceRows, fontRecordData, type FontFaceRow } from '../sync/kinds';
import {
  fontNameProblem,
  type FontFormat,
  MAX_FONT_FILE_NAME,
  RESERVED_FONT_NAMES,
} from './font-format';
import { readFontNames } from './font-name-table';
import { FontStore, FontTooLargeError, NotAFontError, type ReceivedFont } from './font-store';
import { type GoogleFamily, type GoogleFonts, GoogleFontsError } from './google-fonts';

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
  /** 'upload' or 'google' (Phase 10). */
  source: 'upload' | 'google';
  copyright: string | null;
  licenseUrl: string | null;
}

/** A font's other weight (a Google font's bold) with its stored file. */
export interface StoredFace extends FontFaceRow {
  filePath: string;
}

/** A Google Fonts family as the picker shows it. */
export interface GoogleFamilyState extends GoogleFamily {
  /**
   * available: can be added. added: a live Google font has this name. built_in: the
   * reader already has it. name_taken: an uploaded font has this name.
   */
  status: 'available' | 'added' | 'built_in' | 'name_taken';
}

export interface FontServiceOptions {
  db: Database.Database;
  store: FontStore;
  sync: SyncStore;
  /** Largest accepted font file (FONT_MAX_MB). */
  maxBytes: number;
  /** Google Fonts (Phase 10); without it, adding from Google answers 503. */
  google?: GoogleFonts | null;
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
  source: 'upload' | 'google';
  copyright: string | null;
  license_url: string | null;
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
    source: row.source ?? 'upload',
    copyright: row.copyright ?? null,
    licenseUrl: row.license_url ?? null,
  };
}

const isReserved = (name: string) =>
  RESERVED_FONT_NAMES.some((r) => r.toLowerCase() === name.toLowerCase());

/** The file name as shown in the list: its last path part, at most 200 characters. */
export function cleanFileName(raw: string, format: FontFormat): string {
  const base = raw.split(/[\\/]/).pop()?.trim() ?? '';
  const chars = Array.from(base);
  return chars.length ? chars.slice(0, MAX_FONT_FILE_NAME).join('') : `font.${format}`;
}

export class FontService {
  readonly store: FontStore;
  readonly maxBytes: number;
  readonly google: GoogleFonts | null;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: FontServiceOptions) {
    this.store = opts.store;
    this.maxBytes = opts.maxBytes;
    this.google = opts.google ?? null;
    this.log = opts.log ?? console.log;
  }

  /** A font's other weights with their files (none for uploaded fonts). */
  faces(fontId: string): StoredFace[] {
    const rows = this.opts.db
      .prepare(
        'SELECT weight, format, size, sha256, file_path FROM font_faces WHERE font_id = ? ORDER BY weight',
      )
      .all(fontId) as (FontFaceRow & { file_path: string })[];
    return rows.map(({ file_path, ...face }) => ({ ...face, filePath: file_path }));
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
      source: 'upload',
      copyright: null,
      licenseUrl: null,
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

  /** Google's Japanese families, each with what adding it would do. */
  async googleFamilies(userId: string): Promise<GoogleFamilyState[]> {
    const families = await this.googleCall((google) => google.list());
    const live = this.liveFonts(userId);
    return families.map((f) => {
      const same = live.find((l) => l.name.toLowerCase() === f.family.toLowerCase());
      let status: GoogleFamilyState['status'] = 'available';
      if (isReserved(f.family)) status = 'built_in';
      else if (same) status = same.source === 'google' ? 'added' : 'name_taken';
      return { ...f, status };
    });
  }

  /** Runs a Google Fonts step, its errors as FontErrors. */
  private async googleCall<T>(step: (google: GoogleFonts) => Promise<T>): Promise<T> {
    if (!this.google) throw new FontError(503, 'google_off', 'Google Fonts is off on this server');
    try {
      return await step(this.google);
    } catch (err) {
      if (err instanceof GoogleFontsError) throw new FontError(err.status, err.code, err.message);
      throw err;
    }
  }

  /**
   * Adds a family from Google Fonts (Phase 10): its whole regular file, and bold where the
   * family has it, stored like an uploaded font, with the font's record written as the
   * asking device. The family must be in Google's Japanese list now.
   */
  async addGoogleFont(
    userId: string,
    deviceId: string,
    family: string,
    now = Date.now(),
  ): Promise<StoredFont> {
    if (isReserved(family)) {
      throw new FontError(400, 'built_in', `${family} is already built into the reader`);
    }
    this.checkName(userId, family);
    const listed = (await this.googleCall((google) => google.list())).find(
      (f) => f.family === family,
    );
    if (!listed) {
      throw new FontError(
        404,
        'not_a_google_font',
        `Google Fonts has no Japanese font "${family}"`,
      );
    }
    const faces = await this.googleCall((google) => google.faces(family, listed.weights));
    const received: { weight: number; file: ReceivedFont }[] = [];
    try {
      for (const face of faces) {
        const stream = await this.googleCall((google) => google.download(face));
        received.push({ weight: face.weight, file: await this.receiveGoogleFile(stream) });
      }
      return await this.storeGoogleFont(userId, deviceId, family, received, now);
    } finally {
      // Committed files were moved away; what is left is a temp file.
      for (const r of received) await this.store.discard(r.file);
    }
  }

  private async receiveGoogleFile(stream: NodeJS.ReadableStream): Promise<ReceivedFont> {
    let file: ReceivedFont;
    try {
      file = await this.store.receive(stream, this.maxBytes);
    } catch (err) {
      if (err instanceof FontTooLargeError) {
        throw new FontError(
          413,
          'too_large',
          `The font is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MB`,
        );
      }
      if (err instanceof NotAFontError) {
        throw new FontError(
          502,
          'google_unexpected',
          'Google Fonts sent a file that is not a font',
        );
      }
      throw new FontError(
        502,
        'google_unreachable',
        `Google Fonts can't be reached: ${(err as Error)?.message ?? err}`,
      );
    }
    if (file.format !== 'woff2' && file.format !== 'ttf') {
      await this.store.discard(file);
      throw new FontError(502, 'google_unexpected', `Google Fonts sent a ${file.format} file`);
    }
    return file;
  }

  private async storeGoogleFont(
    userId: string,
    deviceId: string,
    family: string,
    received: { weight: number; file: ReceivedFont }[],
    now: number,
  ): Promise<StoredFont> {
    const [regular, ...others] = received;
    const names = readFontNames(await fs.readFile(regular.file.tmp));
    // Added by another device while this one was downloading.
    this.checkName(userId, family);
    const id = randomUUID();
    const font: StoredFont = {
      id,
      userId,
      name: family,
      fileName: cleanFileName(
        `${family.replace(/ /g, '')}-${regular.weight}.${regular.file.format}`,
        regular.file.format,
      ),
      format: regular.file.format,
      size: regular.file.size,
      sha256: regular.file.sha256,
      filePath: FontStore.fontPath(id, regular.file.format),
      createdAt: now,
      source: 'google',
      copyright: names.copyright,
      licenseUrl: names.licenseUrl,
    };
    const committed: string[] = [await this.store.commit(regular.file, id)];
    try {
      const faces: StoredFace[] = [];
      for (const other of others) {
        const filePath = await this.store.commitFace(other.file, id, other.weight);
        committed.push(filePath);
        faces.push({
          weight: other.weight,
          format: other.file.format,
          size: other.file.size,
          sha256: other.file.sha256,
          filePath,
        });
      }
      this.opts.db.transaction(() => {
        this.opts.db
          .prepare(
            `INSERT INTO fonts (id, user_id, name, file_name, format, size, sha256, file_path,
                                created_at, source, copyright, license_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'google', ?, ?)`,
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
            font.copyright,
            font.licenseUrl,
          );
        const insertFace = this.opts.db.prepare(
          `INSERT INTO font_faces (font_id, weight, format, size, sha256, file_path)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const f of faces) insertFace.run(id, f.weight, f.format, f.size, f.sha256, f.filePath);
        const result = this.opts.sync.writeAs(
          userId,
          deviceId,
          {
            kind: FONT_KIND,
            id,
            updatedAt: now,
            data: fontRecordData(
              {
                name: font.name,
                file_name: font.fileName,
                format: font.format,
                size: font.size,
                sha256: font.sha256,
                created_at: font.createdAt,
                source: 'google',
                copyright: font.copyright,
                license_url: font.licenseUrl,
              },
              fontFaceRows(this.opts.db, id),
            ),
          },
          now,
        );
        if (result.status !== 'applied') {
          throw new Error(`writing the font record: ${result.status}`);
        }
      })();
    } catch (err) {
      await this.store.uncommitAll(committed);
      throw err;
    }
    const total = received.reduce((sum, r) => sum + r.file.size, 0);
    const weights = received.map((r) => r.weight).join('+');
    this.log(
      `Fonts: added "${family}" from Google Fonts (${id}, weights ${weights}, ${total} bytes)`,
    );
    return font;
  }
}
