<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP17: Settings > Audiobooks, "Models on the PC": the models a book can be read with
   * (decided with the user: chosen per book, list editable). A model is added by its
   * Hugging Face name; the server records its current version, so it can't change under a
   * book later. The PC downloads a model once (shared by every Windows account) and
   * deletes its files after it is removed here. The default is chosen first on a book page.
   */
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import { modelSourceText } from '$lib/audio/tts-text';
  import type { TtsModel } from '$lib/audio/tts-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeTtsModelCopy } from '$lib/confirm/confirm-copy';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;

  let available = true;
  let models: TtsModel[] = [];
  let loaded = false;
  let error = '';
  let source = '';
  let adding = false;
  let addError = '';
  let started = false;

  $: if (api && !started) {
    started = true;
    void load();
  }

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')) {
      return 'The library server cannot be reached (offline, or the server is down).';
    }
    return (err as Error).message;
  }

  async function load() {
    try {
      const r = await api.ttsModels();
      available = r.available;
      models = r.models;
      loaded = true;
      error = '';
    } catch (err) {
      error = describe(err);
    }
  }

  async function add() {
    if (adding || !source.trim()) return;
    adding = true;
    addError = '';
    try {
      await api.addTtsModel(source.trim());
      source = '';
      await load();
    } catch (err) {
      addError = describe(err);
    } finally {
      adding = false;
    }
  }

  async function remove(m: TtsModel) {
    const ok = await confirmDestructive({
      ...removeTtsModelCopy(m.label),
      testid: 'tts-model-remove-confirm',
      confirmTestid: 'tts-model-remove-confirm-button'
    });
    if (!ok) return;
    try {
      await api.removeTtsModel(m.id);
      await load();
    } catch (err) {
      error = describe(err);
    }
  }

  async function makeDefault(m: TtsModel) {
    try {
      models = await api.setDefaultTtsModel(m.id);
    } catch (err) {
      error = describe(err);
    }
  }
</script>

{#if loaded && available}
  <section class="mt-10" aria-label="Models on the PC" data-testid="tts-models">
    <SettingsSection
      jp="モデル"
      title="Models on the PC"
      tooltip="The speech models your PC can read a book with. You choose one per book. The PC downloads a model the first time it is used, into one folder shared by every Windows account."
    />
    {#if error}
      <p class="c-notice mt-4" role="alert" data-testid="tts-models-error">{error}</p>
    {/if}
    {#if models.length === 0}
      <p class="mt-4 text-[15px]" data-testid="tts-models-empty">No models. Add one below.</p>
    {:else}
      <ul class="mt-2 max-w-3xl" data-testid="tts-models-list">
        {#each models as m (m.id)}
          <li
            class="c-mrow flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
            data-testid="tts-model"
            data-source={m.source}
          >
            <div class="min-w-0 grow basis-60">
              <div class="break-words font-mincho text-[15px] font-bold">
                {m.label}{m.isDefault ? ' · default' : ''}
              </div>
              {#if m.note}
                <div class="text-sm" data-testid="tts-model-note">{m.note}</div>
              {/if}
              <div class="break-all text-xs text-c-muted">{modelSourceText(m)}</div>
            </div>
            {#if !m.isDefault}
              <button
                class="c-btn c-btn-secondary c-round"
                data-testid="tts-model-default"
                on:click={() => makeDefault(m)}
              >
                Make default
              </button>
            {/if}
            <button
              class="c-btn c-btn-secondary c-round"
              data-testid="tts-model-remove"
              on:click={() => remove(m)}
            >
              Remove
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="mt-4 flex max-w-3xl flex-wrap items-end gap-3">
      <label class="grid min-w-0 grow gap-1 text-sm">
        <span class="text-c-muted">Add a model by its Hugging Face name</span>
        <input
          class="c-input text-base"
          placeholder="Aratako/Irodori-TTS-v4.1-Small"
          bind:value={source}
          data-testid="tts-model-source"
          on:keydown={(e) => e.key === 'Enter' && add()}
        />
      </label>
      <button
        class="c-btn c-btn-secondary c-round"
        data-testid="tts-model-add"
        disabled={adding || !source.trim()}
        on:click={add}
      >
        {adding ? 'Adding…' : 'Add'}
      </button>
    </div>
    {#if addError}
      <p class="c-notice mt-3" role="alert" data-testid="tts-model-add-error">{addError}</p>
    {/if}
    <p class="mt-2 max-w-3xl text-sm text-c-muted">
      Irodori-TTS models work. A newer Irodori version may need the PC's program updated first; if
      so, its preview says so.
    </p>
  </section>
{/if}

<style>
  .c-mrow + .c-mrow {
    border-top: 1px dashed var(--c-line);
  }

  .c-round {
    border-radius: 0.75rem;
  }
</style>
