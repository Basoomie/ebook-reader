/**
 * The reader's side of the switch (WP21e-2): what the audiobook cleanup's switch may do in the
 * reader, and nothing else: the audiobook hold (src/audio/audio-hold.ts), the scanner's one
 * scan while it is held, merges resumed afterwards, what keeps the switch from starting, and a
 * verified copy of ttsu.db before the links are rewritten.
 */
import type Database from 'better-sqlite3';
import path from 'path';
import { clearHold, isHeld, setHold } from '../../audio/audio-hold';
import type { AudioScanService } from '../../audio/scan-service';
import { snapshotDir, writeVerifiedCopy } from '../../snapshot';
import type { SwitchReader } from './stage6-switch';

const HOLD_REASON = {
  switch: 'The audiobook cleanup is moving the audiobooks to their new folders',
  merge_wait: 'The audiobook cleanup has not switched to the new folders yet',
} as const;

/**
 * What keeps the switch from starting: a merge or a PC job (subtitles queued with an
 * audiobook's path; any job running) or a write that hasn't finished.
 */
export function readerBusy(db: Database.Database): string[] {
  const out: string[] = [];
  // Merged files the reader wrote into the library itself (before WP21e-2): the switch would
  // leave them in japanese-old. Read from ttsu.db, independent of stage 6's move list.
  const merged = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM audio_writes WHERE state = 'done' AND purpose = 'merge'
         AND final_rel_path LIKE 'japanese/%'`,
      )
      .get() as { n: number }
  ).n;
  if (merged)
    out.push(
      `${merged} merged file(s) the reader saved in the library itself: they would stay in japanese-old (decide first)`,
    );
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const merges = n(
    `SELECT COUNT(*) AS n FROM audio_merge_jobs WHERE state IN ('queued', 'running', 'saving')`,
  );
  if (merges) out.push(`${merges} merge(s) waiting or running: let them finish or cancel them`);
  const running = n(`SELECT COUNT(*) AS n FROM worker_jobs WHERE state = 'running'`);
  if (running) out.push(`${running} job(s) running on the PC: let them finish or pause the PC`);
  const subtitles = n(
    `SELECT COUNT(*) AS n FROM worker_jobs WHERE state = 'queued' AND kind = 'sync_subtitles'`,
  );
  if (subtitles)
    out.push(
      `${subtitles} subtitle job(s) waiting (they keep an audiobook's path): cancel them first`,
    );
  const writes = n(
    `SELECT COUNT(*) AS n FROM audio_writes WHERE state IN ('reserving', 'writing', 'published')`,
  );
  if (writes) out.push(`${writes} file write(s) in the audiobooks folder not finished`);
  return out;
}

function stamp(d: Date): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}Z`;
}

export function switchReader(opts: {
  db: Database.Database;
  scan: AudioScanService;
  resumeMerges: () => void;
  dbDir: string;
}): SwitchReader {
  const { db, scan } = opts;
  return {
    db,
    setHold: (kind, on) => {
      if (on) setHold(db, kind, HOLD_REASON[kind]);
      else clearHold(db, kind);
    },
    held: (kind) => isHeld(db, kind),
    audioFolders: () =>
      (
        db.prepare(`SELECT audio_dir FROM libraries WHERE audio_dir IS NOT NULL`).all() as {
          audio_dir: string;
        }[]
      ).map((r) => r.audio_dir.replace(/\/+$/, '')),
    scanIdle: () => scan.idle(),
    scanForSwitch: () => scan.scanForSwitch(),
    scanned: () => scan.scanned.folders,
    wakeScan: () => scan.wake(),
    resumeMerges: opts.resumeMerges,
    busy: () => readerBusy(db),
    snapshot: async (label) => {
      const name = `pre-wp21e2-${label}-${stamp(new Date())}.db`;
      await writeVerifiedCopy(db, path.join(snapshotDir(opts.dbDir), name));
      return name;
    },
  };
}
