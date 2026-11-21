/**
 * WP21f-1 stop 1: the expected counts for the archives under the torrents, read only. For each
 * archive of a copy of the live cleanup.db (audio_files, kind archive), its zip central directory
 * is read over SMB (the end of the file only: the directory and its end record, never the data):
 * entries, names (UTF-8 when the zip marks them so, else CP932), sizes, encrypted entries, links.
 * A RAR (or anything that isn't a zip) is tried with the PC's tar on stdin. Windows bsdtar can't
 * show RAR5's Japanese names, so a RAR reported as failed here is listed in the Linux image
 * instead (the sidecar's bsdtar): copy it locally, then
 *   docker run --rm -v <dir>:/a:ro --entrypoint sh ttsu-test:wp21f -c 'LC_ALL=C.UTF-8 bsdtar -tvf /a/a.rar'
 * Then what the arrivals run would do with each: unpack (audio inside), password, no audio, not an
 * archive, unreadable names; and how many of the audio entries have the size of a torrent audio
 * file already there (likely the same file: stage 1 hashes them) and whose ASIN an existing
 * recording has.
 *
 *   npx ts-node --transpile-only scripts/wp21f-archives.ts --db <copy/cleanup.db>
 *     --torrents \\192.168.1.5\data\torrents\audiobooks\japanese [--out report.json]
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { AUDIO_EXTS } from '../src/cleanup/audio/walk';
import { entrySkip } from '../src/cleanup/audio/stage7-arrivals';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

interface Entry {
  name: string | null;
  raw: Buffer;
  utf8Flag: boolean;
  size: number;
  compressed: number;
  encrypted: boolean;
  link: boolean;
  dir: boolean;
}

const sjis = new TextDecoder('shift_jis', { fatal: true });
const utf8 = new TextDecoder('utf-8', { fatal: true });

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  let off = 0;
  while (off < len) {
    const n = fs.readSync(fd, b, off, len - off, pos + off);
    if (n === 0) break;
    off += n;
  }
  return b.subarray(0, off);
}

/** The zip's central directory (zip64 included), or why it can't be read. */
function zipEntries(file: string): { entries: Entry[] } | { problem: string } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65_557 + 20);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50) {
        e = i;
        break;
      }
    if (e < 0) return { problem: 'No zip end record (not a zip)' };
    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOff = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
      // ZIP64: the locator just before the end record.
      const l = e - 20;
      if (l < 0 || tail.readUInt32LE(l) !== 0x07064b50)
        return { problem: 'ZIP64 without a locator' };
      const z64 = Number(tail.readBigUInt64LE(l + 8));
      const rec = readAt(fd, z64, 56);
      if (rec.readUInt32LE(0) !== 0x06064b50) return { problem: 'ZIP64 end record missing' };
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOff = Number(rec.readBigUInt64LE(48));
    }
    const cd = readAt(fd, cdOff, cdSize);
    const out: Entry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50)
        return { problem: `Bad central directory at entry ${i}` };
      const flags = cd.readUInt16LE(p + 8);
      let compressed = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const xlen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const made = cd.readUInt16LE(p + 4) >> 8;
      const ext = cd.readUInt32LE(p + 38);
      const raw = cd.subarray(p + 46, p + 46 + nlen);
      const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
      // ZIP64 sizes in the extra field.
      for (let x = 0; x + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(x);
        const len = extra.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) {
            usize = Number(extra.readBigUInt64LE(q));
            q += 8;
          }
          if (compressed === 0xffffffff) compressed = Number(extra.readBigUInt64LE(q));
        }
        x += 4 + len;
      }
      const utf8Flag = (flags & 0x0800) !== 0;
      let name: string | null = null;
      try {
        name = utf8.decode(raw); // valid UTF-8 first (flagged or not), as the sidecar's listArchive
      } catch {
        name = null;
      }
      const unixMode = made === 3 ? ext >>> 16 : 0;
      out.push({
        name,
        raw,
        utf8Flag,
        size: usize,
        compressed,
        encrypted: (flags & 1) !== 0,
        link: (unixMode & 0o170000) === 0o120000,
        dir: raw.length > 0 && raw[raw.length - 1] === 0x2f,
      });
      p += 46 + nlen + xlen + clen;
    }
    return { entries: out };
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  const dbPath = arg('db')!;
  const torrents = arg('torrents')!;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const archives = db
    .prepare(
      `SELECT rel_path, size FROM audio_files WHERE root = 'torrents' AND kind = 'archive' AND gone_at IS NULL ORDER BY rel_path`,
    )
    .all() as { rel_path: string; size: number }[];
  const sizes = new Map<number, number>();
  for (const r of db
    .prepare(
      `SELECT size, COUNT(*) AS n FROM audio_files WHERE root = 'torrents' AND kind = 'audio' AND gone_at IS NULL GROUP BY size`,
    )
    .all() as { size: number; n: number }[])
    sizes.set(r.size, r.n);
  const asins = new Set<string>();
  for (const r of db.prepare('SELECT inputs_json FROM audio_online_units').all() as {
    inputs_json: string;
  }[])
    for (const m of r.inputs_json.match(/B0[0-9A-Z]{8}/g) ?? []) asins.add(m);
  const report: Record<string, unknown>[] = [];
  const totals = {
    archives: archives.length,
    bytes: 0,
    unpack: 0,
    password: 0,
    noAudio: 0,
    notArchive: 0,
    names: 0,
    failed: 0,
    entries: 0,
    audioEntries: 0,
    audioBytes: 0,
    skipped: 0,
    links: 0,
    cp932Archives: 0,
    utf8Archives: 0,
    audioSameSizeAsTorrent: 0,
    archivesWithKnownAsin: 0,
    readBytes: 0,
  };
  for (const a of archives) {
    totals.bytes += a.size;
    const file = path.join(torrents, ...a.rel_path.split('/'));
    const base = a.rel_path.split('/').pop()!;
    const asin = (a.rel_path.match(/B0[0-9A-Z]{8}/) ?? [])[0] ?? null;
    if (asin && asins.has(asin)) totals.archivesWithKnownAsin++;
    let state = '';
    let detail: string | null = null;
    let encoding: string | null = null;
    let entries: Entry[] = [];
    if (/\.zip$/i.test(base)) {
      const r = zipEntries(file);
      if ('problem' in r) {
        state = base.startsWith('._') ? 'not_archive' : 'failed';
        detail = r.problem;
      } else entries = r.entries;
    } else {
      // A RAR: the PC's tar (libarchive) lists it (names are not needed for the counts).
      try {
        // On stdin: Windows tar can't open a name outside the ANSI code page, and reads "Z:" as a host.
        const fd = fs.openSync(file, 'r');
        let out: string;
        try {
          out = execFileSync('tar', ['-tvf', '-'], {
            encoding: 'latin1',
            maxBuffer: 64 << 20,
            stdio: [fd, 'pipe', 'pipe'],
          });
        } finally {
          fs.closeSync(fd);
        }
        for (const line of out.split(/\r?\n/).filter(Boolean)) {
          const m = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s(.*)$/.exec(line);
          if (!m) continue;
          entries.push({
            name: m[3],
            raw: Buffer.from(m[3], 'latin1'),
            utf8Flag: true,
            size: Number(m[2]),
            compressed: 0,
            encrypted: false,
            link: m[1] === 'l',
            dir: m[1] === 'd',
          });
        }
        if (!entries.length) {
          state = base.startsWith('._') ? 'not_archive' : 'no_audio';
          detail = 'Empty listing';
        }
      } catch (err) {
        state = base.startsWith('._') ? 'not_archive' : 'failed';
        detail = String((err as Error).message)
          .split('\n')[0]
          .slice(0, 200);
      }
    }
    if (!state) {
      // Names: UTF-8 when marked (or valid); else CP932.
      const nonUtf = entries.filter((e) => e.name === null);
      if (nonUtf.length) {
        encoding = 'cp932';
        for (const e of entries)
          if (e.name === null)
            try {
              e.name = sjis.decode(e.raw);
            } catch {
              e.name = null;
            }
        const markedMixed = entries.some((e) => e.utf8Flag && /[^\x20-\x7e]/.test(e.name ?? ''));
        if (entries.some((e) => e.name === null) || markedMixed) {
          state = 'names';
          detail = 'Names in two encodings or not readable';
        }
      } else encoding = 'utf8';
    }
    const files = entries.filter((e) => !e.dir && !e.link);
    const usable = files.filter((e) => e.name && entrySkip(e.name.replace(/^\.\//, '')) === null);
    const audio = usable.filter((e) => AUDIO_EXTS.has(path.extname(e.name!).toLowerCase()));
    if (!state) {
      if (audio.some((e) => e.encrypted) || files.some((e) => e.encrypted)) state = 'password';
      else if (!audio.length) state = 'no_audio';
      else state = 'unpack';
    }
    if (encoding === 'cp932') totals.cp932Archives++;
    if (encoding === 'utf8') totals.utf8Archives++;
    const same = audio.filter((e) => sizes.has(e.size)).length;
    totals.entries += files.length;
    totals.skipped += files.length - usable.length;
    totals.links += entries.filter((e) => e.link).length;
    if (state === 'unpack') {
      totals.unpack++;
      totals.audioEntries += audio.length;
      totals.audioBytes += audio.reduce((s, e) => s + e.size, 0);
      totals.audioSameSizeAsTorrent += same;
    } else if (state === 'password') totals.password++;
    else if (state === 'no_audio') totals.noAudio++;
    else if (state === 'not_archive') totals.notArchive++;
    else if (state === 'names') totals.names++;
    else totals.failed++;
    report.push({
      rel: a.rel_path,
      size: a.size,
      state,
      detail,
      encoding,
      entries: files.length,
      audio: audio.length,
      audioBytes: audio.reduce((s, e) => s + e.size, 0),
      sameSizeAsTorrent: same,
      asinKnown: asin ? asins.has(asin) : null,
      skipped: files
        .filter((e) => !e.name || entrySkip(e.name.replace(/^\.\//, '')) !== null)
        .slice(0, 5)
        .map(
          (e) =>
            `${e.name ?? '(unreadable)'}: ${e.name ? entrySkip(e.name.replace(/^\.\//, '')) : 'name'}`,
        ),
      sample: audio.slice(0, 3).map((e) => e.name),
    });
  }
  console.log(JSON.stringify(totals, null, 1));
  const out = arg('out');
  if (out) fs.writeFileSync(out, JSON.stringify({ totals, archives: report }, null, 1));
}

main();
