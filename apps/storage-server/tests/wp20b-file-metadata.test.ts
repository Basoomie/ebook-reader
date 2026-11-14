/**
 * WP20b: reading an EPUB's own metadata (read-only) and preparing its cover for Calibre.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import {
  coverForCalibre,
  readCoverBytes,
  readFileMetadata,
  xhtmlText,
} from '../src/cleanup/file-metadata';
import { coverImage, makeMetaEpub } from './helpers/stage2-fixture';
import { makeTempDir } from './helpers/spawn-server';

const dir = makeTempDir('wp20b-epub-');
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function write(buf: Buffer): string {
  const f = path.join(dir, `b${n++}.epub`);
  fs.writeFileSync(f, buf);
  return f;
}

describe('readFileMetadata', () => {
  it('EPUB2: title, creators with opf:role, publisher, language, identifiers and the ASIN', async () => {
    const f = write(
      makeMetaEpub({
        version: '2.0',
        title: '魔法の本 1',
        creators: [
          { name: '山田 太郎', role: 'aut' },
          { name: '絵師', role: 'ill' },
          { name: '訳者', role: 'trl' },
          { name: '無役' },
        ],
        publisher: 'KADOKAWA',
        language: 'ja',
        identifiers: [{ value: 'urn:uuid:0000' }, { value: 'B0ABCDEFGH', scheme: 'ASIN' }],
        cover: { data: await coverImage(600, 900), declared: 'meta' },
      }),
    );
    const m = await readFileMetadata(f);
    expect(m.title).toBe('魔法の本 1');
    expect(m.creators).toEqual([
      { name: '山田 太郎', role: 'aut' },
      { name: '絵師', role: 'ill' },
      { name: '訳者', role: 'trl' },
      { name: '無役', role: null },
    ]);
    expect(m.publishers).toEqual(['KADOKAWA']);
    expect(m.languages).toEqual(['ja']);
    expect(m.asin).toBe('B0ABCDEFGH');
    expect(m.cover).toMatchObject({
      entry: 'OEBPS/images/cover.jpg',
      width: 600,
      height: 900,
      mediaType: 'image/jpeg',
    });
    expect(m.cover!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.cover!.dhash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('EPUB3: roles from <meta refines>, the cover-image property, a PNG cover', async () => {
    const f = write(
      makeMetaEpub({
        title: '三版',
        creators: [
          { name: '作者', role: 'aut', refines: true },
          { name: '挿絵', role: 'ill', refines: true },
        ],
        cover: {
          data: await coverImage(1000, 1500, 3, 'png'),
          mediaType: 'image/png',
          declared: 'epub3',
        },
      }),
    );
    const m = await readFileMetadata(f);
    expect(m.creators).toEqual([
      { name: '作者', role: 'aut' },
      { name: '挿絵', role: 'ill' },
    ]);
    expect(m.cover).toMatchObject({ width: 1000, height: 1500, mediaType: 'image/png' });
  });

  it('a cover declared only by its name is still found; none declared and none named = no cover', async () => {
    const named = await readFileMetadata(
      write(
        makeMetaEpub({
          title: 'x',
          cover: { data: await coverImage(300, 450), declared: 'name-only' },
        }),
      ),
    );
    expect(named.cover?.width).toBe(300);
    const none = await readFileMetadata(write(makeMetaEpub({ title: 'x' })));
    expect(none.cover).toBeNull();
  });

  it('keeps the start and the end of the text as evidence, without ruby readings', async () => {
    const f = write(
      makeMetaEpub({
        title: 'x',
        pages: [
          '<h1>魔法の<ruby>本<rt>ほん</rt></ruby></h1><p>イラスト／絵師</p>',
          '<p>本文…</p>',
          '<p>発行　二〇二六年</p><p>著者　山田</p>',
        ],
      }),
    );
    const m = await readFileMetadata(f);
    expect(m.frontText).toContain('魔法の本');
    expect(m.frontText).not.toContain('ほん');
    expect(m.colophonText).toContain('著者');
    expect(xhtmlText('<body><p>A&amp;B&#12354;</p></body>')).toBe('A&Bあ');
  });

  it('a damaged EPUB throws (the analysis records the error and goes on)', async () => {
    const f = path.join(dir, 'bad.epub');
    fs.writeFileSync(f, 'not a zip');
    await expect(readFileMetadata(f)).rejects.toThrow();
  });

  it('reads the cover bytes again for the sidecar', async () => {
    const data = await coverImage(400, 600);
    const f = write(makeMetaEpub({ title: 'x', cover: { data } }));
    expect((await readCoverBytes(f, 'OEBPS/images/cover.jpg'))?.equals(data)).toBe(true);
    expect(await readCoverBytes(f, 'OEBPS/nope.jpg')).toBeNull();
  });
});

describe('coverForCalibre (D1)', () => {
  const limits = { maxBytes: 10 * 1024 * 1024, maxSide: 4096 };

  it('JPEG and PNG pass through unchanged', async () => {
    const jpg = await coverImage(800, 1200);
    const a = await coverForCalibre(jpg, limits);
    expect(a).toMatchObject({ ext: 'jpg', converted: false });
    expect(a.bytes.equals(jpg)).toBe(true);
    const png = await coverImage(800, 1200, 1, 'png');
    expect(await coverForCalibre(png, limits)).toMatchObject({ ext: 'png', converted: false });
  });

  it('other formats and very large covers become a JPEG no longer than the limit', async () => {
    const webp = await coverForCalibre(await coverImage(800, 1200, 2, 'webp'), limits);
    expect(webp).toMatchObject({ ext: 'jpg', converted: true });
    expect((await sharp(webp.bytes).metadata()).format).toBe('jpeg');
    const big = await coverForCalibre(await coverImage(3000, 5000), {
      maxBytes: limits.maxBytes,
      maxSide: 2000,
    });
    const meta = await sharp(big.bytes).metadata();
    expect(big.converted).toBe(true);
    expect(Math.max(meta.width!, meta.height!)).toBe(2000);
  });
});
