<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP16: "Make subtitles on the PC" in a book's Audiobook section. The server queues the
   * job; the subtitle program on the user's PC (SubPlz, apps/gpu-worker) picks it up when
   * the PC is on. Before queuing, the server looks in the subtitle folder for files that
   * look like this book's: those are offered first ("Use this"), and new subtitles can
   * still be made. Status and progress show here (also after a reload), with Stop. When
   * the subtitles are ready the book uses them (the server links them) and `linked` fires.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import AudioChoiceRow from '$lib/components/audio/audio-choice-row.svelte';
  import {
    linkView,
    linkedSubtitleName,
    subtitleDetails,
    subtitleJobActive,
    subtitleJobText
  } from '$lib/audio/audio-link';
  import type {
    AudioLink,
    GpuWorkerStatus,
    SubtitleFileSummary,
    SubtitleJob
  } from '$lib/audio/audio-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { replaceSubtitlesWithJobCopy, stopSubtitleJobCopy } from '$lib/confirm/confirm-copy';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;
  export let bookId: string;
  export let link: AudioLink | null;
  /** The server's audiobooks folder is there (changes are possible). */
  export let audioEnabled: boolean;
  /** Something else in the section is busy (a link change, a merge). */
  export let busy = false;

  const dispatch = createEventDispatcher<{
    linked: SubtitleJob;
    chooseSubtitle: SubtitleFileSummary;
  }>();

  /** How often a waiting or running job is asked about. */
  const POLL_MS = 2000;

  let worker: GpuWorkerStatus | null = null;
  let job: SubtitleJob | null = null;
  let archiveMatches: SubtitleFileSummary[] | null = null;
  let message = '';
  let starting = false;
  let loadedFor = '';
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let now = Date.now();

  $: active = subtitleJobActive(job);
  $: playable = linkView(link) === 'linked';
  $: hasSubtitles = link?.subtitleState === 'linked';
  $: canStart =
    audioEnabled && playable && !!worker?.available && !active && archiveMatches === null;
  $: barValue =
    job && active && job.progress !== null && !job.cancelRequested
      ? Math.floor(Math.max(0, Math.min(1, job.progress)) * 100)
      : null;

  $: if (bookId && bookId !== loadedFor) void load(bookId);

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function load(id: string) {
    loadedFor = id;
    job = null;
    archiveMatches = null;
    message = '';
    clearTimeout(timer);
    try {
      const [status, latest] = await Promise.all([
        api.gpuWorker().catch(() => null),
        api.subtitleJob(id).catch(() => null)
      ]);
      if (destroyed || loadedFor !== id) return;
      worker = status;
      now = Date.now();
      // A waiting or running job, or one that failed after the link last changed.
      if (
        latest &&
        (subtitleJobActive(latest) ||
          (latest.state === 'failed' && (latest.finishedAt ?? 0) > (link?.confirmedAt ?? 0)))
      ) {
        job = latest;
        if (subtitleJobActive(latest)) schedulePoll();
      }
    } catch (err) {
      logger.warn(`Details: subtitle job: ${describe(err)}`);
    }
  }

  function schedulePoll() {
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), POLL_MS);
  }

  async function poll() {
    const id = bookId;
    const watching = job?.id;
    if (watching === undefined) return;
    let latest: SubtitleJob | null;
    try {
      [latest, worker] = await Promise.all([
        api.subtitleJob(id),
        api.gpuWorker().catch(() => worker)
      ]);
    } catch {
      // Offline for a moment: ask again later.
      if (!destroyed && id === bookId) schedulePoll();
      return;
    }
    now = Date.now();
    if (destroyed || id !== bookId || !latest || latest.id !== watching) return;
    job = latest;
    if (subtitleJobActive(latest)) {
      schedulePoll();
      return;
    }
    if (latest.state === 'done' && latest.linked) dispatch('linked', latest);
  }

  async function start(force = false) {
    if (starting) return;
    if (!force && hasSubtitles && link) {
      const ok = await confirmDestructive({
        ...replaceSubtitlesWithJobCopy(linkedSubtitleName(link)),
        testid: 'subtitle-job-replace-confirm',
        confirmTestid: 'subtitle-job-replace-confirm-button'
      });
      if (!ok) return;
    }
    starting = true;
    message = '';
    const id = bookId;
    try {
      const result = await api.startSubtitleJob(id, force);
      if (destroyed || id !== bookId) return;
      if ('archiveMatches' in result) {
        // The file this book already uses is no reason to ask again.
        const current = hasSubtitles ? link?.subtitleRelPath : null;
        const others = result.archiveMatches.filter((m) => m.relPath !== current);
        if (others.length === 0) {
          starting = false;
          await start(true);
          return;
        }
        archiveMatches = others;
        return;
      }
      archiveMatches = null;
      job = result.job;
      worker = await api.gpuWorker().catch(() => worker);
      now = Date.now();
      schedulePoll();
    } catch (err) {
      message = describe(err);
      logger.warn(`Details: subtitle job could not start: ${message}`);
    } finally {
      starting = false;
    }
  }

  function useArchived(file: SubtitleFileSummary) {
    archiveMatches = null;
    dispatch('chooseSubtitle', file);
  }

  async function stop() {
    if (!job) return;
    const ok = await confirmDestructive({
      ...stopSubtitleJobCopy(job.bookTitle ?? job.audioFileName),
      testid: 'subtitle-job-stop-confirm',
      confirmTestid: 'subtitle-job-stop-confirm-button'
    });
    if (!ok || !job) return;
    try {
      job = await api.cancelSubtitleJob(job.id);
      now = Date.now();
      if (subtitleJobActive(job)) schedulePoll();
    } catch (err) {
      message = describe(err);
    }
  }
</script>

{#if link?.state === 'linked' && (job || archiveMatches || canStart || message)}
  <div class="c-apanel mt-4 rounded px-5 py-4" data-testid="subtitle-job">
    <div class="text-xs text-c-muted">Subtitles made on your PC</div>

    {#if message}
      <p class="c-notice mt-2" role="alert" data-testid="subtitle-job-message">{message}</p>
    {/if}

    {#if job}
      <p
        class="mt-1 text-sm"
        role="status"
        aria-live="polite"
        data-testid="subtitle-job-text"
        data-state={job.state}
        data-stage={job.stage ?? ''}
      >
        {subtitleJobText(job, worker, now)}
      </p>
      {#if barValue !== null}
        <div
          class="c-mbar mt-2"
          role="progressbar"
          aria-label="Subtitle progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={barValue}
          data-testid="subtitle-job-bar"
        >
          <div style="width: {barValue}%" />
        </div>
      {/if}
      {#if active}
        <p class="mt-2 text-sm text-c-muted">
          This goes on when you leave this page, and waits while the PC is off. A long audiobook can
          take an hour or more.
        </p>
        <div class="mt-3">
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="subtitle-job-stop"
            disabled={job.cancelRequested}
            on:click={stop}
          >
            Stop
          </button>
        </div>
      {:else}
        {#if job.state === 'failed' && job.logTail}
          <details class="mt-2 text-sm" data-testid="subtitle-job-log">
            <summary class="min-h-[2.75rem] cursor-pointer leading-[2.75rem]">
              What SubPlz said last
            </summary>
            <pre
              class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{job.logTail}</pre>
          </details>
        {/if}
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="subtitle-job-dismiss"
            on:click={() => (job = null)}
          >
            OK
          </button>
        </div>
      {/if}
    {:else if archiveMatches}
      <p class="mt-1 text-sm" data-testid="subtitle-job-archive">
        Your subtitle folder may already have subtitles for this book:
      </p>
      <ul class="mt-2 divide-y divide-dashed divide-c-line" data-testid="subtitle-job-matches">
        {#each archiveMatches as file (file.id)}
          <AudioChoiceRow
            name={file.name}
            details={subtitleDetails(file)}
            disabled={busy}
            testid="subtitle-job-match"
            on:choose={() => useArchived(file)}
          />
        {/each}
      </ul>
      <div class="mt-3 flex flex-wrap gap-2">
        <button
          class="c-btn c-btn-secondary c-round"
          data-testid="subtitle-job-force"
          disabled={starting || busy}
          on:click={() => start(true)}
        >
          Make new subtitles anyway
        </button>
        <button
          class="c-btn c-btn-secondary c-round"
          data-testid="subtitle-job-archive-cancel"
          on:click={() => (archiveMatches = null)}
        >
          Cancel
        </button>
      </div>
    {:else if canStart}
      <p class="mt-1 text-sm text-c-muted">
        SubPlz on your PC matches this audiobook to the book's text and saves the subtitles in the
        subtitle folder. {hasSubtitles ? 'This book then uses the new subtitles.' : ''}
      </p>
      <div class="mt-3">
        <button
          class="c-btn c-btn-secondary c-round"
          data-testid="subtitle-job-start"
          disabled={starting || busy}
          on:click={() => start(false)}
        >
          {hasSubtitles ? 'Make new subtitles on the PC' : 'Make subtitles on the PC'}
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .c-apanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-round {
    border-radius: 0.75rem;
  }

  .c-mbar {
    height: 0.75rem;
    border: var(--c-border-width) solid currentColor;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .c-mbar > div {
    height: 100%;
    background-color: currentColor;
    transition: width 0.3s;
  }
</style>
