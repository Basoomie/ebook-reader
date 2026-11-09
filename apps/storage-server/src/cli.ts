/**
 * Admin CLI for the storage server. Runs inside the container against the same
 * database as the server (WAL mode makes that safe):
 *
 *   docker exec ttsu-storage node dist/cli.js token create "Phone"
 *   docker exec ttsu-storage node dist/cli.js token list
 *   docker exec ttsu-storage node dist/cli.js token revoke <token-id>
 *
 * Uses DB_DIR (default /db) and DATA_DIR (default /data) like the server.
 */
import path from 'path';
import { initDatabase } from './db/database';
import { createToken, listTokens, revokeToken } from './db/tokens';
import { getUserByName, listUsers } from './db/users';

const USAGE = `Usage:
  cli token create <label> [--user <name>]   Create a token (shown once)
  cli token list                             List tokens
  cli token revoke <token-id>                Revoke a token`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function formatDate(ms: number | null): string {
  return ms === null ? '-' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
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
  if (group !== 'token' || !command) fail(USAGE);

  const state = initDatabase(
    path.resolve(env.DB_DIR ?? '/db'),
    path.resolve(env.DATA_DIR ?? '/data'),
  );
  if (!state.ok) fail(`Database unavailable: ${state.error}`);
  const db = state.db;

  try {
    switch (command) {
      case 'create': {
        const label = rest.join(' ').trim();
        if (!label) fail('token create needs a label, e.g. token create "Phone"');
        let user;
        if (userName) {
          user = getUserByName(db, userName);
          if (!user) fail(`No user named "${userName}"`);
        } else {
          const users = listUsers(db);
          if (users.length !== 1) fail('More than one user exists; pass --user <name>');
          user = users[0];
        }
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
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env);
}
