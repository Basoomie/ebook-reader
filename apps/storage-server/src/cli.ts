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
 *
 * Uses DB_DIR (default /db) and DATA_DIR (default /data) like the server, and
 * PAIR_CODE_MINUTES for how long a pairing code stays valid.
 * The CLI never touches the Calibre libraries: `index run` and `thumbs rebuild`
 * only leave a request in the database that the server picks up on its next poll.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import {
  getIndexState,
  getLibrary,
  Library,
  LibraryChanges,
  listLibraries,
  requestReindex,
  updateLibrary,
} from './calibre/libraries';
import { parsePairingConfig } from './config';
import { initDatabase } from './db/database';
import { createPairingCode, prunePairingCodes } from './db/pairing';
import { rotateSecret, THUMBNAIL_URL_SECRET } from './db/secrets';
import { createToken, listTokens, revokeToken } from './db/tokens';
import { getUserByName, listUsers } from './db/users';
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
  cli thumbs rotate-key                      Invalidate every signed thumbnail URL already handed out`;

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
  if (!['token', 'library', 'index', 'thumbs'].includes(group) || !command) fail(USAGE);

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
    else thumbsCommand(db, command, rest);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env);
}
