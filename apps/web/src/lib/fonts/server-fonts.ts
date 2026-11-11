/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BehaviorSubject, Subject } from 'rxjs';
import { reservedFontNames } from '$lib/data/fonts';
import type { FontCache, CachedFont } from '$lib/fonts/font-cache-db';

/**
 * Server-synced custom fonts (WP13). A font is uploaded once from any device; the
 * server writes a "font" record (id = font id, data { name, fileName, format, size,
 * sha256, createdAt }) and every device downloads the file, keeps it in IndexedDB and
 * registers it with the FontFace API, so it works offline. Which font a device uses
 * stays its own setting. Deleting a font is a deletion of its record.
 *
 * Nothing here may block or break reading: every step catches its errors and only
 * reports them.
 */
export const FONT_KIND = 'font';

export interface FontRecordData {
  name: string;
  fileName: string;
  format: string;
  size: number;
  sha256: string;
  createdAt: number;
}

/** The parts of a synced record the service reads. */
export interface FontRecordLike {
  kind: string;
  id: string;
  deletedAt: number | null;
  data: Record<string, unknown>;
}

/**
 * saved: on this device. queued/downloading: being fetched. waiting: not connected to
 * the server yet. failed: the download or the browser refused it (tried again on the next
 * sync).
 */
export type FontStatus = 'saved' | 'queued' | 'downloading' | 'waiting' | 'failed';

export interface ServerFontState {
  id: string;
  name: string;
  fileName: string;
  format: string;
  size: number;
  createdAt: number;
  status: FontStatus;
}

/** Makes a font file usable by the page under a family name. */
export interface FaceRegistry {
  /** Throws when the browser can't use the file as a font. */
  register(id: string, name: string, blob: Blob): Promise<void>;
  unregister(id: string): void;
}

export interface ServerFontDeps {
  cache: FontCache;
  faces: FaceRegistry;
  /** Downloads a font file; null when this device isn't connected to a server. */
  download(id: string): Promise<Blob | null>;
  /** SHA-256 (hex) of a file, or null when the browser can't hash (plain http). */
  hash(blob: Blob): Promise<string | null>;
  /** A font that was deleted on the server (to reset this device's font setting). */
  onFontDeleted?(name: string): void;
  now?: () => number;
  warn(message: string): void;
}

export function fontRecordData(data: Record<string, unknown>): FontRecordData | null {
  const { name, fileName, format, size, sha256, createdAt } = data ?? {};
  if (
    typeof name !== 'string' ||
    typeof fileName !== 'string' ||
    typeof format !== 'string' ||
    typeof size !== 'number' ||
    typeof sha256 !== 'string' ||
    typeof createdAt !== 'number'
  ) {
    return null;
  }
  return { name, fileName, format, size, sha256, createdAt };
}

const message = (error: unknown) => (error as Error)?.message ?? String(error);

export class ServerFonts {
  /** Every live server font with its state on this device, oldest first. */
  readonly fonts$ = new BehaviorSubject<ServerFontState[]>([]);

  /** Family names usable in the pickers (live server fonts and fonts saved here). */
  readonly names$ = new BehaviorSubject<string[]>([]);

  /** A font became usable after start (a download finished): its family name. */
  readonly arrived$ = new Subject<string>();

  /** Fires on every change of what isPending() answers. */
  private readonly changed$ = new Subject<void>();

  private started = false;
  private startDone = false;
  /** The synced font records have been read once (or can't be). */
  private recordsKnown = false;
  /** Live records by id. */
  private readonly live = new Map<string, FontRecordData>();
  /** Ids known to be deleted on the server. */
  private readonly deleted = new Set<string>();
  /** Cached files by id. */
  private readonly cached = new Map<string, CachedFont>();
  /** Registered faces: id -> family name. */
  private readonly registered = new Map<string, string>();
  private readonly status = new Map<string, FontStatus>();
  private downloading: Promise<void> | null = null;
  private again = false;

  constructor(private readonly deps: ServerFontDeps) {}

  /** Registers the fonts saved on this device. Never throws. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      for (const font of await this.deps.cache.getAll()) {
        this.cached.set(font.id, font);
        await this.registerFace(font);
      }
    } catch (error) {
      this.deps.warn(`Fonts: could not read the fonts saved on this device: ${message(error)}`);
    } finally {
      this.startDone = true;
      this.publish();
    }
  }

  /**
   * Takes font records (all of them at start with `initial`, then each pulled or local
   * change): deleted fonts are removed from this device, new ones downloaded. Never throws.
   */
  async applyRecords(
    records: readonly FontRecordLike[],
    { initial = false }: { initial?: boolean } = {}
  ): Promise<void> {
    for (const record of records) {
      if (record.kind !== FONT_KIND) continue;
      try {
        if (record.deletedAt !== null) {
          await this.removeFont(record.id);
          continue;
        }
        const data = fontRecordData(record.data);
        if (!data) continue;
        this.deleted.delete(record.id);
        this.live.set(record.id, data);
        if (!this.isSaved(record.id) && !this.isLoading(record.id)) {
          this.status.set(record.id, 'queued');
        }
      } catch (error) {
        this.deps.warn(`Fonts: could not apply a font record: ${message(error)}`);
      }
    }
    if (initial) this.recordsKnown = true;
    this.publish();
    await this.downloadMissing();
  }

  /** The synced records can't be read (no sync engine): stop waiting for them. */
  noRecords(): void {
    this.recordsKnown = true;
    this.publish();
  }

  /** Downloads what is missing again (after connecting, or on a retry). Never throws. */
  async retry(): Promise<void> {
    for (const id of this.live.keys()) {
      if (!this.isSaved(id) && !this.isLoading(id)) this.status.set(id, 'queued');
    }
    this.publish();
    await this.downloadMissing();
  }

  /** A font this device just uploaded: saved and usable at once, no download. */
  async addUploaded(id: string, data: FontRecordData, blob: Blob): Promise<void> {
    const font: CachedFont = {
      id,
      name: data.name,
      format: data.format,
      size: data.size,
      sha256: data.sha256,
      blob,
      savedAt: this.now()
    };
    this.live.set(id, data);
    this.deleted.delete(id);
    try {
      await this.deps.cache.put(font);
      this.cached.set(id, font);
    } catch (error) {
      this.deps.warn(`Fonts: could not save "${data.name}" on this device: ${message(error)}`);
    }
    await this.registerFace(font);
    this.status.set(id, this.registered.has(id) ? 'saved' : 'failed');
    this.publish();
    if (this.registered.has(id)) this.arrived$.next(data.name);
  }

  /**
   * True while the reader should wait for this family: before the saved fonts are
   * registered and the synced records read (for any name that isn't bundled), or while a
   * server font of that name is being downloaded. Not for fonts that can't be fetched now
   * (offline, failed).
   */
  isPending(name: string): boolean {
    if (!name || reservedFontNames.has(name)) return false;
    if (this.started && (!this.startDone || !this.recordsKnown)) return true;
    for (const [id, data] of this.live) {
      if (data.name !== name || this.registered.has(id)) continue;
      if (this.isLoading(id)) return true;
    }
    return false;
  }

  /** Calls `ready` once isPending(name) is false; returns a function that stops waiting. */
  whenReady(name: string, ready: () => void): () => void {
    if (!this.isPending(name)) {
      ready();
      return () => {};
    }
    const sub = this.changed$.subscribe(() => {
      if (this.isPending(name)) return;
      sub.unsubscribe();
      ready();
    });
    return () => sub.unsubscribe();
  }

  /** True when the family is a server font (live or saved here). */
  isServerFont(name: string): boolean {
    return this.names$.getValue().includes(name);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private isSaved(id: string): boolean {
    const data = this.live.get(id);
    const file = this.cached.get(id);
    return !!data && !!file && file.sha256 === data.sha256 && this.registered.has(id);
  }

  private isLoading(id: string): boolean {
    const s = this.status.get(id);
    return s === 'queued' || s === 'downloading';
  }

  private async registerFace(font: CachedFont): Promise<void> {
    if (this.registered.get(font.id) === font.name) return;
    try {
      await this.deps.faces.register(font.id, font.name, font.blob);
      this.registered.set(font.id, font.name);
    } catch (error) {
      this.deps.warn(`Fonts: this browser can't use "${font.name}": ${message(error)}`);
    }
  }

  private async removeFont(id: string): Promise<void> {
    const name = this.live.get(id)?.name ?? this.cached.get(id)?.name ?? null;
    const wasKnown = this.live.has(id) || this.cached.has(id) || this.registered.has(id);
    this.deleted.add(id);
    this.live.delete(id);
    this.status.delete(id);
    if (this.registered.has(id)) {
      try {
        this.deps.faces.unregister(id);
      } catch (error) {
        this.deps.warn(`Fonts: could not remove a font from the page: ${message(error)}`);
      }
      this.registered.delete(id);
    }
    if (this.cached.has(id)) {
      this.cached.delete(id);
      try {
        await this.deps.cache.delete(id);
      } catch (error) {
        this.deps.warn(`Fonts: could not delete a saved font: ${message(error)}`);
      }
    }
    // Another live font may still carry the name (deleted and uploaded again).
    if (wasKnown && name && ![...this.live.values()].some((d) => d.name === name)) {
      try {
        this.deps.onFontDeleted?.(name);
      } catch (error) {
        this.deps.warn(`Fonts: ${message(error)}`);
      }
    }
  }

  /** One download loop at a time; a call during a run makes it go round once more. */
  private downloadMissing(): Promise<void> {
    if (this.downloading) {
      this.again = true;
      return this.downloading;
    }
    this.downloading = (async () => {
      do {
        this.again = false;
        for (const [id, data] of [...this.live]) {
          if (this.status.get(id) !== 'queued') continue;
          await this.fetchOne(id, data);
        }
      } while (this.again);
    })().finally(() => {
      this.downloading = null;
    });
    return this.downloading;
  }

  private async fetchOne(id: string, data: FontRecordData): Promise<void> {
    // Already saved with the right bytes (e.g. registered at start).
    const file = this.cached.get(id);
    if (file && file.sha256 === data.sha256) {
      await this.registerFace(file);
      this.status.set(id, this.registered.has(id) ? 'saved' : 'failed');
      this.publish();
      return;
    }
    this.status.set(id, 'downloading');
    this.publish();
    try {
      const blob = await this.deps.download(id);
      if (!blob) {
        this.status.set(id, 'waiting');
        return;
      }
      if (blob.size !== data.size) {
        throw new Error(`got ${blob.size} bytes instead of ${data.size}`);
      }
      const hash = await this.deps.hash(blob);
      if (hash !== null && hash !== data.sha256) throw new Error('the file is damaged');
      // Deleted while downloading.
      if (!this.live.has(id)) return;
      const font: CachedFont = {
        id,
        name: data.name,
        format: data.format,
        size: data.size,
        sha256: data.sha256,
        blob,
        savedAt: this.now()
      };
      await this.deps.cache.put(font);
      this.cached.set(id, font);
      await this.registerFace(font);
      if (!this.registered.has(id)) {
        this.status.set(id, 'failed');
        return;
      }
      this.status.set(id, 'saved');
      this.arrived$.next(data.name);
    } catch (error) {
      this.status.set(id, 'failed');
      this.deps.warn(`Fonts: could not download "${data.name}": ${message(error)}`);
    } finally {
      this.publish();
    }
  }

  private publish(): void {
    const states: ServerFontState[] = [...this.live]
      .map(([id, d]) => ({
        id,
        name: d.name,
        fileName: d.fileName,
        format: d.format,
        size: d.size,
        createdAt: d.createdAt,
        status: this.isSaved(id) ? ('saved' as const) : (this.status.get(id) ?? 'queued')
      }))
      .sort((a, b) => a.createdAt - b.createdAt);
    this.fonts$.next(states);
    const names: string[] = [];
    for (const s of states) if (!names.includes(s.name)) names.push(s.name);
    // Fonts saved here whose records are not pulled yet (e.g. offline at start).
    for (const [id, name] of this.registered) {
      if (!this.deleted.has(id) && !names.includes(name)) names.push(name);
    }
    if (JSON.stringify(names) !== JSON.stringify(this.names$.getValue())) this.names$.next(names);
    this.changed$.next();
  }
}
