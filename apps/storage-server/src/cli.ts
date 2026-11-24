/**
 * Admin CLI for the storage server. Runs inside the container against the same
 * database as the server (WAL mode makes that safe):
 *
 *   docker exec ttsu-storage node dist/cli.js token pair "Boox"
 *   docker exec ttsu-storage node dist/cli.js token create "Phone"
 *   docker exec ttsu-storage node dist/cli.js token worker "PC GPU worker"
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
 *   docker exec ttsu-storage node dist/cli.js fonts list
 *   docker exec ttsu-storage node dist/cli.js library set <id> --audio-dir japanese --subtitle-dir japanese-srt
 *   docker exec ttsu-storage node dist/cli.js audio status
 *   docker exec ttsu-storage node dist/cli.js audio scan [<library-id>]
 *   docker exec ttsu-storage node dist/cli.js audio match <book-id>
 *   docker exec ttsu-storage node dist/cli.js audio links
 *   docker exec ttsu-storage node dist/cli.js token cleanup "cleanup sidecar"
 *   docker exec ttsu-storage node dist/cli.js cleanup status
 *   docker exec ttsu-storage node dist/cli.js cleanup resume 3
 *
 * Uses DB_DIR (default /db) and DATA_DIR (default /data) like the server, and
 * PAIR_CODE_MINUTES for how long a pairing code stays valid.
 * The CLI never touches the Calibre libraries: `index run`, `thumbs rebuild` and
 * `counts rebuild|retry` only leave a request in the database that the server picks
 * up on its next poll. The same goes for the audiobooks folder (WP15): `audio scan` only
 * asks the server, and `audio match` reads the index in the database.
 * For the same reason the WP5 scan and import run in the server (from the
 * migration page); the CLI only reports on them and can undo the import.
 */
import type Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { UPLOADS_DIRNAME, UploadStore } from './uploads/upload-store';
import { readBookScript } from './audio/book-script';
import { countImportOptions } from './counts/counter-bundle';
import { importSummaries, type ImportFile } from './summaries/import';
import { AiCore } from './ai/core';
import { bookEpub } from './summaries/start';
import { openSummariesDb, summariesDbPath } from './summaries/summaries-db';
import { LABELS_REQUESTED, labelPlan } from './summaries/service';
import { readSummarySettings } from './summaries/settings';
import { SummaryStore } from './summaries/store';
import { RecapService, RECAPS_REQUESTED } from './summaries/recap-service';
import { BUILT_IN_PRICES } from './ai/prices';
import { FontStore } from './fonts/font-store';
import { FontService } from './fonts/service';
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
import {
  getScanState,
  listAudioFolders,
  listSubtitleFiles,
  requestAudioScan,
} from './audio/audio-index';
import { rankEntries } from './audio/match';
import { listLinks, resolveLink } from './audio/audio-links';
import { createApplyToken, listApplyTokens, revokeApplyToken } from './cleanup/apply-tokens';
import { initCleanupDatabase } from './cleanup/cleanup-db';
import { listStages } from './cleanup/stages';
import { recordReviewDecisions, resumeFailedStage3 } from './cleanup/stage3';
import { importDryRun, runAudioDryRun } from './cleanup/audio/dry-run';

/**
 * `cli summaries import <file> [--apply]`: the accuracy test's summaries into summaries.db
 * (a dry run without --apply). The running server sends them to the devices within 10 minutes.
 */
async function summariesImportCommand(rest: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const file = rest[0];
  const apply = rest.includes('--apply');
  const state = initDatabase(
    path.resolve(env.DB_DIR ?? '/db'),
    path.resolve(env.DATA_DIR ?? '/data'),
  );
  if (!state.ok) fail(`Database unavailable: ${state.error}`);
  const warnings: string[] = [];
  const counts = parseCountsConfig(env, warnings);
  const sdb = openSummariesDb(summariesDbPath(path.resolve(env.DB_DIR ?? '/db')));
  const o = {
    calibreDir: (env.CALIBRE_DIR ?? '').trim() || null,
    uploads: new UploadStore(path.resolve(env.DATA_DIR ?? '/data')),
  };
  try {
    const r = await importSummaries({
      main: state.db,
      sdb,
      file: JSON.parse(readFileSync(file, 'utf8')) as ImportFile,
      apply,
      readScript: async (bookId) => {
        const epub = bookEpub(state.db, o, bookId);
        if (!epub) throw new Error("the book's EPUB is not available");
        return readBookScript(epub, {
          importOptions: countImportOptions(counts),
          maxSentence: Number(env.TTS_MAX_SENTENCE ?? 120),
          timeoutMs: 300_000,
        });
      },
    });
    for (const l of r.lines)
      console.log(
        `${l.problem ? 'NO ' : 'ok '} ${l.key}: ${l.title}` +
          (l.bookId
            ? `\n     -> ${l.liveTitle} (${l.bookId}, by ${l.how}); ${l.quotes} quotes found, ${l.moved} at a new position`
            : '') +
          (l.problem
            ? `\n     ${l.problem}${l.missing.length ? `: ${l.missing.join(', ')}` : ''}`
            : ''),
      );
    if (!r.ok) {
      console.log('Nothing stored: every summary must match one book and every quote be found.');
      return 1;
    }
    console.log(
      apply
        ? `Stored ${r.stored} summaries. The server sends them to the devices within 10 minutes.`
        : `Dry run: all ${r.lines.length} match. Run again with --apply to store them.`,
    );
    return 0;
  } finally {
    sdb.close();
    state.db.close();
  }
}

/**
 * `cli summaries label [--apply]` (session 4): the relationships of current summaries written
 * before labels existed, and a rough cost; --apply asks the running server to label them once
 * (it starts within a minute and logs what it did; the devices get the labels as usual).
 */
function summariesLabelCommand(rest: string[], env: NodeJS.ProcessEnv): number {
  const apply = rest.includes('--apply');
  const dbDir = path.resolve(env.DB_DIR ?? '/db');
  const sdb = openSummariesDb(summariesDbPath(dbDir));
  try {
    const store = new SummaryStore(sdb);
    const model = readSummarySettings(sdb).translator;
    const plan = labelPlan(store, BUILT_IN_PRICES[model] ?? null);
    for (const s of plan.summaries)
      console.log(`  ${s.title}: ${s.items} relationship${s.items === 1 ? '' : 's'}`);
    const n = plan.summaries.reduce((a, s) => a + s.items, 0);
    if (!n) {
      console.log('Every relationship of the current summaries has a label.');
      return 0;
    }
    const cost =
      plan.usd === null ? 'cost unknown' : `about $${Math.max(plan.usd, 0.01).toFixed(2)}`;
    if (!apply) {
      console.log(
        `${n} relationships in ${plan.summaries.length} summaries need a label (${model}, ${cost}, plus re-translating those items in the saved languages). Run again with --apply to label them.`,
      );
      return 0;
    }
    sdb
      .prepare('INSERT OR REPLACE INTO summary_state (key, value) VALUES (?, ?)')
      .run(LABELS_REQUESTED, String(Date.now()));
    console.log(
      `Asked the server to label ${n} relationships in ${plan.summaries.length} summaries (${cost}). It starts within a minute; its log says when it is done.`,
    );
    return 0;
  } finally {
    sdb.close();
  }
}

/**
 * `cli summaries recaps [--series <name>] [--apply]` (session 5): the series a "story so far"
 * could be made for now (two or more completed volumes with a summary) and a rough cost; --apply
 * asks the running server to make those that have none (a series that has one is remade with the
 * panel's Regenerate). Nothing is asked without --apply.
 */
function summariesRecapsCommand(rest: string[], env: NodeJS.ProcessEnv): number {
  const apply = rest.includes('--apply');
  const si = rest.indexOf('--series');
  const only = si >= 0 ? rest[si + 1] : undefined;
  if (si >= 0 && !only) fail('--series needs a series name');
  const dbDir = path.resolve(env.DB_DIR ?? '/db');
  const state = initDatabase(dbDir, path.resolve(env.DATA_DIR ?? '/data'));
  if (!state.ok) fail(`Database unavailable: ${state.error}`);
  const sdb = openSummariesDb(summariesDbPath(dbDir));
  try {
    const store = new SummaryStore(sdb);
    const settings = readSummarySettings(sdb);
    const recaps = new RecapService({
      db: sdb,
      main: state.db,
      runner: null as never,
      store,
      now: Date.now,
      settings: () => settings,
      openRun: () => {
        throw new Error('not here');
      },
      closeRun: () => undefined,
      stopping: () => false,
      writeRecord: () => undefined,
      openBookJobs: () => new Set(),
    });
    const plan = recaps.plan(only);
    // The first setup's writer and checkers at list price: 1.2 tokens per character plus the
    // instructions; about a sixth as much written as read; each checker reads about as much.
    const first = settings.route[0];
    const wp = BUILT_IN_PRICES[first.writer] ?? null;
    let usd = 0;
    let known = !!wp;
    const todo = plan.filter((p) => !p.has);
    for (const p of todo) {
      const inTok = 1500 + p.characters * 1.2;
      const outTok = Math.min(64_000, inTok / 6);
      if (wp) usd += (inTok * wp.inputPerMTok + outTok * wp.outputPerMTok) / 1e6;
      for (const c of new Set(first.finders)) {
        const cp = BUILT_IN_PRICES[c];
        if (!cp) known = false;
        else usd += (inTok * cp.inputPerMTok + 4000 * cp.outputPerMTok) / 1e6;
      }
    }
    for (const p of plan)
      console.log(
        `  ${p.series}: ${p.volumes} volumes with a summary, ${p.characters.toLocaleString('en')} characters${p.has ? ' (has a story so far)' : ''}`,
      );
    if (!todo.length) {
      console.log(
        plan.length
          ? 'Every series that can have a story so far has one.'
          : 'No series has two completed volumes with a summary.',
      );
      return 0;
    }
    const cost = known ? `about $${Math.max(usd, 0.01).toFixed(2)} at list price` : 'cost unknown';
    if (!apply) {
      console.log(
        `${todo.length} series would get a story so far (${cost}, before batch discounts; plus translating into the saved languages). Run again with --apply to make them.`,
      );
      return 0;
    }
    sdb
      .prepare('INSERT OR REPLACE INTO summary_state (key, value) VALUES (?, ?)')
      .run(RECAPS_REQUESTED, JSON.stringify(todo.map((p) => p.series)));
    console.log(
      `Asked the server to make the story so far of ${todo.length} series (${cost}). It starts within a minute; its log says when each is done.`,
    );
    return 0;
  } finally {
    sdb.close();
    state.db.close();
  }
}

/** `cli ai flex-test <model>`: whether OpenAI answers the model at the flex tier (a fraction of a cent). */
async function aiFlexTestCommand(model: string, env: NodeJS.ProcessEnv): Promise<number> {
  const dbDir = path.resolve(env.DB_DIR ?? '/db');
  const state = initDatabase(dbDir, path.resolve(env.DATA_DIR ?? '/data'));
  if (!state.ok) fail(`Database unavailable: ${state.error}`);
  try {
    const core = new AiCore({ db: state.db, dbDir });
    const r = await core.flexTest(model);
    if (r.refusedForCapacity) {
      console.log(
        `OpenAI refused the flex request for capacity (429, not charged) after ${r.ms} ms. Try again later.`,
      );
      return 0;
    }
    console.log(
      `${model}: answered in ${r.ms} ms at the tier "${r.tier ?? '(not reported)'}", $${r.costUsd.toFixed(6)} counted${r.tier === 'flex' ? ' (the batch price)' : ''}.`,
    );
    return r.tier === 'flex' ? 0 : 2;
  } finally {
    state.db.close();
  }
}

const USAGE = `Usage:
  cli token pair <label> [--user <name>]     Make a one-time code a device trades for its own token
  cli token create <label> [--user <name>]   Create a token (shown once)
  cli token worker <label> [--user <name>]   Create a GPU worker token (WP16; only the worker's routes)
  cli token cleanup <label>                  Create the library cleanup sidecar's token (WP20a; only
                                             /api/v1/cleanup-apply/*, kept in cleanup.db)
  cli token fetch <label>                    Create the cleanup fetch container's token (WP20d; only
                                             /api/v1/cleanup-fetch/*, kept in cleanup.db)
  cli token link <label>                     Create the audiobook linking sidecar's token (WP21e-1;
                                             only /api/v1/cleanup-link/*, kept in cleanup.db)
  cli token list                             List tokens
  cli token revoke <token-id>                Revoke a token
  cli library list                           List discovered Calibre libraries
  cli library set <id> [--name <name>] [--language <tag>] [--enable | --disable]
                    [--audio-dir <folder>] [--subtitle-dir <folder>]
                                             Name a library, set its language (ja, en, ...)
                                             and turn indexing on or off; set its audiobook and
                                             subtitle folders inside AUDIOBOOKS_DIR (none = unset)
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
  cli uploads list                           Uploaded books and files still waiting for a decision
  cli fonts list                             Custom fonts: name, size, source, deleted or not, file present
  cli audio status                           Audiobook and subtitle index per library
  cli audio scan [<library-id>]              Scan the audiobook and subtitle folders again (in the server)
  cli audio match <book-id> [--limit <n>]    The suggestions the picker would show for a book
  cli audio links                            The audiobooks linked to books, and whether they are still there
  cli ai flex-test <model>                   One tiny request with OpenAI's Flex processing: the tier
                                             OpenAI reports and its cost (counted as Settings' own)
  cli summaries import <file> [--apply]      Book summaries: the accuracy test's summaries, matched to
                                             the library's books (a dry run without --apply)
  cli summaries label [--apply]              Book summaries: relationships written before labels
                                             existed and the cost; --apply has the server label them
  cli summaries recaps [--series <name>] [--apply]
                                             Book summaries: the series that can have a story so far,
                                             and the cost; --apply has the server make the missing ones
  cli cleanup status                         The library cleanup's stages, batches and sidecar tokens
  cli cleanup revoke <token-id>              Revoke a cleanup sidecar token
  cli cleanup decide 3 <file>                Record the review's decisions on stage 3 pairs (marked as
                                             Claude's; your own decisions stay)
  cli cleanup resume 3                       Resume stage 3's failed analysis at the step that failed
                                             (keeps the books read and the pairs measured)
  cli cleanup audio-dryrun --stage 0|1|2 --out <folder>
                                             Audiobook cleanup dry run (WP21a): the real analysis on a
                                             scratch database in <folder>, never the live cleanup.db;
                                             stage 0 needs --abs-url and the API key on stdin
  cli cleanup audio-import-dryrun <file>...  The live audiobook stages take over the dry runs' results
                                             (stage 1's hashes, stage 2's file checks), kept only for
                                             files that are unchanged when the live run walks them`;

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
    case 'worker': {
      const label = rest.join(' ').trim();
      if (!label) fail('token worker needs a label, e.g. token worker "PC GPU worker"');
      const user = pickUser(db, userName);
      const { token, record } = createToken(db, user.id, label, Date.now(), 'worker');
      console.log(
        `Created GPU worker token "${record.label}" for user "${user.name}" (id ${record.id}).`,
      );
      console.log('It works only for the GPU worker (its jobs and their files), not as a device.');
      console.log("Copy it now into the worker's config.json; it cannot be shown again:");
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
            ...(t.scope === 'worker' ? ['scope=worker'] : []),
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
    ...(lib.audioDir ? [`audio="${lib.audioDir}"`] : []),
    ...(lib.srtArchivePath ? [`subtitles="${lib.srtArchivePath}"`] : []),
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
      const audioDir = takeOption(args, '--audio-dir');
      const subtitleDir = takeOption(args, '--subtitle-dir');
      if (enable && disable) fail('Use either --enable or --disable, not both');
      if (audioDir !== undefined) changes.audioDir = audioDir;
      if (subtitleDir !== undefined) changes.subtitleDir = subtitleDir;
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

/** Read-only: custom fonts (WP13), including deleted ones (their files stay). */
function fontsCommand(
  db: Database.Database,
  command: string,
  env: Record<string, string | undefined>,
) {
  if (command !== 'list') fail(USAGE);
  const store = new FontStore(path.resolve(env.DATA_DIR ?? '/data'));
  const fonts = FontService.listAll(db);
  if (!fonts.length) console.log('No custom fonts.');
  const exists = (relative: string) => {
    try {
      return existsSync(store.resolve(relative));
    } catch {
      // A stored path outside the font folder is never followed.
      return false;
    }
  };
  const faceRows = db.prepare(
    'SELECT weight, size, file_path FROM font_faces WHERE font_id = ? ORDER BY weight',
  );
  for (const f of fonts) {
    const faces = faceRows.all(f.id) as { weight: number; size: number; file_path: string }[];
    const present = exists(f.filePath) && faces.every((face) => exists(face.file_path));
    console.log(
      `${f.id}  ${formatDate(f.createdAt)}  ${f.size} bytes  ${f.format}  ${f.name}  (${f.fileName})` +
        (f.source === 'google' ? '  from Google Fonts' : '') +
        faces.map((face) => `  +${face.weight}: ${face.size} bytes`).join('') +
        (f.deleted ? '  (deleted)' : '') +
        (present ? '' : '  (file missing)'),
    );
  }
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function audioCommand(db: Database.Database, command: string, rest: string[], userName?: string) {
  const args = [...rest];
  switch (command) {
    case 'status': {
      const libs = listLibraries(db).filter((l) => l.audioDir || l.srtArchivePath);
      if (!libs.length) {
        console.log(
          'No library has an audio or subtitle folder (cli library set <id> --audio-dir ...).',
        );
      }
      for (const lib of libs) {
        const s = getScanState(db, lib.id);
        const folders = listAudioFolders(db, lib.id);
        const single = folders.filter((f) => f.fileCount === 1).length;
        const pending = folders.reduce(
          (n, f) =>
            n + f.files.filter((x) => x.durationSeconds === null && !x.durationFailed).length,
          0,
        );
        console.log(describeLibrary(lib));
        console.log(
          `    status=${s.status}  scanned=${formatDate(s.scannedAt)}  ` +
            `folders=${s.folders} (single-file ${single})  subtitles=${s.subtitles}  ` +
            `archives skipped=${s.archivesSkipped}  durations pending=${pending}` +
            (s.scanRequestedAt ? '  scan=requested' : ''),
        );
        if (s.lastError) console.log(`    error (${formatDate(s.lastErrorAt)}): ${s.lastError}`);
      }
      break;
    }
    case 'scan': {
      const targets = args[0]
        ? [requireLibrary(db, args[0])]
        : listLibraries(db).filter((l) => l.audioDir || l.srtArchivePath);
      if (!targets.length) fail('No library has an audio or subtitle folder');
      for (const lib of targets) {
        requestAudioScan(db, lib.id);
        console.log(`Scan requested for "${lib.name}"; the server runs it on its next poll.`);
      }
      break;
    }
    case 'match': {
      const limitRaw = takeOption(args, '--limit');
      const bookId = args[0];
      if (!bookId) fail('Give a book id');
      const book = db
        .prepare(
          `SELECT b.title, b.library_id, b.series_index, se.name AS series_name
           FROM books b LEFT JOIN series se ON se.id = b.series_id WHERE b.id = ?`,
        )
        .get(bookId) as
        | {
            title: string;
            library_id: string;
            series_index: number | null;
            series_name: string | null;
          }
        | undefined;
      if (!book) fail(`No book with id ${bookId}`);
      const limit = limitRaw ? Number(limitRaw) : 10;
      const forMatch = {
        title: book.title,
        seriesName: book.series_name,
        seriesIndex: book.series_name ? book.series_index : null,
      };
      const series = book.series_name ? `  (series ${book.series_name} #${book.series_index})` : '';
      console.log(`${book.title}${series}`);
      console.log('Audiobook folders:');
      for (const s of rankEntries(forMatch, listAudioFolders(db, book.library_id), limit)) {
        const f = s.entry;
        const files = `${f.fileCount} file${f.fileCount === 1 ? '' : 's'}`;
        console.log(
          `  ${s.score} ${s.tier.padEnd(12)} ${f.relPath}  (${files}, ${formatDuration(f.durationSeconds)})`,
        );
      }
      console.log('Subtitle files:');
      const subs = listSubtitleFiles(db, book.library_id).map((x) => ({ ...x, fileCount: 1 }));
      for (const s of rankEntries(forMatch, subs, limit)) {
        console.log(`  ${s.score} ${s.tier.padEnd(12)} ${s.entry.relPath}`);
      }
      break;
    }
    case 'links': {
      const user = pickUser(db, userName);
      const links = listLinks(db, user.id).map((l) => resolveLink(db, l));
      if (!links.length) console.log('No book has an audiobook linked yet.');
      const title = db.prepare('SELECT title FROM books WHERE id = ?');
      for (const l of links) {
        const name =
          (title.get(l.bookId) as { title: string } | undefined)?.title ?? '(unknown book)';
        if (l.state === 'none') {
          console.log(`${l.bookId}  ${name}\n    no audiobook`);
          continue;
        }
        const files = l.folder
          ? `${l.folder.fileCount} file${l.folder.fileCount === 1 ? '' : 's'}`
          : '';
        console.log(`${l.bookId}  ${name}`);
        console.log(`    audiobook ${l.status}  ${l.folderRelPath}${files ? `  (${files})` : ''}`);
        const sub =
          l.subtitleState === 'linked'
            ? `${l.subtitleStatus}  ${l.subtitleRelPath}`
            : (l.subtitleState ?? 'not chosen yet');
        console.log(`    subtitles ${sub}`);
        console.log(`    confirmed ${formatDate(l.confirmedAt)}  source=${l.source}`);
      }
      break;
    }
    default:
      fail(USAGE);
  }
}

function cleanupCommand(command: string, rest: string[], env: Record<string, string | undefined>) {
  const state = initCleanupDatabase(path.resolve(env.DB_DIR ?? '/db'));
  if (!state.ok) fail(`cleanup.db unavailable: ${state.error}`);
  const db = state.db;
  try {
    switch (command) {
      case 'token': {
        const label = rest.join(' ').trim();
        if (!label) fail('token cleanup needs a label, e.g. token cleanup "cleanup sidecar"');
        const { token, record } = createApplyToken(db, label);
        console.log(`Created library cleanup sidecar token "${record.label}" (id ${record.id}).`);
        console.log(
          'It works only for the apply sidecar (/api/v1/cleanup-apply/*), not as a device.',
        );
        console.log("Copy it now into the sidecar's CLEANUP_TOKEN; it cannot be shown again:");
        console.log(token);
        break;
      }
      case 'token-link': {
        const label = rest.join(' ').trim();
        if (!label) fail('token link needs a label, e.g. token link "link sidecar"');
        const { token, record } = createApplyToken(db, label, Date.now(), 'link');
        console.log(`Created audiobook linking sidecar token "${record.label}" (id ${record.id}).`);
        console.log(
          'It works only for the linking sidecar (/api/v1/cleanup-link/*), not as a device.',
        );
        console.log("Copy it now into the linking sidecar's LINK_TOKEN; it cannot be shown again:");
        console.log(token);
        break;
      }
      case 'token-fetch': {
        const label = rest.join(' ').trim();
        if (!label) fail('token fetch needs a label, e.g. token fetch "fetch container"');
        const { token, record } = createApplyToken(db, label, Date.now(), 'fetch');
        console.log(`Created library cleanup fetch token "${record.label}" (id ${record.id}).`);
        console.log(
          'It works only for the fetch container (/api/v1/cleanup-fetch/*), not as a device.',
        );
        console.log(
          "Copy it now into the fetch container's FETCH_TOKEN; it cannot be shown again:",
        );
        console.log(token);
        break;
      }
      case 'resume': {
        const [which] = rest;
        if (which !== '3')
          fail(
            'cleanup resume needs the stage: only stage 3 can resume a failed analysis (cleanup resume 3)',
          );
        const out = resumeFailedStage3(db);
        console.log(out.message);
        if (!out.ok) process.exitCode = 1;
        break;
      }
      case 'decide': {
        const [which, file] = rest;
        if (which !== '3' || !file)
          fail('cleanup decide needs the stage and a file: cleanup decide 3 <decisions.json>');
        let input: unknown;
        try {
          input = JSON.parse(readFileSync(file, 'utf8'));
        } catch (err) {
          fail(`Can't read ${file}: ${(err as Error).message}`);
        }
        const out = recordReviewDecisions(db, input);
        console.log(out.message);
        if (!out.ok) process.exitCode = 1;
        break;
      }
      case 'audio-import-dryrun': {
        if (rest.length === 0)
          fail('cleanup audio-import-dryrun needs the dry runs’ cleanup-dryrun.db files');
        for (const file of rest) {
          const out = importDryRun(db, file);
          console.log(
            `${file}: ${out.files} files, ${out.hashes} hashes and ${out.checks} file checks taken over.`,
          );
        }
        console.log(
          'Each is kept only if the file is unchanged when the live run walks the folders; changed files are read again.',
        );
        break;
      }
      case 'revoke': {
        const [id] = rest;
        if (!id) fail('cleanup revoke needs a token id (see cleanup status)');
        console.log(revokeApplyToken(db, id) ? `Revoked ${id}.` : `No active cleanup token ${id}.`);
        break;
      }
      case 'status': {
        for (const s of listStages(db)) {
          console.log(
            `stage ${s.stage} ${s.name}: mode=${s.mode} state=${s.state}` +
              (s.pauseReason ? ` paused (${s.pauseReason}): ${s.pauseDetail ?? ''}` : ''),
          );
        }
        const batches = db
          .prepare(
            'SELECT id, kind, state, item_count, created_at FROM batches ORDER BY created_at DESC LIMIT 10',
          )
          .all() as {
          id: string;
          kind: string;
          state: string;
          item_count: number;
          created_at: number;
        }[];
        console.log(batches.length ? 'Latest batches:' : 'No batches.');
        for (const b of batches) {
          console.log(
            `  ${b.id} ${b.kind} ${b.state} ${b.item_count} items ${formatDate(b.created_at)}`,
          );
        }
        const tokens = listApplyTokens(db);
        console.log(tokens.length ? 'Sidecar and fetch tokens:' : 'No sidecar or fetch tokens.');
        for (const t of tokens) {
          console.log(
            `  ${t.id} ${t.scope} label="${t.label}" created=${formatDate(t.createdAt)} last-used=${formatDate(t.lastUsedAt)}` +
              (t.revokedAt ? ` revoked=${formatDate(t.revokedAt)}` : ''),
          );
        }
        break;
      }
      default:
        fail(USAGE);
    }
  } finally {
    db.close();
  }
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
  const groups = [
    'token',
    'library',
    'index',
    'thumbs',
    'counts',
    'sync',
    'migration',
    'uploads',
    'fonts',
    'audio',
    'cleanup',
    'summaries',
    'ai',
  ];
  if (!groups.includes(group) || !command) {
    fail(USAGE);
  }
  // Book summaries session 3: one tiny request with OpenAI's Flex processing (with the stored key).
  if (group === 'ai') {
    if (command !== 'flex-test' || !rest[0]) fail(USAGE);
    void aiFlexTestCommand(rest[0], env).then(
      (code) => process.exit(code),
      (err) => {
        console.error(`Flex test failed: ${(err as Error).message ?? err}`);
        process.exit(1);
      },
    );
    return;
  }
  // Book summaries session 3: the one-time import of the accuracy test's summaries.
  if (group === 'summaries') {
    if (command === 'label') process.exit(summariesLabelCommand(rest, env));
    if (command === 'recaps') process.exit(summariesRecapsCommand(rest, env));
    if (command !== 'import' || !rest[0]) fail(USAGE);
    void summariesImportCommand(rest, env).then(
      (code) => process.exit(code),
      (err) => {
        console.error(`Import failed: ${(err as Error).message ?? err}`);
        process.exit(1);
      },
    );
    return;
  }
  // The audiobook dry run never opens the live cleanup.db (WP21a).
  if (group === 'cleanup' && command === 'audio-dryrun') {
    void runAudioDryRun(rest, env).then(
      (code) => process.exit(code),
      (err) => {
        console.error(`Dry run failed: ${(err as Error).message ?? err}`);
        process.exit(1);
      },
    );
    return;
  }
  // The cleanup sidecar's tokens and the cleanup's state live in cleanup.db (WP20a).
  if (
    group === 'cleanup' ||
    (group === 'token' && (command === 'cleanup' || command === 'fetch' || command === 'link'))
  ) {
    cleanupCommand(
      group === 'token'
        ? command === 'fetch'
          ? 'token-fetch'
          : command === 'link'
            ? 'token-link'
            : 'token'
        : command,
      rest,
      env,
    );
    return;
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
    else if (group === 'fonts') fontsCommand(db, command, env);
    else if (group === 'audio') audioCommand(db, command, rest, userName);
    else thumbsCommand(db, command, rest);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env);
}
