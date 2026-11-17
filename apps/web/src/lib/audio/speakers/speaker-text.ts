/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Season 2 Phase 12 session 5: what the book page and the review page say about who speaks,
 * in everyday words (no "attribution", "model run" or "voice map" on screen).
 */
import { timeAgo } from '$lib/audio/audio-link';
import type { GpuWorkerStatus, SubtitleJob } from '$lib/audio/audio-types';
import { ttsWaitText } from '$lib/audio/tts-text';
import type { SpeakerCharacter, SpeakerOverview } from './speaker-types';

/** The PC program that finds who speaks. */
export const SPEAKERS_WORKER_VERSION = '1.4.0';

export function speakerJobActive(job: SubtitleJob | null | undefined): boolean {
  return !!job && (job.state === 'queued' || job.state === 'running');
}

/** One line on the job finding who speaks. */
export function speakerJobText(
  job: SubtitleJob,
  worker: GpuWorkerStatus | null,
  now: number
): string {
  switch (job.state) {
    case 'queued': {
      // The server's own explanation (a sentence: "Paused for read-aloud; …").
      const why = job.message && /\.$/.test(job.message) ? `${job.message} ` : '';
      return `${why}${ttsWaitText(job, worker, now)}`;
    }
    case 'running': {
      if (job.cancelRequested) return 'Stopping…';
      const line = job.message ?? 'The PC is getting ready';
      const p =
        job.progress === null
          ? ''
          : ` · ${Math.floor(Math.max(0, Math.min(1, job.progress)) * 100)} %`;
      const since = job.startedAt ? ` Started ${timeAgo(job.startedAt, now)}.` : '';
      return `${line}${String(job.stage) === 'generating' ? p : ''}.${since}`;
    }
    case 'done':
      return 'Done: every quote has the speaker the PC found.';
    case 'cancelled':
      return 'Finding who speaks was stopped.';
    case 'failed':
      return `Finding who speaks failed: ${(job.error ?? 'unknown error').replace(/\.$/, '')}.`;
  }
}

/** "Sure" / "Fairly sure" / "Unsure" with the percent (null: not known). */
export function sureText(p: number | null, below: number): string {
  if (p === null) return '';
  const pct = `${Math.round(p * 100)} %`;
  if (p >= 0.95) return `Sure (${pct})`;
  if (p >= below) return `Fairly sure (${pct})`;
  return `Unsure (${pct})`;
}

/** The characters in the order the panel shows them: most quotes first, hidden last. */
export function sortedCharacters(list: SpeakerCharacter[]): SpeakerCharacter[] {
  return [...list].sort(
    (a, b) => Number(a.hidden) - Number(b.hidden) || b.quotes - a.quotes || a.no - b.no
  );
}

/**
 * A character the list folds away (decided with the user 2026-11-17): the PC found it, it
 * speaks no quote, and nothing was set on it (voice, narrator, "not a character").
 */
export function isQuiet(c: SpeakerCharacter): boolean {
  return c.quotes === 0 && c.origin === 'model' && !c.voiceId && !c.narrator && !c.hidden;
}

/** "Found 12 characters for 1,039 quotes (Gemma 4 26B A4B, 2 h ago)." */
export function runText(o: SpeakerOverview, now: number): string {
  if (!o.run) return '';
  const n = o.characters.filter((c) => !c.hidden).length;
  return `Found ${n} ${n === 1 ? 'character' : 'characters'} for ${o.run.quotes.toLocaleString('en-US')} ${
    o.run.quotes === 1 ? 'quote' : 'quotes'
  } (${o.run.model ? `${o.run.model}, ` : ''}${timeAgo(o.run.finishedAt, now)}).`;
}

/** Whether a version ("1.4.0") is older than `min`. */
export function olderThan(version: string, min: string): boolean {
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** The PC's program finds who speaks (an older one never takes the job). */
export function pcProgramNote(o: SpeakerOverview, worker: GpuWorkerStatus | null): string {
  if (o.pcCanRun === false) {
    const old = !!worker?.version && olderThan(worker.version, SPEAKERS_WORKER_VERSION);
    return old
      ? `The program on the PC needs an update to find who speaks (version ${SPEAKERS_WORKER_VERSION}).`
      : 'The program on the PC can’t find who speaks yet: run “main.js pull-speakers” on the PC.';
  }
  return '';
}

/** "ホロ (賢狼, ホロさん)" */
export function characterLabel(c: Pick<SpeakerCharacter, 'name' | 'aliases'>): string {
  return c.aliases.length ? `${c.name} (${c.aliases.slice(0, 3).join(', ')})` : c.name;
}
