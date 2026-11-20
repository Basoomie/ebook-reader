/**
 * The reader's link remap at the switch (WP21e-2, checklist section 3.2): every audio link of
 * ttsu.db (`folder_rel_path` + `file_name`, relative to the audiobooks root) is mapped through
 * stage 6's move list to where its file is after the renames. Pure: no database, no disk.
 *
 * - `moved` / `ai`: the new path, `japanese-new/` read as `japanese/` and
 *   `japanese-generated-new/` as `japanese-generated/` (the renames);
 * - `dropped`: the kept copy's file, or its folder when the copies have different file counts
 *   (a folder with one planned audio file is a link to that file; with several, the link
 *   becomes a folder link and is listed: the user picks a file);
 * - `library_only_pending`: the planned path (the file is linked there before the renames);
 * - a folder link (no file name): the folder of its files' new paths; when they land in
 *   different folders it is left as it is and listed;
 * - links outside the library's audio folder (the subtitle archive, generated audiobooks) and
 *   every subtitle path are left as they are.
 * Anything that can't be mapped (a file the move list doesn't know, reader-written, unaccounted)
 * is left as it is and listed: the switch refuses to go on with such a link (the dry run shows
 * them first).
 */

export type MoveOutcome =
  | 'moved'
  | 'ai'
  | 'dropped'
  | 'library_only_pending'
  | 'reader_written'
  | 'unaccounted';

export interface SwitchMove {
  oldPath: string;
  outcome: MoveOutcome;
  newPath: string | null;
  keptPath: string | null;
}

export interface SwitchLink {
  userId: string;
  bookId: string;
  state: 'linked' | 'none';
  folderRelPath: string | null;
  fileName: string | null;
}

export type RemapOutcome =
  /** Outside the library's audio folder, or "No audiobook": nothing to do. */
  | 'outside'
  | 'moved'
  | 'ai'
  | 'dropped'
  | 'library_only'
  /** A folder link mapped to its files' one new folder. */
  | 'folder'
  /** Can't be mapped: left as it is (the switch refuses while any exist). */
  | 'listed';

export interface RemapResult {
  userId: string;
  bookId: string;
  oldFolder: string | null;
  oldFile: string | null;
  newFolder: string | null;
  newFile: string | null;
  outcome: RemapOutcome;
  /** Whether the link changes. */
  changed: boolean;
  /** Why it was listed, or what the user should know (a dropped copy, a folder link now). */
  detail: string | null;
}

export interface RemapOptions {
  /** The library's audio folder before the switch (libraries.audio_dir), e.g. `japanese`. */
  libraryFolder: string;
  /**
   * The first part of the move list's old paths when it differs from `libraryFolder` (stage 6
   * names it after CLEANUP_AUDIO_LIBRARY_DIR's last part: `library` on the NAS, found
   * 2026-11-20): read as `libraryFolder`.
   */
  moveFolder?: string;
  /** The planned audio files of every new folder (paths as in the move list, before renames). */
  plannedFiles: Map<string, string[]>;
}

/** The build's staging folders and what they are called after the renames. */
export const RENAMED_ROOTS: readonly (readonly [string, string])[] = [
  ['japanese-new', 'japanese'],
  ['japanese-generated-new', 'japanese-generated'],
];

/** A path of the build (`japanese-new/…`) as it is after the renames (`japanese/…`). */
export function afterRenames(p: string): string {
  for (const [from, to] of RENAMED_ROOTS) {
    if (p === from) return to;
    if (p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`;
  }
  return p;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** Where one old file is after the switch: [new folder, new file or null], or why it can't be. */
function target(
  move: SwitchMove | undefined,
  opts: RemapOptions,
):
  | { folder: string; file: string | null; outcome: RemapOutcome; detail: string | null }
  | { why: string } {
  if (!move) return { why: 'not in the move list' };
  switch (move.outcome) {
    case 'moved':
    case 'ai':
    case 'library_only_pending': {
      if (!move.newPath) return { why: `${move.outcome} without a new path` };
      const p = afterRenames(move.newPath);
      return {
        folder: dirOf(p),
        file: baseOf(p),
        outcome: move.outcome === 'library_only_pending' ? 'library_only' : move.outcome,
        detail: null,
      };
    }
    case 'dropped': {
      if (!move.keptPath) return { why: 'a dropped copy without a kept copy' };
      const kept = move.keptPath;
      const files = opts.plannedFiles.get(kept);
      if (files) {
        // The kept copy's folder (its file count differs from this copy's).
        if (files.length === 1)
          return {
            folder: afterRenames(kept),
            file: baseOf(files[0]),
            outcome: 'dropped',
            detail: 'a proven duplicate: now the kept copy (one file)',
          };
        return {
          folder: afterRenames(kept),
          file: null,
          outcome: 'dropped',
          detail: `a proven duplicate: now the kept copy's folder of ${files.length} files (choose one)`,
        };
      }
      const p = afterRenames(kept);
      return {
        folder: dirOf(p),
        file: baseOf(p),
        outcome: 'dropped',
        detail: 'a proven duplicate: now the kept copy',
      };
    }
    case 'reader_written':
      return { why: 'written by the reader (a merge): not moved by the switch' };
    case 'unaccounted':
      return { why: 'not accounted for by stage 6' };
  }
}

export function remapLinks(
  links: SwitchLink[],
  moves: SwitchMove[],
  opts: RemapOptions,
): RemapResult[] {
  const from =
    opts.moveFolder && opts.moveFolder !== opts.libraryFolder ? `${opts.moveFolder}/` : null;
  if (from)
    moves = moves.map((m) =>
      m.oldPath.startsWith(from)
        ? { ...m, oldPath: `${opts.libraryFolder}/${m.oldPath.slice(from.length)}` }
        : m,
    );
  const byOld = new Map(moves.map((m) => [m.oldPath, m]));
  // The move list's files per old folder (for folder links).
  const byOldFolder = new Map<string, SwitchMove[]>();
  for (const m of moves) {
    const d = dirOf(m.oldPath);
    const list = byOldFolder.get(d);
    if (list) list.push(m);
    else byOldFolder.set(d, [m]);
  }
  const prefix = `${opts.libraryFolder.replace(/\/+$/, '')}/`;
  const out: RemapResult[] = [];
  for (const l of links) {
    const base = {
      userId: l.userId,
      bookId: l.bookId,
      oldFolder: l.folderRelPath,
      oldFile: l.fileName,
    };
    const same = (outcome: RemapOutcome, detail: string | null): RemapResult => ({
      ...base,
      newFolder: l.folderRelPath,
      newFile: l.fileName,
      outcome,
      changed: false,
      detail,
    });
    if (l.state !== 'linked' || !l.folderRelPath || !l.folderRelPath.startsWith(prefix)) {
      out.push(same('outside', null));
      continue;
    }
    if (l.fileName !== null) {
      const t = target(byOld.get(`${l.folderRelPath}/${l.fileName}`), opts);
      if ('why' in t) {
        out.push(same('listed', t.why));
        continue;
      }
      out.push({
        ...base,
        newFolder: t.folder,
        newFile: t.file,
        outcome: t.outcome,
        changed: t.folder !== l.folderRelPath || t.file !== l.fileName,
        detail: t.detail,
      });
      continue;
    }
    // A folder link: every file of the old folder must land in one new folder.
    const files = byOldFolder.get(l.folderRelPath) ?? [];
    if (!files.length) {
      out.push(same('listed', 'a folder the move list has no files of'));
      continue;
    }
    const folders = new Set<string>();
    const whys: string[] = [];
    for (const m of files) {
      const t = target(m, opts);
      if ('why' in t) whys.push(t.why);
      else folders.add(t.folder);
    }
    if (whys.length) {
      out.push(same('listed', `a folder link: ${whys[0]}`));
      continue;
    }
    if (folders.size !== 1) {
      out.push(same('listed', `a folder link whose files land in ${folders.size} folders`));
      continue;
    }
    const folder = [...folders][0];
    out.push({
      ...base,
      newFolder: folder,
      newFile: null,
      outcome: 'folder',
      changed: folder !== l.folderRelPath,
      detail: null,
    });
  }
  return out;
}

/** Counts per outcome (and how many change). */
export function remapCounts(results: RemapResult[]): Record<RemapOutcome | 'changed', number> {
  const c: Record<RemapOutcome | 'changed', number> = {
    outside: 0,
    moved: 0,
    ai: 0,
    dropped: 0,
    library_only: 0,
    folder: 0,
    listed: 0,
    changed: 0,
  };
  for (const r of results) {
    c[r.outcome]++;
    if (r.changed) c.changed++;
  }
  return c;
}
