/**
 * Benchmark for the library search and browse queries (WP7a; not part of npm test).
 *
 *   node -r ts-node/register/transpile-only scripts/bench-search.ts [--books 65000]
 *   node -r ts-node/register/transpile-only scripts/bench-search.ts --db <copy of ttsu.db>
 *
 * Without --db it builds a synthetic catalog straight into a server database in a temp
 * folder: --books books, a quarter as many authors, an eighth as many series (two of three
 * books in one), 300 tags with three per book plus one big tag on half of the books, 90%
 * counted, and some book state (statuses, favorites, opened books) for one user.
 * With --db it opens the given file READ-ONLY (use a copy of a real snapshot) and uses its
 * first user. Add --migrate to first bring an older copy up to the current schema (this
 * writes to the copy and prints how long migrations and the search-fold backfill took).
 *
 * Every query runs on the main connection (median of 5) and, for patterns, once more
 * through the search worker to show its overhead.
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fillSearchFolds } from '../src/catalog/fold';
import { clearGroupCaches, planGroups } from '../src/catalog/groups';
import { planBooks, planCount, PlannedQuery } from '../src/catalog/queries';
import { BOOK_SORT_KEYS, SORT_DIRS } from '../src/catalog/sort';
import { registerRegexp } from '../src/catalog/regexp';
import { SearchRunner } from '../src/catalog/search-runner';
import { openDatabase } from '../src/db/database';
import { getOrCreateSecret, THUMBNAIL_URL_SECRET } from '../src/db/secrets';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const WORDS = [
  '薬屋',
  '後宮',
  '異世界',
  '転生',
  '魔法',
  '探偵',
  '剣',
  '恋',
  '学園',
  '王女',
  '竜',
  '夜',
];

function buildSynthetic(file: string, books: number): string {
  const db = openDatabase(file);
  const user = (db.prepare('SELECT id FROM users').get() as { id: string }).id;
  const now = Date.now();
  db.prepare(
    `INSERT INTO libraries (id, folder, name, language, enabled, discovered_at, updated_at)
     VALUES ('lib', 'japanese-library', 'Japanese', 'ja', 1, ?, ?)`,
  ).run(now, now);
  const authors = Math.max(1, Math.floor(books / 4));
  const series = Math.max(1, Math.floor(books / 8));
  db.transaction(() => {
    const a = db.prepare('INSERT INTO authors (id, name, sort) VALUES (?, ?, ?)');
    for (let i = 1; i <= authors; i++) a.run(i, `著者${i}`, `著者${i}`);
    const s = db.prepare('INSERT INTO series (id, name, sort) VALUES (?, ?, ?)');
    for (let i = 1; i <= series; i++) s.run(i, `シリーズ${WORDS[i % WORDS.length]}${i}`, null);
    const t = db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)');
    for (let i = 1; i <= 300; i++) t.run(i, i === 1 ? 'ライトノベル' : `タグ${i}`);
    const b = db.prepare(
      `INSERT INTO books (id, library_id, title, title_sort, author_sort, series_id, series_index,
                          added_at, published_at, char_count, created_at, updated_at)
       VALUES (?, 'lib', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const src = db.prepare(
      `INSERT INTO book_sources (id, book_id, kind, library_id, calibre_uuid, calibre_id, calibre_path,
                                 file_path, file_size, has_cover, calibre_last_modified, created_at, updated_at)
       VALUES (?, ?, 'calibre', 'lib', ?, ?, ?, ?, 1000, 1, ?, ?, ?)`,
    );
    const ba = db.prepare(
      'INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)',
    );
    const bt = db.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)');
    const cc = db.prepare(
      `INSERT INTO char_counts (book_id, status, source_key, spec, characters, counted_at)
       VALUES (?, 'ok', ?, 'v1|Off|anchor', ?, 0)`,
    );
    const rec = db.prepare(
      `INSERT INTO sync_records (user_id, kind, id, book_id, device_id, updated_at, deleted_at, rev, data, received_at)
       VALUES (?, ?, ?, ?, 'dev', ?, NULL, ?, ?, ?)`,
    );
    let rev = 1;
    for (let i = 0; i < books; i++) {
      const id = randomUUID();
      const inSeries = i % 3 !== 0;
      const seriesId = inSeries ? (i % series) + 1 : null;
      const chars = 50_000 + ((i * 7919) % 250_000);
      const counted = i % 10 !== 0;
      const title = `${WORDS[i % WORDS.length]}の物語 ${WORDS[(i * 7) % WORDS.length]} 第${i}巻`;
      const lastModified = now - i;
      const filePath = `著者/${i}/book.epub`;
      b.run(
        id,
        title,
        title,
        // WP19a: a few uploads without an author sort, a fifth without a publication date.
        i % 50 === 0 ? null : `著者${(i % authors) + 1}`,
        seriesId,
        inSeries ? Math.floor(i / series) + 1 : null,
        now - i * 60_000,
        i % 5 === 0 ? null : now - ((i * 104729) % 40) * 365 * 86_400_000,
        counted ? chars : null,
        now,
        now,
      );
      src.run(randomUUID(), id, randomUUID(), i + 1, `著者/${i}`, filePath, lastModified, now, now);
      ba.run(id, (i % authors) + 1, 0);
      if (i % 20 === 0) ba.run(id, ((i * 13) % authors) + 1, 1);
      for (let k = 0; k < 3; k++) bt.run(id, 2 + ((i * (k + 3)) % 299));
      if (i % 2 === 0) bt.run(id, 1);
      if (counted) cc.run(id, `${lastModified}|${filePath}|1000`, chars);
      if (i % 200 === 0) {
        const status = ['reading', 'completed', 'dropped'][i % 3];
        rec.run(
          user,
          'book-status',
          id,
          id,
          now,
          rev++,
          JSON.stringify({ status, auto: false }),
          now,
        );
        rec.run(
          user,
          'position',
          `${id}:dev`,
          id,
          now - i,
          rev++,
          JSON.stringify({ charPos: 1, progress: 0.5, readThroughId: null }),
          now,
        );
      }
      if (i % 1000 === 0) {
        rec.run(user, 'book-favorite', id, id, now, rev++, JSON.stringify({ favorite: true }), now);
      }
    }
  })();
  getOrCreateSecret(db, THUMBNAIL_URL_SECRET);
  fillSearchFolds(db);
  db.close();
  return user;
}

async function main(): Promise<void> {
  const given = arg('--db');
  const books = Number(arg('--books') ?? 65_000);
  let file: string;
  let base: string | null = null;
  if (given) {
    file = path.resolve(given);
    if (process.argv.includes('--migrate')) {
      // Brings an older copy up to date first (migrations + search folds), timed.
      const t = process.hrtime.bigint();
      openDatabase(file).close();
      console.log(`Migrated ${file} in ${(ms(t) / 1000).toFixed(2)} s`);
    }
  } else {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsu-bench-search-'));
    file = path.join(base, 'ttsu.db');
    const t = process.hrtime.bigint();
    buildSynthetic(file, books);
    console.log(`Built a ${books}-book catalog in ${(ms(t) / 1000).toFixed(1)} s (${base})`);
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  registerRegexp(db);
  const user = {
    id: (db.prepare('SELECT id FROM users ORDER BY created_at').get() as { id: string }).id,
  };
  const count = (db.prepare('SELECT COUNT(*) AS n FROM books').get() as { n: number }).n;
  const sample = db
    .prepare(
      `SELECT (SELECT name FROM authors WHERE id = (SELECT author_id FROM book_authors GROUP BY author_id ORDER BY COUNT(*) DESC LIMIT 1)) AS bigAuthor,
              (SELECT name FROM authors ORDER BY id DESC LIMIT 1) AS someAuthor,
              (SELECT name FROM tags WHERE id = (SELECT tag_id FROM book_tags GROUP BY tag_id ORDER BY COUNT(*) DESC LIMIT 1)) AS bigTag,
              (SELECT name FROM tags WHERE id = (SELECT tag_id FROM book_tags GROUP BY tag_id ORDER BY COUNT(*) ASC LIMIT 1)) AS smallTag,
              (SELECT name FROM series ORDER BY id DESC LIMIT 1) AS someSeries`,
    )
    .get() as Record<string, string | null>;
  const q = (s: string | null) => `"${(s ?? '').replace(/"/g, '')}"`;
  console.log(`${count} books; samples: ${JSON.stringify(sample)}`);

  const time = <T>(plan: () => PlannedQuery<T>): { median: number; result: T } => {
    const runs: number[] = [];
    let result!: T;
    for (let i = 0; i < 5; i++) {
      const s = process.hrtime.bigint();
      const p = plan();
      result = p.finish(db.prepare(p.sql).all(...p.params));
      runs.push(ms(s));
    }
    runs.sort((a, b) => a - b);
    return { median: runs[2], result };
  };

  console.log('\nBooks, first page of 50 (median of 5):');
  const bookQueries: [string, string][] = [
    ['all (no search)', ''],
    ['broad text', '物語'],
    ['no-match text', '存在しない言葉'],
    ['full-width text', 'ＧＪ部'],
    ['author (small)', `author:=${q(sample.someAuthor)}`],
    ['author (biggest)', `author:=${q(sample.bigAuthor)}`],
    ['author substring', 'author:日向'],
    ['tag (biggest)', `tag:=${q(sample.bigTag)}`],
    ['tag (smallest)', `tag:=${q(sample.smallTag)}`],
    ['two tags (all)', `tag:=${q(sample.bigTag)} tag:=${q(sample.smallTag)}`],
    ['series', `series:${q(sample.someSeries)}`],
    ['chars:<100k', 'chars:<100k'],
    ['chars range rare', 'chars:299990-300000'],
    ['status:reading', 'status:reading'],
    ['status:unread', 'status:unread'],
    ['-status:completed', '-status:completed'],
    ['favorite:yes', 'favorite:yes'],
    ['regex broad', '/物語/'],
    ['regex rare', '/第1234[0-9]巻$/'],
    ['regex no match', '/^存在しない/'],
    ['regex i flag', '/^NOPE/i'],
    ['regex author', 'author:/^著者1$/'],
    ['mixed', `物語 -tag:=${q(sample.bigTag)} chars:>100k -status:completed`],
  ];
  for (const [label, query] of bookQueries) {
    const { median, result } = time(() => planBooks(db, user, { query }));
    console.log(
      `  ${label.padEnd(22)} ${median.toFixed(1).padStart(8)} ms  (${result.books.length} on page)`,
    );
  }

  console.log('\nGroups, first page of 50 (first = nothing cached; cached = median of 5):');
  for (const by of ['series', 'author', 'tag'] as const) {
    for (const [label, query] of [
      ['all', ''],
      ['status:reading', 'status:reading'],
      ['regex no match', '/^存在しない/'],
    ] as const) {
      clearGroupCaches(db);
      const s = process.hrtime.bigint();
      const first = planGroups(db, user, { by, query });
      first.finish(db.prepare(first.sql).all(...first.params));
      const cold = ms(s);
      const { median, result } = time(() => planGroups(db, user, { by, query }));
      console.log(
        `  ${`${by} ${label}`.padEnd(22)} ${cold.toFixed(1).padStart(8)} ms first, ${median.toFixed(1).padStart(6)} ms cached  (${result.groups.length} groups)`,
      );
    }
  }
  console.log('\nOpening a group, first page (median of 5):');
  for (const [label, group] of [
    ['series', { by: 'series', name: sample.someSeries }],
    ['No series', { by: 'series', name: null }],
    ['author (biggest)', { by: 'author', name: sample.bigAuthor }],
    ['tag (biggest)', { by: 'tag', name: sample.bigTag }],
  ] as const) {
    const { median, result } = time(() => planBooks(db, user, { group: group as never }));
    console.log(
      `  ${label.padEnd(22)} ${median.toFixed(1).padStart(8)} ms  (${result.books.length} on page)`,
    );
  }

  console.log('\nSorted lists (WP19a), first page and page 20 of 50 (median of 5):');
  const sortQueries: [string, string][] = [
    ['all', ''],
    ['broad text', '物語'],
    ['no-match text', '存在しない言葉'],
    ['tag (biggest)', `tag:=${q(sample.bigTag)}`],
    ['author (small)', `author:=${q(sample.someAuthor)}`],
    ['status:reading', 'status:reading'],
  ];
  for (const key of BOOK_SORT_KEYS) {
    for (const dir of SORT_DIRS) {
      for (const [label, query] of sortQueries) {
        const sort = { key, dir };
        const first = time(() => planBooks(db, user, { query, sort }));
        let cursor = first.result.nextCursor;
        for (let page = 2; page < 20 && cursor; page++) {
          const p = planBooks(db, user, { query, sort, cursor });
          cursor = p.finish(db.prepare(p.sql).all(...p.params)).nextCursor;
        }
        const later = cursor
          ? time(() => planBooks(db, user, { query, sort, cursor: cursor ?? undefined })).median
          : null;
        console.log(
          `  ${`${key} ${dir} ${label}`.padEnd(34)} ${first.median.toFixed(1).padStart(8)} ms first, ${
            later === null ? '     -' : later.toFixed(1).padStart(6)
          } ms page 20  (${first.result.books.length} on page)`,
        );
      }
    }
  }

  console.log('\nCounts (WP19a, uncached, median of 5):');
  for (const [label, query] of [
    ['all (no search)', ''],
    ['broad text', '物語'],
    ['no-match text', '存在しない言葉'],
    ['author (biggest)', `author:=${q(sample.bigAuthor)}`],
    ['tag (biggest)', `tag:=${q(sample.bigTag)}`],
    ['chars:<100k', 'chars:<100k'],
    ['status:reading', 'status:reading'],
    ['-status:completed', '-status:completed'],
    ['regex no match', '/^存在しない/'],
    ['mixed', `物語 -tag:=${q(sample.bigTag)} chars:>100k -status:completed`],
  ] as const) {
    const { median, result } = time(() => planCount(db, user, { query }));
    console.log(`  ${label.padEnd(22)} ${median.toFixed(1).padStart(8)} ms  (${result.count})`);
  }

  console.log('\nThrough the search worker (one run each, after a warm-up):');
  const runner = new SearchRunner({ db, file, timeoutSeconds: 30 });
  const warm = planBooks(db, user, { query: '/x/' });
  await runner.all(warm.sql, warm.params);
  for (const query of ['/^存在しない/', '/物語/']) {
    const p = planBooks(db, user, { query });
    const s = process.hrtime.bigint();
    await runner.all(p.sql, p.params);
    console.log(`  ${query.padEnd(22)} ${ms(s).toFixed(1).padStart(8)} ms`);
  }
  await runner.close();
  db.close();
  if (base && process.argv.includes('--keep')) console.log(`Kept ${file}`);
  else if (base) fs.rmSync(base, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
