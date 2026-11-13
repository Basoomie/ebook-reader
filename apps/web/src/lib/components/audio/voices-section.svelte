<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP17: Settings > Audiobooks, "Voices": the voices an audiobook made on the PC can be
   * read in (stored on the server). A voice is either the user's own recording (the upload
   * asks to confirm it is their voice or its owner agreed, as the model's terms require) or
   * a voice described in words: the PC makes a short sample, the user listens and keeps it
   * or tries again. Also the pauses used in made audiobooks (for every device).
   */
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import type { GpuWorkerStatus } from '$lib/audio/audio-types';
  import {
    ttsChapterPauseMs$,
    ttsParagraphPauseMs$,
    ttsSentencePauseMs$
  } from '$lib/audio/tts-settings';
  import {
    audiobookJobText,
    modelsForDescriptions,
    ttsJobActive,
    voiceDetails
  } from '$lib/audio/tts-text';
  import type { AudiobookJob, TtsModel, VoiceList, VoicePreset } from '$lib/audio/tts-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { deleteVoiceCopy } from '$lib/confirm/confirm-copy';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import { onDestroy } from 'svelte';

  export let api: LibraryApi;

  const POLL_MS = 2000;

  let list: VoiceList | null = null;
  let models: TtsModel[] = [];
  let worker: GpuWorkerStatus | null = null;
  let error = '';
  let started = false;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let now = Date.now();

  // Playing a voice
  let playingId = '';
  let playUrl = '';

  // Your own recording
  let file: File | null = null;
  let fileInput: HTMLInputElement;
  let clipName = '';
  let consent = false;
  let uploading = false;
  let uploadProgress = 0;
  let uploadError = '';

  // Describe a voice
  let describeName = '';
  let description = '';
  let describeModelId: number | null = null;
  let sample: AudiobookJob | null = null;
  let sampleUrl = '';
  let describing = false;
  let describeError = '';
  let keeping = false;

  $: if (api && !started) {
    started = true;
    void load();
  }
  $: describeModels = modelsForDescriptions(models);
  $: if (describeModelId === null && describeModels.length) describeModelId = describeModels[0].id;
  $: sampleActive = ttsJobActive(sample);

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    if (playUrl) URL.revokeObjectURL(playUrl);
    if (sampleUrl) URL.revokeObjectURL(sampleUrl);
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function load() {
    try {
      const [v, m, w, s] = await Promise.all([
        api.voices(),
        api.ttsModels().catch(() => ({ available: false, models: [] })),
        api.gpuWorker().catch(() => null),
        api.latestVoiceSample().catch(() => null)
      ]);
      if (destroyed) return;
      list = v;
      models = m.models;
      worker = w;
      now = Date.now();
      // An unkept sample from the last day comes back (to keep it or try again).
      if (
        s &&
        (ttsJobActive(s) || (s.state === 'done' && now - (s.finishedAt ?? 0) < 86_400_000))
      ) {
        sample = s;
        if (s.state === 'done') void loadSample(s);
        else schedulePoll();
      }
      error = '';
    } catch (err) {
      if (!destroyed) error = describe(err);
    }
  }

  function schedulePoll() {
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), POLL_MS);
  }

  async function poll() {
    if (!sample) return;
    const watching = sample.id;
    try {
      const [s, w] = await Promise.all([
        api.latestVoiceSample(),
        api.gpuWorker().catch(() => worker)
      ]);
      if (destroyed) return;
      worker = w;
      now = Date.now();
      if (s && s.id === watching) {
        sample = s;
        if (s.state === 'done') void loadSample(s);
      }
    } catch {
      // Offline for a moment.
    }
    if (!destroyed && ttsJobActive(sample)) schedulePoll();
  }

  async function loadSample(s: AudiobookJob) {
    try {
      const blob = await api.ttsJobAudio(s.id);
      if (destroyed || sample?.id !== s.id) return;
      if (sampleUrl) URL.revokeObjectURL(sampleUrl);
      sampleUrl = URL.createObjectURL(blob);
    } catch {
      // Gone (an old sample): just no player.
    }
  }

  async function play(v: VoicePreset) {
    if (playingId === v.id && playUrl) return;
    try {
      const blob = await api.voiceClip(v.id);
      if (destroyed) return;
      if (playUrl) URL.revokeObjectURL(playUrl);
      playUrl = URL.createObjectURL(blob);
      playingId = v.id;
    } catch (err) {
      error = describe(err);
    }
  }

  async function remove(v: VoicePreset) {
    const ok = await confirmDestructive({
      ...deleteVoiceCopy(v.name),
      testid: 'voice-delete-confirm',
      confirmTestid: 'voice-delete-confirm-button'
    });
    if (!ok) return;
    try {
      await api.deleteVoice(v.id);
      if (playingId === v.id) playingId = '';
      list = await api.voices();
    } catch (err) {
      error = describe(err);
    }
  }

  async function upload() {
    if (!file || uploading) return;
    uploading = true;
    uploadError = '';
    uploadProgress = 0;
    try {
      await api.uploadVoice(file, clipName.trim(), consent, {
        onProgress: (sent: number, total: number) => {
          uploadProgress = total ? sent / total : 0;
        }
      });
      list = await api.voices();
      file = null;
      clipName = '';
      consent = false;
      if (fileInput) fileInput.value = '';
    } catch (err) {
      uploadError = describe(err);
    } finally {
      uploading = false;
    }
  }

  async function makeSample() {
    if (describing) return;
    describing = true;
    describeError = '';
    if (sampleUrl) URL.revokeObjectURL(sampleUrl);
    sampleUrl = '';
    try {
      sample = await api.startVoiceSample({
        name: describeName.trim(),
        description: description.trim(),
        modelId: describeModelId ?? undefined
      });
      worker = await api.gpuWorker().catch(() => worker);
      now = Date.now();
      schedulePoll();
    } catch (err) {
      describeError = describe(err);
    } finally {
      describing = false;
    }
  }

  async function keep() {
    if (!sample || keeping) return;
    keeping = true;
    describeError = '';
    try {
      await api.keepVoiceSample(sample.id);
      list = await api.voices();
      sample = null;
      if (sampleUrl) URL.revokeObjectURL(sampleUrl);
      sampleUrl = '';
      describeName = '';
      description = '';
    } catch (err) {
      describeError = describe(err);
    } finally {
      keeping = false;
    }
  }

  async function stopSample() {
    if (!sample) return;
    try {
      await api.cancelSubtitleJob(sample.id);
      sample = await api.latestVoiceSample();
    } catch (err) {
      describeError = describe(err);
    }
  }

  function onFile(ev: Event) {
    const input = ev.currentTarget as HTMLInputElement;
    file = input.files?.[0] ?? null;
    if (file && !clipName.trim()) clipName = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
  }
</script>

<section class="mt-10" aria-label="Voices" data-testid="voices">
  <SettingsSection
    jp="声"
    title="Voices"
    tooltip="The voices your PC can read a book aloud in (a book's page > Audiobook > Make an audiobook on the PC). Stored on the server, so every device has them."
  />
  {#if error}
    <p class="c-notice mt-4" role="alert" data-testid="voices-error">{error}</p>
  {/if}
  {#if list && !list.available}
    <p class="mt-4 text-[15px]" data-testid="voices-off">This server can't make audiobooks.</p>
  {:else if list}
    {#if list.voices.length === 0}
      <p class="mt-4 text-[15px]" data-testid="voices-empty">
        No voices yet. Add your own recording, or describe a voice below.
      </p>
    {:else}
      <ul class="mt-2 max-w-3xl" data-testid="voices-list">
        {#each list.voices as v (v.id)}
          <li
            class="c-vrow flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
            data-testid="voice"
            data-name={v.name}
          >
            <div class="min-w-0 grow basis-52">
              <div class="break-words font-mincho text-[15px] font-bold">{v.name}</div>
              <div class="text-sm text-c-muted" data-testid="voice-details">{voiceDetails(v)}</div>
              {#if v.description}
                <div class="break-words text-sm text-c-muted">“{v.description}”</div>
              {/if}
            </div>
            <button
              class="c-btn c-btn-secondary c-round"
              data-testid="voice-play"
              on:click={() => play(v)}
            >
              Listen
            </button>
            <button
              class="c-btn c-btn-secondary c-round"
              data-testid="voice-delete"
              on:click={() => remove(v)}
            >
              Delete
            </button>
            {#if playingId === v.id && playUrl}
              <!-- svelte-ignore a11y-media-has-caption -->
              <audio class="w-full" controls autoplay src={playUrl} data-testid="voice-audio" />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <div class="c-vpanel mt-6 max-w-3xl rounded px-5 py-4" data-testid="voice-upload">
      <h3 class="font-mincho text-lg font-bold">Add your own recording</h3>
      <p class="mt-1 text-sm text-c-muted">
        One clear speaker without music,
        {list.limits
          ? `${list.limits.minSeconds}–${list.limits.maxSeconds} seconds`
          : 'up to two minutes'}
        (about 30 seconds works well). The PC copies how this voice sounds.
      </p>
      <div class="mt-3 grid gap-3">
        <input
          bind:this={fileInput}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.m4b,.flac,.ogg"
          data-testid="voice-file"
          on:change={onFile}
        />
        <label class="grid gap-1 text-sm">
          <span class="text-c-muted">Name</span>
          <input
            class="c-input max-w-sm text-base"
            maxlength="60"
            bind:value={clipName}
            data-testid="voice-name"
          />
        </label>
        <label class="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            class="mt-1 h-5 w-5 shrink-0"
            bind:checked={consent}
            data-testid="voice-consent"
          />
          <span>
            This is my own voice, or the person whose voice it is agreed that it may be copied. The
            model's terms forbid copying anyone's voice without their consent.
          </span>
        </label>
      </div>
      {#if uploadError}
        <p class="c-notice mt-3" role="alert" data-testid="voice-upload-error">{uploadError}</p>
      {/if}
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <button
          class="c-btn c-btn-secondary c-round"
          data-testid="voice-upload-button"
          disabled={!file || !clipName.trim() || !consent || uploading}
          on:click={upload}
        >
          {uploading ? `Uploading… ${Math.floor(uploadProgress * 100)} %` : 'Add this voice'}
        </button>
      </div>
    </div>

    <div class="c-vpanel mt-4 max-w-3xl rounded px-5 py-4" data-testid="voice-describe">
      <h3 class="font-mincho text-lg font-bold">Describe a voice</h3>
      <p class="mt-1 text-sm text-c-muted">
        Write what the voice should sound like, in Japanese works best (e.g.
        「落ち着いた声の大人の女性が、丁寧に本を朗読している。」). The PC makes a short sample; keep
        it if you like it, or try again for another one.
      </p>
      {#if sample && sample.state !== 'cancelled' && sample.state !== 'failed'}
        <div class="mt-3" data-testid="voice-sample" data-state={sample.state}>
          <div class="font-mincho text-[15px] font-bold">{sample.params?.narrator.name ?? ''}</div>
          <p class="text-sm" role="status" aria-live="polite" data-testid="voice-sample-text">
            {audiobookJobText(sample, worker, now)}
          </p>
          {#if sampleUrl}
            <!-- svelte-ignore a11y-media-has-caption -->
            <audio class="mt-2 w-full" controls src={sampleUrl} data-testid="voice-sample-audio" />
          {/if}
          <div class="mt-3 flex flex-wrap gap-2">
            {#if sampleActive}
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="voice-sample-stop"
                on:click={stopSample}
              >
                Stop
              </button>
            {:else}
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="voice-sample-keep"
                disabled={keeping}
                on:click={keep}
              >
                Keep this voice
              </button>
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="voice-sample-again"
                disabled={describing}
                on:click={makeSample}
              >
                Try again
              </button>
            {/if}
          </div>
        </div>
      {:else}
        {#if sample?.state === 'failed' || sample?.state === 'cancelled'}
          <p class="c-notice mt-3" role="alert" data-testid="voice-sample-failed">
            {audiobookJobText(sample, worker, now)}
          </p>
        {/if}
        <div class="mt-3 grid gap-3">
          <label class="grid gap-1 text-sm">
            <span class="text-c-muted">Name</span>
            <input
              class="c-input max-w-sm text-base"
              maxlength="60"
              bind:value={describeName}
              data-testid="voice-describe-name"
            />
          </label>
          <label class="grid gap-1 text-sm">
            <span class="text-c-muted">Description</span>
            <textarea
              class="c-input min-h-[5rem] py-2 text-base"
              maxlength="300"
              bind:value={description}
              data-testid="voice-describe-text"
            />
          </label>
          {#if describeModels.length > 1}
            <label class="grid gap-1 text-sm">
              <span class="text-c-muted">Model</span>
              <select
                class="c-input block w-full max-w-sm text-base"
                bind:value={describeModelId}
                data-testid="voice-describe-model"
              >
                {#each describeModels as m (m.id)}
                  <option value={m.id}>{m.label}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
      {/if}
      {#if describeError}
        <p class="c-notice mt-3" role="alert" data-testid="voice-describe-error">{describeError}</p>
      {/if}
      {#if !sample || sample.state === 'failed' || sample.state === 'cancelled'}
        <div class="mt-3">
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="voice-describe-button"
            disabled={!describeName.trim() || !description.trim() || describing}
            on:click={makeSample}
          >
            Make a sample
          </button>
        </div>
      {/if}
    </div>

    <div class="c-vpanel mt-4 max-w-3xl rounded px-5 py-4" data-testid="tts-pauses">
      <h3 class="font-mincho text-lg font-bold">Pauses in made audiobooks</h3>
      <p class="mt-1 text-sm text-c-muted">
        In milliseconds (1000 = one second). Used for audiobooks and previews started from now on.
      </p>
      <div class="mt-3 grid gap-3 sm:grid-cols-3">
        <label class="grid gap-1 text-sm">
          <span class="text-c-muted">After a sentence</span>
          <input
            class="c-input text-base"
            type="number"
            min="0"
            max="10000"
            step="50"
            bind:value={$ttsSentencePauseMs$}
            data-testid="tts-pause-sentence"
          />
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-c-muted">After a paragraph</span>
          <input
            class="c-input text-base"
            type="number"
            min="0"
            max="10000"
            step="50"
            bind:value={$ttsParagraphPauseMs$}
            data-testid="tts-pause-paragraph"
          />
        </label>
        <label class="grid gap-1 text-sm">
          <span class="text-c-muted">After a chapter</span>
          <input
            class="c-input text-base"
            type="number"
            min="0"
            max="10000"
            step="100"
            bind:value={$ttsChapterPauseMs$}
            data-testid="tts-pause-chapter"
          />
        </label>
      </div>
    </div>
  {/if}
</section>

<style>
  .c-vpanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-vrow + .c-vrow {
    border-top: 1px dashed var(--c-line);
  }

  .c-round {
    border-radius: 0.75rem;
  }
</style>
