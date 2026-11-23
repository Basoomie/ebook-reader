/**
 * WP21f-1: reading archives (.zip/.rar/.7z) under the torrents, read only. bsdtar (libarchive)
 * gets the archive as a read-only file descriptor (/dev/fd/3) and only ever lists it (-t) or
 * writes one entry to its standard output (-x -O): it never gets a folder or a file name to
 * write to. writer.ts (the only module that writes) puts those bytes into a new file under
 * torrents/audiobooks/japanese/_extracted/.
 *
 * Names: bsdtar lists in a UTF-8 locale, so a name that is valid UTF-8 prints as it is and the
 * bytes of any other name print as \ooo escapes (bsdtar's own safe printing). A zip that doesn't
 * mark its names as UTF-8 and holds Japanese names is almost always CP932 (Windows): it is listed
 * again with libarchive converting from CP932, and those converted names are what the entries
 * are asked for by (so the name and the pattern come from the same conversion).
 */
import { spawn } from 'child_process';
import type { FileHandle } from 'fs/promises';

export interface ArchiveEntry {
  /** The path inside the archive as text (as bsdtar's -x is asked for it). */
  name: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  size: number;
}

export interface ArchiveListing {
  entries: ArchiveEntry[];
  /** utf8: names as they are; cp932: names converted from CP932 (hdrcharset). */
  encoding: 'utf8' | 'cp932';
  /** Why the archive can't be used (names in two encodings, unreadable names), or null. */
  problem: string | null;
}

/**
 * WP20g: the entries of a book archive the server keeps: EPUBs, the other book formats and
 * files without an extension (the server's catalog.ts classifyName; a test keeps the two
 * lists the same). An archive of tens of thousands of pictures sends a short list (stop 2 on
 * the NAS: a listing over the server's 4 MB limit stopped the import's archives).
 */
const BOOK_ENTRY =
  /\.(epub|azw|azw3|azw4|mobi|prc|kfx|kpf|pdf|cbz|cbr|cb7|djvu|djv|fb2|lit|lrf|pdb)$/i;

export function bookEntries(entries: ArchiveEntry[]): { entries: ArchiveEntry[]; others: number } {
  const out: ArchiveEntry[] = [];
  let others = 0;
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const base = e.name.slice(e.name.lastIndexOf('/') + 1);
    if (BOOK_ENTRY.test(base) || base.lastIndexOf('.') <= 0) out.push(e);
    else others++;
  }
  return { entries: out, others };
}

export interface ToolRun {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

/** The CP932 converter's name for libarchive (iconv); a setting of the sidecar. */
export const DEFAULT_CHARSET = 'CP932';

/** Runs bsdtar with the archive as fd 3 (read only); collects the output (listings only). */
export function runBsdtar(
  bsdtar: string,
  archive: FileHandle,
  args: string[],
  limitBytes = 64 * 1024 * 1024
): Promise<ToolRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(bsdtar, args, {
      stdio: ['ignore', 'pipe', 'pipe', archive.fd],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    child.stdout!.on('data', (b: Buffer) => {
      size += b.length;
      if (size > limitBytes) child.kill('SIGKILL');
      else out.push(b);
    });
    child.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: size > limitBytes ? -1 : code, stdout: Buffer.concat(out), stderr: err })
    );
  });
}

/** bsdtar's escapes (\ooo octal bytes and \\) back to the name's bytes. */
export function unescapeName(s: string): Buffer {
  const out: number[] = [];
  const bytes = Buffer.from(s, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0x5c && i + 1 < bytes.length) {
      const n = bytes[i + 1];
      if (n === 0x5c) {
        out.push(0x5c);
        i++;
        continue;
      }
      const oct = bytes.subarray(i + 1, i + 4).toString('latin1');
      if (/^[0-7]{3}$/.test(oct)) {
        out.push(parseInt(oct, 8));
        i += 3;
        continue;
      }
    }
    out.push(c);
  }
  return Buffer.from(out);
}

const LINE =
  /^([-dlbcps?hw][-rwxsStTlL?+.@]{9}[+.@]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s(.*)$/;

/**
 * bsdtar -tv lines. A symlink prints `name -> target`, a hard link `name link to target`.
 * Returns the entries with their names as bytes (null for a line that isn't an entry).
 */
export function parseListing(
  text: string
): { raw: Buffer; kind: ArchiveEntry['kind']; size: number }[] {
  const out: { raw: Buffer; kind: ArchiveEntry['kind']; size: number }[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const m = LINE.exec(line.replace(/\r$/, ''));
    if (!m) throw new Error(`Unexpected listing line: ${line.slice(0, 200)}`);
    const type = m[1][0];
    let name = m[3];
    let kind: ArchiveEntry['kind'] =
      type === '-' ? 'file' : type === 'd' ? 'dir' : type === 'l' ? 'link' : 'other';
    if (kind === 'link') name = name.replace(/ -> .*$/, '');
    const hard = / link to .*$/.exec(name);
    if (hard && kind === 'file') {
      kind = 'link';
      name = name.slice(0, hard.index);
    }
    out.push({ raw: unescapeName(name), kind, size: Number(m[2]) });
  }
  return out;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** A name's bytes as UTF-8 text, or null. */
export function asUtf8(raw: Buffer): string | null {
  try {
    return utf8.decode(raw);
  } catch {
    return null;
  }
}

/**
 * Lists an archive: every entry with its kind and size, names as text. A listing bsdtar can't
 * finish (not an archive, damaged, a header it can't read) throws with bsdtar's message.
 */
export async function listArchive(
  bsdtar: string,
  archive: FileHandle,
  charset = DEFAULT_CHARSET
): Promise<ArchiveListing> {
  const first = await runBsdtar(bsdtar, archive, ['-t', '-v', '-f', '/dev/fd/3']);
  if (first.code !== 0)
    throw new Error(first.stderr.trim().slice(0, 500) || `bsdtar exit ${first.code}`);
  const raw = parseListing(first.stdout.toString('utf8'));
  const names = raw.map((e) => asUtf8(e.raw));
  if (names.every((n) => n !== null)) {
    return {
      entries: raw.map((e, i) => ({ name: names[i] as string, kind: e.kind, size: e.size })),
      encoding: 'utf8',
      problem: null
    };
  }
  // Some names aren't UTF-8: libarchive converts from CP932 (names a zip marks as UTF-8 stay
  // as they are, so a mix of both shows as two encodings below).
  const again = await runBsdtar(bsdtar, archive, [
    '-t',
    '-v',
    '--options',
    `hdrcharset=${charset}`,
    '-f',
    '/dev/fd/3'
  ]);
  if (again.code !== 0)
    return {
      entries: [],
      encoding: 'cp932',
      problem: `Names can't be read as ${charset}: ${again.stderr.trim().slice(0, 300)}`
    };
  const conv = parseListing(again.stdout.toString('utf8'));
  if (conv.length !== raw.length)
    return { entries: [], encoding: 'cp932', problem: 'The two listings differ' };
  const out: ArchiveEntry[] = [];
  for (let i = 0; i < conv.length; i++) {
    const n = asUtf8(conv[i].raw);
    if (n === null) return { entries: [], encoding: 'cp932', problem: 'Names in two encodings' };
    // A name that was UTF-8 already and changes under CP932: two encodings in one archive.
    if (
      names[i] !== null &&
      [...(names[i] as string)].some((c) => c.charCodeAt(0) > 0x7f) &&
      n !== names[i]
    )
      return { entries: [], encoding: 'cp932', problem: 'Names in two encodings' };
    out.push({ name: n, kind: conv[i].kind, size: conv[i].size });
  }
  return { entries: out, encoding: 'cp932', problem: null };
}

/**
 * One entry's bytes from bsdtar's standard output (the archive as fd 3, read only). `done`
 * resolves with bsdtar's exit code and its last messages once the stream has ended.
 */
export function entryStream(
  bsdtar: string,
  archive: FileHandle,
  args: string[]
): {
  stream: NodeJS.ReadableStream;
  done: Promise<{ code: number | null; stderr: string }>;
  kill: () => void;
} {
  const child = spawn(bsdtar, args, {
    stdio: ['ignore', 'pipe', 'pipe', archive.fd],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }
  });
  let err = '';
  child.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: err }));
  });
  return { stream: child.stdout!, done, kill: () => child.kill('SIGKILL') };
}

/** A bsdtar pattern that matches exactly this name (its pattern characters escaped). */
export function exactPattern(name: string): string {
  return name.replace(/[\\*?[\]]/g, (c) => '\\' + c);
}

/** The arguments that write exactly one entry to standard output. */
export function extractArgs(
  name: string,
  encoding: 'utf8' | 'cp932',
  charset = DEFAULT_CHARSET
): string[] {
  return [
    '-x',
    '-O',
    ...(encoding === 'cp932' ? ['--options', `hdrcharset=${charset}`] : []),
    '-f',
    '/dev/fd/3',
    '--',
    exactPattern(name)
  ];
}

// ---- WP20g: split sets (.001, .002 …) through 7-Zip -----------------------------------------
//
// bsdtar can't read a split set (it takes one file). 7-Zip (`7zz`) opens the first volume by its
// name and finds the others beside it; it only lists (`l`) or writes one entry to its standard
// output (`x -so`), never a file. Names: UTF-8 on the console (-sccUTF-8); a zip's names without
// the UTF-8 flag are read as CP932 (-mcp=932), the Japanese sources' encoding.

/** 7-Zip's arguments shared by listing and extracting. */
// A fixed wrong password: an encrypted set fails ("Wrong password") instead of waiting for input.
const SEVEN_COMMON = ['-sccUTF-8', '-mcp=932', '-bb0', '-bd', '-pttsu-no-password'];

function runSeven(
  sevenZip: string,
  args: string[],
  limitBytes = 64 * 1024 * 1024
): Promise<ToolRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    child.stdout!.on('data', (b: Buffer) => {
      size += b.length;
      if (size > limitBytes) child.kill('SIGKILL');
      else out.push(b);
    });
    child.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code: size > limitBytes ? -1 : code, stdout: Buffer.concat(out), stderr: err })
    );
  });
}

/** `7zz l -slt -ba` blocks ("Path = …", "Size = …", "Folder = +/-", "Attributes = …"). */
export function parseSevenListing(text: string): ArchiveEntry[] {
  const out: ArchiveEntry[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const f: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' = ');
      if (i > 0) f[line.slice(0, i)] = line.slice(i + 3);
    }
    if (f.Path === undefined) continue;
    const attrs = f.Attributes ?? '';
    const kind: ArchiveEntry['kind'] =
      f.Folder === '+' || /^D/.test(attrs)
        ? 'dir'
        : /\sl[r-][w-]/.test(` ${attrs}`)
          ? 'link'
          : 'file';
    const size = Number(f.Size ?? '0');
    out.push({ name: f.Path, kind, size: Number.isFinite(size) && size >= 0 ? size : 0 });
  }
  return out;
}

/** Lists a split set from its first volume (a path checked by the writer). Throws on 7-Zip's error. */
export async function listSevenZip(
  sevenZip: string,
  file: string | Buffer
): Promise<ArchiveListing> {
  const name = typeof file === 'string' ? file : file.toString('latin1');
  const r = await runSeven(sevenZip, ['l', '-slt', '-ba', ...SEVEN_COMMON, '--', name]);
  if (/Wrong password|Enter password|encrypted/i.test(r.stderr))
    return { entries: [], encoding: 'utf8', problem: 'The archive needs a password' };
  if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 500) || `7zz exit ${r.code}`);
  return { entries: parseSevenListing(r.stdout.toString('utf8')), encoding: 'utf8', problem: null };
}

/** One entry of a split set written to 7-Zip's standard output (wildcards off: -spd). */
export function sevenEntryStream(
  sevenZip: string,
  file: string | Buffer,
  entry: string
): {
  stream: NodeJS.ReadableStream;
  done: Promise<{ code: number | null; stderr: string }>;
  kill: () => void;
} {
  const name = typeof file === 'string' ? file : file.toString('latin1');
  const child = spawn(sevenZip, ['x', '-so', '-spd', ...SEVEN_COMMON, '--', name, entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' }
  });
  let err = '';
  child.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)));
  const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: err }));
  });
  return { stream: child.stdout!, done, kill: () => child.kill('SIGKILL') };
}
