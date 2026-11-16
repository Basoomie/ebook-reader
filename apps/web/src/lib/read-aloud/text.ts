/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { ReadAloudPc } from '$lib/audio/tts-types';

/** Season 2 Phase 12 session 3: what read-aloud's status line says (pure, tested). */

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const clock = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Why read-aloud waits for audio from the PC, as one line. */
export function waitingText(pc: ReadAloudPc | null, now: number = Date.now()): string {
  if (!pc) return 'Asking the library server…';
  if (!pc.lastSeenAt) {
    return "The program on the PC hasn't checked in yet. Read-aloud works while the PC is on.";
  }
  if (!pc.online) {
    return `The PC is off (last seen ${time(pc.lastSeenAt)}). Read-aloud goes on when the PC is back.`;
  }
  if (pc.paused) return 'The PC is paused (Settings > Audiobooks).';
  if (!pc.supportsLive) {
    return `The program on the PC needs an update to read aloud (it has ${pc.version ?? 'an older version'}; 1.2.0 or newer).`;
  }
  if (pc.problem) return `The PC can't read now: ${pc.problem}`;
  if (pc.busy && !pc.busy.yielding && pc.busy.kind === 'sync_subtitles') {
    return `The PC is making subtitles${pc.busy.bookTitle ? ` for ${pc.busy.bookTitle}` : ''}; read-aloud starts when that is done.`;
  }
  if (pc.busy?.yielding) {
    return `The PC is stopping the audiobook${pc.busy.bookTitle ? ` for ${pc.busy.bookTitle}` : ''}; it goes on after read-aloud.`;
  }
  if (pc.engine?.state === 'loading') {
    return `The PC is loading the voice (about 2 minutes) · ${clock((now - pc.engine.since) / 1000)}`;
  }
  if (!pc.answering) {
    return pc.lastAskedAt
      ? `Waiting for the PC (last answered ${time(pc.lastAskedAt)})…`
      : 'Waiting for the PC…';
  }
  return 'The PC is reading…';
}

/** Why a session ended, for the status line (null: nothing to say). */
export function endedText(why: string | null | undefined): string | null {
  if (why === 'takeover') return 'Read-aloud moved to another device.';
  if (why === 'idle') return 'Read-aloud stopped: this device stopped answering for a while.';
  if (why === 'server') return 'Read-aloud stopped: the library server restarted.';
  return null;
}

/** "1.0×", "1.5×" */
export function speedLabel(speed: number): string {
  return `${speed.toFixed(1)}×`;
}
