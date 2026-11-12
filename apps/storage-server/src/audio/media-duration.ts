/**
 * Duration of an audio file from its headers (WP15a), read through a positioned
 * reader so only a few small reads are made (a 500 MB m4b costs a few KB).
 * - MP4 (.m4b, .m4a): the movie header (`moov` → `mvhd`) holds timescale and duration.
 * - MP3: the Xing/Info or VBRI header holds the frame count; otherwise the
 *   first frame's bitrate gives an estimate (exact for constant bitrate).
 * Returns null when the file can't be understood; the picker then shows no duration.
 */

export interface PositionedReader {
  readonly size: number;
  read(position: number, length: number): Promise<Buffer>;
}

/** Longer than this is treated as a misread header (no audiobook is 1,000 hours). */
const MAX_SECONDS = 1000 * 3600;
/** Boxes visited before giving up (a corrupt file must not loop forever). */
const MAX_BOXES = 10_000;

export async function audioDuration(
  reader: PositionedReader,
  extension: string,
): Promise<number | null> {
  const ext = extension.toLowerCase();
  const seconds =
    ext === '.mp3'
      ? await mp3Duration(reader)
      : ext === '.m4b' || ext === '.m4a'
        ? await mp4Duration(reader)
        : null;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS) {
    return null;
  }
  return Math.round(seconds * 1000) / 1000;
}

interface BoxHeader {
  type: string;
  start: number;
  /** Offset of the box's content. */
  contentStart: number;
  end: number;
}

async function readBoxHeader(
  reader: PositionedReader,
  position: number,
  limit: number,
): Promise<BoxHeader | null> {
  if (position + 8 > limit) return null;
  const head = await reader.read(position, 16);
  if (head.length < 8) return null;
  let size = head.readUInt32BE(0);
  const type = head.toString('latin1', 4, 8);
  let contentStart = position + 8;
  if (size === 1) {
    if (head.length < 16) return null;
    const big = head.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    contentStart = position + 16;
  } else if (size === 0) {
    size = limit - position;
  }
  if (size < contentStart - position || position + size > limit) return null;
  return { type, start: position, contentStart, end: position + size };
}

/** Finds the first child box of `type` between `from` and `to`. */
async function findBox(
  reader: PositionedReader,
  type: string,
  from: number,
  to: number,
): Promise<BoxHeader | null> {
  let position = from;
  for (let i = 0; i < MAX_BOXES && position < to; i += 1) {
    const box = await readBoxHeader(reader, position, to);
    if (!box) return null;
    if (box.type === type) return box;
    if (box.end <= position) return null;
    position = box.end;
  }
  return null;
}

async function mp4Duration(reader: PositionedReader): Promise<number | null> {
  const moov = await findBox(reader, 'moov', 0, reader.size);
  if (!moov) return null;
  const mvhd = await findBox(reader, 'mvhd', moov.contentStart, moov.end);
  if (!mvhd) return null;
  const body = await reader.read(mvhd.contentStart, 32);
  if (body.length < 20) return null;
  const version = body.readUInt8(0);
  if (version === 1) {
    if (body.length < 32) return null;
    const timescale = body.readUInt32BE(20);
    const duration = Number(body.readBigUInt64BE(24));
    return timescale ? duration / timescale : null;
  }
  const timescale = body.readUInt32BE(12);
  const duration = body.readUInt32BE(16);
  return timescale ? duration / timescale : null;
}

const MP3_BITRATES = {
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

/** Skips any ID3v2 tags at the start; returns where the audio frames begin. */
async function skipId3(reader: PositionedReader): Promise<number> {
  let position = 0;
  for (let i = 0; i < 4; i += 1) {
    const head = await reader.read(position, 10);
    if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') break;
    const size =
      ((head[6] & 0x7f) << 21) |
      ((head[7] & 0x7f) << 14) |
      ((head[8] & 0x7f) << 7) |
      (head[9] & 0x7f);
    const footer = (head[5] & 0x10) !== 0 ? 10 : 0;
    position += 10 + size + footer;
  }
  return position;
}

async function mp3Duration(reader: PositionedReader): Promise<number | null> {
  const audioStart = await skipId3(reader);
  const window = await reader.read(audioStart, 64 * 1024);
  for (let i = 0; i + 4 <= window.length; i += 1) {
    if (window[i] !== 0xff || (window[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (window[i + 1] >> 3) & 3;
    const layerBits = (window[i + 1] >> 1) & 3;
    const bitrateIndex = window[i + 2] >> 4;
    const rateIndex = (window[i + 2] >> 2) & 3;
    // Layer III only (audiobooks); 1 = reserved version, 15 = bad bitrate, 3 = reserved rate.
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15) continue;
    if (rateIndex === 3) continue;
    const mpeg1 = versionBits === 3;
    const bitrate = (mpeg1 ? MP3_BITRATES.v1l3 : MP3_BITRATES.v2l3)[bitrateIndex] * 1000;
    const sampleRate = MP3_SAMPLE_RATES[versionBits][rateIndex];
    const samplesPerFrame = mpeg1 ? 1152 : 576;
    const mono = window[i + 3] >> 6 === 3;
    const frameStart = audioStart + i;

    const sideInfo = mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xing = await reader.read(frameStart + 4 + sideInfo, 16);
    const tag = xing.toString('latin1', 0, 4);
    if (
      (tag === 'Xing' || tag === 'Info') &&
      xing.length >= 12 &&
      (xing.readUInt32BE(4) & 1) !== 0
    ) {
      const frames = xing.readUInt32BE(8);
      if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
    }
    const vbri = await reader.read(frameStart + 4 + 32, 18);
    if (vbri.length >= 18 && vbri.toString('latin1', 0, 4) === 'VBRI') {
      const frames = vbri.readUInt32BE(14);
      if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
    }
    return ((reader.size - frameStart) * 8) / bitrate;
  }
  return null;
}
