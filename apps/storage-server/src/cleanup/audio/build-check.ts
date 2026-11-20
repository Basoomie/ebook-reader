/**
 * Stage 6's check (WP21e-1, plan section 8 step 3), the parts that look at the disk: walks of the
 * torrents, the live library and the new folders (lstat only, through the read-only module), and
 * the comparisons the check makes from them. Every walk waits while a Calibre job uses the disk.
 */
import { lstatEntry, readDir, type EntryStat } from './audio-source-fs';

export interface ManifestEntry {
  /** Relative to the walked root, forward slashes (the text form of the name). */
  rel: string;
  /** The exact bytes as hex when a name on the way is not UTF-8. */
  raw: string | null;
  isDir: boolean;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  nlink: number;
}

export interface WalkOutcome {
  entries: ManifestEntry[];
  errors: string[];
  pausedMs: number;
}

export interface TreeWalkOptions {
  shouldStop?: () => boolean;
  /** True while a Calibre job uses the disk: the walk waits. */
  shouldPause?: () => boolean;
  onEntries?: (n: number) => void;
}

/**
 * Every folder and file under `root` (symlinks recorded, never followed), lstat only. Null when
 * stopped on the way. A missing root gives no entries.
 */
export async function walkTree(
  root: string,
  opts: TreeWalkOptions = {},
): Promise<WalkOutcome | null> {
  const { shouldStop = () => false, shouldPause = () => false, onEntries } = opts;
  const out: WalkOutcome = { entries: [], errors: [], pausedMs: 0 };
  const top = await lstatEntry(root);
  if (!top?.isDir) return out;
  const giveWay = async (): Promise<boolean> => {
    while (shouldPause()) {
      if (shouldStop()) return false;
      const t = Date.now();
      await new Promise((r) => setTimeout(r, 1000));
      out.pausedMs += Date.now() - t;
    }
    return !shouldStop();
  };
  const stack: { full: string | Buffer; rel: string; relBytes: Buffer; raw: boolean }[] = [
    { full: root, rel: '', relBytes: Buffer.alloc(0), raw: false },
  ];
  while (stack.length) {
    if (!(await giveWay())) return null;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readDir(dir.full);
    } catch (err) {
      out.errors.push(`${dir.rel || '.'}: ${(err as Error).message}`.slice(0, 300));
      continue;
    }
    for (const e of entries) {
      if (shouldPause() && !(await giveWay())) return null;
      const nameBytes = e.rawHex !== null ? Buffer.from(e.rawHex, 'hex') : Buffer.from(e.name);
      const rel = dir.rel ? `${dir.rel}/${e.name}` : e.name;
      const relBytes = dir.rel
        ? Buffer.concat([dir.relBytes, Buffer.from('/'), nameBytes])
        : nameBytes;
      const raw = dir.raw || e.rawHex !== null;
      let st: EntryStat | null;
      try {
        st = await lstatEntry(e.fullPath);
      } catch (err) {
        out.errors.push(`${rel}: ${(err as Error).message}`.slice(0, 300));
        continue;
      }
      if (!st) continue;
      out.entries.push({
        rel,
        raw: raw ? relBytes.toString('hex') : null,
        isDir: st.isDir,
        size: st.isDir ? 0 : st.size,
        mtimeMs: Math.floor(st.mtimeMs),
        dev: st.dev,
        ino: st.ino,
        nlink: st.nlink,
      });
      if (st.isDir) stack.push({ full: e.fullPath, rel, relBytes, raw });
      if (onEntries && out.entries.length % 500 === 0) onEntries(out.entries.length);
    }
  }
  onEntries?.(out.entries.length);
  return out;
}

export interface ManifestDiff {
  added: string[];
  removed: string[];
  /** Size, mtime, device, inode or kind changed. */
  changed: { path: string; what: string }[];
  /** Files whose link count grew by exactly the links the build made to them. */
  linkedAsPlanned: number;
  /** Link counts that differ from before plus the build's links. */
  nlinkWrong: { path: string; before: number; after: number; expected: number }[];
}

const LIST_MAX = 200;

/**
 * Before vs after (one root): nothing may be added, removed or changed; the only difference
 * allowed is a file's link count growing by the number of links the build made to it.
 * `expectedLinks`: rel -> links the build made to that file.
 */
export function compareManifests(
  before: ManifestEntry[],
  after: ManifestEntry[],
  expectedLinks: Map<string, number>,
): ManifestDiff & {
  counts: { added: number; removed: number; changed: number; nlinkWrong: number };
} {
  const b = new Map(before.map((e) => [e.rel, e]));
  const a = new Map(after.map((e) => [e.rel, e]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: { path: string; what: string }[] = [];
  const nlinkWrong: ManifestDiff['nlinkWrong'] = [];
  const counts = { added: 0, removed: 0, changed: 0, nlinkWrong: 0 };
  let linkedAsPlanned = 0;
  for (const [rel, x] of b) {
    const y = a.get(rel);
    if (!y) {
      counts.removed++;
      if (removed.length < LIST_MAX) removed.push(rel);
      continue;
    }
    const what: string[] = [];
    if (x.isDir !== y.isDir) what.push('kind');
    if (x.size !== y.size) what.push(`size ${x.size} -> ${y.size}`);
    if (x.mtimeMs !== y.mtimeMs) what.push('mtime');
    if (x.dev !== y.dev || x.ino !== y.ino) what.push('inode');
    if (what.length) {
      counts.changed++;
      if (changed.length < LIST_MAX) changed.push({ path: rel, what: what.join(', ') });
    }
    if (!x.isDir) {
      const expected = x.nlink + (expectedLinks.get(rel) ?? 0);
      if (y.nlink !== expected) {
        counts.nlinkWrong++;
        if (nlinkWrong.length < LIST_MAX)
          nlinkWrong.push({ path: rel, before: x.nlink, after: y.nlink, expected });
      } else if ((expectedLinks.get(rel) ?? 0) > 0) linkedAsPlanned++;
    }
  }
  for (const rel of a.keys()) {
    if (b.has(rel)) continue;
    counts.added++;
    if (added.length < LIST_MAX) added.push(rel);
  }
  return { added, removed, changed, linkedAsPlanned, nlinkWrong, counts };
}

export interface PlannedEntry {
  kind: 'folder' | 'link' | 'pdf' | 'metadata';
  dst: string;
  dev: number | null;
  ino: number | null;
}

export interface NewTreeResult {
  folders: { planned: number; ok: number };
  links: { planned: number; ok: number };
  pdfs: { planned: number; ok: number };
  metadata: { planned: number; present: number };
  /** Planned entries that are missing or not what was planned. */
  wrong: { path: string; what: string }[];
  wrongCount: number;
  /** Files and folders in the new trees that the plan doesn't have. */
  extra: string[];
  extraCount: number;
  /** Audio files whose link count is below 2 (not a link to anything). */
  notLinked: number;
}

/**
 * The new trees against the plan: every folder a folder, every link and PDF the planned
 * torrent file's device and inode with a link count of at least 2, every metadata.json present
 * (its bytes are compared by the caller), nothing else there.
 */
export function compareNewTree(entries: ManifestEntry[], planned: PlannedEntry[]): NewTreeResult {
  const byPath = new Map(entries.map((e) => [e.rel, e]));
  const r: NewTreeResult = {
    folders: { planned: 0, ok: 0 },
    links: { planned: 0, ok: 0 },
    pdfs: { planned: 0, ok: 0 },
    metadata: { planned: 0, present: 0 },
    wrong: [],
    wrongCount: 0,
    extra: [],
    extraCount: 0,
    notLinked: 0,
  };
  const wrong = (path: string, what: string) => {
    r.wrongCount++;
    if (r.wrong.length < LIST_MAX) r.wrong.push({ path, what });
  };
  const seen = new Set<string>();
  for (const p of planned) {
    seen.add(p.dst);
    const e = byPath.get(p.dst);
    if (p.kind === 'folder') {
      r.folders.planned++;
      if (e?.isDir) r.folders.ok++;
      else wrong(p.dst, e ? 'not a folder' : 'missing');
      continue;
    }
    if (p.kind === 'metadata') {
      r.metadata.planned++;
      if (e && !e.isDir) r.metadata.present++;
      else wrong(p.dst, 'missing');
      continue;
    }
    const bucket = p.kind === 'link' ? r.links : r.pdfs;
    bucket.planned++;
    if (!e || e.isDir) {
      wrong(p.dst, 'missing');
      continue;
    }
    if (e.dev !== p.dev || e.ino !== p.ino) {
      wrong(p.dst, `inode ${e.dev}:${e.ino}, planned ${p.dev}:${p.ino}`);
      continue;
    }
    if (e.nlink < 2) {
      r.notLinked++;
      wrong(p.dst, `link count ${e.nlink}`);
      continue;
    }
    bucket.ok++;
  }
  for (const e of entries) {
    if (seen.has(e.rel)) continue;
    r.extraCount++;
    if (r.extra.length < LIST_MAX) r.extra.push(e.rel);
  }
  return r;
}
