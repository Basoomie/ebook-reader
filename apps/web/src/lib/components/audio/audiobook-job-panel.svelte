<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP17: "Make an audiobook on the PC" in a book's Audiobook section. The user picks a
   * voice (Settings > Audiobooks > Voices) and a model, can hear about a minute of a chapter
   * first (Preview), then starts the whole book. The PC reads it chapter by chapter (it goes
   * on when the page is closed, waits while the PC is off, and continues where it stopped);
   * the server then saves the audiobook and its subtitles in the generated audiobooks folder
   * and this book uses them (`linked` fires). Stop throws away what was read so far.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { linkedFolderName } from '$lib/audio/audio-link';
  import type { AudioLink, GpuWorkerStatus } from '$lib/audio/audio-types';
  import { currentPauses } from '$lib/audio/tts-settings';
  import {
    audioLengthText,
    audiobookJobText,
    modelsForVoices,
    ttsJobActive
  } from '$lib/audio/tts-text';
  import type { AudiobookJob, BookChapters, TtsModel, VoicePreset } from '$lib/audio/tts-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { replaceAudiobookWithMadeCopy, stopAudiobookJobCopy } from '$lib/confirm/confirm-copy';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import { settingsTabHref } from '$lib/settings/settings-tab';

  export let api: LibraryApi;
  export let bookId: string;
  export let link: AudioLink | null;
  export let audioEnabled: boolean;
  export let busy = false;

  const dispatch = createEventDispatcher<{ linked: AudiobookJob }>();
  const POLL_MS = 2000;

  let worker: GpuWorkerStatus | null = null;
  let models: TtsModel[] = [];
  let voices: VoicePreset[] = [];
  let available = false;
  let job: AudiobookJob | null = null;
  let preview: AudiobookJob | null = null;
  let previewUrl = '';
  let chapters: BookChapters | null = null;
  let chaptersError = '';
  let open = false;
  let voiceId = '';
  let modelId: number | null = null;
  let chapterIndex = 0;
  let message = '';
  let starting = false;
  let loadedFor = '';
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let now = Date.now();

  $: usable = modelsForVoices(models);
  $: model = usable.find((m) => m.id === modelId) ?? null;
  $: active = ttsJobActive(job);
  $: previewActive = ttsJobActive(preview);
  $: barValue =
    job && active && job.progress !== null && !job.cancelRequested
      ? Math.floor(Math.max(0, Math.min(1, job.progress)) * 100)
      : null;
  $: canStart = audioEnabled && available && !active && !!voiceId && !!model;
  $: if (bookId && bookId !== loadedFor) void load(bookId);

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  function setPreviewUrl(url: string) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
  }

  async function load(id: string) {
    loadedFor = id;
    job = null;
    preview = null;
    chapters = null;
    open = false;
    message = '';
    setPreviewUrl('');
    clearTimeout(timer);
    try {
      const [status, modelList, voiceList, latest, latestPreview] = await Promise.all([
        api.gpuWorker().catch(() => null),
        api.ttsModels().catch(() => ({ available: false, models: [] })),
        api.voices().catch(() => ({ available: false, voices: [], limits: null })),
        api.audiobookJob(id).catch(() => null),
        api.audiobookPreview(id).catch(() => null)
      ]);
      if (destroyed || loadedFor !== id) return;
      worker = status;
      models = modelList.models;
      voices = voiceList.voices;
      available = !!status?.available && modelList.available && voiceList.available;
      modelId = modelsForVoices(models)[0]?.id ?? null;
      voiceId = voices[0]?.id ?? '';
      now = Date.now();
      if (
        latest &&
        (ttsJobActive(latest) ||
          (latest.state === 'failed' && (latest.finishedAt ?? 0) > (link?.confirmedAt ?? 0)))
      ) {
        job = latest;
      }
      if (latestPreview && ttsJobActive(latestPreview)) {
        preview = latestPreview;
        open = true;
      }
      // Not `active`/`previewActive`: reactive values update only after this function.
      if (ttsJobActive(job) || ttsJobActive(preview)) schedulePoll();
    } catch (err) {
      logger.warn(`Details: audiobook job: ${describe(err)}`);
    }
  }

  async function openForm() {
    open = true;
    message = '';
    if (chapters) return;
    chaptersError = '';
    const id = bookId;
    try {
      const c = await api.audiobookChapters(id);
      if (!destroyed && id === bookId) chapters = c;
    } catch (err) {
      if (!destroyed && id === bookId) chaptersError = describe(err);
    }
  }

  function schedulePoll() {
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), POLL_MS);
  }

  async function poll() {
    const id = bookId;
    try {
      const [latest, latestPreview, status] = await Promise.all([
        job ? api.audiobookJob(id) : Promise.resolve(null),
        preview ? api.audiobookPreview(id) : Promise.resolve(null),
        api.gpuWorker().catch(() => worker)
      ]);
      if (destroyed || id !== bookId) return;
      worker = status;
      now = Date.now();
      if (latest && job && latest.id === job.id) {
        job = latest;
        if (latest.state === 'done' && latest.linked) dispatch('linked', latest);
      }
      if (latestPreview && preview && latestPreview.id === preview.id) {
        const wasActive = ttsJobActive(preview);
        preview = latestPreview;
        if (wasActive && latestPreview.state === 'done') void loadPreviewAudio(latestPreview);
      }
    } catch {
      // Offline for a moment: ask again later.
    }
    if (!destroyed && id === bookId && (ttsJobActive(job) || ttsJobActive(preview))) {
      schedulePoll();
    }
  }

  async function loadPreviewAudio(p: AudiobookJob) {
    try {
      const blob = await api.ttsJobAudio(p.id);
      if (!destroyed && preview?.id === p.id) setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      message = describe(err);
    }
  }

  function request(withChapter: boolean) {
    return {
      voiceId,
      modelId: model?.id,
      pauses: currentPauses(),
      ...(withChapter ? { chapterIndex } : {})
    };
  }

  async function startPreview() {
    if (starting || !voiceId) return;
    starting = true;
    message = '';
    setPreviewUrl('');
    const id = bookId;
    try {
      preview = await api.startAudiobookPreview(id, request(true));
      worker = await api.gpuWorker().catch(() => worker);
      now = Date.now();
      schedulePoll();
    } catch (err) {
      message = describe(err);
    } finally {
      starting = false;
    }
  }

  async function start() {
    if (starting || !canStart) return;
    if (link?.state === 'linked') {
      const ok = await confirmDestructive({
        ...replaceAudiobookWithMadeCopy(linkedFolderName(link)),
        testid: 'audiobook-job-replace-confirm',
        confirmTestid: 'audiobook-job-replace-confirm-button'
      });
      if (!ok) return;
    }
    starting = true;
    message = '';
    const id = bookId;
    try {
      job = await api.startAudiobookJob(id, request(false));
      open = false;
      worker = await api.gpuWorker().catch(() => worker);
      now = Date.now();
      schedulePoll();
    } catch (err) {
      message = describe(err);
      logger.warn(`Details: audiobook could not start: ${message}`);
    } finally {
      starting = false;
    }
  }

  async function stop() {
    if (!job) return;
    const ok = await confirmDestructive({
      ...stopAudiobookJobCopy(job.bookTitle ?? 'this book', job.chaptersDone),
      testid: 'audiobook-job-stop-confirm',
      confirmTestid: 'audiobook-job-stop-confirm-button'
    });
    if (!ok || !job) return;
    try {
      await api.cancelSubtitleJob(job.id);
      job = await api.audiobookJob(bookId);
      now = Date.now();
      if (ttsJobActive(job)) schedulePoll();
    } catch (err) {
      message = describe(err);
    }
  }

  async function stopPreview() {
    if (!preview) return;
    try {
      await api.cancelSubtitleJob(preview.id);
      preview = await api.audiobookPreview(bookId);
    } catch (err) {
      message = describe(err);
    }
  }
</script>

{#if available && audioEnabled}
  <div class="c-apanel mt-4 rounded px-5 py-4" data-testid="audiobook-job">
    <div class="text-xs text-c-muted">Audiobook made on your PC</div>

    {#if message}
      <p class="c-notice mt-2" role="alert" data-testid="audiobook-job-message">{message}</p>
    {/if}

    {#if job}
      <p
        class="mt-1 text-sm"
        role="status"
        aria-live="polite"
        data-testid="audiobook-job-text"
        data-state={job.state}
        data-stage={job.stage ?? ''}
      >
        {audiobookJobText(job, worker, now)}
      </p>
      {#if job.params}
        <p class="mt-1 text-sm text-c-muted" data-testid="audiobook-job-voice">
          Voice “{job.params.narrator.name}”, {job.params.model.label}
        </p>
      {/if}
      {#if barValue !== null}
        <div
          class="c-mbar mt-2"
          role="progressbar"
          aria-label="Audiobook progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={barValue}
          data-testid="audiobook-job-bar"
        >
          <div style="width: {barValue}%" />
        </div>
      {/if}
      {#if active}
        <p class="mt-2 text-sm text-c-muted">
          This goes on when you leave this page and waits while the PC is off; it continues with the
          next chapter. A long book takes an hour or more.
        </p>
        <div class="mt-3">
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audiobook-job-stop"
            disabled={job.cancelRequested || job.stage === 'assembling' || job.stage === 'saving'}
            on:click={stop}
          >
            Stop
          </button>
        </div>
      {:else}
        {#if job.state === 'failed' && job.logTail}
          <details class="mt-2 text-sm" data-testid="audiobook-job-log">
            <summary class="min-h-[2.75rem] cursor-pointer leading-[2.75rem]">
              What the PC said last
            </summary>
            <pre
              class="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{job.logTail}</pre>
          </details>
        {/if}
        <div class="mt-3">
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audiobook-job-dismiss"
            on:click={() => (job = null)}
          >
            OK
          </button>
        </div>
      {/if}
    {:else if !open}
      <p class="mt-1 text-sm text-c-muted">
        Your PC reads this book aloud with a voice you choose and saves the audiobook, with
        subtitles that match it exactly, in the generated audiobooks folder.
      </p>
      <div class="mt-3">
        <button
          class="c-btn c-btn-secondary c-round"
          data-testid="audiobook-job-open"
          disabled={busy}
          on:click={openForm}
        >
          Make an audiobook on the PC
        </button>
      </div>
    {:else}
      {#if voices.length === 0}
        <p class="mt-2 text-sm" data-testid="audiobook-job-no-voice">
          Add a voice first: your own recording, or a voice described in words.
          <a class="c-link" href={settingsTabHref(pagePath, 'Audiobooks')}>Voices in Settings</a>
        </p>
      {:else}
        <div class="mt-2 grid max-w-xl gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-c-muted">Voice</span>
            <select
              class="c-input block w-full text-base"
              bind:value={voiceId}
              data-testid="audiobook-job-voice-select"
            >
              {#each voices as v (v.id)}
                <option value={v.id}>{v.name}</option>
              {/each}
            </select>
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-c-muted">Model</span>
            <select
              class="c-input block w-full text-base"
              bind:value={modelId}
              data-testid="audiobook-job-model-select"
            >
              {#each usable as m (m.id)}
                <option value={m.id}>{m.label}{m.isDefault ? ' (default)' : ''}</option>
              {/each}
            </select>
            {#if model?.note}
              <span class="text-c-muted" data-testid="audiobook-job-model-note">{model.note}</span>
            {/if}
          </label>
          {#if chapters}
            <p class="text-sm" data-testid="audiobook-job-length">
              {chapters.chapters.length === 1
                ? '1 chapter'
                : `${chapters.chapters.length} chapters`}, {audioLengthText(chapters.characters)}.
            </p>
            <label class="grid gap-1 text-sm">
              <span class="text-c-muted">Preview from</span>
              <select
                class="c-input block w-full text-base"
                bind:value={chapterIndex}
                data-testid="audiobook-job-chapter-select"
              >
                {#each chapters.chapters as c (c.index)}
                  <option value={c.index}>{c.title}</option>
                {/each}
              </select>
            </label>
          {:else if chaptersError}
            <p class="c-notice text-sm" role="alert">{chaptersError}</p>
          {:else}
            <p class="text-sm text-c-muted" data-testid="audiobook-job-reading">
              Reading the book…
            </p>
          {/if}
        </div>

        {#if preview}
          <div class="mt-3" data-testid="audiobook-preview" data-state={preview.state}>
            <p
              class="text-sm"
              role="status"
              aria-live="polite"
              data-testid="audiobook-preview-text"
            >
              {audiobookJobText(preview, worker, now)}
            </p>
            {#if previewActive}
              <button
                class="c-link mt-1 min-h-[2.75rem] text-sm"
                data-testid="audiobook-preview-stop"
                disabled={preview.cancelRequested}
                on:click={stopPreview}>Stop the preview</button
              >
            {/if}
            {#if previewUrl}
              <!-- svelte-ignore a11y-media-has-caption -->
              <audio
                class="mt-2 w-full"
                controls
                src={previewUrl}
                data-testid="audiobook-preview-audio"
              />
            {/if}
          </div>
        {/if}

        <div class="mt-4 flex flex-wrap gap-2">
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audiobook-preview-start"
            disabled={starting || busy || previewActive || !voiceId || !model}
            on:click={startPreview}
          >
            {preview?.state === 'done' ? 'Another preview' : 'Preview'}
          </button>
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audiobook-job-start"
            disabled={starting || busy || !canStart || !chapters}
            on:click={start}
          >
            Make the audiobook
          </button>
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audiobook-job-cancel"
            on:click={() => (open = false)}
          >
            Cancel
          </button>
        </div>
        <p class="mt-2 text-sm text-c-muted">
          A preview reads about a minute of the chapter, with the same voice and model.
        </p>
      {/if}
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
