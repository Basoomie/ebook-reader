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
   * Season 2 Phase 12 session 3: the voice the PC keeps loaded for read-aloud and Enrich
   * clips, and how long it keeps it after its last use (stored on the server, every device).
   */
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import PagedList from '$lib/components/settings/paged-list.svelte';
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

  let keepInput = '';
  let keepError = '';
  $: if (status?.keepLoadedMinutes !== undefined && keepInput === '') {
    keepInput = String(status.keepLoadedMinutes);
  }

  async function saveKeep() {
    const n = Number(keepInput);
    if (!Number.isInteger(n) || n < 0 || n > 1440) {
      keepError = 'A whole number of minutes from 0 to 1440.';
      return;
    }
    try {
      const minutes = await api.setKeepLoaded(n);
      if (status) status = { ...status, keepLoadedMinutes: minutes };
      keepInput = String(minutes);
      keepError = '';
    } catch (err) {
      keepError = describe(err);
    }
  }

  const clockTime = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  /** "Irodori-TTS-v4.1-Small loaded · kept until 14:32" */
  function voiceText(s: GpuWorkerStatus): string {
    const engine = s.engine;
    if (!engine) return 'Not loaded.';
    const model = engine.source.split('/').pop() ?? engine.source;
    if (engine.state === 'loading') return `Loading ${model}…`;
    if (s.live) return `${model} loaded · in use by read-aloud.`;
    return s.keepVoiceUntil
      ? `${model} loaded · kept until ${clockTime(s.keepVoiceUntil)}; other jobs wait until then.`
      : `${model} loaded.`;
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

<SettingsGroup id="audio-pc" testid="gpu-worker">
  <svelte:fragment slot="before">
    {#if error}
      <p class="c-notice mb-3" role="alert" data-testid="gpu-worker-error">{error}</p>
    {/if}
  </svelte:fragment>
  {#if status && !status.available}
    <p class="px-5 py-4" data-testid="gpu-worker-off">
      This server can't make subtitles: it has no audiobooks folder.
    </p>
  {:else if status}
    <SettingRow id="pc-state" layout="info">
      <span class="font-medium" data-testid="gpu-worker-state">{stateText(status)}</span>
    </SettingRow>
    {#if programText(status)}
      <SettingRow title="Program" layout="info">
        <span data-testid="gpu-worker-program">{programText(status)}</span>
      </SettingRow>
    {/if}
    {#if status.keepLoadedMinutes !== undefined}
      <SettingRow title="Voice" layout="info">
        <span data-testid="gpu-worker-voice">{voiceText(status)}</span>
      </SettingRow>
      <SettingRow id="pc-keep-loaded" shared>
        <svelte:fragment slot="description">
          {#if keepError}
            <p class="c-notice mt-2" role="alert" data-testid="gpu-worker-keep-error">
              {keepError}
            </p>
          {/if}
        </svelte:fragment>
        <SettingField unit="minutes">
          <input
            id="gpu-worker-keep"
            type="number"
            min="0"
            max="1440"
            step="1"
            aria-label="Keep the voice loaded (minutes)"
            data-testid="gpu-worker-keep"
            value={keepInput}
            on:change={(e) => {
              keepInput = e.currentTarget.value;
              void saveKeep();
            }}
          />
        </SettingField>
      </SettingRow>
    {/if}
    <SettingRow
      id="pc-pause"
      layout="inline"
      description={status.paused
        ? 'Paused: jobs wait until you resume.'
        : 'While paused, the PC takes no new jobs; a job already running finishes. A long audiobook stops after its current chapter and goes on later.'}
    >
      <button
        class="c-btn c-btn-secondary"
        aria-pressed={status.paused}
        data-testid="gpu-worker-pause"
        disabled={switching}
        on:click={togglePause}
      >
        {status.paused ? 'Resume' : 'Pause'}
      </button>
    </SettingRow>
    <div id="setting-pc-jobs">
      <p class="px-4 pb-1 pt-3 font-semibold sm:px-5">
        Waiting and running{#if jobs.length}<span class="font-normal text-c-muted">
            · {jobs.length}</span
          >{/if}
      </p>
      {#if jobs.length === 0}
        <p class="px-4 pb-3 text-sm text-c-muted sm:px-5" data-testid="gpu-worker-no-jobs">
          Nothing to do.
        </p>
      {:else}
        <PagedList
          items={jobs}
          pageSize={5}
          text={(job) => workerJobTitle(job)}
          searchLabel="Search jobs"
          label="Jobs"
          let:rows
        >
          <ul data-testid="gpu-worker-jobs">
            {#each rows as job (job.id)}
              <li class="s-item" data-testid="gpu-worker-job">
                <div class="s-item-main flex flex-col gap-0.5">
                  {#if job.bookId}
                    <a
                      class="c-link self-start font-mincho text-[15px] font-bold"
                      href={bookHref(job.bookId)}>{workerJobTitle(job)}</a
                    >
                  {:else}
                    <span class="font-mincho text-[15px] font-bold">{workerJobTitle(job)}</span>
                  {/if}
                  <div class="text-sm" data-testid="gpu-worker-job-text">
                    {isTtsJob(job)
                      ? audiobookJobText(job, status, now)
                      : subtitleJobText(job, status, now)}
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        </PagedList>
      {/if}
    </div>
  {/if}
</SettingsGroup>
