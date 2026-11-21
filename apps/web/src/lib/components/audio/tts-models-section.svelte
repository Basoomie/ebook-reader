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
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
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
  <SettingsGroup id="audio-models" testid="tts-models">
    <svelte:fragment slot="before">
      {#if error}
        <p class="c-notice mb-3" role="alert" data-testid="tts-models-error">{error}</p>
      {/if}
    </svelte:fragment>
    {#if models.length === 0}
      <p class="px-5 py-4" data-testid="tts-models-empty">No models. Add one below.</p>
    {:else}
      <div>
        <ul data-testid="tts-models-list">
          {#each models as m (m.id)}
            <li class="s-item" data-testid="tts-model" data-source={m.source}>
              <div class="s-item-main">
                <div class="flex flex-wrap items-center gap-2 font-mincho text-[15px] font-bold">
                  {m.label}
                  {#if m.isDefault}<span class="c-count font-sans">Default</span>{/if}
                </div>
                {#if m.note}
                  <div class="text-sm" data-testid="tts-model-note">{m.note}</div>
                {/if}
                <div class="break-all text-xs text-c-muted">{modelSourceText(m)}</div>
              </div>
              <div class="s-item-actions">
                {#if !m.isDefault}
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    data-testid="tts-model-default"
                    on:click={() => makeDefault(m)}
                  >
                    Make default
                  </button>
                {/if}
                <button
                  class="c-btn c-btn-secondary c-btn-sm"
                  data-testid="tts-model-remove"
                  on:click={() => remove(m)}
                >
                  Remove…
                </button>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    <SettingRow
      title="Add a model"
      description="By its Hugging Face name. Irodori-TTS models work; a newer Irodori version may need the PC's program updated first (its preview says so). The PC downloads a model the first time it is used, into one folder shared by every Windows account."
      layout="stack"
    >
      <div class="flex flex-wrap items-center gap-2">
        <input
          class="c-input min-w-0 flex-1 basis-60 text-base"
          placeholder="Aratako/Irodori-TTS-v4.1-Small"
          aria-label="Hugging Face name of the model"
          bind:value={source}
          data-testid="tts-model-source"
          on:keydown={(e) => e.key === 'Enter' && add()}
        />
        <button
          class="c-btn c-btn-secondary"
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
    </SettingRow>
  </SettingsGroup>
{/if}
