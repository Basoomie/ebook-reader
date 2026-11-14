/**
 * A minimal, read-only ZIP reader for the WP5 migration (no dependency).
 *
 * The fingerprint check only needs each entry's name and CRC32 from the
 * central directory, plus a few small text entries (container.xml, the OPF,
 * staticdata.json). Only the central directory and the requested entries are
 * read; the file is opened with flag 'r' through the opener the caller passes,
 * so the caller decides which read-only module touches the file.
 *
 * Supported: stored (0) and deflated (8) entries. Not supported (reported as
 * an error, which the scan shows as "damaged"): ZIP64, encryption, other
 * compression methods.
 */
import type { FileHandle } from 'fs/promises';
import { inflateRawSync } from 'zlib';

export interface ZipEntryInfo {
  name: string;
  crc32: number;
  method: number;
  flags: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
}

export type ReadOnlyOpener = (file: string) => Promise<FileHandle>;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
/** Largest entry readText() inflates (staticdata.json holds a whole book's HTML). */
export const MAX_TEXT_ENTRY_BYTES = 64 * 1024 * 1024;

// IBM code page 437, upper half (names without the UTF-8 flag are decoded as
// CP437, like zip.js does, so names compare the same way as in WP3a).
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

export class ZipError extends Error {}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new ZipError('Unexpected end of file');
    done += bytesRead;
  }
  return buf;
}

export class ZipFile {
  private constructor(
    private readonly handle: FileHandle,
    readonly entries: ZipEntryInfo[],
  ) {}

  /** Opens a ZIP and reads its central directory. Close it when done. */
  static async open(file: string, opener: ReadOnlyOpener): Promise<ZipFile> {
    const handle = await opener(file);
    try {
      const size = (await handle.stat()).size;
      if (size < EOCD_MIN) throw new ZipError('Not a ZIP file (too small)');
      const tailLength = Math.min(size, EOCD_MIN + MAX_COMMENT);
      const tail = await readAt(handle, size - tailLength, tailLength);
      let eocd = -1;
      for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
          eocd = i;
          break;
        }
      }
      if (eocd === -1) throw new ZipError('Not a ZIP file (no end of central directory)');
      const count = tail.readUInt16LE(eocd + 10);
      const cdSize = tail.readUInt32LE(eocd + 12);
      const cdOffset = tail.readUInt32LE(eocd + 16);
      if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new ZipError('ZIP64 files are not supported');
      }
      if (cdOffset + cdSize > size) throw new ZipError('Central directory out of range');
      const cd = await readAt(handle, cdOffset, cdSize);
      const entries: ZipEntryInfo[] = [];
      let p = 0;
      for (let n = 0; n < count; n++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
          throw new ZipError('Damaged central directory');
        }
        const flags = cd.readUInt16LE(p + 8);
        const nameLength = cd.readUInt16LE(p + 28);
        const extraLength = cd.readUInt16LE(p + 30);
        const commentLength = cd.readUInt16LE(p + 32);
        const rawName = cd.subarray(p + 46, p + 46 + nameLength);
        entries.push({
          name: flags & 0x800 ? rawName.toString('utf8') : decodeCp437(rawName),
          flags,
          method: cd.readUInt16LE(p + 10),
          crc32: cd.readUInt32LE(p + 16),
          compressedSize: cd.readUInt32LE(p + 20),
          size: cd.readUInt32LE(p + 24),
          localHeaderOffset: cd.readUInt32LE(p + 42),
        });
        p += 46 + nameLength + extraLength + commentLength;
      }
      return new ZipFile(handle, entries);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  get(name: string): ZipEntryInfo | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** Reads and inflates one entry as UTF-8 text. */
  async readText(entry: ZipEntryInfo): Promise<string> {
    return (await this.readBytes(entry, MAX_TEXT_ENTRY_BYTES)).toString('utf8');
  }

  /** Reads and inflates one entry (at most `maxBytes`, compressed and inflated). */
  async readBytes(entry: ZipEntryInfo, maxBytes: number): Promise<Buffer> {
    if (entry.flags & 0x1) throw new ZipError(`Encrypted entry: ${entry.name}`);
    if (entry.size > maxBytes || entry.compressedSize > maxBytes) {
      throw new ZipError(`Entry too large: ${entry.name}`);
    }
    const header = await readAt(this.handle, entry.localHeaderOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipError(`Damaged local header: ${entry.name}`);
    }
    const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    const raw = await readAt(this.handle, start, entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: maxBytes });
    throw new ZipError(`Unsupported compression ${entry.method}: ${entry.name}`);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
