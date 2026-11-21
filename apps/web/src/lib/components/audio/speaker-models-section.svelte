<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12 session 5: Settings > Audiobooks, "Speaker models on the PC": the models
   * that work out who speaks each quote (decided with the user: an editable list, like the
   * speech models, chosen per run on a book's page; the default first). A model is one GGUF
   * file of a Hugging Face repo; the server pins its version and records the file's size and
   * checksum, so the PC can check its download. The PC deletes a removed model's file.
   * Also the bar under which a quote's speaker counts as unsure (every device).
   */
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import type { SpeakerModel } from '$lib/audio/speakers/speaker-types';
  import { speakerUnsureBelow$ } from '$lib/audio/tts-settings';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeSpeakerModelCopy } from '$lib/confirm/confirm-copy';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;

  let available = false;
  let models: SpeakerModel[] = [];
  let error = '';
  let repo = '';
  let file = '';
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
      const r = await api.speakerModels();
      available = r.available;
      models = r.models;
      error = '';
    } catch (err) {
      error = describe(err);
    }
  }

  async function add() {
    if (adding || !repo.trim() || !file.trim()) return;
    adding = true;
    addError = '';
    try {
      await api.addSpeakerModel(repo.trim(), file.trim());
      repo = '';
      file = '';
      await load();
    } catch (err) {
      addError = describe(err);
    } finally {
      adding = false;
    }
  }

  async function remove(m: SpeakerModel) {
    const ok = await confirmDestructive({
      ...removeSpeakerModelCopy(m.label),
      testid: 'speaker-model-remove-confirm',
      confirmTestid: 'speaker-model-remove-confirm-button'
    });
    if (!ok) return;
    try {
      await api.removeSpeakerModel(m.id);
      await load();
    } catch (err) {
      error = describe(err);
    }
  }

  async function makeDefault(m: SpeakerModel) {
    try {
      await api.setDefaultSpeakerModel(m.id);
      await load();
    } catch (err) {
      error = describe(err);
    }
  }

  const sizeText = (bytes: number | null) =>
    bytes === null
      ? ''
      : ` · ${(bytes / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB`;
</script>

{#if available}
  <SettingsGroup id="audio-speakers" testid="speaker-models">
    <svelte:fragment slot="before">
      {#if error}
        <p class="c-notice mb-3" role="alert" data-testid="speaker-models-error">{error}</p>
      {/if}
    </svelte:fragment>
    {#if models.length === 0}
      <p class="px-5 py-4" data-testid="speaker-models-empty">No models. Add one below.</p>
    {:else}
      <ul data-testid="speaker-models-list">
        {#each models as m (m.id)}
          <li class="s-item" data-testid="speaker-model" data-repo={m.repo}>
            <div class="s-item-main">
              <div class="flex flex-wrap items-center gap-2 font-mincho text-[15px] font-bold">
                {m.label}
                {#if m.isDefault}<span class="c-count font-sans">Default</span>{/if}
              </div>
              <div class="break-all text-xs text-c-muted">
                {m.repo} · {m.file} · {m.revision.slice(0, 8)}{sizeText(m.size)}
              </div>
            </div>
            <div class="s-item-actions">
              {#if !m.isDefault}
                <button
                  class="c-btn c-btn-secondary c-btn-sm"
                  data-testid="speaker-model-default"
                  on:click={() => makeDefault(m)}
                >
                  Make default
                </button>
              {/if}
              <button
                class="c-btn c-btn-secondary c-btn-sm"
                data-testid="speaker-model-remove"
                on:click={() => remove(m)}
              >
                Remove…
              </button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <SettingRow
      title="Add a model"
      description="Any chat model in GGUF form that llama.cpp runs. It must fit the PC: Gemma 4 26B A4B uses nearly all of a 12 GB graphics card and about 16 GB of Docker's memory. You choose one each time on a book's page (Characters)."
      layout="stack"
    >
      <div class="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label class="grid min-w-0 gap-1 text-sm">
          <span class="text-c-muted">Hugging Face repo</span>
          <input
            class="c-input text-base"
            placeholder="unsloth/gemma-4-26B-A4B-it-GGUF"
            bind:value={repo}
            data-testid="speaker-model-repo"
          />
        </label>
        <label class="grid min-w-0 gap-1 text-sm">
          <span class="text-c-muted">File (.gguf)</span>
          <input
            class="c-input text-base"
            placeholder="gemma-4-26B-A4B-it-UD-IQ4_XS.gguf"
            bind:value={file}
            data-testid="speaker-model-file"
            on:keydown={(e) => e.key === 'Enter' && add()}
          />
        </label>
        <button
          class="c-btn c-btn-secondary"
          data-testid="speaker-model-add"
          disabled={adding || !repo.trim() || !file.trim()}
          on:click={add}
        >
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
      {#if addError}
        <p class="c-notice mt-3" role="alert" data-testid="speaker-model-add-error">{addError}</p>
      {/if}
    </SettingRow>
    <SettingRow id="speaker-unsure" settingKey="speakerUnsureBelow" let:labelId>
      <SettingField unit="%">
        <input
          type="number"
          min="1"
          max="100"
          step="1"
          aria-labelledby={labelId}
          bind:value={$speakerUnsureBelow$}
          data-testid="speaker-unsure-below"
        />
      </SettingField>
    </SettingRow>
  </SettingsGroup>
{/if}
