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
 *   2026-11-13, and taken off again by Undo), trash restore and add (Undo only).
 * The password goes in through stdin (`--password <stdin>`), never on the command line.
 */
import { spawn } from 'child_process';

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
  | 'set_tags';

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
  'set_tags'
];

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
}

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
    case 'remove':
      return ['remove', ...remote, ...args];
    case 'trash_list':
      return ['trash', 'list', ...remote, '--for-machine'];
    case 'trash_restore':
      return ['trash', 'restore', ...remote, ...args];
    case 'add':
      return ['add', ...remote, ...args];
    case 'set_tags': {
      // Exactly: <book id> <the whole tag list, comma separated>. Nothing but the tags field.
      const [id, tags, ...rest] = args;
      if (!/^\d+$/.test(id ?? '') || tags === undefined || rest.length > 0) {
        throw new Error('set_tags takes a book id and a tag list');
      }
      return ['set_metadata', ...remote, id, '--field', `tags:${tags}`];
    }
  }
}

export class Calibredb {
  constructor(private readonly opts: CalibredbOptions) {}

  run(command: CalibredbCommand, login: Login | null, args: string[] = []): Promise<RunResult> {
    const argv = buildArgs(command, login, args);
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
      const tail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join(' | ');
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

  /** Replaces a book's tag list (tags only; Calibre tags never contain commas). */
  async setTags(login: Login, calibreId: number, tags: string[]): Promise<void> {
    if (tags.some((t) => t.includes(','))) throw new Error('A tag contains a comma');
    await this.ok('set_tags', login, [String(calibreId), tags.join(',')]);
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
