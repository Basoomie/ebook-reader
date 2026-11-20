/**
 * WP21e-1 tests: real torrent and library files on disk plus a cleanup.db whose stages 1-5 are
 * finished (identity, books, duplicate groups, units, stage 5's values), as stage 6 reads it.
 * One temp folder holds data/torrents/audiobooks/japanese and data/media/audiobooks/japanese, so
 * hard links work (the same filesystem, like /mnt/disk1).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface SeedFile {
  root: 'torrents' | 'library';
  rel: string;
  bytes: Buffer | string;
}

export interface SeedBook {
  /** Torrent-relative path of the unit (a folder or one file). */
  rel: string;
  kind: 'folder' | 'file';
  /** Its audio files (torrent-relative), in order. */
  files: string[];
}

export interface SeedCopy {
  key: string;
  bookKey: string;
  kind: 'file' | 'parts' | 'library_only';
  /** root:rel of each file, in order. */
  files: string[];
  ai?: boolean;
  excluded?: boolean;
  group?: {
    key: string;
    kind: 'group' | 'unsure';
    outcome: 'auto' | 'review';
    role: 'keep' | 'drop' | 'review';
    rank: number;
  };
}

export interface SeedUnit {
  key: string;
  kind: 'record' | 'no_record' | 'ai' | 'radio';
  name: string;
  copies: string[];
  values: Record<string, unknown>;
}

export interface BuildSeed {
  files: SeedFile[];
  books: SeedBook[];
  copies: SeedCopy[];
  units: SeedUnit[];
  /** Library files that are byte copies of torrent files (library rel -> torrent rels). */
  libraryCopies: Record<string, string[]>;
  /** Library files with no torrent original. */
  libraryOnly?: string[];
  decisions?: Record<string, string>;
  gates?: boolean;
}

export const IDS = { s1: 'a1', s2: 'a2', s3: 'a3', s4: 'a4', s5: 'a5' };

export interface SeededDisk {
  data: string;
  torrents: string;
  library: string;
  media: string;
  /** audio_files id of root:rel. */
  fileId: (key: string) => number;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export function seedBuild(db: Database.Database, dir: string, seed: BuildSeed): SeededDisk {
  const data = path.join(dir, 'data');
  const torrents = path.join(data, 'torrents', 'audiobooks', 'japanese');
  const media = path.join(data, 'media', 'audiobooks');
  const library = path.join(media, 'japanese');
  fs.mkdirSync(torrents, { recursive: true });
  fs.mkdirSync(library, { recursive: true });
  const ids = new Map<string, number>();
  const ins = db.prepare(
    `INSERT INTO audio_files (root, rel_path, ext, kind, size, mtime_ms, dev, ino, nlink, sha256,
       first_seen_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  );
  for (const f of seed.files) {
    const base = f.root === 'torrents' ? torrents : library;
    const p = path.join(base, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const bytes = Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes);
    fs.writeFileSync(p, bytes);
    const st = fs.lstatSync(p, { bigint: true });
    const ext = path.extname(f.rel).toLowerCase();
    const kind = ['.m4b', '.m4a', '.mp3', '.mp4', '.aac', '.flac', '.ogg', '.opus'].includes(ext)
      ? 'audio'
      : ext === '.zip' || ext === '.rar' || ext === '.7z'
        ? 'archive'
        : 'other';
    const id = Number(
      ins.run(
        f.root,
        f.rel,
        ext,
        kind,
        Number(st.size),
        Math.floor(Number(st.mtimeMs)),
        Number(st.dev),
        Number(st.ino),
        Number(st.nlink),
        kind === 'audio' ? sha(bytes) : null,
      ).lastInsertRowid,
    );
    ids.set(`${f.root}:${f.rel}`, id);
  }
  const fileId = (k: string) => {
    const id = ids.get(k);
    if (id === undefined) throw new Error(`no file ${k}`);
    return id;
  };
  // Stage 1: identities of the library's audio files.
  const ident = db.prepare(
    `INSERT INTO audio_identity (analysis_id, file_id, class, original_file_ids) VALUES (?, ?, ?, ?)`,
  );
  for (const [rel, originals] of Object.entries(seed.libraryCopies))
    ident.run(
      IDS.s1,
      fileId(`library:${rel}`),
      'copy',
      JSON.stringify(originals.map((o) => fileId(`torrents:${o}`))),
    );
  for (const rel of seed.libraryOnly ?? [])
    ident.run(IDS.s1, fileId(`library:${rel}`), 'library_only', null);
  // Stage 2: books.
  const book = db.prepare(
    `INSERT INTO audio_books (analysis_id, book_key, root, unit_rel_path, unit_kind, source, name_raw,
       file_count, multi_class) VALUES (?, ?, 'torrents', ?, ?, 'other', ?, ?, 'single')`,
  );
  const bookFile = db.prepare(
    `INSERT INTO audio_book_files (book_id, file_id, position) VALUES (?, ?, ?)`,
  );
  for (const b of seed.books) {
    const id = Number(
      book.run(IDS.s2, `torrents:${b.rel}`, b.rel, b.kind, path.basename(b.rel), b.files.length)
        .lastInsertRowid,
    );
    b.files.forEach((f, i) => bookFile.run(id, fileId(`torrents:${f}`), i));
  }
  // Stage 3: copies and groups.
  const copy = db.prepare(
    `INSERT INTO audio_dup_copies (analysis_id, copy_key, book_key, kind, file_ids, name, seconds, ai,
       excluded) VALUES (?, ?, ?, ?, ?, ?, 600, ?, ?)`,
  );
  const groups = new Map<string, number>();
  const group = db.prepare(
    `INSERT INTO audio_dup_groups (analysis_id, group_key, kind, first_test, tests_json, members, outcome)
     VALUES (?, ?, ?, 'identical', '[]', 0, ?)`,
  );
  const member = db.prepare(
    `INSERT INTO audio_dup_members (group_id, copy_id, rank, role) VALUES (?, ?, ?, ?)`,
  );
  for (const c of seed.copies) {
    const id = Number(
      copy.run(
        IDS.s3,
        c.key,
        c.bookKey,
        c.kind,
        JSON.stringify(c.files.map(fileId)),
        c.key,
        c.ai ? 1 : 0,
        c.excluded ? 1 : 0,
      ).lastInsertRowid,
    );
    if (c.group) {
      let gid = groups.get(c.group.key);
      if (gid === undefined) {
        gid = Number(group.run(IDS.s3, c.group.key, c.group.kind, c.group.outcome).lastInsertRowid);
        groups.set(c.group.key, gid);
      }
      member.run(gid, id, c.group.rank, c.group.role);
    }
  }
  const decision = db.prepare(
    `INSERT INTO audio_dup_decisions (group_key, member_keys, decision, decided_at) VALUES (?, '[]', ?, 0)`,
  );
  for (const [k, d] of Object.entries(seed.decisions ?? {})) decision.run(k, d);
  // Stages 4 and 5: units and values.
  const online = db.prepare(
    `INSERT INTO audio_online_units (analysis_id, unit_key, copy_keys, book_keys, name, seconds, kind,
       state, inputs_json, class, updated_at) VALUES (?, ?, ?, '[]', ?, 600, ?, 'decided', ?, ?, 0)`,
  );
  const meta = db.prepare(
    `INSERT INTO audio_meta_units (analysis_id, unit_key, name, kind, state, updated_at)
     VALUES (?, ?, ?, ?, 'decided', 0)`,
  );
  const value = db.prepare(
    `INSERT INTO ai_values (stage, item_key, field, value_json, source, flagged, decided_at)
     VALUES ('audio5', ?, ?, ?, ?, ?, 0)`,
  );
  const copyFiles = new Map(seed.copies.map((c) => [c.key, c.files]));
  for (const u of seed.units) {
    const paths = u.copies.flatMap((k) => copyFiles.get(k) ?? []);
    online.run(
      IDS.s4,
      u.key,
      JSON.stringify(u.copies),
      u.name,
      u.kind === 'ai' || u.kind === 'radio' ? 'none_expected' : 'lookup',
      JSON.stringify({
        opening: paths
          .filter((p) => p.startsWith('torrents:'))
          .slice(0, 1)
          .map((p) => ({ root: 'torrents', rel: p.slice(9) })),
        paths,
      }),
      u.kind === 'ai' || u.kind === 'radio' ? 'none_expected' : 'auto',
    );
    meta.run(IDS.s5, u.key, u.name, u.kind);
    // "?field" is an unconfirmed value (its best guess); it replaces a plain "field".
    const fields = new Map<string, { v: unknown; flagged: boolean }>();
    for (const [field, v] of Object.entries(u.values)) {
      const flagged = field.startsWith('?');
      const name = flagged ? field.slice(1) : field;
      if (!flagged && fields.get(name)?.flagged) continue;
      fields.set(name, { v, flagged });
    }
    for (const [name, { v, flagged }] of fields)
      value.run(
        u.key,
        name,
        JSON.stringify(v),
        flagged ? 'secondary_guess' : 'rules',
        flagged ? 1 : 0,
      );
  }
  const gate = { passed: seed.gates !== false, misses: [] };
  const stage = db.prepare(`UPDATE audio_stages SET progress_json = ? WHERE stage = ?`);
  stage.run(JSON.stringify({ analysisId: IDS.s1, phase: 'done', error: null }), 1);
  stage.run(JSON.stringify({ analysisId: IDS.s2, phase: 'done', error: null }), 2);
  stage.run(
    JSON.stringify({
      analysisId: IDS.s3,
      phase: 'done',
      error: null,
      stage1Id: IDS.s1,
      stage2Id: IDS.s2,
      gate,
    }),
    3,
  );
  stage.run(
    JSON.stringify({ analysisId: IDS.s4, phase: 'done', error: null, stage3Id: IDS.s3, gate }),
    4,
  );
  stage.run(
    JSON.stringify({
      analysisId: IDS.s5,
      phase: 'done',
      error: null,
      stage4Id: IDS.s4,
      rulesKey: 'r',
      askKey: 'k',
      gate: { ...gate, fields: {}, books: 0, notFound: [], flaggedWrong: [], error: null },
    }),
    5,
  );
  return { data, torrents, library, media, fileId };
}
