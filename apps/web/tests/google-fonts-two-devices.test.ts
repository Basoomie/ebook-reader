/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 Phase 10: a font added from Google Fonts on device A reaches device B, against
 * the real storage server (tests/helpers/sync-harness.ts) with Google stood in by
 * tests/helpers/google-fonts-stub.cjs (serving the two BIZ UDGothic files the app keeps in
 * lib/assets/fonts, real Google font files):
 * - A's API lists the Japanese families, adds one; the server stores regular and bold;
 * - B gets the "font" record, its font service downloads both files with the same bytes,
 *   saves them and registers bold with its weight;
 * - B deletes it; A's font service removes it and reports the name;
 * - DATA_DIR changes only in .uploads/fonts, the Calibre folder is byte-identical, and no
 *   stat-day or position records are written.
 */
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibraryApi, LibraryApiError, type ServerFontInfo } from '$lib/library/api';
import type { CachedFont, FontCache } from '$lib/fonts/font-cache-db';
import { FONT_KIND, ServerFonts, type FaceRegistry } from '$lib/fonts/server-fonts';
import { Device, tempDir, TestServer } from './helpers/sync-harness';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../storage-server/tests/fixtures/calibre-7.1');
const REGULAR = path.resolve(HERE, '../src/lib/assets/fonts/biz-udgothic-v1-400.woff2');
const BOLD = path.resolve(HERE, '../src/lib/assets/fonts/biz-udgothic-v1-700.woff2');
const STUB = path.resolve(HERE, 'helpers/google-fonts-stub.cjs');

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
  registered = new Map<string, { name: string; weights: number[] }>();
  async register(id: string, name: string, _blob: Blob, faces: readonly { weight: number }[] = []) {
    this.registered.set(id, { name, weights: faces.map((f) => f.weight) });
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
    download: (id, weight) => api.downloadFont(id, { weight }),
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
  COUNT_BACKGROUND: 'false',
  NODE_OPTIONS: `--require ${STUB}`,
  GOOGLE_FONTS_STUB: JSON.stringify({
    'BIZ UDGothic': { category: 'Sans Serif', files: { 400: REGULAR, 700: BOLD } }
  })
});

async function syncAll(...devices: Device[]) {
  for (const d of devices) await d.sync();
  for (const d of devices) await d.sync();
}

describe('Google fonts between devices (real server, stand-in Google)', () => {
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

  it('lists the Japanese families and adds one on A', async () => {
    expect((await apiA.fontInfo())?.google).toBe(true);
    expect(await apiA.googleFonts()).toEqual([
      { family: 'BIZ UDGothic', category: 'Sans Serif', weights: [400, 700], status: 'available' },
      { family: 'Noto Sans JP', category: 'Sans Serif', weights: [400, 700], status: 'built_in' }
    ]);
    font = await apiA.addGoogleFont('BIZ UDGothic');
    expect(font).toMatchObject({
      name: 'BIZ UDGothic',
      format: 'woff2',
      size: fs.statSync(REGULAR).size,
      source: 'google',
      licenseUrl: 'https://scripts.sil.org/OFL'
    });
    expect(font.copyright).toMatch(/^Copyright/);
    expect(font.faces).toEqual([
      expect.objectContaining({ weight: 700, format: 'woff2', size: fs.statSync(BOLD).size })
    ]);
    expect((await apiA.googleFonts())[0].status).toBe('added');
    const again = await apiA.addGoogleFont('BIZ UDGothic').catch((e) => e);
    expect(again).toBeInstanceOf(LibraryApiError);
    expect((again as LibraryApiError).code).toBe('name_taken');
  });

  it('gets both files to B with the same bytes, bold registered with its weight', async () => {
    await syncAll(a, b);
    const records = await b.engine.getAll(FONT_KIND);
    expect(records.map((r) => [r.id, r.deletedAt])).toEqual([[font.id, null]]);
    const onB = fontService(apiB);
    await onB.fonts.start();
    await onB.fonts.applyRecords(records, { initial: true });
    expect(onB.faces.registered.get(font.id)).toEqual({ name: 'BIZ UDGothic', weights: [700] });
    const saved = onB.cache.files.get(font.id)!;
    expect(Buffer.from(await saved.blob.arrayBuffer()).equals(fs.readFileSync(REGULAR))).toBe(true);
    const bold = saved.faces?.find((f) => f.weight === 700);
    expect(Buffer.from(await bold!.blob.arrayBuffer()).equals(fs.readFileSync(BOLD))).toBe(true);
    expect(onB.fonts.fonts$.getValue()).toEqual([
      expect.objectContaining({
        status: 'saved',
        source: 'google',
        weights: [400, 700],
        size: fs.statSync(REGULAR).size + fs.statSync(BOLD).size
      })
    ]);
  });

  it("removes a Google font B deleted from A's device", async () => {
    const onA = fontService(apiA);
    await onA.fonts.start();
    await onA.fonts.applyRecords(await a.engine.getAll(FONT_KIND), { initial: true });
    expect(onA.faces.registered.get(font.id)?.name).toBe('BIZ UDGothic');
    expect(await b.engine.remove(FONT_KIND, font.id)).toBe(true);
    await syncAll(b, a);
    await onA.fonts.applyRecords(await a.engine.getAll(FONT_KIND));
    expect(onA.cache.files.size).toBe(0);
    expect(onA.faces.registered.size).toBe(0);
    expect(onA.deleted).toEqual(['BIZ UDGothic']);
    expect((await apiA.googleFonts())[0].status).toBe('available');
  });

  it('writes only .uploads/fonts, leaves Calibre alone and writes no reading records', async () => {
    const after = hashTree(server.dataDir);
    const changed = Object.keys(after).filter((f) => after[f] !== dataBefore[f]);
    expect(changed.sort()).toEqual([
      `.uploads/fonts/${font.id}/font-700.woff2`,
      `.uploads/fonts/${font.id}/font.woff2`
    ]);
    expect(hashTree(calibreRoot)).toEqual(calibreBefore);
    for (const d of [a, b]) {
      expect(await d.engine.getAll('stat-day')).toEqual([]);
      expect(await d.engine.getAll('position')).toEqual([]);
    }
  });
});
