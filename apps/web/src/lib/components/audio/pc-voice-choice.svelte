<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: the voice and model the PC reads a book's sentences with, for Enrich
   * when the book has no audiobook (decided with the user, 2026-11-14/15). One choice for
   * every book (Settings > Anki; Off by default) and, on a book's page, one for that book
   * ("Same as in Settings" by default); "Make an audiobook on the PC" starts from it. Stored
   * on the server, so every device has the same; a change is saved at once.
   *
   * Session 4 (decided with the user, 2026-11-16): a "Dialogue voice" beside it ("Same as
   * the voice" by default): quotes in 「」 are read with it in audiobooks made on the PC,
   * read-aloud and Anki's sentence audio.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import { modelsForVoices } from '$lib/audio/tts-text';
  import type { BookVoiceChoices, TtsModel, VoiceChoice, VoicePreset } from '$lib/audio/tts-types';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;
  /** null: the choice for every book (Settings > Anki). */
  export let bookId: string | null = null;
  export let testid = 'pc-voice-choice';

  const dispatch = createEventDispatcher<{ changed: BookVoiceChoices | null }>();
  const selectClasses = 'c-input mt-1 block min-h-[3rem] w-full max-w-[18rem] text-base';

  let loaded = false;
  let available = true;
  let error = '';
  let saving = false;
  let saved = '';
  let voices: VoicePreset[] = [];
  let models: TtsModel[] = [];
  let own: VoiceChoice | null = null;
  let global: VoiceChoice | null = null;
  /** '' = off (every book) / same as Settings (a book). */
  let voiceId = '';
  /** '' = the same voice reads the dialogue. */
  let dialogueVoiceId = '';
  let modelId: number | null = null;

  $: usable = modelsForVoices(models);
  $: problem = own?.problem ?? null;
  $: sameText = global
    ? `Same as in Settings > Anki (${global.voiceName ?? 'a deleted voice'}${
        global.dialogueVoiceId ? `, dialogue ${global.dialogueVoiceName ?? 'a deleted voice'}` : ''
      }, ${global.modelLabel ?? 'a removed model'})`
    : 'Same as in Settings > Anki (off)';

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error)?.message ?? String(err);
  }

  function show(choice: VoiceChoice | null) {
    own = choice;
    voiceId = choice?.voiceId ?? '';
    dialogueVoiceId = choice?.dialogueVoiceId ?? '';
    modelId = choice?.modelId ?? modelsForVoices(models)[0]?.id ?? null;
  }

  async function load() {
    try {
      const [voiceList, modelList] = await Promise.all([api.voices(), api.ttsModels()]);
      voices = voiceList.voices;
      models = modelList.models;
      if (!voiceList.available || !modelList.available) {
        available = false;
        return;
      }
      if (bookId) {
        const choices = await api.bookVoiceChoice(bookId);
        global = choices.global;
        show(choices.book);
      } else {
        show(await api.voiceChoice());
      }
      error = '';
    } catch (err) {
      if (err instanceof LibraryApiError && (err.status === 404 || err.status === 503)) {
        available = false;
      } else {
        error = describe(err);
      }
    } finally {
      loaded = true;
    }
  }

  async function save() {
    saving = true;
    saved = '';
    error = '';
    const choice =
      voiceId && modelId !== null
        ? {
            voiceId,
            dialogueVoiceId:
              dialogueVoiceId && dialogueVoiceId !== voiceId ? dialogueVoiceId : null,
            modelId
          }
        : null;
    try {
      if (bookId) {
        const choices = await api.setBookVoiceChoice(bookId, choice);
        global = choices.global;
        show(choices.book);
        dispatch('changed', choices);
      } else {
        show(await api.setVoiceChoice(choice));
        dispatch('changed', null);
      }
      saved = 'Saved.';
    } catch (err) {
      error = describe(err);
    } finally {
      saving = false;
    }
  }

  function onVoice(event: Event) {
    voiceId = (event.currentTarget as HTMLSelectElement).value;
    const list = modelsForVoices(models);
    if (voiceId && (modelId === null || !list.some((m) => m.id === modelId))) {
      modelId = list[0]?.id ?? null;
    }
    void save();
  }

  function onDialogue(event: Event) {
    dialogueVoiceId = (event.currentTarget as HTMLSelectElement).value;
    void save();
  }

  function onModel(event: Event) {
    modelId = Number((event.currentTarget as HTMLSelectElement).value);
    void save();
  }

  onMount(load);
</script>

<div data-testid={testid}>
  {#if !loaded}
    <p class="mt-2 text-sm text-c-muted">Loading the PC voices…</p>
  {:else if !available}
    <p class="mt-2 text-sm text-c-muted" data-testid="{testid}-unavailable">
      The library server can't read with the PC (voices and models aren't set up there).
    </p>
  {:else}
    <label class="mt-2 block text-sm text-c-muted">
      {bookId ? 'PC voice for this book' : 'Voice'}
      <select
        class={selectClasses}
        data-testid="{testid}-voice"
        value={voiceId}
        disabled={saving}
        on:change={onVoice}
      >
        <option value="">{bookId ? sameText : 'Off'}</option>
        {#each voices as v (v.id)}
          <option value={v.id}>{v.name}</option>
        {/each}
        {#if own && !voices.some((v) => v.id === own?.voiceId)}
          <option value={own.voiceId}>A deleted voice</option>
        {/if}
      </select>
    </label>
    {#if voiceId}
      <label class="mt-3 block text-sm text-c-muted">
        Dialogue voice
        <select
          class={selectClasses}
          data-testid="{testid}-dialogue"
          value={dialogueVoiceId}
          disabled={saving}
          on:change={onDialogue}
        >
          <option value="">Same as the voice</option>
          {#each voices.filter((v) => v.id !== voiceId) as v (v.id)}
            <option value={v.id}>{v.name}</option>
          {/each}
          {#if own?.dialogueVoiceId && !voices.some((v) => v.id === own?.dialogueVoiceId)}
            <option value={own.dialogueVoiceId}>A deleted voice</option>
          {/if}
        </select>
        <span class="mt-1 block text-xs">Reads quotes in 「」.</span>
      </label>
      <label class="mt-3 block text-sm text-c-muted">
        Model
        <select
          class={selectClasses}
          data-testid="{testid}-model"
          value={modelId === null ? '' : String(modelId)}
          disabled={saving}
          on:change={onModel}
        >
          {#each usable as m (m.id)}
            <option value={String(m.id)}>{m.label}</option>
          {/each}
          {#if own && modelId !== null && !usable.some((m) => m.id === modelId)}
            <option value={String(modelId)}>A removed model</option>
          {/if}
        </select>
      </label>
    {/if}
    {#if !voices.length}
      <p class="mt-2 text-sm text-c-muted" data-testid="{testid}-no-voices">
        No voices yet: make one in Settings > Audiobooks ("Describe a voice" or your own clip).
      </p>
    {/if}
    {#if problem}
      <p class="c-notice mt-2 text-sm" role="alert" data-testid="{testid}-problem">
        {problem.charAt(0).toUpperCase() + problem.slice(1)}: choose again.
      </p>
    {/if}
  {/if}
  {#if error}
    <p class="c-notice mt-2 text-sm" role="alert" data-testid="{testid}-error">{error}</p>
  {:else if saved}
    <p class="mt-2 text-sm text-c-muted" role="status" data-testid="{testid}-saved">{saved}</p>
  {/if}
</div>
