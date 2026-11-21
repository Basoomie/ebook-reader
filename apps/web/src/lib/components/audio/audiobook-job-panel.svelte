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
   *
   * 2026-11-20 (Audiobook section redesign, decided with the user): it reads with the book's
   * TTS voice (`choice`, chosen once in the Text-to-speech row) and has no voice or model
   * choice of its own. `compact` (the row closed) shows only a running job's status.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { linkedFolderName } from '$lib/audio/audio-link';
  import type { AudioLink, GpuWorkerStatus } from '$lib/audio/audio-types';
  import { currentPauses } from '$lib/audio/tts-settings';
  import {
    audioLengthText,
    audiobookJobText,
    jobVoicesText,
    ttsJobActive
  } from '$lib/audio/tts-text';
  import type { AudiobookJob, BookChapters, BookVoiceChoices } from '$lib/audio/tts-types';
  import { jobFixesText } from '$lib/audio/pronunciation/fix-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    audiobookWithoutSpeakersCopy,
    replaceAudiobookWithMadeCopy,
    stopAudiobookJobCopy
  } from '$lib/confirm/confirm-copy';
  import { speakerJobActive } from '$lib/audio/speakers/speaker-text';
  import type { SpeakerOverview } from '$lib/audio/speakers/speaker-types';
  import { unsureBelow } from '$lib/audio/tts-settings';
  import { pagePath } from '$lib/data/env';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import { settingsTabHref } from '$lib/settings/settings-tab';

  export let api: LibraryApi;
  export let bookId: string;
  export let link: AudioLink | null;
  export let audioEnabled: boolean;
  export let busy = false;
  /** The book's TTS voice (its own, else the one in Settings > Anki); null = none chosen. */
  export let choice: BookVoiceChoices['effective'] = null;
  /** The Text-to-speech row is closed: only a running job's status shows. */
  export let compact = false;
  /** Bound up: the PC can make audiobooks (worker, voices and models set up). */
  export let available = false;

  const dispatch = createEventDispatcher<{ linked: AudiobookJob }>();
  const POLL_MS = 2000;

  let worker: GpuWorkerStatus | null = null;
  let job: AudiobookJob | null = null;
  let preview: AudiobookJob | null = null;
  let previewUrl = '';
  let chapters: BookChapters | null = null;
  let chaptersError = '';
  let open = false;
  let chapterIndex = 0;
  let message = '';
  let starting = false;
  let loadedFor = '';
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let now = Date.now();

  $: usableChoice = choice && !choice.problem ? choice : null;
  $: choiceText = usableChoice
    ? `${usableChoice.voiceName ?? 'a deleted voice'}${
        usableChoice.dialogueVoiceId
          ? `, dialogue ${usableChoice.dialogueVoiceName ?? 'a deleted voice'}`
          : ''
      }, ${usableChoice.modelLabel ?? 'a removed model'}`
    : '';
  $: active = ttsJobActive(job);
  $: previewActive = ttsJobActive(preview);
  $: fixesUsed = jobFixesText(job?.params?.fixes);
  $: barValue =
    job && active && job.progress !== null && !job.cancelRequested
      ? Math.floor(Math.max(0, Math.min(1, job.progress)) * 100)
      : null;
  $: canStart = audioEnabled && available && !active && !!usableChoice;
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
      available = !!status?.available && modelList.available && voiceList.available;
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

  /** Session 5: the book's speakers (null: none yet, or an older server). */
  let speakers: SpeakerOverview | null = null;
  let speakersKnown = false;
  $: voiced = speakers ? speakers.characters.filter((c) => !c.hidden && c.voiceId).length : 0;

  async function loadSpeakers() {
    try {
      speakers = await api.speakers(bookId, unsureBelow());
      speakersKnown = true;
    } catch {
      speakers = null;
      speakersKnown = false;
    }
  }

  /** Opens the form ("Make one with text-to-speech" in the Audiobook row). */
  export async function openForm() {
    open = true;
    message = '';
    void loadSpeakers();
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
      voiceId: usableChoice?.voiceId ?? '',
      dialogueVoiceId: usableChoice?.dialogueVoiceId ?? null,
      modelId: usableChoice?.modelId,
      pauses: currentPauses(),
      ...(withChapter ? { chapterIndex } : {})
    };
  }

  async function startPreview() {
    if (starting || !usableChoice) return;
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
    // Session 5 (user, 2026-11-16): starting before the book's speakers are worked out asks
    // first; the audiobook then reads every quote without a speaker with the dialogue voice.
    await loadSpeakers();
    if (speakersKnown && speakers && (speakerJobActive(speakers.job) || !speakers.run)) {
      const ok = await confirmDestructive({
        ...audiobookWithoutSpeakersCopy(speakerJobActive(speakers.job)),
        testid: 'audiobook-job-speakers-confirm',
        confirmTestid: 'audiobook-job-speakers-confirm-button'
      });
      if (!ok) return;
    }
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

{#if available && audioEnabled && (!compact || job || previewActive)}
  <div
    class={compact ? 'mt-2' : 'c-sub mt-4 pt-3'}
    data-testid="audiobook-job"
    data-compact={compact ? 'true' : 'false'}
  >
    {#if !compact}
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h4 class="font-medium">Make an audiobook with this voice</h4>
          <p class="max-w-3xl text-sm text-c-muted">
            Your PC reads the whole book aloud and saves it, with subtitles that match it exactly,
            in the generated audiobooks folder; this book then uses it.
          </p>
        </div>
        {#if !job}
          <button
            class="c-btn c-btn-secondary shrink-0"
            aria-expanded={open}
            data-testid={open ? 'audiobook-job-cancel' : 'audiobook-job-open'}
            disabled={busy && !open}
            on:click={() => (open ? (open = false) : openForm())}
          >
            {open ? 'Close' : 'Set up'}
          </button>
        {/if}
      </div>
    {/if}

    {#if message && !compact}
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
        {compact ? 'Audiobook on the PC: ' : ''}{audiobookJobText(job, worker, now)}
      </p>
      {#if job.params && !compact}
        <p class="mt-1 text-sm text-c-muted" data-testid="audiobook-job-voice">
          {jobVoicesText(job.params)}, {job.params.model.label}{fixesUsed ? ` · ${fixesUsed}` : ''}
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
      {#if !compact}
        {#if active}
          <p class="mt-2 text-sm text-c-muted">
            This goes on when you leave this page and waits while the PC is off; it continues with
            the next chapter. A long book takes an hour or more.
          </p>
          <div class="mt-3">
            <button
              class="c-btn c-btn-secondary"
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
              class="c-btn c-btn-secondary"
              data-testid="audiobook-job-dismiss"
              on:click={() => (job = null)}
            >
              OK
            </button>
          </div>
        {/if}
      {/if}
    {:else if compact}
      {#if preview}
        <p class="mt-1 text-sm" role="status" data-testid="audiobook-preview-text">
          Preview on the PC: {audiobookJobText(preview, worker, now)}
        </p>
      {/if}
    {:else if open}
      {#if !usableChoice}
        <p class="mt-2 text-sm" data-testid="audiobook-job-no-voice">
          {choice?.problem
            ? `The TTS voice can't be used (${choice.problem}): choose it again above.`
            : 'Choose a TTS voice above first.'}
          No voices yet? Make one in
          <a class="c-link" href={settingsTabHref(pagePath, 'Audiobooks')}>Settings > Audiobooks</a
          >.
        </p>
      {:else}
        <div class="mt-2 grid max-w-xl gap-3">
          <p class="text-sm" data-testid="audiobook-job-reads-with">Reads with {choiceText}.</p>
          {#if speakers?.run}
            <p class="text-sm" data-testid="audiobook-job-characters">
              {#if voiced}
                Character voices: {voiced}
                {voiced === 1 ? 'character reads' : 'characters read'} their own quotes (Characters,
                below).
              {:else}
                No character has a voice of their own yet (Characters, below).
              {/if}
            </p>
          {/if}
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
            class="c-btn c-btn-secondary"
            data-testid="audiobook-preview-start"
            disabled={starting || busy || previewActive || !usableChoice}
            on:click={startPreview}
          >
            {preview?.state === 'done' ? 'Another preview' : 'Preview a minute'}
          </button>
          <button
            class="c-btn c-btn-secondary"
            data-testid="audiobook-job-start"
            disabled={starting || busy || !canStart || !chapters}
            on:click={start}
          >
            Make the audiobook
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
  .c-sub {
    border-top: var(--c-border-width) dashed var(--c-line);
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
