/**
 * Builds the real-Calibre test fixture (tests/fixtures/calibre-<version>/).
 *
 *   node -r ts-node/register/transpile-only scripts/make-calibre-fixture.ts <new-empty-dir>
 *
 * Runs `calibredb` ONLY against a brand-new library in <new-empty-dir> (the
 * script refuses an existing non-empty folder), so it can never touch a real
 * library. Set CALIBREDB to the calibredb executable if it is not on PATH.
 *
 * The output folder holds a tiny Calibre library made by Calibre itself, which
 * the tests use to check that the indexer reads Calibre's real schema.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import zlib from 'zlib';

const DEFAULT_WINDOWS_CALIBREDB = 'C:\\Program Files\\Calibre2\\calibredb.exe';

function calibredbPath(): string {
  if (process.env.CALIBREDB) return process.env.CALIBREDB;
  if (process.platform === 'win32' && fs.existsSync(DEFAULT_WINDOWS_CALIBREDB)) {
    return DEFAULT_WINDOWS_CALIBREDB;
  }
  return 'calibredb';
}

/** Minimal ZIP writer (stored entries only), enough for an EPUB container. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeEpub(title: string, body: string): Buffer {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:00000000-0000-4000-8000-000000000000</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`;
  const xhtml = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeXml(title)}</title></head><body>${inner}</body></html>`;
  return zip([
    { name: 'mimetype', data: Buffer.from('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    },
    { name: 'OEBPS/content.opf', data: Buffer.from(opf) },
    { name: 'OEBPS/c1.xhtml', data: Buffer.from(xhtml(`<p>${escapeXml(body)}</p>`)) },
    {
      name: 'OEBPS/nav.xhtml',
      data: Buffer.from(
        xhtml('<nav epub:type="toc"><ol><li><a href="c1.xhtml">1</a></li></ol></nav>'),
      ),
    },
  ]);
}

const TINY_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

async function makeCover(file: string, hue: number): Promise<void> {
  await sharp({
    create: { width: 600, height: 900, channels: 3, background: { r: hue, g: 80, b: 200 - hue } },
  })
    .jpeg({ quality: 70 })
    .toFile(file);
}

async function main(): Promise<void> {
  const out = process.argv[2];
  if (!out) throw new Error('usage: make-calibre-fixture.ts <new-empty-dir>');
  const libDir = path.resolve(out);
  if (fs.existsSync(libDir) && fs.readdirSync(libDir).length > 0) {
    throw new Error(`Refusing to use a non-empty folder: ${libDir}`);
  }
  fs.mkdirSync(libDir, { recursive: true });
  const inputs = fs.mkdtempSync(path.join(path.dirname(libDir), 'calibre-inputs-'));
  const calibredb = calibredbPath();

  const run = (args: string[]): string =>
    execFileSync(calibredb, ['--library-path', libDir, ...args], { encoding: 'utf8' });

  // Returns the new Calibre book id ("Added book ids: 3").
  const add = (args: string[]): number => {
    const output = run(['add', ...args]);
    const m = /Added book ids: (\d+)/.exec(output);
    if (!m) throw new Error(`calibredb add printed no id:\n${output}`);
    return Number(m[1]);
  };

  const file = async (name: string, data: Buffer) => {
    const p = path.join(inputs, name);
    fs.writeFileSync(p, data);
    return p;
  };

  const cover1 = path.join(inputs, 'cover1.jpg');
  const cover2 = path.join(inputs, 'cover2.jpg');
  const cover3 = path.join(inputs, 'cover3.jpg');
  await makeCover(cover1, 30);
  await makeCover(cover2, 120);
  await makeCover(cover3, 200);

  // 1, 2, 3: a series with an integer and a fractional index, tags, publisher, comments.
  add([
    await file('s1.epub', makeEpub('薬屋のひとりごと 1', '猫猫は薬師である。')),
    '--title',
    '薬屋のひとりごと 1',
    '--authors',
    '日向夏',
    '--series',
    '薬屋のひとりごと',
    '--series-index',
    '1',
    '--tags',
    'ライトノベル,ミステリー',
    '--cover',
    cover1,
    '--languages',
    'jpn',
  ]);
  add([
    await file('s2.epub', makeEpub('薬屋のひとりごと 2', '壬氏は宦官である。')),
    '--title',
    '薬屋のひとりごと 2',
    '--authors',
    '日向夏',
    '--series',
    '薬屋のひとりごと',
    '--series-index',
    '2',
    '--tags',
    'ライトノベル',
    '--cover',
    cover2,
  ]);
  add([
    await file('s15.epub', makeEpub('薬屋のひとりごと 外伝', '短編集。')),
    '--title',
    '薬屋のひとりごと 外伝',
    '--authors',
    '日向夏',
    '--series',
    '薬屋のひとりごと',
    '--series-index',
    '1.5',
  ]);
  // 4: two authors in a set order, no cover.
  add([
    await file('two.epub', makeEpub('共著の本', '二人で書いた。')),
    '--title',
    '共著の本',
    '--authors',
    '著者二 & 著者一',
    '--tags',
    'アンソロジー',
  ]);
  // 5: PDF only (must be skipped).
  const pdfOnly = add(['--empty', '--title', 'PDFだけの本', '--authors', '日向夏']);
  run(['add_format', String(pdfOnly), await file('only.pdf', TINY_PDF)]);
  // 6: EPUB + PDF (indexed via the EPUB).
  const both = add([
    await file('both.epub', makeEpub('両方ある本', 'EPUBとPDF。')),
    '--title',
    '両方ある本',
    '--authors',
    'Jane Doe',
    '--cover',
    cover3,
  ]);
  run(['add_format', String(both), await file('both.pdf', TINY_PDF)]);

  // Publisher, published date and comments go through set_metadata.
  run([
    'set_metadata',
    '1',
    '--field',
    'publisher:主婦の友社',
    '--field',
    'pubdate:2014-08-29',
    '--field',
    'comments:<p>花街の薬屋で働く<b>猫猫</b>の物語。</p>',
  ]);

  fs.rmSync(inputs, { recursive: true, force: true });
  console.log(`Fixture library written to ${libDir}`);
  console.log(execFileSync(calibredb, ['--version'], { encoding: 'utf8' }).trim());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
