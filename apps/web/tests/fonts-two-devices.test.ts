/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP13: server-synced custom fonts between devices, against the real storage server
 * (tests/helpers/sync-harness.ts):
 * - a font uploaded on A reaches B as a "font" record, and B's font service downloads
 *   the same bytes, saves them and registers the font;
 * - B deletes it; A's font service removes it and reports the name (setting reset);
 * - DATA_DIR changes only in .uploads/fonts, the Calibre folder is byte-identical, and
 *   no stat-day or position records are written.
 */
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibraryApi, type ServerFontInfo } from '$lib/library/api';
import type { CachedFont, FontCache } from '$lib/fonts/font-cache-db';
import { FONT_KIND, ServerFonts, type FaceRegistry } from '$lib/fonts/server-fonts';
import { Device, tempDir, TestServer } from './helpers/sync-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../storage-server/tests/fixtures/calibre-7.1');
const FONT_FILE = path.resolve(HERE, '../src/lib/assets/fonts/biz-udgothic-v1-400.woff2');

function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else
        out[path.relative(dir, full).split(path.sep).join('/')] = createHash('sha1')
          .update(fs.readFileSync(full))
          .digest('hex');
    }
  };
  walk(dir);
  return out;
}

class MemoryCache implements FontCache {
  files = new Map<string, CachedFont>();
  async getAll() {
    return [...this.files.values()];
  }
  async put(font: CachedFont) {
    this.files.set(font.id, font);
  }
  async delete(id: string) {
    this.files.delete(id);
  }
}

class Faces implements FaceRegistry {
  registered = new Map<string, string>();
  async register(id: string, name: string) {
    this.registered.set(id, name);
  }
  unregister(id: string) {
    this.registered.delete(id);
  }
}

function fontService(api: LibraryApi) {
  const cache = new MemoryCache();
  const faces = new Faces();
  const deleted: string[] = [];
  const fonts = new ServerFonts({
    cache,
    faces,
    download: (id) => api.downloadFont(id),
    hash: async (blob) =>
      createHash('sha256')
        .update(Buffer.from(await blob.arrayBuffer()))
        .digest('hex'),
    onFontDeleted: (name) => deleted.push(name),
    warn: (m) => {
      throw new Error(m);
    }
  });
  return { fonts, cache, faces, deleted };
}

const calibreRoot = tempDir('calibre');
fs.cpSync(FIXTURE, calibreRoot, { recursive: true });
const server = new TestServer({
  CALIBRE_DIR: calibreRoot,
  CACHE_DIR: tempDir('cache'),
  CALIBRE_REQUIRE_READONLY: 'false',
  CALIBRE_SETTLE_SECONDS: '0',
  COUNT_BACKGROUND: 'false'
});

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

describe('custom fonts between devices (real server)', () => {
  const tokens: string[] = [];
  let a: Device;
  let b: Device;
  let apiA: LibraryApi;
  let apiB: LibraryApi;
  let calibreBefore: Record<string, string>;
  let dataBefore: Record<string, string>;
  let font: ServerFontInfo;

  beforeAll(async () => {
    calibreBefore = hashTree(calibreRoot);
    await server.start();
    dataBefore = hashTree(server.dataDir);
    for (const label of ['A', 'B']) {
      tokens.push(server.cli('token', 'create', label).trim().split(/\r?\n/).pop()!);
    }
    apiA = new LibraryApi(server.url, tokens[0], 20);
    apiB = new LibraryApi(server.url, tokens[1], 20);
    a = new Device('A', tokens[0], server);
    b = new Device('B', tokens[1], server);
    await a.open();
    await b.open();
    await syncAll(a, b);
  }, 180_000);

  afterAll(async () => {
    a?.engine.close();
    b?.engine.close();
    await server.stop();
  });

  it('gets a font uploaded on A to B, with the same bytes', async () => {
    const info = await apiA.fontInfo();
    expect(info?.maxBytes).toBe(64 * 1024 * 1024);
    // The web app sends the file with XMLHttpRequest; Node has none, so plain fetch here.
    const res = await fetch(
      `${server.url}/api/v1/fonts?${new URLSearchParams({ name: 'Test Gothic', fileName: 'biz.woff2' })}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokens[0]}` },
        body: fs.readFileSync(FONT_FILE)
      }
    );
    expect(res.status).toBe(201);
    font = (await res.json()).font;
    expect(font).toMatchObject({ name: 'Test Gothic', fileName: 'biz.woff2', format: 'woff2' });

    await syncAll(a, b);
    const records = await b.engine.getAll(FONT_KIND);
    expect(records.map((r) => [r.id, r.deletedAt])).toEqual([[font.id, null]]);

    const onB = fontService(apiB);
    await onB.fonts.start();
    await onB.fonts.applyRecords(records);
    expect(onB.faces.registered.get(font.id)).toBe('Test Gothic');
    const saved = onB.cache.files.get(font.id)!;
    expect(Buffer.from(await saved.blob.arrayBuffer()).equals(fs.readFileSync(FONT_FILE))).toBe(
      true
    );
    expect(onB.fonts.fonts$.getValue().map((f) => f.status)).toEqual(['saved']);
  });

  it("removes a font B deleted from A's device", async () => {
    const onA = fontService(apiA);
    await onA.fonts.start();
    await onA.fonts.applyRecords(await a.engine.getAll(FONT_KIND));
    expect(onA.faces.registered.get(font.id)).toBe('Test Gothic');

    expect(await b.engine.remove(FONT_KIND, font.id)).toBe(true);
    await syncAll(b, a);
    const records = await a.engine.getAll(FONT_KIND);
    expect(records[0].deletedAt).not.toBeNull();
    await onA.fonts.applyRecords(records);
    expect(onA.cache.files.size).toBe(0);
    expect(onA.faces.registered.size).toBe(0);
    expect(onA.deleted).toEqual(['Test Gothic']);
    expect((await apiA.fontInfo())?.fonts).toEqual([]);
  });

  it('writes only .uploads/fonts, leaves Calibre alone and writes no reading records', async () => {
    const after = hashTree(server.dataDir);
    const changed = Object.keys(after).filter((f) => after[f] !== dataBefore[f]);
    expect(changed).toEqual([`.uploads/fonts/${font.id}/font.woff2`]);
    expect(hashTree(calibreRoot)).toEqual(calibreBefore);
    for (const d of [a, b]) {
      expect(await d.engine.getAll('stat-day')).toEqual([]);
      expect(await d.engine.getAll('position')).toEqual([]);
    }
  });
});
