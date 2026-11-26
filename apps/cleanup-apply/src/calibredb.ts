/**
 * The only way the sidecar touches Calibre: calibredb against the RUNNING content server
 * (`--with-library http://host:port/#<library id>`), never the library folder (calibredb
 * refuses to open it while the GUI runs, and the sidecar doesn't mount it).
 *
 * An allowlist of subcommands, checked for every call:
 * - read: --version, list (also the library list via #-), custom_columns, export (files
 *   are sent back by the server and written into the quarantine folder), trash list;
 * - write: remove (to Calibre's trash, NEVER --permanent), set_tags (set_metadata of the tags
 *   field only: the user's own tags of a removed copy are added to the kept copy, decided
 *   2026-11-13, and taken off again by Undo), trash restore and add (Undo only), and
 *   set_fields (stage 2, WP20b: set_metadata of exactly the fields stage 2 writes: title and
 *   its sort, authors and author_sort, identifiers, publisher, languages, #illustrator and
 *   the cover; never tags, never an OPF);
 * - 1.7.0 (books without an EPUB): add_format (one file to one book, never replacing a format
 *   the book has: the EPUB the server checked, from this sidecar's own folder, or a copy's file
 *   from the quarantine onto its twin) and remove_format (one format of one book: only a format
 *   the pass added, as its Undo; the server names it).
 * The password goes in through stdin (`--password <stdin>`), never on the command line.
 *
 * list, set_tags, set_fields, remove, export and add go through the long-lived calibredb helper when there is one
 * (calibredb-helper.ts), with the same argument lists; everything else runs the program.
 */
import { spawn } from 'child_process';
import path from 'path';
import { CalibredbHelper, HelperUnavailable } from './calibredb-helper';

export type CalibredbCommand =
  | 'version'
  | 'libraries'
  | 'list'
  | 'custom_columns'
  | 'export'
  | 'remove'
  | 'trash_list'
  | 'trash_restore'
  | 'add'
  | 'set_tags'
  | 'set_fields'
  | 'add_format'
  | 'remove_format';

export const ALLOWED: readonly CalibredbCommand[] = [
  'version',
  'libraries',
  'list',
  'custom_columns',
  'export',
  'remove',
  'trash_list',
  'trash_restore',
  'add',
  'set_tags',
  'set_fields',
  'add_format',
  'remove_format'
];

/**
 * 1.7.0: the formats add_format and remove_format may name (the files of the library's books
 * without an EPUB, and the EPUB made for them). Never PDF or KFX: the pass leaves those alone.
 */
export const BOOK_FORMATS = [
  'EPUB',
  'AZW3',
  'AZW',
  'MOBI',
  'PRC',
  'TXT',
  'HTML',
  'HTMLZ',
  'ZIP',
  'CBZ',
  'CBR',
  'RAR'
] as const;

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;
/** The EPUB the server checked, downloaded into this sidecar's own folder for one item. */
export const FORMAT_ITEM_FILE =
  /^(\/|[A-Za-z]:[\\/]).*[\\/]ttsu-format-item-\d+[\\/][^\\/]+\.epub$/i;
/** A copy's file in its quarantine export (<quarantine>/<batch>/<calibre id>[-n]/<name>.<fmt>). */
export const QUARANTINED_FILE =
  /^(\/|[A-Za-z]:[\\/]).*[\\/][0-9a-f-]{36}[\\/]\d+(-\d+)?[\\/][^\\/]+\.[A-Za-z0-9]+$/;

/** The format a file is, by its extension, when it is one add_format may add. */
export function formatOfFile(file: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(file);
  const f = m ? m[1].toUpperCase() : '';
  return (BOOK_FORMATS as readonly string[]).includes(f) ? f : null;
}

/**
 * The only fields set_fields may set (stage 2; series, series_index and comments: stage 4;
 * tags: stage 5, the book's whole tag list as the server worked it out from Calibre's own).
 */
export const SET_FIELDS = [
  'title',
  'sort',
  'authors',
  'author_sort',
  'identifiers',
  'publisher',
  'languages',
  '#illustrator',
  'cover',
  'series',
  'series_index',
  'comments',
  'tags',
  // The user's edits from the reader (calibre metadata editing): published date and rating.
  'pubdate',
  'rating',
  // Manga part A (1.6.0): a moved book's #characters and date added, written again only when the
  // add from its export did not carry them (it does on calibre 9.18: the probe, 2026-11-24).
  '#characters',
  'timestamp'
] as const;

/** A title for `add --title`: one line, no control characters, not an option, not too long. */
export function isPlainTitle(t: string | undefined): boolean {
  return (
    typeof t === 'string' &&
    t.trim() !== '' &&
    !t.startsWith('-') &&
    [...t].length <= 300 &&
    ![...t].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  );
}

/** Options never allowed, whatever the subcommand. */
const FORBIDDEN_ARGS = ['--permanent', '--library-path', '--automerge', '-m'];

export interface Login {
  contentServerUrl: string;
  libraryId: string;
  username: string;
  password: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class CalibredbError extends Error {
  constructor(
    message: string,
    readonly result: RunResult | null
  ) {
    super(message);
  }
}

export interface CalibredbOptions {
  program: string;
  /** Arguments before calibredb's own (tests run a script with node). */
  prefixArgs?: string[];
  timeoutMs: number;
  /** For tests: extra environment for the program. */
  env?: Record<string, string>;
  /** The long-lived helper for list/set_tags/set_fields (none = always the program). */
  helper?: CalibredbHelper | null;
}

/**
 * The commands the helper runs. `add` since 1.6.1: a new calibredb program per add cost about
 * 0.4-0.6 s of each move's 6 s (measured with real calibre 9.18, 2026-11-25).
 */
const HELPER_COMMANDS: readonly CalibredbCommand[] = [
  'list',
  'set_tags',
  'set_fields',
  'remove',
  'export',
  'add'
];

export function withLibrary(login: Login, libraryId = login.libraryId): string {
  return `${login.contentServerUrl.replace(/\/+$/, '')}/#${libraryId}`;
}

/**
 * The full argument list for a call. Exported for the tests, which check that every call is
 * remote, never permanent and never carries the password.
 */
export function buildArgs(
  command: CalibredbCommand,
  login: Login | null,
  args: string[]
): string[] {
  if (!ALLOWED.includes(command)) throw new Error(`calibredb ${command} is not allowed`);
  for (const a of args) {
    if (FORBIDDEN_ARGS.includes(a)) throw new Error(`calibredb option ${a} is not allowed`);
  }
  if (command === 'version') return ['--version'];
  if (!login) throw new Error('calibredb needs the content server login');
  const remote = [
    '--with-library',
    withLibrary(login, command === 'libraries' ? '-' : login.libraryId),
    '--username',
    login.username,
    '--password',
    '<stdin>'
  ];
  switch (command) {
    case 'libraries':
      return ['list', ...remote, '--limit', '0'];
    case 'list':
      return ['list', ...remote, ...args];
    case 'custom_columns':
      return ['custom_columns', ...remote, '--details'];
    case 'export':
      return ['export', ...remote, ...args];
    case 'remove': {
      // Exactly one whole book, to Calibre's trash (never --permanent, never a list or range).
      if (args.length !== 1 || !/^\d+$/.test(args[0])) {
        throw new Error('remove takes exactly one book id');
      }
      return ['remove', ...remote, args[0]];
    }
    case 'trash_list':
      return ['trash', 'list', ...remote, '--for-machine'];
    case 'trash_restore': {
      // Whole books only (never --formats), given as plain ids (never a range). Calibre reads
      // its whole trash on every call, so Undo asks for all of a batch's books at once.
      if (args.length === 0 || !args.every((a) => /^\d+$/.test(a))) {
        throw new Error('trash restore takes book ids');
      }
      return ['trash', 'restore', ...remote, args.join(',')];
    }
    case 'add': {
      // Exactly one of two forms (WP20g): Undo's re-add of a quarantined export
      // (--duplicates --one-book-per-directory <folder>), and the import's add of one EPUB from
      // this sidecar's own temporary folder (--duplicates <…/ttsu-arrival-<item>/<name>.epub>).
      // Never -m/--automerge (FORBIDDEN_ARGS), never several files or a folder of files.
      const readd =
        args.length === 3 &&
        args[0] === '--duplicates' &&
        args[1] === '--one-book-per-directory' &&
        /^(\/|[A-Za-z]:[\\/])/.test(args[2]);
      const arrivalFile = (f: string | undefined) =>
        !!f && /^(\/|[A-Za-z]:[\\/]).*[\\/]ttsu-arrival-\d+[\\/][^\\/]+\.epub$/i.test(f);
      const arrival = args.length === 2 && args[0] === '--duplicates' && arrivalFile(args[1]);
      // 1.4.0: the same add with the title the server fitted for Calibre's folder names (the
      // file's own would make a name the disk refuses: Calibre keeps the record without the file).
      const arrivalTitled =
        args.length === 4 &&
        args[0] === '--duplicates' &&
        args[1] === '--title' &&
        isPlainTitle(args[2]) &&
        arrivalFile(args[3]);
      if (!readd && !arrival && !arrivalTitled)
        throw new Error('add takes a quarantined folder or one arrival EPUB');
      return ['add', ...remote, ...args];
    }
    case 'set_tags': {
      // Exactly: <book id> <the whole tag list, comma separated>. Nothing but the tags field.
      const [id, tags, ...rest] = args;
      if (!/^\d+$/.test(id ?? '') || tags === undefined || rest.length > 0) {
        throw new Error('set_tags takes a book id and a tag list');
      }
      return ['set_metadata', ...remote, id, '--field', `tags:${tags}`];
    }
    case 'set_fields': {
      // Exactly: <book id> then "<field>:<value>" for the allowed fields only, each once.
      const [id, ...fields] = args;
      if (!/^\d+$/.test(id ?? '') || fields.length === 0) {
        throw new Error('set_fields takes a book id and at least one field');
      }
      const seen = new Set<string>();
      const out = ['set_metadata', ...remote, id];
      for (const f of fields) {
        const name = f.slice(0, f.indexOf(':'));
        if (f.indexOf(':') < 1 || !(SET_FIELDS as readonly string[]).includes(name)) {
          throw new Error(`set_fields can't set ${name || f.slice(0, 20)}`);
        }
        if (seen.has(name)) throw new Error(`set_fields: ${name} given twice`);
        seen.add(name);
        if ((name === 'title' || name === 'authors') && f.slice(name.length + 1).trim() === '') {
          throw new Error(`set_fields: ${name} can't be empty`);
        }
        if (name === 'cover' && !/^(\/|[A-Za-z]:[\\/])/.test(f.slice(6))) {
          throw new Error('set_fields: the cover must be an absolute path');
        }
        out.push('--field', f);
      }
      return out;
    }
    case 'add_format': {
      // Exactly: --dont-replace <book id> <file>: an EPUB from this sidecar's own item folder, or
      // a copy's file from its quarantine export. Never replaces a format the book has.
      const [flag, id, file, ...rest] = args;
      if (flag !== '--dont-replace' || !/^\d+$/.test(id ?? '') || rest.length > 0 || !file) {
        throw new Error('add_format takes --dont-replace, a book id and one file');
      }
      if (!ABSOLUTE.test(file) || !formatOfFile(file)) {
        throw new Error('add_format: the file must be an absolute path of a book format');
      }
      if (!FORMAT_ITEM_FILE.test(file) && !QUARANTINED_FILE.test(file)) {
        throw new Error("add_format: the file must be an item's EPUB or a quarantined copy's file");
      }
      return ['add_format', ...remote, '--dont-replace', id, file];
    }
    case 'remove_format': {
      // Exactly: <book id> <format>, one format of the allowed ones.
      const [id, fmt, ...rest] = args;
      if (!/^\d+$/.test(id ?? '') || rest.length > 0) {
        throw new Error('remove_format takes a book id and one format');
      }
      if (!(BOOK_FORMATS as readonly string[]).includes(fmt ?? '')) {
        throw new Error(`remove_format can't remove ${String(fmt).slice(0, 10)}`);
      }
      return ['remove_format', ...remote, id, fmt];
    }
  }
}

export class Calibredb {
  /** Called after every call with its time (the sidecar's step timing; stage 1 uses it). */
  onCall: ((command: CalibredbCommand, ms: number, viaHelper: boolean) => void) | null = null;

  constructor(private readonly opts: CalibredbOptions) {}

  async run(
    command: CalibredbCommand,
    login: Login | null,
    args: string[] = []
  ): Promise<RunResult> {
    const t0 = Date.now();
    let viaHelper = false;
    try {
      return await this.runTimed(command, login, args, () => (viaHelper = true));
    } finally {
      this.onCall?.(command, Date.now() - t0, viaHelper);
    }
  }

  private async runTimed(
    command: CalibredbCommand,
    login: Login | null,
    args: string[],
    helped: () => void
  ): Promise<RunResult> {
    const argv = buildArgs(command, login, args);
    const helper = this.opts.helper;
    if (helper && login && HELPER_COMMANDS.includes(command) && helper.usable()) {
      try {
        helped();
        return await helper.call(argv, login.password, this.opts.timeoutMs);
      } catch (err) {
        // Not started: nothing was sent, so the program runs it. Sent: never again.
        if (!(err instanceof HelperUnavailable)) {
          throw new CalibredbError((err as Error).message, null);
        }
      }
    }
    return this.spawnRun(command, login, argv);
  }

  /** Stops the helper (after the worker stopped). */
  close(): void {
    this.opts.helper?.stop();
  }

  private spawnRun(
    command: CalibredbCommand,
    login: Login | null,
    argv: string[]
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.program, [...(this.opts.prefixArgs ?? []), ...argv], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.opts.env },
        windowsHide: true
      });
      let stdout = '';
      let stderr = '';
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        child.kill('SIGKILL');
        done = true;
        reject(
          new CalibredbError(
            `calibredb ${command} took longer than ${this.opts.timeoutMs / 1000} s`,
            null
          )
        );
      }, this.opts.timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        if (stdout.length < 50_000_000) stdout += d;
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        if (stderr.length < 1_000_000) stderr += d;
      });
      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(new CalibredbError(`calibredb could not start: ${err.message}`, null));
      });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      child.stdin.on('error', () => {});
      child.stdin.end(login && command !== 'version' ? `${login.password}\n` : '');
    });
  }

  /** run() that fails on a non-zero exit, with the end of stderr in the message. */
  async ok(
    command: CalibredbCommand,
    login: Login | null,
    args: string[] = []
  ): Promise<RunResult> {
    const r = await this.run(command, login, args);
    if (r.code !== 0) {
      // The last lines of the output, each and all of it kept short: calibre can print very
      // long lines (a whole traceback or page on one line).
      const tail = shorten(
        (r.stderr || r.stdout)
          .trim()
          .split(/\r?\n/)
          .slice(-5)
          .map((l) => shorten(l, 300))
          .join(' | '),
        1000
      );
      throw new CalibredbError(`calibredb ${command} failed (exit ${r.code}): ${tail}`, r);
    }
    return r;
  }

  async version(): Promise<string | null> {
    const r = await this.run('version', null);
    const m = /calibre\s+(\d+\.\d+(?:\.\d+)?)/i.exec(r.stdout);
    return m ? m[1] : null;
  }

  /** A book's current record, or null when the id is not in the library. */
  async book(
    login: Login,
    calibreId: number
  ): Promise<{
    id: number;
    uuid: string;
    last_modified: string;
    formats: string[];
    title: string;
    tags: string[];
  } | null> {
    const r = await this.ok('list', login, [
      '--search',
      `id:=${calibreId}`,
      '--fields',
      'uuid,last_modified,formats,title,tags',
      '--for-machine'
    ]);
    const rows = JSON.parse(r.stdout || '[]') as {
      id: number;
      uuid: string;
      last_modified: string;
      formats?: string[];
      title: string;
      tags?: string[] | string;
    }[];
    const row = rows.find((b) => b.id === calibreId);
    if (!row) return null;
    const tags = Array.isArray(row.tags)
      ? row.tags
      : typeof row.tags === 'string' && row.tags !== ''
        ? row.tags.split(',').map((t) => t.trim())
        : [];
    return { ...row, formats: row.formats ?? [], tags };
  }

  /** The UUIDs of those of these books that are in the library (100 ids per `list` call). */
  async presentUuids(login: Login, calibreIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (let i = 0; i < calibreIds.length; i += 100) {
      const chunk = calibreIds.slice(i, i + 100);
      const r = await this.ok('list', login, [
        '--search',
        chunk.map((id) => `id:=${id}`).join(' or '),
        '--fields',
        'uuid',
        '--for-machine',
        '--limit',
        String(chunk.length + 10)
      ]);
      for (const b of JSON.parse(r.stdout || '[]') as { id: number; uuid: string }[]) {
        if (chunk.includes(b.id)) out.set(b.id, b.uuid);
      }
    }
    return out;
  }

  /** Replaces a book's tag list (tags only; Calibre tags never contain commas). */
  async setTags(login: Login, calibreId: number, tags: string[]): Promise<void> {
    if (tags.some((t) => t.includes(','))) throw new Error('A tag contains a comma');
    await this.ok('set_tags', login, [String(calibreId), tags.join(',')]);
  }

  /**
   * Stage 2: sets a book's fields. A cover must be a file in one of `coverDirs` (the sidecar's
   * temp folder for a cover from the server, the quarantine for an old cover put back).
   */
  async setFields(
    login: Login,
    calibreId: number,
    fields: string[],
    coverDirs: string[]
  ): Promise<void> {
    for (const f of fields) {
      if (!f.startsWith('cover:')) continue;
      const file = path.resolve(f.slice(6));
      if (!coverDirs.some((d) => file.startsWith(path.resolve(d) + path.sep))) {
        throw new Error('The cover file is not in the temp or quarantine folder');
      }
    }
    await this.ok('set_fields', login, [String(calibreId), ...fields]);
  }

  /**
   * 1.7.0: adds one file as a format of a book (never replacing one it has). The file must be in
   * one of `dirs` (this sidecar's own format folder, or the quarantine).
   */
  async addFormat(login: Login, calibreId: number, file: string, dirs: string[]): Promise<void> {
    const resolved = path.resolve(file);
    if (!dirs.some((d) => resolved.startsWith(path.resolve(d) + path.sep))) {
      throw new Error('The file to add is not in the format or quarantine folder');
    }
    await this.ok('add_format', login, ['--dont-replace', String(calibreId), file]);
  }

  /** 1.7.0: removes one format of a book (Undo of a format the pass added). */
  async removeFormat(login: Login, calibreId: number, format: string): Promise<void> {
    await this.ok('remove_format', login, [String(calibreId), format.toUpperCase()]);
  }

  /** Stage 2: what Calibre shows for these books (one `list` call), by id. */
  async listBooks(
    login: Login,
    calibreIds: number[],
    fields: string
  ): Promise<Map<number, Record<string, unknown>>> {
    const out = new Map<number, Record<string, unknown>>();
    if (calibreIds.length === 0) return out;
    const r = await this.ok('list', login, [
      '--search',
      calibreIds.map((id) => `id:=${id}`).join(' or '),
      '--fields',
      fields,
      '--for-machine',
      '--limit',
      String(calibreIds.length + 10)
    ]);
    for (const b of JSON.parse(r.stdout || '[]') as Record<string, unknown>[]) {
      if (typeof b.id === 'number' && calibreIds.includes(b.id)) out.set(b.id, b);
    }
    return out;
  }

  /** Books with exactly this title (for an interrupted Undo re-add). */
  async idsWithTitle(login: Login, title: string): Promise<number[]> {
    const escaped = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const r = await this.ok('list', login, [
      '--search',
      `title:"=${escaped}"`,
      '--fields',
      'title',
      '--for-machine'
    ]);
    return (JSON.parse(r.stdout || '[]') as { id: number }[]).map((b) => b.id);
  }
}

/** At most `max` characters: the start and the end, with "…" between. */
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

/** Calibre's timestamps as ms (snapshot "2026-11-09 04:00:11.251060+00:00" or ISO). */
export function calibreTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value.trim()
    );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0);
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(':', '');
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000;
  }
  return t;
}

/** The same calibre version ("9.18" from calibredb --version equals "9.18.0" from the server). */
export function sameVersion(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && versionAtLeast(a, b) && versionAtLeast(b, a);
}

/** Compares versions like 9.18.0 >= 9.18. */
export function versionAtLeast(version: string | null, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}
