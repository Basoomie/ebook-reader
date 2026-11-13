<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP16: Settings > Audiobooks, "Subtitles made on the PC": whether the subtitle program on
   * the user's PC (SubPlz, apps/gpu-worker) is there, what keeps it from working, the
   * waiting and running jobs, and the pause switch (stored on the server, so it works from
   * any device). Pausing is a toggle that undoes itself, so it doesn't ask.
   * WP17: also audiobooks, previews and voice samples made on the PC (a long audiobook
   * stops after its current chapter when paused).
   */
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import { subtitleJobText, timeAgo } from '$lib/audio/audio-link';
  import { audiobookJobText, isTtsJob, workerJobTitle } from '$lib/audio/tts-text';
  import type { GpuWorkerStatus } from '$lib/audio/audio-types';
  import { pagePath } from '$lib/data/env';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import { onDestroy } from 'svelte';

  export let api: LibraryApi;

  /** How often the section asks again while it is open. */
  const POLL_MS = 5000;

  let status: GpuWorkerStatus | null = null;
  let error = '';
  let switching = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let now = Date.now();
  let started = false;

  $: if (api && !started) {
    started = true;
    void load();
  }
  $: jobs = status?.jobs ?? [];

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    if (err instanceof LibraryApiError && err.status === 404) {
      return "This server can't make subtitles yet (update the server).";
    }
    return (err as Error).message;
  }

  async function load() {
    try {
      const s = await api.gpuWorker();
      if (destroyed) return;
      status = s;
      error = '';
    } catch (err) {
      if (!destroyed) error = describe(err);
    }
    now = Date.now();
    clearTimeout(timer);
    if (!destroyed) timer = setTimeout(() => void load(), POLL_MS);
  }

  async function togglePause() {
    if (!status || switching) return;
    switching = true;
    try {
      const paused = await api.setGpuWorkerPaused(!status.paused);
      status = { ...status, paused };
      error = '';
    } catch (err) {
      error = describe(err);
    } finally {
      switching = false;
    }
  }

  function stateText(s: GpuWorkerStatus): string {
    if (s.paused) return 'Paused: the PC takes no new jobs.';
    if (!s.online) {
      return s.lastSeenAt
        ? `Off: the PC was last seen ${timeAgo(s.lastSeenAt, now)}.`
        : 'Not set up yet: no PC has checked in.';
    }
    if (s.problem) return s.problem.replace(/\.$/, '') + '.';
    const running = (s.jobs ?? []).find((j) => j.state === 'running');
    if (running) return `Working on “${workerJobTitle(running)}”.`;
    return 'Ready.';
  }

  /** "1.0.0 · SubPlz sha256:58cddc13c517" */
  function programText(s: GpuWorkerStatus): string {
    const image = s.image ? s.image.replace(/^.*@(sha256:[0-9a-f]{12}).*$/, 'SubPlz $1') : '';
    const tts = s.ttsImage ? `audiobooks ${s.ttsImage.replace(/^.*:/, 'program ')}` : '';
    return [s.version ? `Version ${s.version}` : '', image, tts].filter(Boolean).join(' · ');
  }

  function bookHref(id: string) {
    return `${pagePath}/library/book?id=${encodeURIComponent(id)}`;
  }
</script>

<section class="mt-10" aria-label="Subtitles made on the PC" data-testid="gpu-worker">
  <SettingsSection
    jp="字幕作成"
    title="Subtitles made on the PC"
    tooltip="SubPlz on your PC makes subtitles for an audiobook when you ask for them on a book's page (Audiobook > Make subtitles on the PC). The PC also makes audiobooks read aloud from a book (Audiobook > Make an audiobook on the PC). Jobs wait while the PC is off. Pausing lets a long audiobook finish its current chapter and continue later."
  />
  {#if error}
    <p class="c-notice mt-4" role="alert" data-testid="gpu-worker-error">{error}</p>
  {/if}
  {#if status && !status.available}
    <p class="mt-4 text-[15px]" data-testid="gpu-worker-off">
      This server can't make subtitles: it has no audiobooks folder.
    </p>
  {:else if status}
    <div class="c-gwpanel mt-4 max-w-3xl rounded px-5 py-4">
      <dl class="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-y-1 text-sm">
        <dt class="text-c-muted">The PC</dt>
        <dd class="break-words font-medium" data-testid="gpu-worker-state">{stateText(status)}</dd>
        {#if programText(status)}
          <dt class="text-c-muted">Program</dt>
          <dd class="break-words" data-testid="gpu-worker-program">{programText(status)}</dd>
        {/if}
      </dl>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button
          class="c-btn c-btn-secondary"
          aria-pressed={status.paused}
          data-testid="gpu-worker-pause"
          disabled={switching}
          on:click={togglePause}
        >
          {status.paused ? 'Resume' : 'Pause'}
        </button>
        <span class="text-sm text-c-muted">
          {status.paused
            ? 'Jobs wait until you resume.'
            : 'While paused, the PC takes no new jobs; a job already running finishes.'}
        </span>
      </div>
    </div>

    <h3 class="mt-6 font-mincho text-lg font-bold">Waiting and running</h3>
    {#if jobs.length === 0}
      <p class="mt-1 text-[15px]" data-testid="gpu-worker-no-jobs">Nothing to do.</p>
    {:else}
      <ul class="mt-1" data-testid="gpu-worker-jobs">
        {#each jobs as job (job.id)}
          <li class="c-gwrow flex flex-col gap-1 py-3" data-testid="gpu-worker-job">
            {#if job.bookId}
              <a
                class="c-link self-start break-words font-mincho text-[15px] font-bold"
                href={bookHref(job.bookId)}>{workerJobTitle(job)}</a
              >
            {:else}
              <span class="break-words font-mincho text-[15px] font-bold"
                >{workerJobTitle(job)}</span
              >
            {/if}
            <div class="break-words text-sm" data-testid="gpu-worker-job-text">
              {isTtsJob(job)
                ? audiobookJobText(job, status, now)
                : subtitleJobText(job, status, now)}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .c-gwpanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-gwrow + .c-gwrow {
    border-top: 1px dashed var(--c-line);
  }
</style>
