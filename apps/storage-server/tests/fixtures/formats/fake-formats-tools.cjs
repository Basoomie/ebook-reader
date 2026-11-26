#!/usr/bin/env node
/**
 * Books without an EPUB (sidecar 1.7.0) tests: stands in for calibre's ebook-convert and for
 * `calibre-debug -e formats-helper.py` (the sidecar's two programs), with the same arguments and
 * answers, on test files where a "Kindle book" is simply an EPUB's bytes under another name:
 *
 *   calibre-debug mode (first argument -e <script>):
 *     inspect <file>              an AZW3/MOBI: {"drm": <its bytes start with "DRM">}; an archive: its
 *                                 entries (names and sizes) read from the ZIP's central directory
 *     extract <zip> <entry> <out> one entry written to <out>
 *     extractall <zip> <dir>      every entry
 *   ebook-convert mode (<input> <output> [options]):
 *     <output>.txt                the text of the input's XHTML (the input is an EPUB's bytes)
 *     <output>.epub               a comic (.cbz/.cbr) gives FAKE_COMIC_EPUB's file; anything else
 *                                 the input's own bytes (a "Kindle book" is an EPUB here)
 *   FAKE_FAIL_CONVERT=1: ebook-convert fails. Every path must be inside TTSU_WORK_DIR, as the
 *   real helper checks; FAKE_TOOLS_LOG gets each call's arguments.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const argv = process.argv.slice(2);
if (process.env.FAKE_TOOLS_LOG)
  fs.appendFileSync(process.env.FAKE_TOOLS_LOG, JSON.stringify(argv) + '\n');

const work = path.resolve(process.env.TTSU_WORK_DIR || '/nonexistent');
const inside = (p) => path.resolve(p).startsWith(work + path.sep);

function entries(file) {
  const b = fs.readFileSync(file);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = b.readUInt16LE(eocd + 10);
  let at = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    const method = b.readUInt16LE(at + 10);
    const csize = b.readUInt32LE(at + 20);
    const size = b.readUInt32LE(at + 24);
    const nameLen = b.readUInt16LE(at + 28);
    const extra = b.readUInt16LE(at + 30);
    const comment = b.readUInt16LE(at + 32);
    const local = b.readUInt32LE(at + 42);
    const name = b.toString('utf8', at + 46, at + 46 + nameLen);
    out.push({ name, size, method, csize, local });
    at += 46 + nameLen + extra + comment;
  }
  return { b, list: out };
}

function read(file, entry) {
  const { b, list } = entries(file);
  const e = list.find((x) => x.name === entry);
  if (!e) throw new Error(`no entry ${entry}`);
  const nameLen = b.readUInt16LE(e.local + 26);
  const extra = b.readUInt16LE(e.local + 28);
  const start = e.local + 30 + nameLen + extra;
  const data = b.subarray(start, start + e.csize);
  return e.method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
}

function answer(obj) {
  process.stdout.write('@@ttsu ' + JSON.stringify(obj) + '\n');
}

if (argv[0] === '-e') {
  const [, , cmd, ...rest] = argv;
  try {
    const paths = cmd === 'extract' ? [rest[0], rest[2]] : rest;
    if (!paths.every((p) => path.isAbsolute(p) && inside(p)))
      throw new Error('A path is not inside the work folder');
    if (cmd === 'inspect') {
      const f = rest[0];
      if (/\.(azw3|azw|mobi|prc)$/i.test(f))
        answer({
          ok: true,
          result: {
            size: fs.statSync(f).size,
            drm: fs.readFileSync(f).subarray(0, 3).toString() === 'DRM',
          },
        });
      else
        answer({
          ok: true,
          result: {
            size: fs.statSync(f).size,
            entries: entries(f).list.map((e) => ({ name: e.name, size: e.size })),
          },
        });
    } else if (cmd === 'extract') {
      fs.writeFileSync(rest[2], read(rest[0], rest[1]), { flag: 'wx' });
      answer({ ok: true });
    } else if (cmd === 'extractall') {
      for (const e of entries(rest[0]).list) {
        if (e.name.endsWith('/')) continue;
        const target = path.join(rest[1], e.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, read(rest[0], e.name));
      }
      answer({ ok: true, result: { ok: true } });
    } else throw new Error('Unknown command');
  } catch (err) {
    answer({ ok: false, error: String(err.message || err) });
  }
  process.exit(0);
}

// ebook-convert
const [input, output] = argv;
if (!inside(input) || !inside(output)) {
  process.stderr.write('outside the work folder\n');
  process.exit(3);
}
if (process.env.FAKE_FAIL_CONVERT === '1') {
  process.stderr.write('Conversion error: simulated\n');
  process.exit(1);
}
if (/\.txt$/i.test(output)) {
  const { list } = entries(input);
  const text = list
    .filter((e) => /\.x?html?$/i.test(e.name))
    .map((e) =>
      read(input, e.name)
        .toString('utf8')
        .replace(/<rt[^>]*>.*?<\/rt>/g, '')
        .replace(/<[^>]+>/g, ''),
    )
    .join('\n');
  fs.writeFileSync(output, text);
} else if (/\.(cbz|cbr)$/i.test(input)) {
  fs.copyFileSync(process.env.FAKE_COMIC_EPUB, output);
} else {
  fs.copyFileSync(input, output);
}
process.exit(0);
