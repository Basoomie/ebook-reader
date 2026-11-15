/**
 * Prepares a varied catalog for the web app's offline Library parity test
 * (apps/web/tests/offline-library-parity.test.ts), which runs the real server as a
 * separate process and compares its answers with the device's offline catalog:
 *
 *   node -r ts-node/register/transpile-only tests/helpers/seed-catalog-fixture.ts <dbDir> <tokens>
 *
 * Creates (and migrates) the database and writes books covering what searches, sorts and
 * groups depend on: two enabled libraries and a switched-off one, an upload, a book
 * missing from Calibre, series indexes null/0/1/1.5/2, co-authors with and without sort
 * names, a book without authors, tags, counts that are missing, pending (stale) or
 * failed, publication dates, title sorts, equal dates added (id tie-breaks), full-width
 * names, a kana with a separate voiced mark, and a title outside the BMP. The folded
 * search copies are left NULL; the server fills them when it opens the database.
 * Prints "SEED " + { tokens, bookIds } as JSON on its own line.
 */
import { randomUUID } from 'crypto';
import path from 'path';
import { openDatabase } from '../../src/db/database';
import { createToken } from '../../src/db/tokens';
import { listUsers } from '../../src/db/users';

const [dbDir, countRaw] = process.argv.slice(2);
const count = Number(countRaw ?? '1');
if (!dbDir || !Number.isInteger(count) || count < 1) {
  console.error('usage: seed-catalog-fixture.ts <dbDir> <tokens>');
  process.exit(1);
}

interface SeedBook {
  title: string;
  titleSort?: string | null;
  lib?: string;
  authors?: string[];
  series?: [string, number | null];
  tags?: string[];
  chars?: number | null;
  /** counted (default when chars is set), pending (stale count row), error, none. */
  count?: 'counted' | 'pending' | 'error' | 'none';
  published?: number | null;
  publisher?: string | null;
  /** Days after the first book; equal values test the id tie-break. */
  added: number;
  missing?: boolean;
  upload?: boolean;
}

const AUTHORS: Record<string, string | null> = {
  日向夏: 'ひゅうがなつ',
  'Ａｕｔｈｏｒ　Ｏｎｅ': 'Author One',
  'Co Writer': null,
  gj作家: 'gjさっか',
  ['て' + String.fromCharCode(0x3099) + 'んき']: 'でんき',
  著者一: 'ちょしゃいち',
  'Zed Last': 'Last, Zed',
};

const BOOKS: SeedBook[] = [
  {
    title: 'ＧＪ部 第１巻',
    titleSort: 'GJ部 01',
    authors: ['gj作家'],
    series: ['ＧＪ部', 1],
    tags: ['SF'],
    chars: 120000,
    added: 1,
    published: 1000,
  },
  {
    title: 'ＧＪ部 第２巻',
    titleSort: 'GJ部 02',
    authors: ['gj作家'],
    series: ['ＧＪ部', 2],
    tags: ['SF'],
    chars: 118000,
    added: 2,
    published: 2000,
  },
  {
    title: 'ＧＪ部 外伝',
    authors: ['gj作家', 'Co Writer'],
    series: ['ＧＪ部', null],
    tags: ['SF', 'ホラー'],
    chars: null,
    count: 'none',
    added: 3,
  },
  {
    title: 'ＧＪ部 第０巻',
    authors: ['gj作家'],
    series: ['ＧＪ部', 0],
    chars: 50000,
    added: 4,
    published: 500,
  },
  {
    title: 'ＧＪ部 第1.5巻',
    authors: ['gj作家'],
    series: ['ＧＪ部', 1.5],
    chars: 60000,
    count: 'pending',
    added: 5,
  },
  {
    title: '魔女の旅々２０',
    authors: ['著者一'],
    series: ['魔女の旅々', 20],
    tags: ['ファンタジー'],
    chars: 200000,
    added: 6,
    published: 3000,
  },
  {
    title: '魔女の旅々19',
    authors: ['著者一'],
    series: ['魔女の旅々', 19],
    tags: ['ファンタジー'],
    chars: 190000,
    added: 6,
    published: 2900,
  },
  {
    title: '薬屋のひとりごと',
    titleSort: 'くすりやのひとりごと',
    authors: ['日向夏'],
    series: ['薬屋', 1],
    tags: ['ミステリー', 'needs-metadata'],
    chars: 300000,
    added: 7,
    publisher: '主婦の友社',
    published: 4000,
  },
  {
    title: '薬屋のひとりごと 2',
    titleSort: 'くすりやのひとりごと 2',
    authors: ['日向夏'],
    series: ['薬屋', 2],
    tags: ['ミステリー'],
    chars: 310000,
    count: 'error',
    added: 8,
  },
  {
    title: 'Ｎｏ推理',
    authors: ['Ａｕｔｈｏｒ　Ｏｎｅ'],
    tags: ['ミステリー'],
    chars: 9000,
    added: 9,
  },
  { title: 'NO推理 too', authors: ['Ａｕｔｈｏｒ　Ｏｎｅ', 'Zed Last'], chars: 9100, added: 9 },
  { title: '😀 Smile', authors: ['Zed Last'], chars: 1500, added: 10, published: 100 },
  { title: 'Ａ letter', authors: ['Zed Last'], chars: 1600, added: 11 },
  {
    title: 'でんき物語',
    authors: ['て' + String.fromCharCode(0x3099) + 'んき'],
    tags: ['ホラー'],
    chars: 70000,
    added: 12,
  },
  {
    title: 'No author book',
    authors: [],
    tags: ['needs-metadata'],
    chars: null,
    count: 'none',
    added: 13,
  },
  { title: '100% 本当', authors: ['著者一'], chars: 2500, added: 14 },
  { title: 'a_b underscore', authors: ['Co Writer'], chars: 2600, added: 15 },
  { title: 'Re:ゼロ 1/2', authors: ['Co Writer'], series: ['Re:ゼロ', 1], chars: 80000, added: 16 },
  {
    title: 'Second library book',
    lib: 'lib2',
    authors: ['日向夏'],
    series: ['薬屋', 3],
    tags: ['ミステリー'],
    chars: 320000,
    added: 17,
  },
  { title: 'Second library alone', lib: 'lib2', authors: ['Zed Last'], chars: 4000, added: 18 },
  { title: 'Uploaded book', authors: ['Co Writer'], upload: true, chars: 5000, added: 19 },
  {
    title: 'Gone from Calibre',
    authors: ['日向夏'],
    series: ['薬屋', 4],
    missing: true,
    chars: 1000,
    added: 20,
  },
  { title: 'Switched-off library', lib: 'lib3', authors: ['日向夏'], chars: 1000, added: 21 },
  {
    title: '短編集',
    authors: ['著者一', '日向夏'],
    tags: ['短編'],
    chars: 40000,
    added: 22,
    published: 5000,
  },
  {
    title: '短編集 二',
    authors: ['著者一'],
    tags: ['短編'],
    chars: 41000,
    added: 22,
    published: 5000,
  },
];

const db = openDatabase(path.join(dbDir, 'ttsu.db'));
try {
  const now = Date.now();
  const day = 86_400_000;
  const base = now - 60 * day;
  const insertLib = db.prepare(
    `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
     VALUES (?, ?, ?, 'ja', ?, ?, ?)`,
  );
  insertLib.run('lib1', 'lib1', 'Main', 1, now, now);
  insertLib.run('lib2', 'lib2', 'Second', 1, now, now);
  insertLib.run('lib3', 'lib3', 'Off', 0, now, now);

  const authorIds = new Map<string, number>();
  for (const [name, sort] of Object.entries(AUTHORS)) {
    const r = db.prepare('INSERT INTO authors (name, sort) VALUES (?, ?)').run(name, sort);
    authorIds.set(name, Number(r.lastInsertRowid));
  }
  const seriesIds = new Map<string, number>();
  const tagIds = new Map<string, number>();
  const idOf = (map: Map<string, number>, table: string, name: string) => {
    let id = map.get(name);
    if (id === undefined) {
      id = Number(db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name).lastInsertRowid);
      map.set(name, id);
    }
    return id;
  };

  const bookIds: string[] = [];
  BOOKS.forEach((b, i) => {
    const id = randomUUID();
    bookIds.push(id);
    const lib = b.lib ?? 'lib1';
    const seriesId = b.series ? idOf(seriesIds, 'series', b.series[0]) : null;
    const authorSort = b.authors?.length
      ? (b.authors.map((a) => AUTHORS[a] ?? null).find((s) => s !== null) ?? null)
      : null;
    db.prepare(
      `INSERT INTO books (id, library_id, title, title_sort, author_sort, series_id, series_index,
                          publisher, published_at, added_at, char_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      lib,
      b.title,
      b.titleSort ?? null,
      authorSort,
      seriesId,
      b.series ? b.series[1] : null,
      b.publisher ?? null,
      b.published ?? null,
      base + b.added * day,
      b.chars ?? null,
      now,
      now,
    );
    (b.authors ?? []).forEach((name, position) => {
      db.prepare('INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)').run(
        id,
        authorIds.get(name),
        position,
      );
    });
    for (const tag of b.tags ?? []) {
      db.prepare('INSERT INTO book_tags (book_id, tag_id) VALUES (?, ?)').run(
        id,
        idOf(tagIds, 'tags', tag),
      );
    }
    const filePath = `book${i}/book.epub`;
    const size = 1000 + i;
    const lastModified = base + i;
    db.prepare(
      `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, calibre_id, calibre_path,
                                 file_path, file_size, has_cover, calibre_last_modified, content_hash,
                                 missing_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      id,
      b.upload ? 'upload' : 'calibre',
      lib,
      b.upload ? null : randomUUID(),
      b.upload ? null : i + 1,
      b.upload ? null : `book${i}`,
      filePath,
      size,
      b.upload ? null : lastModified,
      b.upload ? `hash${i}` : null,
      b.missing ? now : null,
      now,
      now,
    );
    const status = b.count ?? (b.chars !== null && b.chars !== undefined ? 'counted' : 'none');
    if (status !== 'none') {
      const key =
        status === 'pending'
          ? 'stale|key|0'
          : `${b.upload ? '' : lastModified}|${filePath}|${size}`;
      db.prepare(
        `INSERT INTO char_counts (book_id, status, source_key, spec, characters, counted_at)
         VALUES (?, ?, ?, 'v1|Off|anchor', ?, ?)`,
      ).run(
        id,
        status === 'error' ? 'error' : 'ok',
        key,
        status === 'error' ? null : (b.chars ?? 0),
        now,
      );
    }
  });

  const [owner] = listUsers(db);
  const tokens = Array.from(
    { length: count },
    (_, i) => createToken(db, owner.id, `Device ${i + 1}`).token,
  );
  console.log(`SEED ${JSON.stringify({ tokens, bookIds })}`);
} finally {
  db.close();
}
