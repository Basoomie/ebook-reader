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
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import PagedList from '$lib/components/settings/paged-list.svelte';
  import { compareText, type ListSort } from '$lib/settings/paged-list';
  import type { GpuWorkerStatus } from '$lib/audio/audio-types';
  import {
    ttsChapterPauseMs$,
    ttsDialoguePauseMs$,
    ttsParagraphPauseMs$,
    ttsSentencePauseMs$
  } from '$lib/audio/tts-settings';
  import {
    audiobookJobText,
    jobVoices,
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

  // The server's order first (as the list was), or by name.
  const voiceSorts: ListSort<VoicePreset>[] = [
    { id: 'server', label: 'As added', compare: () => 0 },
    { id: 'name', label: 'Name', compare: (a, b) => compareText(a.name, b.name) }
  ];

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

<SettingsGroup id="audio-voices" testid="voices">
  <svelte:fragment slot="before">
    {#if error}
      <p class="c-notice mb-3" role="alert" data-testid="voices-error">{error}</p>
    {/if}
  </svelte:fragment>
  {#if list && !list.available}
    <p class="px-5 py-4" data-testid="voices-off">This server can't make audiobooks.</p>
  {:else if list}
    {#if list.voices.length === 0}
      <p class="px-5 py-4" data-testid="voices-empty">
        No voices yet. Add your own recording, or describe a voice below.
      </p>
    {:else}
      <PagedList
        items={list.voices}
        pageSize={8}
        text={(v) => `${v.name} ${v.description ?? ''}`}
        searchLabel="Search voices"
        sorts={voiceSorts}
        label="Voices"
        let:rows
      >
        <ul data-testid="voices-list">
          {#each rows as v (v.id)}
            <li class="s-item" data-testid="voice" data-name={v.name}>
              <div class="s-item-main">
                <div class="s-item-title font-mincho text-[15px]">{v.name}</div>
                <div class="s-item-meta" data-testid="voice-details">{voiceDetails(v)}</div>
                {#if v.description}
                  <div class="s-item-meta">“{v.description}”</div>
                {/if}
              </div>
              <div class="s-item-actions">
                <button
                  class="c-btn c-btn-secondary c-btn-sm"
                  data-testid="voice-play"
                  on:click={() => play(v)}
                >
                  Listen
                </button>
                <button
                  class="c-btn c-btn-secondary c-btn-sm"
                  data-testid="voice-delete"
                  on:click={() => remove(v)}
                >
                  Delete…
                </button>
              </div>
              {#if playingId === v.id && playUrl}
                <!-- svelte-ignore a11y-media-has-caption -->
                <audio class="w-full" controls autoplay src={playUrl} data-testid="voice-audio" />
              {/if}
            </li>
          {/each}
        </ul>
      </PagedList>
    {/if}

    <details class="s-fold" data-testid="voice-upload">
      <summary id="setting-voice-upload">Add your own recording</summary>
      <div class="s-fold-body">
        <p class="text-sm text-c-muted">
          One clear speaker without music,
          {list.limits
            ? `${list.limits.minSeconds}–${list.limits.maxSeconds} seconds`
            : 'up to two minutes'}
          (about 30 seconds works well). The PC copies how this voice sounds.
        </p>
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
            class="c-input w-full text-base sm:w-80"
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
        {#if uploadError}
          <p class="c-notice" role="alert" data-testid="voice-upload-error">{uploadError}</p>
        {/if}
        <div>
          <button
            class="c-btn c-btn-secondary"
            data-testid="voice-upload-button"
            disabled={!file || !clipName.trim() || !consent || uploading}
            on:click={upload}
          >
            {uploading ? `Uploading… ${Math.floor(uploadProgress * 100)} %` : 'Add this voice'}
          </button>
        </div>
      </div>
    </details>

    <details class="s-fold" data-testid="voice-describe" open={!!sample}>
      <summary id="setting-voice-describe">Describe a voice</summary>
      <div class="s-fold-body">
        <p class="text-sm text-c-muted">
          Write what the voice should sound like, in Japanese works best (e.g.
          「落ち着いた声の大人の女性が、丁寧に本を朗読している。」). The PC makes a short sample;
          keep it if you like it, or try again for another one.
        </p>
        {#if sample && sample.state !== 'cancelled' && sample.state !== 'failed'}
          <div data-testid="voice-sample" data-state={sample.state}>
            <div class="font-mincho text-[15px] font-bold">
              {jobVoices(sample.params)?.narration ?? ''}
            </div>
            <p class="text-sm" role="status" aria-live="polite" data-testid="voice-sample-text">
              {audiobookJobText(sample, worker, now)}
            </p>
            {#if sampleUrl}
              <!-- svelte-ignore a11y-media-has-caption -->
              <audio
                class="mt-2 w-full"
                controls
                src={sampleUrl}
                data-testid="voice-sample-audio"
              />
            {/if}
            <div class="mt-3 flex flex-wrap gap-2">
              {#if sampleActive}
                <button
                  class="c-btn c-btn-secondary"
                  data-testid="voice-sample-stop"
                  on:click={stopSample}
                >
                  Stop
                </button>
              {:else}
                <button
                  class="c-btn c-btn-secondary"
                  data-testid="voice-sample-keep"
                  disabled={keeping}
                  on:click={keep}
                >
                  Keep this voice
                </button>
                <button
                  class="c-btn c-btn-secondary"
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
            <p class="c-notice" role="alert" data-testid="voice-sample-failed">
              {audiobookJobText(sample, worker, now)}
            </p>
          {/if}
          <label class="grid gap-1 text-sm">
            <span class="text-c-muted">Name</span>
            <input
              class="c-input w-full text-base sm:w-80"
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
                class="c-input block w-full text-base sm:w-80"
                bind:value={describeModelId}
                data-testid="voice-describe-model"
              >
                {#each describeModels as m (m.id)}
                  <option value={m.id}>{m.label}</option>
                {/each}
              </select>
            </label>
          {/if}
        {/if}
        {#if describeError}
          <p class="c-notice" role="alert" data-testid="voice-describe-error">{describeError}</p>
        {/if}
        {#if !sample || sample.state === 'failed' || sample.state === 'cancelled'}
          <div>
            <button
              class="c-btn c-btn-secondary"
              data-testid="voice-describe-button"
              disabled={!describeName.trim() || !description.trim() || describing}
              on:click={makeSample}
            >
              Make a sample
            </button>
          </div>
        {/if}
      </div>
    </details>
  {/if}
</SettingsGroup>

{#if list?.available}
  <SettingsGroup id="audio-pauses" testid="tts-pauses">
    <SettingRow id="pause-sentence" settingKey="ttsSentencePauseMs" let:labelId>
      <SettingField unit="ms">
        <input
          type="number"
          min="0"
          max="10000"
          step="50"
          aria-labelledby={labelId}
          bind:value={$ttsSentencePauseMs$}
          data-testid="tts-pause-sentence"
        />
      </SettingField>
    </SettingRow>
    <SettingRow id="pause-paragraph" settingKey="ttsParagraphPauseMs" let:labelId>
      <SettingField unit="ms">
        <input
          type="number"
          min="0"
          max="10000"
          step="50"
          aria-labelledby={labelId}
          bind:value={$ttsParagraphPauseMs$}
          data-testid="tts-pause-paragraph"
        />
      </SettingField>
    </SettingRow>
    <SettingRow id="pause-chapter" settingKey="ttsChapterPauseMs" let:labelId>
      <SettingField unit="ms">
        <input
          type="number"
          min="0"
          max="10000"
          step="100"
          aria-labelledby={labelId}
          bind:value={$ttsChapterPauseMs$}
          data-testid="tts-pause-chapter"
        />
      </SettingField>
    </SettingRow>
    <SettingRow id="pause-dialogue" settingKey="ttsDialoguePauseMs" let:labelId>
      <SettingField unit="ms">
        <input
          type="number"
          min="0"
          max="10000"
          step="50"
          aria-labelledby={labelId}
          bind:value={$ttsDialoguePauseMs$}
          data-testid="tts-pause-dialogue"
        />
      </SettingField>
    </SettingRow>
  </SettingsGroup>
{/if}

<style>
  .s-fold > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 3rem;
    padding: 0.75rem 1rem;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }

  @media (min-width: 640px) {
    .s-fold > summary {
      padding: 0.75rem 1.25rem;
    }

    .s-fold-body {
      padding: 0 1.25rem 1.25rem;
    }
  }

  .s-fold > summary::-webkit-details-marker {
    display: none;
  }

  .s-fold > summary::after {
    content: '+';
    font-size: 1.25rem;
    font-weight: 400;
    color: var(--c-muted);
  }

  .s-fold[open] > summary::after {
    content: '−';
  }

  .s-fold > summary:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: -2px;
  }

  .s-fold-body {
    display: grid;
    gap: 0.75rem;
    padding: 0 1rem 1rem;
  }
</style>
