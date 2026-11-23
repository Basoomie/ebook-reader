/**
 * WP21g stop 1: what Audiobookshelf 2.37.1 (the live version) makes of stage 8's genres and tags,
 * on a scratch ABS in its own compose project, volumes and port (removed at the end). Settings as
 * live (metadata and cover stored with the item), the watcher off (the NAS's FUSE layer gives ABS
 * no file events: WP21f-2 B0). The files are written as the real code writes them
 * (`metadataBytes`), by a helper container on the same volume (temp file + rename, as the linking
 * sidecar does), and ABS is told only through the real modules (`AbsLibraryScan`, `AbsSetFields`,
 * `AbsClearFields`).
 *
 *   npx vite-node scripts/wp21g-abs-proof.ts -- --root C:/Data/Projects/local-ttsu/.tmp-e2e/wp21g-abs
 *
 * 1. round trip: genres and tags (Japanese labels, their order, ドラマCD last) as written.
 * 2. ABS's fill: genres [] with a `genre` tag in the audio file.
 * 3. our genres over that fill, by the library scan alone, with progress and a bookmark.
 * 4. genres emptied: the scan keeps the old ones; the clear call empties them; a later scan.
 * 5. a series gained from the ebook: the folder moved into Author/Series/Vol N - Title, one library
 *    scan: the same item, its progress, bookmark and finished flag.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bookValues, metadataBytes } from '../src/cleanup/audio/build-metadata';
import { AbsLibraryScan } from '../src/cleanup/audio/abs-library-scan';
import { AbsSetFields } from '../src/cleanup/audio/abs-set-fields';
import { AbsClearFields } from '../src/cleanup/audio/abs-clear-fields';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`--${name} is required`);
}
const ROOT = arg('root');
fs.mkdirSync(ROOT, { recursive: true });
const P = 'wp21gabs';
const PORT = 23411;
const ABS = `http://localhost:${PORT}`;
const IMAGE = 'ghcr.io/advplyr/audiobookshelf:2.37.1';
const LIB = '/audiobooks/japanese';
const FX = '/fx/data/media/audiobooks/japanese';
fs.writeFileSync(
  path.join(ROOT, 'compose.yml'),
  `# WP21g scratch Audiobookshelf 2.37.1 (the live version). Removed by scripts/wp21g-abs-proof.ts.
name: ${P}
services:
  abs:
    image: ${IMAGE}
    ports:
      - '${PORT}:80'
    volumes:
      - absconfig:/config
      - absmeta:/metadata
      - type: volume
        source: fx
        target: /audiobooks
        volume:
          subpath: data/media/audiobooks
volumes:
  fx:
  absconfig:
  absmeta:
`,
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = (cmd: string, args: string[], input?: string) =>
  spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 1 << 26 });
const compose = (...a: string[]) =>
  run('docker', ['compose', '-f', path.join(ROOT, 'compose.yml'), '-p', P, ...a]);
const sh = (script: string) => {
  const r = run(
    'docker',
    ['run', '--rm', '-i', '-v', `${P}_fx:/fx`, '--entrypoint', 'sh', IMAGE, '-s'],
    script,
  );
  if (r.status !== 0) throw new Error(`helper failed: ${r.stderr}\n${script.slice(0, 400)}`);
  return r.stdout;
};
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const logFile = path.join(ROOT, 'proof.log');
fs.writeFileSync(logFile, '');
const log = (...a: unknown[]) => {
  const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(l);
  fs.appendFileSync(logFile, l + '\n');
};
let token = '';
async function call(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(`${ABS}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${t.slice(0, 200)}`);
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}
/** metadata.json as the cleanup writes it (temp file + rename over it). */
const writeMeta = (dir: string, values: Record<string, unknown>) => {
  const bytes = metadataBytes(bookValues(values, path.posix.basename(dir))).toString('utf8');
  return `printf '%s' ${q(bytes)} > ${q(`${FX}/${dir}/.metadata.json.tmp`)} && mv ${q(`${FX}/${dir}/.metadata.json.tmp`)} ${q(`${FX}/${dir}/metadata.json`)}`;
};
const readMeta = (dir: string) =>
  JSON.parse(sh(`cat ${q(`${FX}/${dir}/metadata.json`)}`)) as Record<string, unknown>;
const tone = (file: string, tags: Record<string, string>, seconds = 30) =>
  `ffmpeg -v error -f lavfi -i sine=frequency=440:sample_rate=22050 -t ${seconds} -ac 1 -q:a 9 -map_metadata -1 ${Object.entries(
    tags,
  )
    .map(([k, v]) => `-metadata ${k}=${q(v)}`)
    .join(' ')} ${q(`${FX}/${file}`)}`;

const BOOKS = {
  round: '作者R/往復',
  fill: '作者F/埋める',
  clear: '作者C/消す',
  move: '作者M/動く',
  moveTo: '作者M/シリーズM/Vol 2 - 動く',
};
const base = (title: string, more: Record<string, unknown> = {}) => ({
  title,
  authors: [title === '往復' ? '作者R' : `作者${title}`],
  narrators: ['読み手'],
  ...more,
});
const out: Record<string, unknown> = { at: new Date().toISOString() };
try {
  compose('down', '-v');
  sh(
    [
      'set -e',
      ...Object.entries(BOOKS)
        .filter(([k]) => k !== 'moveTo')
        .map(([, d]) => `mkdir -p ${q(`${FX}/${d}`)}`),
      tone(`${BOOKS.round}/book.mp3`, { album: '往復', artist: '作者R' }),
      tone(`${BOOKS.fill}/book.mp3`, {
        album: '埋める',
        artist: '作者F',
        genre: '文学・フィクション, ライトノベル(ラノベ)',
      }),
      tone(`${BOOKS.clear}/book.mp3`, { album: '消す', artist: '作者C', genre: 'Audiobook' }),
      tone(`${BOOKS.move}/book.mp3`, { album: '動く', artist: '作者M' }, 60),
      writeMeta(BOOKS.round, {
        ...base('往復'),
        genres: ['ファンタジー', '恋愛', '歴史・時代'],
        ebook_tags: ['異世界', '男性主人公', 'アニメ化', 'ライトノベル'],
        drama: true,
        multi_narr: true,
      }),
      writeMeta(BOOKS.fill, base('埋める')),
      writeMeta(BOOKS.clear, { ...base('消す'), genres: ['ホラー'], ebook_tags: ['怪談'] }),
      writeMeta(BOOKS.move, base('動く')),
      'chown -R 99:100 /fx/data',
    ].join('\n'),
  );
  compose('up', '-d', 'abs');
  for (let i = 0; i < 120; i++) {
    try {
      await call('GET', '/status');
      break;
    } catch {
      await sleep(1000);
    }
  }
  out.version = (await call('GET', '/status')).serverVersion;
  await call('POST', '/init', { newRoot: { username: 'root', password: 'scratch-wp21g' } });
  const login = await call('POST', '/login', { username: 'root', password: 'scratch-wp21g' });
  token = login.user.accessToken ?? login.user.token;
  await call('PATCH', '/api/settings', {
    storeMetadataWithItem: true,
    storeCoverWithItem: true,
    scannerDisableWatcher: true,
  });
  const lib = await call('POST', '/api/libraries', {
    name: 'Japanese Audiobooks',
    folders: [{ fullPath: LIB }],
    mediaType: 'book',
    provider: 'audible.jp',
  });
  const opts = { baseUrl: ABS, apiKey: token, timeoutMs: 30_000 };
  const scanner = new AbsLibraryScan(opts);
  const setter = new AbsSetFields(opts);
  const clearer = new AbsClearFields(opts);
  const items = async () =>
    (await call('GET', `/api/libraries/${lib.id}/items?limit=500`)).results as any[];
  const scan = async () => {
    await scanner.scan(lib.id);
    await sleep(12_000);
  };
  await scan();
  for (let i = 0; i < 60 && (await items()).length < 4; i++) await sleep(1000);
  const byRel = async () =>
    new Map((await items()).map((it) => [String(it.relPath).replace(/\\/g, '/'), it]));
  const rel = await byRel();
  log(`ABS ${out.version}: ${rel.size} items`);
  const item = async (id: string) => call('GET', `/api/items/${id}?expanded=1`);
  const shown = async (id: string) => {
    const it = await item(id);
    return {
      relPath: String(it.relPath).replace(/\\/g, '/'),
      isMissing: !!it.isMissing,
      genres: it.media.metadata.genres,
      tags: it.media.tags,
      series: (it.media.metadata.series ?? []).map(
        (s: { name: string; sequence: string | null }) =>
          s.sequence ? `${s.name} #${s.sequence}` : s.name,
      ),
    };
  };
  const me = async () => call('GET', '/api/me');
  const listening = async (id: string) => {
    const u = await me();
    const pr = (u.mediaProgress ?? []).find((m: any) => m.libraryItemId === id) ?? null;
    return {
      progress: pr ? { currentTime: pr.currentTime, isFinished: pr.isFinished } : null,
      bookmarks: (u.bookmarks ?? [])
        .filter((b: any) => b.libraryItemId === id)
        .map((b: any) => b.time),
    };
  };
  const ids: Record<string, string> = {};
  for (const [k, d] of Object.entries(BOOKS))
    if (k !== 'moveTo') {
      const it = rel.get(d);
      if (!it) throw new Error(`no item for ${d}`);
      ids[k] = it.id;
    }

  // 1. The round trip.
  {
    const s = await shown(ids.round);
    const file = readMeta(BOOKS.round);
    const want = {
      genres: ['ファンタジー', '恋愛', '歴史・時代'],
      tags: ['異世界', '男性主人公', 'アニメ化', 'ライトノベル', 'ドラマCD', '複数ナレーター'],
    };
    const ok =
      JSON.stringify(s.genres) === JSON.stringify(want.genres) &&
      JSON.stringify(s.tags) === JSON.stringify(want.tags) &&
      JSON.stringify(file.genres) === JSON.stringify(want.genres) &&
      JSON.stringify(file.tags) === JSON.stringify(want.tags);
    out.roundTrip = { ok, abs: s, file: { genres: file.genres, tags: file.tags } };
    log('1 round trip', ok ? 'OK' : 'DIFFERS', s, file.genres, file.tags);
  }

  // 2. ABS's fill from the file's genre tag.
  {
    const s = await shown(ids.fill);
    const file = readMeta(BOOKS.fill);
    out.fill = { abs: s.genres, file: file.genres };
    log('2 fill: ABS', s.genres, 'metadata.json', file.genres);
  }

  // 3. Our genres over the fill, by the library scan alone; progress and a bookmark kept.
  {
    await call('PATCH', `/api/me/progress/${ids.fill}`, {
      duration: 30,
      currentTime: 12,
      progress: 0.4,
      isFinished: false,
    });
    await call('POST', `/api/me/item/${ids.fill}/bookmark`, { time: 12, title: 'しおり' });
    const before = await listening(ids.fill);
    sh(
      writeMeta(BOOKS.fill, {
        ...base('埋める'),
        genres: ['ミステリー'],
        ebook_tags: ['警察'],
      }),
    );
    await scan();
    const s = await shown(ids.fill);
    const after = await listening(ids.fill);
    let set: unknown = null;
    if (JSON.stringify(s.genres) !== JSON.stringify(['ミステリー'])) {
      // The scan kept the fill: the edit call with the bytes written (what library-changes sends).
      await setter.set(ids.fill, Buffer.from(sh(`cat ${q(`${FX}/${BOOKS.fill}/metadata.json`)}`)), [
        'genres',
        'tags',
      ]);
      set = await shown(ids.fill);
    }
    const ok =
      JSON.stringify((set as any)?.genres ?? s.genres) === JSON.stringify(['ミステリー']) &&
      JSON.stringify(before) === JSON.stringify(after);
    out.overFill = {
      ok,
      byScan: s,
      afterSet: set,
      before,
      after,
      file: readMeta(BOOKS.fill).genres,
    };
    log('3 over the fill', ok ? 'OK' : 'DIFFERS', {
      byScan: s.genres,
      tags: s.tags,
      set,
      before,
      after,
    });
  }

  // 4. Genres emptied (a pair that no longer gives genres).
  {
    sh(writeMeta(BOOKS.clear, base('消す')));
    await scan();
    const byScan = await shown(ids.clear);
    await clearer.clear(ids.clear, ['genres'], true);
    await sleep(2000);
    const cleared = await shown(ids.clear);
    const fileAfterClear = readMeta(BOOKS.clear);
    await scan();
    const afterRescan = await shown(ids.clear);
    out.clear = {
      byScan,
      cleared,
      fileAfterClear: { genres: fileAfterClear.genres, tags: fileAfterClear.tags },
      afterRescan,
    };
    log(
      '4 emptied: scan',
      byScan.genres,
      byScan.tags,
      '| clear',
      cleared.genres,
      cleared.tags,
      '| rescan',
      afterRescan.genres,
      afterRescan.tags,
    );
  }

  // 5. A series from the ebook: moved, one library scan.
  {
    await call('PATCH', `/api/me/progress/${ids.move}`, {
      duration: 60,
      currentTime: 33,
      progress: 0.55,
      isFinished: false,
    });
    await call('POST', `/api/me/item/${ids.move}/bookmark`, { time: 33, title: 'しおり' });
    const before = await listening(ids.move);
    const count0 = (await items()).length;
    sh(
      [
        'set -e',
        writeMeta(BOOKS.move, {
          ...base('動く'),
          series: [{ name: 'シリーズM', position: 2, label: null }],
          series_from: 'ebook',
          genres: ['ファンタジー'],
        }),
        `mkdir -p ${q(`${FX}/${path.posix.dirname(BOOKS.moveTo)}`)}`,
        `mv ${q(`${FX}/${BOOKS.move}`)} ${q(`${FX}/${BOOKS.moveTo}`)}`,
        'chown -R 99:100 /fx/data',
      ].join('\n'),
    );
    await scan();
    const s = await shown(ids.move);
    const after = await listening(ids.move);
    const count1 = (await items()).length;
    let set: unknown = null;
    if (JSON.stringify(s.series) !== JSON.stringify(['シリーズM #2'])) {
      await setter.set(
        ids.move,
        Buffer.from(sh(`cat ${q(`${FX}/${BOOKS.moveTo}/metadata.json`)}`)),
        ['series'],
      );
      set = await shown(ids.move);
    }
    const ok =
      s.relPath === BOOKS.moveTo &&
      !s.isMissing &&
      count0 === count1 &&
      JSON.stringify(before) === JSON.stringify(after);
    out.move = { ok, abs: s, afterSet: set, before, after, items: [count0, count1] };
    log('5 move', ok ? 'OK' : 'DIFFERS', { abs: s, set, before, after, items: [count0, count1] });
  }
} finally {
  fs.writeFileSync(path.join(ROOT, 'proof-result.json'), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(ROOT, 'abs.log'), compose('logs', '--no-color', 'abs').stdout ?? '');
  compose('down', '-v');
}
