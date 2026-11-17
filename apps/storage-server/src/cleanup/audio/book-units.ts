/**
 * Book units of the audiobook cleanup (WP21a, plan section 4). Pure: works on root-relative
 * paths only.
 *
 * - A book is the folder that directly holds audio; `Disc N` / `CD N` / `Disk N` subfolders
 *   belong to their parent (as Audiobookshelf groups them). The library side follows ABS's
 *   folders this way.
 * - Exception: in the TMW torrents every audio file is one book, also inside
 *   `[Author] Series/` folders that hold several volumes.
 */

export type UnitSource = 'tmw' | 'discord' | 'mam' | 'ai' | 'other' | 'library';
export type RootName = 'torrents' | 'library';

export interface UnitFile {
  fileId: number;
  rel: string;
}

export interface BookUnit {
  bookKey: string;
  root: RootName;
  unitRelPath: string;
  unitKind: 'folder' | 'file';
  source: UnitSource;
  /** The unit's own name (last segment; a file's name without its extension). */
  nameRaw: string;
  files: { fileId: number; rel: string; position: number; disc: string | null }[];
}

const TMW_PREFIX = 'TMW Japanese Audiobooks Collection';
/** Disc folders: Disc 1, CD2, Disk 03, DISC-1, ＣＤ１, Disc 1 of 2. */
const DISC = /^(?:disc|disk|cd)\s*[-_.]?\s*([0-9]+)(?:\s*(?:of|\/)\s*[0-9]+)?$/i;

function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** The disc number when a folder name is a disc folder, else null. */
export function discFolder(name: string): string | null {
  const m = DISC.exec(toHalfWidth(name).trim());
  return m ? String(Number(m[1])) : null;
}

export function sourceOf(root: RootName, rel: string): UnitSource {
  if (root === 'library') return 'library';
  const top = rel.split('/')[0];
  if (top.startsWith(TMW_PREFIX)) return 'tmw';
  if (top === 'Discord') return 'discord';
  if (top === 'MAM') return 'mam';
  if (top === 'AI') return 'ai';
  return 'other';
}

function dirname(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

function basename(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

function withoutExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** Natural order (numbers as numbers), so "2" comes before "10". */
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'variant' });

export function buildUnits(root: RootName, files: UnitFile[]): BookUnit[] {
  const units = new Map<string, BookUnit>();
  for (const f of files) {
    const source = sourceOf(root, f.rel);
    let unitRel: string;
    let kind: 'folder' | 'file';
    let disc: string | null = null;
    if (source === 'tmw') {
      unitRel = f.rel;
      kind = 'file';
    } else {
      let dir = dirname(f.rel);
      const d = discFolder(basename(dir));
      if (d !== null && dir.includes('/')) {
        disc = d;
        dir = dirname(dir);
      }
      unitRel = dir;
      kind = 'folder';
    }
    const key = `${root}:${unitRel}`;
    let unit = units.get(key);
    if (!unit) {
      unit = {
        bookKey: key,
        root,
        unitRelPath: unitRel,
        unitKind: kind,
        source,
        nameRaw: kind === 'file' ? withoutExt(basename(unitRel)) : basename(unitRel) || '(root)',
        files: [],
      };
      units.set(key, unit);
    }
    unit.files.push({ fileId: f.fileId, rel: f.rel, position: 0, disc });
  }
  for (const u of units.values()) {
    u.files.sort(
      (a, b) => collator.compare(a.disc ?? '', b.disc ?? '') || collator.compare(a.rel, b.rel),
    );
    u.files.forEach((f, i) => (f.position = i));
  }
  return [...units.values()].sort((a, b) => collator.compare(a.bookKey, b.bookKey));
}

export interface NameIds {
  asins: string[];
  /** TMW's reading-order position `[NN]` at the start of a name. */
  order: number | null;
  kikubon: string | null;
  audiobookJp: string | null;
  /** `[N巻]` / `[N.5巻]` volume labels. */
  volumes: string[];
}

/** Ids the folder and file names carry (evidence for the later lookups). */
export function idsInNames(names: string[]): NameIds {
  const asins = new Set<string>();
  let order: number | null = null;
  let kikubon: string | null = null;
  let audiobookJp: string | null = null;
  const volumes = new Set<string>();
  for (const raw of names) {
    const n = toHalfWidth(raw);
    for (const m of n.matchAll(/(?<![0-9A-Z])(B0[0-9A-Z]{8})(?![0-9A-Z])/g)) asins.add(m[1]);
    const o = /^\[(\d{1,3})\]/.exec(n);
    if (o && order === null) order = Number(o[1]);
    const k = /\[kikubon\s*(\d+)\]/i.exec(n);
    if (k && kikubon === null) kikubon = k[1];
    const a = /\[audiobook\.jp\s*(\d+)\]/i.exec(n);
    if (a && audiobookJp === null) audiobookJp = a[1];
    for (const v of n.matchAll(/\[(\d+(?:\.\d+)?)巻[^\]]*\]/g)) volumes.add(v[1]);
  }
  return { asins: [...asins], order, kikubon, audiobookJp, volumes: [...volumes] };
}

export type MultiClass = 'single' | 'parts' | 'likely_copies' | 'unclear';

/**
 * Parts or copies? (WP15f's hint, measured on the NAS: 94 of 127 multi-file folders were
 * copies.) likely_copies: two or more files, each at least `minMinutes` long, all within
 * `percent` of the longest. unclear: the same similar lengths below the minimum (e.g. drama
 * CDs), or a length not known. parts: everything else. Checked against the store's runtime
 * in a later stage.
 */
export function classifyMulti(
  seconds: (number | null)[],
  minMinutes: number,
  percent: number,
): { cls: MultiClass; reason: string } {
  if (seconds.length <= 1) return { cls: 'single', reason: 'One audio file' };
  if (seconds.some((s) => s === null || !(s > 0))) {
    return { cls: 'unclear', reason: 'The length of a file is not known' };
  }
  const s = seconds as number[];
  const longest = Math.max(...s);
  const similar = s.every((x) => longest - x <= (longest * percent) / 100);
  const minutes = (x: number) => Math.round(x / 60);
  const lengths = s.map((x) => `${minutes(x)} min`).join(', ');
  if (similar && s.every((x) => x >= minMinutes * 60)) {
    return { cls: 'likely_copies', reason: `${s.length} files of similar length (${lengths})` };
  }
  if (similar) {
    return {
      cls: 'unclear',
      reason: `${s.length} files of similar length, shorter than ${minMinutes} min (${lengths})`,
    };
  }
  return { cls: 'parts', reason: `${s.length} files of different lengths (${lengths})` };
}
