/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * WP17: what the page says about audiobooks made on the PC, previews and described
 * voices, in everyday words (no "TTS", "job" or "voice map" on screen).
 */

import { timeAgo } from './audio-link';
import type { GpuWorkerStatus, SubtitleJob } from './audio-types';
import type { AudiobookJob, TtsModel, VoicePreset } from './tts-types';

/** Speech is about this many counted characters per second (measured, WP17 samples). */
export const CHARS_PER_SECOND = 4.8;

export function ttsJobActive(job: AudiobookJob | null | undefined): boolean {
  return !!job && (job.state === 'queued' || job.state === 'running');
}

function percent(p: number | null): string {
  return p === null ? '' : ` · ${Math.floor(Math.max(0, Math.min(1, p)) * 100)} %`;
}

/** "9 h 40 min", "25 min", "under a minute". */
export function durationText(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** The book's length read aloud, roughly. */
export function audioLengthText(characters: number): string {
  return `about ${durationText(characters / CHARS_PER_SECOND)} of audio`;
}

/** Why a waiting job waits (any kind of job on the PC). */
export function ttsWaitText(
  job: { id: number },
  worker: GpuWorkerStatus | null,
  now: number
): string {
  if (!worker || !worker.available) return 'Waiting for the PC…';
  if (worker.paused) return 'Waiting: the PC is paused (Settings > Audiobooks).';
  if (!worker.online) {
    return worker.lastSeenAt
      ? `Waiting for the PC to be switched on (last seen ${timeAgo(worker.lastSeenAt, now)}).`
      : 'Waiting for the PC. The program on the PC has not checked in yet.';
  }
  if (worker.problem) return `Waiting: ${worker.problem.replace(/\.$/, '')}.`;
  if ((worker.jobs ?? []).some((j) => j.state === 'running' && j.id !== job.id)) {
    return 'Waiting for another job on the PC to finish…';
  }
  return 'Waiting for the PC to start…';
}

const what = (job: AudiobookJob) =>
  job.kind === 'voice_sample'
    ? 'the voice sample'
    : job.kind === 'preview_audiobook'
      ? 'the preview'
      : 'the audiobook';

/** One line on an audiobook, preview or voice sample being made. */
export function audiobookJobText(
  job: AudiobookJob,
  worker: GpuWorkerStatus | null,
  now: number
): string {
  const thing = what(job);
  switch (job.state) {
    case 'queued': {
      const wait = ttsWaitText(job, worker, now);
      const done =
        job.kind === 'generate_audiobook' && job.chaptersDone > 0 && job.chaptersTotal
          ? `${job.chaptersDone} of ${job.chaptersTotal} chapters done. `
          : '';
      // The server's own explanation (a sentence, e.g. "…; it will be tried again."), not a
      // progress line left from before ("Chapter 3 of 12").
      const why = job.message && /\.$/.test(job.message) && !done ? `${job.message} ` : '';
      return `${done}${why}${wait}`;
    }
    case 'running':
      if (job.cancelRequested) return 'Stopping…';
      switch (job.stage) {
        case 'assembling':
          return 'Putting the audiobook together on the server…';
        case 'saving':
          return 'Saving into the audiobooks folder…';
        case 'preparing':
          return `The PC is getting ready to make ${thing}…`;
        default: {
          const line = job.message ?? 'Reading';
          const since = job.startedAt ? ` Started ${timeAgo(job.startedAt, now)}.` : '';
          return job.kind === 'generate_audiobook'
            ? `${line}${percent(job.progress)}.${since}`
            : `Making ${thing}: ${line.toLowerCase()}…`;
        }
      }
    case 'done':
      if (job.kind === 'preview_audiobook') return 'The preview is ready.';
      if (job.kind === 'voice_sample')
        return 'The sample is ready. Listen, then keep it or try again.';
      return job.linked
        ? `Audiobook made${job.version && job.version > 1 ? ` (version ${job.version})` : ''}. This book now uses it, with its subtitles.`
        : 'Audiobook made, but this book’s audiobook was changed meanwhile, so it was not chosen. Pick it under “Change audiobook” (it is marked Generated).';
    case 'cancelled':
      return job.kind === 'generate_audiobook'
        ? 'Making the audiobook was stopped. Nothing was added to the audiobooks folder.'
        : `Making ${thing} was stopped.`;
    case 'failed':
      return job.kind === 'generate_audiobook'
        ? `Making the audiobook failed: ${(job.error ?? 'unknown error').replace(/\.$/, '')}. Nothing was added to the audiobooks folder.`
        : `Making ${thing} failed: ${(job.error ?? 'unknown error').replace(/\.$/, '')}.`;
  }
}

/** The name of a job in Settings' list of waiting and running jobs. */
export function workerJobTitle(job: SubtitleJob | AudiobookJob): string {
  if (job.kind === 'voice_sample') {
    return `Voice sample “${(job as AudiobookJob).params?.narrator.name ?? ''}”`;
  }
  const title = job.bookTitle ?? ('audioFileName' in job ? job.audioFileName : '') ?? '';
  if (job.kind === 'preview_audiobook') return `${title} (preview)`;
  return title;
}

/** One line on any job of the PC (Settings > Audiobooks). */
export function isTtsJob(job: SubtitleJob | AudiobookJob): job is AudiobookJob {
  return job.kind !== 'sync_subtitles';
}

/** "Your recording · 24 s" / "Described · 21 s". */
export function voiceDetails(v: VoicePreset): string {
  return `${v.kind === 'clip' ? 'Your recording' : 'Described'} · ${Math.round(v.clipSeconds)} s`;
}

/** Models that can copy a voice preset (unknown counts as yes). */
export const modelsForVoices = (models: TtsModel[]) =>
  models.filter((m) => m.supportsClip !== false);

/** Models that can make a voice from a description (unknown counts as yes). */
export const modelsForDescriptions = (models: TtsModel[]) =>
  models.filter((m) => m.supportsDescription !== false);

/** "Aratako/Irodori-TTS-v4.1-Small · 2b28324d" */
export function modelSourceText(m: TtsModel): string {
  return `${m.source} · ${m.revision.slice(0, 8)}`;
}
