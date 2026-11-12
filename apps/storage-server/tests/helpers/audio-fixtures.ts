/**
 * Audiobook fixtures shared by the audio tests (WP15a, WP15b): tiny m4b/mp3 files with
 * real headers, an audiobooks root shaped like the NAS one, and a scanned test server.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AudioOptions } from '../../src/audio/routes';
import { AudioScanService } from '../../src/audio/scan-service';
import { updateLibrary } from '../../src/calibre/libraries';
import { DEFAULT_AUDIO } from '../../src/config';
import { CalibreRoot, fingerprint } from './calibre-fixture';
import { enableLibrary, IndexerEnv, makeIndexerEnv } from './indexer-env';
import { makeTempDir } from './spawn-server';

export function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

export function mvhd(timescale: number, duration: number, version: 0 | 1 = 0): Buffer {
  const body = Buffer.alloc(100);
  body[0] = version;
  if (version === 0) {
    body.writeUInt32BE(timescale, 12);
    body.writeUInt32BE(duration, 16);
  } else {
    body.writeUInt32BE(timescale, 20);
    body.writeBigUInt64BE(BigInt(duration), 24);
  }
  return box('mvhd', body);
}

/** A minimal MP4/m4b: ftyp, moov (with mvhd), mdat; moov first or last. */
export function m4b(
  seconds: number,
  { moovAtEnd = false, version = 0 as 0 | 1, mdatBytes = 2048 } = {},
): Buffer {
  const ftyp = box('ftyp', Buffer.from('M4B \0\0\0\0isomM4B ', 'latin1'));
  const moov = box(
    'moov',
    mvhd(1000, Math.round(seconds * 1000), version),
    box('trak', Buffer.alloc(16)),
  );
  const mdat = box('mdat', Buffer.alloc(mdatBytes, 7));
  return moovAtEnd ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz, joint stereo. */
export const MP3_HEADER = Buffer.from([0xff, 0xfb, 0x90, 0x64]);

export function id3(size: number): Buffer {
  const h = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  h[6] = (size >> 21) & 0x7f;
  h[7] = (size >> 14) & 0x7f;
  h[8] = (size >> 7) & 0x7f;
  h[9] = size & 0x7f;
  return Buffer.concat([h, Buffer.alloc(size)]);
}

export function mp3({
  xingFrames,
  vbriFrames,
  bytes = 40_000,
  tag = 0,
}: {
  xingFrames?: number;
  vbriFrames?: number;
  bytes?: number;
  tag?: number;
}): Buffer {
  const frame = Buffer.alloc(417);
  MP3_HEADER.copy(frame, 0);
  if (xingFrames !== undefined) {
    frame.write('Xing', 36, 'latin1');
    frame.writeUInt32BE(1, 40);
    frame.writeUInt32BE(xingFrames, 44);
  }
  if (vbriFrames !== undefined) {
    frame.write('VBRI', 36, 'latin1');
    frame.writeUInt32BE(vbriFrames, 36 + 14);
  }
  const rest = Buffer.alloc(Math.max(0, bytes - frame.length));
  return Buffer.concat([tag ? id3(tag) : Buffer.alloc(0), frame, rest]);
}

export const reader = (buf: Buffer) => ({
  size: buf.length,
  read: async (position: number, length: number) => buf.subarray(position, position + length),
});

export function write(root: string, rel: string, content: Buffer | string): string {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

export const absMetadata = (title: string, series: string) =>
  JSON.stringify({ title, series: [series], asin: 'B0DNRYZJN7', authors: ['竹町'] });

/** An audiobooks root shaped like the NAS one (see decisions.md, "Phase 5 decisions"). */
export function makeAudiobooksRoot(): string {
  const root = makeTempDir('audiobooks');
  const u = 'japanese/_Unknown';
  write(
    root,
    `${u}/スパイ教室/Vol 1 - スパイ教室01 《花園》のリリィ/[01] スパイ教室01 《花園》のリリィ [B0DNRYZJN1].m4b`,
    m4b(36_000),
  );
  write(
    root,
    `${u}/スパイ教室/Vol 1 - スパイ教室01 《花園》のリリィ/metadata.json`,
    absMetadata('スパイ教室', 'スパイ教室 #1'),
  );
  write(
    root,
    `${u}/スパイ教室/Vol 2 - スパイ教室02 《愛娘》のグレーテ/[02] スパイ教室02 《愛娘》のグレーテ [B0DNRYZJN7].m4b`,
    m4b(34_200.5, { moovAtEnd: true }),
  );
  write(
    root,
    `${u}/スパイ教室/Vol 2 - スパイ教室02 《愛娘》のグレーテ/metadata.json`,
    absMetadata('スパイ教室', 'スパイ教室 #2'),
  );
  write(root, `${u}/スパイ教室/Vol 2 - スパイ教室02 《愛娘》のグレーテ/cover.jpg`, 'jpg');
  write(
    root,
    `${u}/かくりよの宿飯 あやかしお宿に嫁入りします。_ (KADOKAWA)/かくりよの宿飯.m4b`,
    m4b(40_000, { version: 1 }),
  );
  write(
    root,
    `${u}/神々の山嶺/Vol 1 - 神々の山嶺 上/[上巻] 神々の山嶺 上 [B0794V1N94].m4b`,
    m4b(50_000),
  );
  write(
    root,
    `${u}/神々の山嶺/Vol 2 - 神々の山嶺 下/[下巻] 神々の山嶺 下 [B079ZJGK34].m4b`,
    m4b(52_000),
  );
  write(root, `${u}/グイン・サーガ/01.mp3`, mp3({ xingFrames: 38_281 }));
  write(root, `${u}/グイン・サーガ/02.mp3`, mp3({ bytes: 128_000 }));
  write(root, `${u}/グイン・サーガ/03.mp3`, Buffer.from('not audio at all'));
  write(root, 'japanese/_Archives/old/zipped.m4b', m4b(10));
  write(root, 'japanese/.hidden/x.m4b', m4b(10));
  write(root, 'japanese/restructure_log.csv', 'a,b');
  write(
    root,
    'japanese-srt/Part 1/[2巻] スパイ教室02 《愛娘》のグレーテ.srt',
    '1\n00:00:00,000 --> 00:00:01,000\nテスト\n',
  );
  write(
    root,
    'japanese-srt/Part 1/[1巻] スパイ教室01 《花園》のリリィ.srt',
    '1\n00:00:00,000 --> 00:00:01,000\nテスト\n',
  );
  write(root, 'japanese-srt/subs-new/かくりよの宿飯 あやかしお宿に嫁入りします。.srt', 'x');
  write(root, 'japanese-srt/subs-new/pack.zip', 'zip');
  write(root, 'japanese-srt/older subs/05 - 神々の山嶺 上.vtt', 'WEBVTT');
  return root;
}

/** A Calibre library with 4 books, the audiobooks root above, a scanned index. */
export async function audioEnv(
  track: { envs: IndexerEnv[]; services: AudioScanService[] },
  { root = makeAudiobooksRoot(), books }: { root?: string; books?: string[] } = {},
) {
  const calibre = new CalibreRoot();
  const lib = calibre.library('japanese-library');
  if (books) {
    for (const title of books) await lib.addBook({ title });
  } else {
    await lib.addBook({
      title: 'スパイ教室02 《愛娘》のグレーテ',
      series: { name: 'スパイ教室', index: 2 },
    });
    await lib.addBook({ title: 'かくりよの宿飯　あやかしお宿に嫁入りします。' });
    await lib.addBook({ title: 'グイン・サーガ' });
    await lib.addBook({ title: 'むらさきのスカートの女' });
  }
  const audio: AudioOptions = { service: null };
  const e = makeIndexerEnv(calibre.dir, {}, {}, {}, { audio });
  track.envs.push(e);
  const service = new AudioScanService({
    db: e.db,
    config: { ...DEFAULT_AUDIO, dir: root },
    otherDirs: [{ name: 'DATA_DIR', dir: e.config.dataRoot }],
    log: (m) => e.logs.push(m),
    logError: (m) => e.logs.push(`ERROR ${m}`),
  });
  track.services.push(service);
  audio.service = service;
  await e.indexer.start({ timer: false });
  const libId = enableLibrary(e.db, 'japanese-library');
  await e.indexer.tick();
  updateLibrary(e.db, libId, { audioDir: 'japanese', subtitleDir: 'japanese-srt' });
  const before = fingerprint(root);
  await service.start({ timer: false });
  await service.idle();
  const auth = { Authorization: `Bearer ${e.token()}` };
  const bookId = (title: string) =>
    (e.db.prepare('SELECT id FROM books WHERE title = ?').get(title) as { id: string }).id;
  return { e, root, service, libId, auth, before, bookId, audio };
}

/**
 * WP15f: every file under `dir` (hidden ones too) with its SHA-256, size and mtime, to
 * prove existing files stay byte-identical.
 */
export function treeHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = fs.lstatSync(full);
        const sha = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        out[path.relative(dir, full).split(path.sep).join('/')] = `${sha}:${st.size}:${st.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** What changed between two treeHashes: added, removed and changed paths. */
export function treeDiff(before: Record<string, string>, after: Record<string, string>) {
  return {
    added: Object.keys(after)
      .filter((k) => !(k in before))
      .sort(),
    removed: Object.keys(before)
      .filter((k) => !(k in after))
      .sort(),
    changed: Object.keys(before)
      .filter((k) => k in after && before[k] !== after[k])
      .sort(),
  };
}
