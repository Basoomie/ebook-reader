/**
 * Admin CLI for the storage server. Runs inside the container against the same
 * database as the server (WAL mode makes that safe):
 *
 *   docker exec ttsu-storage node dist/cli.js token pair "Boox"
 *   docker exec ttsu-storage node dist/cli.js token create "Phone"
 *   docker exec ttsu-storage node dist/cli.js token list
 *   docker exec ttsu-storage node dist/cli.js token revoke <token-id>
 *   docker exec ttsu-storage node dist/cli.js library list
 *   docker exec ttsu-storage node dist/cli.js library set <id> --language ja --enable
 *   docker exec ttsu-storage node dist/cli.js index status
 *   docker exec ttsu-storage node dist/cli.js index run [<library-id>]
 *   docker exec ttsu-storage node dist/cli.js thumbs rebuild --library <id>
 *   docker exec ttsu-storage node dist/cli.js thumbs rotate-key
 *   docker exec ttsu-storage node dist/cli.js counts status
 *   docker exec ttsu-storage node dist/cli.js counts retry
 *   docker exec ttsu-storage node dist/cli.js sync status
 *   docker exec ttsu-storage node dist/cli.js sync dump --kind position --book <id>
 *   docker exec ttsu-storage node dist/cli.js sync new-epoch
 *   docker exec ttsu-storage node dist/cli.js migration status
 *   docker exec ttsu-storage node dist/cli.js migration undo [--forget-decisions]
 *   docker exec ttsu-storage node dist/cli.js uploads list
 *
 * Uses DB_DIR (default /db) and DATA_DIR (default /data) like the server, and
 * PAIR_CODE_MINUTES for how long a pairing code stays valid.
 * The CLI never touches the Calibre libraries: `index run`, `thumbs rebuild` and
 * `counts rebuild|retry` only leave a request in the database that the server picks
 * up on its next poll.
 * For the same reason the WP5 scan and import run in the server (from the
 * migration page); the CLI only reports on them and can undo the import.
 */
import type Database from 'better-sqlite3';
import { readdirSync } from 'fs';
import path from 'path';
import { UPLOADS_DIRNAME } from './uploads/upload-store';
import {
  getIndexState,
  getLibrary,
  Library,
  LibraryChanges,
  listLibraries,
  requestReindex,
  updateLibrary,
} from './calibre/libraries';
import { parseCountsConfig, parsePairingConfig, parseSyncConfig } from './config';
import { countSpec, readCounterInfo } from './counts/counter-bundle';
import {
  CountScope,
  countTotalsByLibrary,
  forgetCounts,
  recentCountErrors,
} from './counts/count-records';
import { listDevices } from './db/devices';
import { initDatabase } from './db/database';
import { createPairingCode, prunePairingCodes } from './db/pairing';
import { rotateSecret, THUMBNAIL_URL_SECRET } from './db/secrets';
import { createToken, listTokens, revokeToken } from './db/tokens';
import { getUserByName, listUsers } from './db/users';
import { MigrationService } from './migration/service';
import { SyncStore } from './sync/store';
import { forgetThumbnails, RebuildScope } from './thumbnails/thumbnails';

const USAGE = `Usage:
  cli token pair <label> [--user <name>]     Make a one-time code a device trades for its own token
  cli token create <label> [--user <name>]   Create a token (shown once)
  cli token list                             List tokens
  cli token revoke <token-id>                Revoke a token
  cli library list                           List discovered Calibre libraries
  cli library set <id> [--name <name>] [--language <tag>] [--enable | --disable]
                                             Name a library, set its language (ja, en, ...)
                                             and turn indexing on or off
  cli index status                           Show each library's index state
  cli index run [<library-id>] [--allow-mass-missing]
                                             Re-snapshot and re-index on the server's next poll
  cli thumbs rebuild (--book <id> | --library <id> | --all)
                                             Make thumbnails again (in the background)
  cli thumbs rotate-key                      Invalidate every signed thumbnail URL already handed out
  cli counts status                          Character counts per library and the latest failures
  cli counts rebuild (--book <id> | --library <id> | --all)
                                             Count again (in the background)
  cli counts retry                           Count the books that failed again
  cli sync status [--user <name>]            Synced records per kind, devices and when they last synced
  cli sync dump [--kind <kind>] [--book <id>] [--limit <n>]
                                             Print synced records, newest change first
  cli sync new-epoch                         After restoring the database from a snapshot: every
                                             device re-sends what it has on its next sync
  cli migration status                       The old-sync migration: book folders per state, devices
  cli migration undo [--forget-decisions]    Delete every record the migration import wrote (the old
                                             sync's files are never touched); --forget-decisions also
                                             clears the scan results and your link decisions
  cli uploads list                           Uploaded books and files still waiting for a decision`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function formatDate(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

/** Removes `--name value` from args and returns value (undefined if absent). */
function takeOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value`);
  args.splice(idx, 2);
  return value;
}

/** Removes a boolean `--flag` from args and returns whether it was there. */
function takeFlag(args: string[], name: string): boolean {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function pickUser(db: Database.Database, userName?: string) {
  if (userName) {
    const user = getUserByName(db, userName);
    if (!user) fail(`No user named "${userName}"`);
    return user;
  }
  const users = listUsers(db);
  if (users.length !== 1) fail('More than one user exists; pass --user <name>');
  return users[0];
}

function tokenCommand(
  db: Database.Database,
  command: string,
  rest: string[],
  env: Record<string, string | undefined>,
  userName?: string,
) {
  switch (command) {
    case 'pair': {
      const label = rest.join(' ').trim();
      if (!label) fail('token pair needs a label, e.g. token pair "Boox"');
      const user = pickUser(db, userName);
      const warnings: string[] = [];
      const { codeMinutes } = parsePairingConfig(env, warnings);
      for (const w of warnings) console.warn(`Warning: ${w}`);
      prunePairingCodes(db);
      const code = createPairingCode(db, user.id, label, codeMinutes);
      console.log(`Pairing code for "${code.label}" (user "${user.name}"):`);
      console.log(code.code);
      console.log(
        `Enter it on the device within ${codeMinutes} minute(s) (until ${formatDate(code.expiresAt)}). It works once.`,
      );
      break;
    }
    case 'create': {
      const label = rest.join(' ').trim();
      if (!label) fail('token create needs a label, e.g. token create "Phone"');
      const user = pickUser(db, userName);
      const { token, record } = createToken(db, user.id, label);
      console.log(`Created token "${record.label}" for user "${user.name}" (id ${record.id}).`);
      console.log('Copy it now; it is not stored and cannot be shown again:');
      console.log(token);
      break;
    }
    case 'list': {
      const tokens = listTokens(db);
      if (tokens.length === 0) {
        console.log('No tokens.');
        break;
      }
      for (const t of tokens) {
        console.log(
          [
            t.id,
            `user=${t.userName}`,
            `label="${t.label}"`,
            `created=${formatDate(t.createdAt)}`,
            `last_used=${formatDate(t.lastUsedAt)}`,
            t.revokedAt === null ? 'active' : `revoked=${formatDate(t.revokedAt)}`,
          ].join('  '),
        );
      }
      break;
    }
    case 'revoke': {
      const id = rest[0];
      if (!id) fail('token revoke needs a token id (see token list)');
      if (!revokeToken(db, id)) fail(`No active token with id ${id}`);
      console.log(`Revoked token ${id}.`);
      break;
    }
    default:
      fail(USAGE);
  }
}

function describeLibrary(lib: Library): string {
  return [
    lib.id,
    `folder="${lib.folder || '(root)'}"`,
    `name="${lib.name}"`,
    `language=${lib.language ?? '(not set)'}`,
    lib.enabled ? 'enabled' : 'disabled',
    lib.available ? 'available' : 'NOT AVAILABLE',
  ].join('  ');
}

function requireLibrary(db: Database.Database, id: string | undefined): Library {
  if (!id) fail('Give a library id (see library list)');
  const lib = getLibrary(db, id);
  if (!lib) fail(`No library with id ${id}`);
  return lib;
}

function libraryCommand(db: Database.Database, command: string, rest: string[]) {
  switch (command) {
    case 'list': {
      const libs = listLibraries(db);
      if (libs.length === 0) {
        console.log('No libraries found yet (the server discovers them on its next poll).');
      }
      for (const lib of libs) console.log(describeLibrary(lib));
      break;
    }
    case 'set': {
      const args = [...rest];
      const changes: LibraryChanges = {};
      const name = takeOption(args, '--name');
      const language = takeOption(args, '--language');
      const enable = takeFlag(args, '--enable');
      const disable = takeFlag(args, '--disable');
      if (enable && disable) fail('Use either --enable or --disable, not both');
      if (name !== undefined) changes.name = name;
      if (language !== undefined) changes.language = language;
      if (enable) changes.enabled = true;
      if (disable) changes.enabled = false;
      const lib = requireLibrary(db, args[0]);
      if (args.length > 1) fail(`Unexpected arguments: ${args.slice(1).join(' ')}`);
      if (Object.keys(changes).length === 0) fail('Nothing to change (see usage)');
      try {
        console.log(describeLibrary(updateLibrary(db, lib.id, changes)));
      } catch (err) {
        fail((err as Error).message);
      }
      break;
    }
    default:
      fail(USAGE);
  }
}

function indexCommand(db: Database.Database, command: string, rest: string[]) {
  switch (command) {
    case 'status': {
      const libs = listLibraries(db);
      if (libs.length === 0) console.log('No libraries.');
      for (const lib of libs) {
        const s = getIndexState(db, lib.id);
        console.log(describeLibrary(lib));
        console.log(
          `    status=${s.status}  books=${s.booksIndexed}  missing=${s.booksMissing}  ` +
            `skipped=${s.booksSkipped}  indexed=${formatDate(s.indexedAt)}` +
            (s.reindexRequestedAt ? '  reindex=requested' : ''),
        );
        if (s.lastError) console.log(`    error (${formatDate(s.lastErrorAt)}): ${s.lastError}`);
        if (s.lastWarning) {
          console.log(`    warning (${formatDate(s.lastWarningAt)}): ${s.lastWarning}`);
        }
      }
      break;
    }
    case 'run': {
      const args = [...rest];
      const allowMassMissing = takeFlag(args, '--allow-mass-missing');
      const targets = args[0]
        ? [requireLibrary(db, args[0])]
        : listLibraries(db).filter((l) => l.enabled);
      if (targets.length === 0) fail('No enabled libraries');
      for (const lib of targets) {
        if (!lib.enabled) fail(`Library ${lib.id} is disabled; enable it first`);
        requestReindex(db, lib.id, allowMassMissing);
        console.log(`Reindex requested for "${lib.name}"; the server runs it on its next poll.`);
      }
      break;
    }
    default:
      fail(USAGE);
  }
}

function thumbsCommand(db: Database.Database, command: string, rest: string[]) {
  if (command === 'rotate-key') {
    rotateSecret(db, THUMBNAIL_URL_SECRET);
    console.log(
      'New thumbnail signing key. Devices get new thumbnail URLs on their next list request.',
    );
    return;
  }
  if (command !== 'rebuild') fail(USAGE);
  const args = [...rest];
  const book = takeOption(args, '--book');
  const library = takeOption(args, '--library');
  const all = takeFlag(args, '--all');
  const chosen = [book, library, all ? true : undefined].filter((v) => v !== undefined);
  if (chosen.length !== 1) fail('Give exactly one of --book <id>, --library <id>, --all');
  let scope: RebuildScope;
  if (book) scope = { bookId: book };
  else if (library) scope = { libraryId: requireLibrary(db, library).id };
  else scope = { all: true };
  const n = forgetThumbnails(db, scope);
  console.log(`${n} thumbnail(s) will be made again by the server in the background.`);
}

function countsCommand(
  db: Database.Database,
  command: string,
  rest: string[],
  env: Record<string, string | undefined>,
) {
  const args = [...rest];
  switch (command) {
    case 'status': {
      if (args.length) fail(`Unexpected arguments: ${args.join(' ')}`);
      const config = parseCountsConfig(env, []);
      let spec: string | null = null;
      try {
        const counter = readCounterInfo();
        spec = countSpec(counter.version, config);
        console.log(
          `spec=${spec}  counter build=${counter.build}  ` +
            `background=${config.background ? 'on' : 'off'}`,
        );
      } catch (err) {
        console.log(`The counter is unavailable: ${(err as Error).message}`);
      }
      const totals = countTotalsByLibrary(db, spec);
      const libs = listLibraries(db).filter((l) => l.enabled);
      if (libs.length === 0) console.log('No enabled libraries.');
      for (const lib of libs) {
        const t = totals.get(lib.id) ?? { counted: 0, pending: 0, errors: 0 };
        console.log(describeLibrary(lib));
        console.log(`    counted=${t.counted}  pending=${t.pending}  failed=${t.errors}`);
      }
      const errors = recentCountErrors(db, 20);
      if (errors.length) console.log('Latest failures (newest first):');
      for (const e of errors) {
        console.log(
          `  ${formatDate(e.countedAt)}  ${e.errorCode}  "${e.title}" (${e.bookId}): ${e.error}`,
        );
      }
      break;
    }
    case 'rebuild': {
      const book = takeOption(args, '--book');
      const library = takeOption(args, '--library');
      const all = takeFlag(args, '--all');
      const chosen = [book, library, all ? true : undefined].filter((v) => v !== undefined);
      if (chosen.length !== 1) fail('Give exactly one of --book <id>, --library <id>, --all');
      if (args.length) fail(`Unexpected arguments: ${args.join(' ')}`);
      let scope: CountScope;
      if (book) scope = { bookId: book };
      else if (library) scope = { libraryId: requireLibrary(db, library).id };
      else scope = { all: true };
      const n = forgetCounts(db, scope);
      console.log(
        `${n} book(s) will be counted again by the server in the background ` +
          '(the old counts are shown until then).',
      );
      break;
    }
    case 'retry': {
      if (args.length) fail(`Unexpected arguments: ${args.join(' ')}`);
      const n = forgetCounts(db, { errors: true });
      console.log(`${n} failed book(s) will be counted again by the server in the background.`);
      break;
    }
    default:
      fail(USAGE);
  }
}

function syncCommand(
  db: Database.Database,
  command: string,
  rest: string[],
  env: Record<string, string | undefined>,
  userName?: string,
) {
  const warnings: string[] = [];
  const { maxClockSkewSeconds } = parseSyncConfig(env, warnings);
  const store = new SyncStore(db, { maxClockSkewMs: maxClockSkewSeconds * 1000 });
  switch (command) {
    case 'status': {
      const user = pickUser(db, userName);
      const state = store.getState(user.id);
      console.log(`user=${user.name}  epoch=${state.epoch}  last_rev=${state.lastRev}`);
      const counts = store.counts(user.id);
      if (counts.length === 0) console.log('No synced records.');
      for (const c of counts) console.log(`  ${c.kind}: ${c.live} (+${c.deleted} deleted)`);
      const devices = listDevices(db, store, user.id);
      console.log(devices.length ? 'Devices:' : 'No devices registered.');
      for (const d of devices) {
        console.log(
          `  ${d.id}  name="${d.name}"  created=${formatDate(d.createdAt)}  last_seen=${formatDate(d.lastSeenAt)}`,
        );
      }
      break;
    }
    case 'dump': {
      const args = [...rest];
      const kind = takeOption(args, '--kind');
      const bookId = takeOption(args, '--book');
      const limitRaw = takeOption(args, '--limit');
      const limit = limitRaw === undefined ? 100 : Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) fail('--limit needs a whole number >= 1');
      if (args.length) fail(`Unexpected arguments: ${args.join(' ')}`);
      const user = pickUser(db, userName);
      const records = store.list(user.id, { kind, bookId }, limit);
      if (records.length === 0) console.log('No matching records.');
      for (const r of records) {
        console.log(
          [
            `rev=${r.rev}`,
            r.kind,
            r.id,
            `device=${r.deviceId}`,
            `updated=${formatDate(r.updatedAt)}`,
            r.deletedAt === null ? '' : `deleted=${formatDate(r.deletedAt)}`,
            JSON.stringify(r.data),
          ]
            .filter(Boolean)
            .join('  '),
        );
      }
      break;
    }
    case 'new-epoch': {
      const n = store.newEpoch();
      console.log(
        `New sync epoch for ${n} user(s). Each device pulls everything and re-sends its own records on its next sync.`,
      );
      break;
    }
    default:
      fail(USAGE);
  }
}

function migrationCommand(
  db: Database.Database,
  command: string,
  rest: string[],
  env: Record<string, string | undefined>,
  userName?: string,
) {
  const warnings: string[] = [];
  const { maxClockSkewSeconds } = parseSyncConfig(env, warnings);
  const store = new SyncStore(db, { maxClockSkewMs: maxClockSkewSeconds * 1000 });
  const service = new MigrationService({
    db,
    store,
    dataRoot: path.resolve(env.DATA_DIR ?? '/data'),
    dbDir: path.resolve(env.DB_DIR ?? '/db'),
    calibreDir: null,
    indexerEnabled: () => false,
  });
  const user = pickUser(db, userName);
  switch (command) {
    case 'status': {
      const o = service.overview(user.id);
      console.log(
        `last scan=${formatDate(o.lastScanAt)}  last import=${formatDate(o.lastImportAt)}  ` +
          `pre-import snapshot=${o.lastSnapshot ?? '-'}  old sync=${o.legacySyncEnabled ? 'on' : 'OFF'}`,
      );
      const byState = new Map<string, number>();
      for (const b of o.books) {
        const key = b.state === 'linked' ? `linked (${b.method})` : `${b.state} (${b.reason})`;
        byState.set(key, (byState.get(key) ?? 0) + 1);
      }
      if (!o.books.length) console.log('No scan results yet.');
      for (const [k, n] of [...byState.entries()].sort()) console.log(`  ${k}: ${n}`);
      for (const b of o.books.filter((b) => b.state !== 'linked')) {
        console.log(`    ${b.state}  ${b.reason ?? ''}  ${b.title}`);
      }
      for (const d of o.devices) {
        console.log(
          `  device "${d.name}"  reported=${formatDate(d.reportedAt)}  calibre links=${d.calibreLinks}` +
            (d.localOnlyTitles.length ? `  only on this device: ${d.localOnlyTitles.length}` : ''),
        );
      }
      break;
    }
    case 'undo': {
      const args = [...rest];
      const forget = takeFlag(args, '--forget-decisions');
      if (args.length) fail(`Unexpected arguments: ${args.join(' ')}`);
      const n = service.undo(user.id, forget);
      console.log(
        `Deleted ${n} imported record(s)${forget ? ' and the scan results' : ''}. ` +
          'Devices drop them on their next sync. The old sync files were not touched.',
      );
      break;
    }
    default:
      fail(USAGE);
  }
}

/** Read-only: uploaded books (WP7b) and staged files nobody decided on yet. */
function uploadsCommand(
  db: Database.Database,
  command: string,
  env: Record<string, string | undefined>,
) {
  if (command !== 'list') fail(USAGE);
  const rows = db
    .prepare(
      `SELECT b.id, b.title, l.name AS library, s.file_size, s.created_at, s.missing_at
         FROM book_sources s JOIN books b ON b.id = s.book_id
         JOIN libraries l ON l.id = b.library_id
        WHERE s.kind = 'upload' ORDER BY s.created_at DESC`,
    )
    .all() as {
    id: string;
    title: string;
    library: string;
    file_size: number | null;
    created_at: number;
    missing_at: number | null;
  }[];
  if (!rows.length) console.log('No uploaded books.');
  for (const r of rows) {
    console.log(
      `${r.id}  ${formatDate(r.created_at)}  ${r.library}  ${r.file_size ?? '?'} bytes  ${r.title}` +
        (r.missing_at ? '  (missing)' : ''),
    );
  }
  const staging = path.join(path.resolve(env.DATA_DIR ?? '/data'), UPLOADS_DIRNAME, 'staging');
  let staged: string[] = [];
  try {
    staged = readdirSync(staging).filter((n) => n.endsWith('.epub'));
  } catch {
    // No upload folder yet.
  }
  console.log(`Waiting for a decision: ${staged.length} file(s)`);
}

export function main(argv: string[], env: Record<string, string | undefined>): void {
  const args = [...argv];
  let userName: string | undefined;
  const userIdx = args.indexOf('--user');
  if (userIdx !== -1) {
    userName = args[userIdx + 1];
    if (!userName) fail('--user needs a name');
    args.splice(userIdx, 2);
  }

  const [group, command, ...rest] = args;
  const groups = ['token', 'library', 'index', 'thumbs', 'counts', 'sync', 'migration', 'uploads'];
  if (!groups.includes(group) || !command) {
    fail(USAGE);
  }

  const state = initDatabase(
    path.resolve(env.DB_DIR ?? '/db'),
    path.resolve(env.DATA_DIR ?? '/data'),
  );
  if (!state.ok) fail(`Database unavailable: ${state.error}`);
  const db = state.db;

  try {
    if (group === 'token') tokenCommand(db, command, rest, env, userName);
    else if (group === 'library') libraryCommand(db, command, rest);
    else if (group === 'index') indexCommand(db, command, rest);
    else if (group === 'counts') countsCommand(db, command, rest, env);
    else if (group === 'sync') syncCommand(db, command, rest, env, userName);
    else if (group === 'migration') migrationCommand(db, command, rest, env, userName);
    else if (group === 'uploads') uploadsCommand(db, command, env);
    else thumbsCommand(db, command, rest);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env);
}
