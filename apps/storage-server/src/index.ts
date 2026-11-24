import type { CatalogOptions } from './api/catalog-routes';
import { AiCore } from './ai/core';
import { startSummaryTest } from './summaries/test-start';
import { startSummaries } from './summaries/start';
import { createApp } from './app';
import { CalibreIndexer, snapshotFile } from './calibre/indexer';
import { getLibrary } from './calibre/libraries';
import path from 'path';
import { SearchRunner } from './catalog/search-runner';
import { CharCountService } from './counts/count-service';
import { ThumbnailService } from './thumbnails/thumbnails';
import { FatalConfigError, formatTime, loadConfig, LoadedConfig } from './config';
import { initDatabase } from './db/database';
import { scheduleSnapshots, snapshotDir, SnapshotScheduler } from './snapshot';
import { UploadService } from './uploads/service';
import { UploadStore } from './uploads/upload-store';
import { SERVER_BUILT_AT, SERVER_VERSION } from './version';
import { captureConsole, serverLogs } from './logs/recent-logs';
import { AudioWriter } from './audio/audio-write';
import { ClipService } from './audio/clip-service';
import { MergeService } from './audio/merge-service';
import { MergeWorkdir } from './audio/merge-workdir';
import { AudioScanService } from './audio/scan-service';
import { SubtitleJobService } from './audio/subtitle-jobs';
import { TtsJobService } from './audio/tts-jobs';
import { TtsModelService } from './audio/tts-models';
import { SentenceAudioService } from './audio/sentence-audio';
import { SpeakerBookService } from './audio/speakers/speaker-book';
import { SpeakerJobService } from './audio/speakers/speaker-jobs';
import { SpeakerModelService } from './audio/speakers/speaker-models';
import { SpeakerStore } from './audio/speakers/speaker-store';
import { SpeakerVoices } from './audio/speakers/speaker-voices';
import { ReadAloudService } from './audio/read-aloud';
import { getBookFor } from './catalog/queries';
import { VoiceChoiceService } from './audio/tts-voice-choice';
import { FixRunner } from './pronunciation/fix-runner';
import { FixService } from './pronunciation/fix-service';
import { countImportOptions } from './counts/counter-bundle';
import { IllustrationService } from './catalog/illustrations';
import { VoiceService } from './voices/voice-service';
import { VoiceStore } from './voices/voice-store';
import { initCleanupDatabase } from './cleanup/cleanup-db';
import { CleanupService } from './cleanup/cleanup-service';
import { AudioCleanupService } from './cleanup/audio/audio-cleanup-service';
import { switchReader } from './cleanup/audio/switch-reader';
import {
  audioLabelsReader,
  ebookLabelsReader,
  readerAudioState,
  readerWrittenFiles,
} from './cleanup/audio-stage3-inputs';
import type { CleanupOptions } from './cleanup/routes';
import { onStagePaused } from './cleanup/stages';
import { onAudioStagePaused } from './cleanup/audio/audio-stages';
import { parseNotificationsConfig } from './notifications/config';
import { NotificationService } from './notifications/service';
import { NotificationWatcher } from './notifications/watcher';
import { NativelyLevels } from './natively/levels';

// Every console line is also kept (secrets removed) for the bug report (WP18).
captureConsole(serverLogs);

let loaded: LoadedConfig;
try {
  loaded = loadConfig(process.env);
} catch (err) {
  if (err instanceof FatalConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { config, warnings } = loaded;
serverLogs.configure({
  maxLines: config.logs.bufferLines,
  secrets: config.authToken ? [config.authToken] : [],
});
for (const warning of warnings) console.warn(`Warning: ${warning}`);

// If the database can't be opened, the server still starts and /api/v1 reports the
// reason (health answers 503).
const database = initDatabase(config.dbDir, config.dataRoot);
if (!database.ok) console.error(`Error: database unavailable: ${database.error}`);

// The shared AI layer (book summaries session 1): the provider keys and settings, the model
// checks, the batch tests and the one monthly spending limit, in ttsu.db. Works without
// cleanup.db.
const aiCore = database.ok ? new AiCore({ db: database.db, dbDir: config.dbDir }) : null;
aiCore?.start();

// The Calibre library cleanup (WP20a): its own database beside ttsu.db. Optional: when it
// can't open, only the cleanup routes are off. Opening it the first time after the shared AI
// layer moves its AI keys, settings and spending to ttsu.db first (cleanup/ai-move.ts).
const cleanupDb = database.ok ? initCleanupDatabase(config.dbDir, { mainDb: database.db }) : null;
if (cleanupDb && !cleanupDb.ok) console.error(`Error: library cleanup is off: ${cleanupDb.error}`);
const cleanupOptions: CleanupOptions = { service: null, error: 'the database is unavailable' };

// Notifications (N1): Discord and Gmail. Optional: when it can't start, everything else runs.
let notifications: NotificationService | null = null;
if (database.ok) {
  try {
    const notifyWarnings: string[] = [];
    notifications = new NotificationService({
      db: database.db,
      dbDir: config.dbDir,
      config: parseNotificationsConfig(process.env, notifyWarnings),
    });
    for (const warning of notifyWarnings) console.warn(`Warning: ${warning}`);
  } catch (err) {
    console.error('Error: notifications are off:', err);
  }
}

let snapshots: SnapshotScheduler | null = null;
let cleanupSnapshots: SnapshotScheduler | null = null;
if (database.ok) {
  try {
    snapshots = scheduleSnapshots({
      db: database.db,
      dir: snapshotDir(config.dbDir),
      time: config.snapshotTime,
      keep: config.snapshotKeep,
      onResult: (ok, error) => notifications?.snapshotResult('ttsu', ok, error),
    });
  } catch (err) {
    console.error('Error: could not schedule database snapshots:', err);
  }
  if (cleanupDb?.ok) {
    try {
      cleanupSnapshots = scheduleSnapshots({
        db: cleanupDb.db,
        dir: snapshotDir(config.dbDir),
        time: config.snapshotTime,
        keep: config.snapshotKeep,
        prefix: 'cleanup',
        onResult: (ok, error) => notifications?.snapshotResult('cleanup', ok, error),
      });
    } catch (err) {
      console.error('Error: could not schedule cleanup.db snapshots:', err);
    }
  }
}

// Calibre indexer and thumbnails (WP2). Optional: when CALIBRE_DIR is unset or
// unusable, the catalog routes report it and everything else works.
let indexer: CalibreIndexer | null = null;
let thumbnails: ThumbnailService | null = null;
let counts: CharCountService | null = null;
const catalog: CatalogOptions = {
  thumbnails: null,
  counts: null,
  indexer: { enabled: false, error: 'CALIBRE_DIR is not set' },
};
let cleanup: CleanupService | null = null;
if (database.ok && cleanupDb?.ok) {
  try {
    cleanup = new CleanupService({
      cleanup: cleanupDb.db,
      main: database.db,
      calibreDir: config.calibre.dir,
      cacheDir: config.calibre.cacheDir,
      indexerEnabled: () => catalog.indexer.enabled,
      dbDir: config.dbDir,
      countImport: countImportOptions(config.counts),
      aiCore: aiCore ?? undefined,
      // WP20g: the Calibre import's source folders (read only); null = the import is off.
      bookSourcesDir: config.cleanupBookSources ?? null,
    });
    cleanupOptions.service = cleanup;
    // The audiobook cleanup (WP21a): analysis only, shares the disk lock and the settings.
    cleanupOptions.audio = new AudioCleanupService({
      db: cleanupDb.db,
      secrets: cleanup.secrets,
      lock: cleanup.diskLock,
      roots: config.cleanupAudio
        ? {
            torrents: config.cleanupAudio.torrentsDir,
            library: config.cleanupAudio.libraryDir,
            media: config.cleanupAudio.mediaDir,
          }
        : null,
      tools: {
        ffprobePath: config.audio.merge.ffprobePath,
        ffmpegPath: config.audio.merge.ffmpegPath,
        fpcalcPath: (process.env.FPCALC_PATH ?? '').trim() || 'fpcalc',
        faadPath: (process.env.FAAD_PATH ?? '').trim() || 'faad',
      },
      readLabels: audioLabelsReader(cleanupDb.db, config.dbDir),
      // Stage 8 (WP21g): the Calibre cleanup's target library, read only (the indexer's snapshot
      // copy; its folder under CALIBRE_DIR for the covers).
      calibre:
        config.calibre.dir && config.calibre.cacheDir
          ? () => {
              const id = cleanup?.targetLibrary() ?? null;
              const lib = id ? getLibrary(database.db, id) : null;
              if (!id || !lib) return null;
              return {
                libraryId: id,
                snapshotFile: snapshotFile(config.calibre.cacheDir!, id),
                libraryDir: path.join(config.calibre.dir!, lib.folder),
              };
            }
          : undefined,
      readEbookLabels: ebookLabelsReader(cleanupDb.db, config.dbDir),
      // One AI runner for every cleanup stage that asks the models (WP20e).
      aiRunner: cleanup.aiRunner,
      readerWrittenFiles: config.cleanupAudio
        ? readerWrittenFiles(database.db, config.cleanupAudio.libraryDir)
        : undefined,
      // Stage 6 (WP21e-1): the reader's audio links and folders before and after the build.
      readerState: readerAudioState(database.db),
      // Stage 4 (WP21c) asks through the Calibre cleanup's fetch queue and container.
      fetchQueue: cleanup.fetchQueue,
      fetcherStatus: () => cleanup?.fetcher() ?? null,
    });
    const audioCleanup = cleanupOptions.audio;
    cleanup.onAnswerArrived(() => audioCleanup.answerArrived());
  } catch (err) {
    console.error('Error: library cleanup is off:', err);
    cleanupOptions.error = (err as Error).message;
  }
} else if (cleanupDb && !cleanupDb.ok) {
  cleanupOptions.error = cleanupDb.error;
}
// Uploads (WP7b): files in DATA_DIR/.uploads, books in an indexed library.
let uploadStore: UploadStore | null = null;
if (database.ok && config.calibre.dir) {
  const store = new UploadStore(config.dataRoot);
  try {
    store.init();
    uploadStore = store;
  } catch (err) {
    console.error('Error: uploads are off, the upload folder is unusable:', err);
  }
}

// The Natively level (2026-11-24): the server reads linked books' levels from Natively.
// NATIVELY_LEVELS=0 turns it off; NATIVELY_BASE_URL points it at a stand-in (e2e).
const natively =
  database.ok && process.env.NATIVELY_LEVELS !== '0'
    ? new NativelyLevels({
        db: database.db,
        baseUrl: process.env.NATIVELY_BASE_URL || undefined,
      })
    : null;

if (database.ok && config.calibre.dir) {
  try {
    thumbnails = new ThumbnailService({
      db: database.db,
      calibreDir: config.calibre.dir,
      cacheDir: config.calibre.cacheDir,
      concurrency: config.calibre.thumbConcurrency,
      perSecond: config.calibre.thumbPerSecond,
      background: config.calibre.thumbBackground,
      uploads: uploadStore,
    });
    // Character counts (WP3b) are optional too: without the counter the library
    // just shows counts as pending.
    try {
      counts = new CharCountService({
        db: database.db,
        calibreDir: config.calibre.dir,
        config: config.counts,
        uploads: uploadStore,
      });
      console.log(
        `Character counts: ${config.counts.background ? 'on' : 'off (COUNT_BACKGROUND=false)'}, ` +
          `spec ${counts.spec}, counter build ${counts.counter.build}`,
      );
    } catch (err) {
      console.error('Error: character counts are off, the counter is unavailable:', err);
    }
    indexer = new CalibreIndexer({
      db: database.db,
      config: config.calibre,
      dbDir: config.dbDir,
      dataRoot: config.dataRoot,
      thumbnails,
      counts,
      natively,
      holdIngest: (libraryId) => cleanup?.holdsIngest(libraryId) ?? false,
      wantsIngest: (libraryId) => cleanup?.wantsIngest(libraryId) ?? false,
      // Calibre metadata editing: what the index saw change, sorted out (whose change it was).
      onFieldChanges: () => cleanup?.sortChanges(),
    });
    catalog.indexer = indexer.status;
    catalog.thumbnails = thumbnails;
    catalog.counts = counts;
    catalog.calibreDir = config.calibre.dir;
    // The book page's illustrations (Season 2 §6): read on request, cached in CACHE_DIR.
    catalog.illustrations = new IllustrationService({
      db: database.db,
      cacheDir: config.calibre.cacheDir,
      calibreDir: () => (catalog.indexer.enabled ? (catalog.calibreDir ?? null) : null),
      uploads: uploadStore,
      importOptions: countImportOptions(config.counts),
      timeoutMs: config.calibre.illustrationsTimeoutSeconds * 1000,
    });
    if (uploadStore) {
      const uploads = new UploadService({
        db: database.db,
        store: uploadStore,
        config: config.uploads,
        calibreDir: config.calibre.dir,
        onAdded: () => {
          thumbnails?.wake();
          counts?.wake();
        },
      });
      uploads.start();
      catalog.uploads = uploads;
      console.log(`Uploads: on, up to ${config.uploads.maxMb} MB, in ${uploadStore.root}`);
    }
    indexer
      .start()
      .catch((err) => console.error('Error: the Calibre indexer could not start:', err));
  } catch (err) {
    console.error('Error: the Calibre indexer could not start:', err);
  }
} else if (!config.calibre.dir) {
  console.log('Calibre indexer is off: CALIBRE_DIR is not set');
}

// Searches with a /regex/ run in a worker thread that can be stopped (WP7a).
const search = database.ok
  ? new SearchRunner({
      db: database.db,
      file: database.file,
      timeoutSeconds: config.search.regexTimeoutSeconds,
      logError: (m, err) => console.error(`Error: ${m}:`, err),
    })
  : null;
catalog.search = search;

// Audiobook index and streaming (WP15): optional. WP15f: merged files are the only thing
// ever written into the audiobooks folder, through src/audio/audio-write.ts.
let audio: AudioScanService | null = null;
let merges: MergeService | null = null;
let clips: ClipService | null = null;
let jobs: SubtitleJobService | null = null;
let tts: TtsJobService | null = null;
let ttsModels: TtsModelService | null = null;
let voices: VoiceService | null = null;
let fixes: FixService | null = null;
let sentenceAudio: SentenceAudioService | null = null;
let voiceChoices: VoiceChoiceService | null = null;
let readAloud: ReadAloudService | null = null;
let speakerJobs: SpeakerJobService | null = null;
let speakerBook: SpeakerBookService | null = null;
let speakerModels: SpeakerModelService | null = null;
let speakerStore: SpeakerStore | null = null;
let speakerVoices: SpeakerVoices | null = null;
if (database.ok && config.audio.dir) {
  audio = new AudioScanService({
    db: database.db,
    config: config.audio,
    otherDirs: [
      { name: 'DATA_DIR', dir: config.dataRoot },
      { name: 'DB_DIR', dir: config.dbDir },
      { name: 'CACHE_DIR', dir: config.calibre.cacheDir },
      { name: 'CALIBRE_DIR', dir: config.calibre.dir },
    ],
  });
  const scan = audio;
  let workdir: MergeWorkdir | null = null;
  if (config.calibre.cacheDir) {
    try {
      workdir = new MergeWorkdir(config.calibre.cacheDir, config.audio.dir);
    } catch (err) {
      console.error(`Error: merging is off: ${(err as Error).message}`);
    }
  }
  // The one writer for the audiobooks folder: merged files (WP15f) and generated
  // subtitles (WP16).
  const writer = new AudioWriter({
    db: database.db,
    root: config.audio.dir,
    owner: {
      uid: config.audio.merge.fileUid,
      gid: config.audio.merge.fileGid,
      mode: config.audio.merge.fileMode,
    },
  });
  merges = new MergeService({
    db: database.db,
    scan,
    writer,
    workdir,
    config: config.audio.merge,
  });
  // WP16: the GPU worker's queue. Jobs wait in the database; the worker on the PC asks.
  jobs = new SubtitleJobService({ db: database.db, scan, writer, config: config.audio.worker });
  // WP17: generated audiobooks on the same queue; voice presets in DATA_DIR/.uploads/voices.
  ttsModels = new TtsModelService(database.db);
  try {
    voices = new VoiceService({
      db: database.db,
      store: new VoiceStore(config.dataRoot),
      config: config.audio.tts,
      ffmpegPath: config.audio.merge.ffmpegPath,
      ffprobePath: config.audio.merge.ffprobePath,
    });
  } catch (err) {
    console.error('Error: voice presets are off:', err);
  }
  // Season 2 Phase 12: pronunciation fixes, applied in a worker thread with a time limit.
  fixes = new FixService(
    database.db,
    new FixRunner({
      timeoutSeconds: config.audio.tts.fixTimeoutSeconds,
      logError: (m, err) => console.error(`Error: ${m}:`, err),
    }),
  );
  if (config.calibre.cacheDir) {
    try {
      tts = new TtsJobService({
        db: database.db,
        jobs,
        scan,
        writer,
        models: ttsModels,
        voices,
        fixes,
        config: config.audio.tts,
        tools: config.audio.merge,
        cacheDir: config.calibre.cacheDir,
        calibreDir: config.calibre.dir,
        uploads: uploadStore,
        importOptions: countImportOptions(config.counts),
      });
    } catch (err) {
      console.error(`Error: generated audiobooks are off: ${(err as Error).message}`);
    }
  }
  // Season 2 Phase 12: Enrich's sentence audio read by the PC, and the PC voice choices.
  voiceChoices = new VoiceChoiceService(database.db, voices, ttsModels);
  if (tts) {
    sentenceAudio = new SentenceAudioService({
      db: database.db,
      jobs,
      tts,
      choices: voiceChoices,
      bitrate: config.audio.clip.bitrate,
    });
    // Season 2 Phase 12 session 5: per-character voices (a speaker model on the PC; each
    // character's voice in audiobooks, previews, read-aloud and Enrich clips).
    speakerStore = new SpeakerStore(database.db);
    speakerModels = new SpeakerModelService(database.db);
    speakerVoices = new SpeakerVoices(speakerStore, voices);
    tts.speakers = speakerVoices;
    speakerJobs = new SpeakerJobService({
      db: database.db,
      jobs,
      tts,
      store: speakerStore,
      models: speakerModels,
    });
    speakerJobs.sweep();
    speakerBook = new SpeakerBookService({
      store: speakerStore,
      jobs,
      speakerJobs,
      tts,
      models: speakerModels,
      voices,
      speakerVoices,
    });
    // Season 2 Phase 12 session 3: live read-aloud with the PC voice.
    if (voices && config.calibre.cacheDir) {
      try {
        readAloud = new ReadAloudService({
          db: database.db,
          jobs,
          tts,
          choices: voiceChoices,
          voices,
          config: config.audio.tts,
          bitrate: config.audio.clip.bitrate,
          cacheDir: config.calibre.cacheDir,
          audiobooksRoot: config.audio.dir,
          bookExists: (userId, bookId) => !!getBookFor(database.db, { id: userId }, bookId),
        });
      } catch (err) {
        console.error(`Error: read-aloud is off: ${(err as Error).message}`);
      }
    }
  }
  const readAloudService = readAloud;
  const ttsService = tts;
  const voiceService = voices;
  void voiceService
    ?.start()
    .catch((err) => console.error('Error: voice presets could not start:', err));
  const mergeService = merges;
  // WP14: sentence audio for Anki (read-only cuts to stdout).
  clips = new ClipService({
    config: config.audio.clip,
    hideRoots: () => [scan.root],
    logError: (m, err) => console.error(`Error: ${m}`, err ?? ''),
  });
  // WP21e-2: the audiobook cleanup's switch reaches the reader only through this (the hold is
  // in ttsu.db, so a restart in the middle of the switch keeps scans and merges waiting).
  cleanupOptions.audio?.attachReader(
    switchReader({
      db: database.db,
      scan,
      resumeMerges: () => mergeService.resume(),
      dbDir: config.dbDir,
    }),
  );
  scan
    .start()
    .then(async () => {
      if (scan.status.enabled) await mergeService.start();
      if (scan.status.enabled) await ttsService?.start();
      if (scan.status.enabled) await readAloudService?.start();
    })
    .catch((err) => console.error('Error: the audiobook scanner could not start:', err));
} else if (!config.audio.dir) {
  console.log('Audiobooks are off: AUDIOBOOKS_DIR is not set');
}

if (notifications && database.ok) {
  notifications.attachWatcher(
    new NotificationWatcher(notifications, {
      db: database.db,
      cleanupDb: cleanupDb?.ok ? cleanupDb.db : null,
      cleanup,
      jobs,
      workerOfflineSeconds: jobs ? config.audio.worker.offlineSeconds : undefined,
    }),
  );
  // A paused stage is looked at at once, not on the next round.
  const notifier = notifications;
  onStagePaused(() => notifier.poke());
  onAudioStagePaused(() => notifier.poke());
}

// Book summaries session 2: the accuracy test, only on the PC's test copy (SUMMARIES_TEST=1).
const summariesTest =
  process.env.SUMMARIES_TEST === '1' && database.ok && aiCore && tts
    ? startSummaryTest({ db: database.db, dbDir: config.dbDir, core: aiCore, tts })
    : null;

// Book summaries (session 3): on wherever the AI layer is.
const summaries =
  database.ok && aiCore
    ? startSummaries({
        db: database.db,
        dbDir: config.dbDir,
        core: aiCore,
        calibreDir: config.calibre.dir,
        uploads: uploadStore,
        importOptions: countImportOptions(config.counts),
        maxSentence: config.audio.tts.maxSentence,
        scriptTimeoutSeconds: config.audio.tts.scriptTimeoutSeconds,
        notifications,
      })
    : null;
let summariesSnapshots: SnapshotScheduler | null = null;
if (summaries) {
  try {
    summariesSnapshots = scheduleSnapshots({
      db: summaries.store.db,
      dir: snapshotDir(config.dbDir),
      time: config.snapshotTime,
      keep: config.snapshotKeep,
      prefix: 'summaries',
      onResult: (ok, error) => notifications?.snapshotResult('summaries', ok, error),
    });
  } catch (err) {
    console.error('Error: could not schedule summaries.db snapshots:', err);
  }
}

const app = createApp({
  config,
  database,
  version: SERVER_VERSION,
  builtAt: SERVER_BUILT_AT,
  catalog,
  audio: {
    service: audio,
    merges,
    clips,
    jobs,
    tts,
    models: tts ? ttsModels : null,
    voices,
    fixes: tts ? fixes : null,
    sentenceAudio,
    voiceChoices: tts ? voiceChoices : null,
    readAloud,
    speakerJobs,
    speakerBook,
    speakerModels,
    speakerStore,
    speakerVoices,
    copyHint: {
      minMinutes: config.audio.copyHintMinMinutes,
      percent: config.audio.copyHintPercent,
    },
  },
  cleanup: cleanupOptions,
  notifications,
  ai: aiCore,
  summariesTest,
  summaries,
  natively,
});
cleanup?.start();
natively?.start();
cleanupOptions.audio?.start();
notifications?.start();

app.listen(config.port, () => {
  console.log(`ttsu storage server running on port ${config.port}`);
  console.log(`Data root: ${config.dataRoot}`);
  console.log(
    `CORS origin: ${config.corsOrigins === '*' ? '*' : config.corsOrigins.join(', ') || '(none)'}`,
  );
  if (database.ok) {
    console.log(`Database: ${database.file} (schema v${database.schemaVersion})`);
    console.log(
      `Snapshots: daily at ${formatTime(config.snapshotTime)} (TZ=${process.env.TZ ?? 'unset'}), keeping ${config.snapshotKeep}`,
    );
  }
});

// Docker stops containers with SIGTERM; node as PID 1 ignores it by default.
// Close the database cleanly (checkpoints the WAL) and exit.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  snapshots?.stop();
  cleanupSnapshots?.stop();
  summariesSnapshots?.stop();
  void summaries?.stop();
  void natively?.stop();
  aiCore?.stop();
  void notifications?.stop();
  void cleanup?.stop();
  void cleanupOptions.audio?.stop();
  void indexer?.stop();
  void thumbnails?.stop();
  void counts?.stop();
  void merges?.stop();
  void tts?.stop();
  void readAloud?.stop();
  void audio?.stop();
  void search?.close();
  void fixes?.close();
  if (database.ok) {
    try {
      database.db.close();
    } catch (err) {
      console.error('Error closing the database:', err);
    }
  }
  if (cleanupDb?.ok) {
    try {
      cleanupDb.db.close();
    } catch (err) {
      console.error('Error closing cleanup.db:', err);
    }
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
