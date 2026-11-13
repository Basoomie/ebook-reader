<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Settings tab of /cleanup (WP20a). Everything is kept on the server: the Calibre
   * content server with its user and password, the library to clean (the content server's
   * id for it is found automatically from the server's own list; asked only when it can't
   * be told), your own tags, pacing, the accuracy threshold, and the AI keys and models
   * (stored now, used by later stages). One Save saves all of it. The password and keys are
   * write-only: the page never gets them back, only whether one is saved (and the last
   * 4 characters of an API key).
   *
   * The app compiles with `immutable: true`, so values the template shows are always
   * replaced, never changed in place.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import type {
    CleanupApi,
    CleanupSettings,
    CleanupStatus,
    SecretInfo,
    SecretName
  } from '$lib/cleanup/cleanup-api';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeCleanupSecretCopy } from '$lib/confirm/confirm-copy';
  import { formatWhen } from '$lib/notes/notes-format';

  export let api: CleanupApi;
  export let libraries: { id: string; name: string; folder: string }[] = [];
  /** The content server's libraries and the one in use (from the status). */
  export let calibre: CleanupStatus['calibre'] | null = null;

  const dispatch = createEventDispatcher<{ saved: void }>();

  const KEYS: { name: SecretName; label: string }[] = [
    { name: 'anthropicApiKey', label: 'Anthropic API key' },
    { name: 'openaiApiKey', label: 'OpenAI API key' }
  ];

  const MODEL_LABELS: Record<string, string> = {
    'stage4.primary': 'Online sources: first model',
    'stage4.secondary': 'Online sources: second model',
    'stage4.upgradePrimary': 'Online sources: upgrade, first model',
    'stage4.upgradeSecondary': 'Online sources: upgrade, second model',
    'stage5.primary': 'Genres and tags: first model',
    'stage5.secondary': 'Genres and tags: second model'
  };

  let settings: CleanupSettings | null = null;
  let secrets: Record<SecretName, SecretInfo> | null = null;
  let loadError = '';
  let saveError = '';
  let saved = false;
  let saving = false;
  let secretValues: Record<SecretName, string> = {
    calibrePassword: '',
    anthropicApiKey: '',
    openaiApiKey: ''
  };
  let customTagsText = '';
  /** The content server library chosen by hand ('' = found automatically). */
  let serverLibrary = '';

  $: needsServerLibrary =
    !!calibre && calibre.libraries.length > 1 && (calibre.id === null || !calibre.auto);

  onMount(load);

  async function load() {
    try {
      const answer = await api.settings();
      settings = answer.settings;
      secrets = answer.secrets;
      customTagsText = settings.customTags.join('\n');
      serverLibrary = settings.calibreLibraryId;
      loadError = '';
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  function setSecretValue(name: SecretName, value: string) {
    secretValues = { ...secretValues, [name]: value };
    saved = false;
  }

  /** Saves the settings and every password or key that was typed. */
  async function save() {
    if (!settings) return;
    saving = true;
    saveError = '';
    saved = false;
    try {
      const answer = await api.saveSettings({
        contentServerUrl: settings.contentServerUrl,
        calibreLibraryId: serverLibrary,
        calibreUsername: settings.calibreUsername,
        targetLibraryId: settings.targetLibraryId || null,
        models: settings.models,
        pacing: {
          hashMbPerSecond: Number(settings.pacing.hashMbPerSecond),
          itemDelaySeconds: Number(settings.pacing.itemDelaySeconds),
          batchSize: Number(settings.pacing.batchSize),
          maxBatchPercent: Number(settings.pacing.maxBatchPercent)
        },
        customTags: customTagsText
          .split(/\r?\n/)
          .map((t) => t.trim())
          .filter(Boolean),
        gateThresholdPercent: Number(settings.gateThresholdPercent),
        reviewAlarmPercent: Number(settings.reviewAlarmPercent),
        libraryChangedPausePercent: Number(settings.libraryChangedPausePercent)
      });
      settings = answer.settings;
      secrets = answer.secrets;
      customTagsText = settings.customTags.join('\n');
      for (const name of Object.keys(secretValues) as SecretName[]) {
        const value = secretValues[name];
        if (!value.trim()) continue;
        secrets = (await api.saveSecret(name, value)).secrets;
        secretValues = { ...secretValues, [name]: '' };
      }
      saved = true;
      dispatch('saved');
    } catch (err) {
      saveError = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  async function removeSecret(name: SecretName, label: string) {
    if (!(await confirmDestructive(removeCleanupSecretCopy(label)))) return;
    try {
      secrets = (await api.removeSecret(name)).secrets;
      dispatch('saved');
    } catch (err) {
      saveError = (err as Error).message;
    }
  }

  function secretState(info: SecretInfo | undefined): string {
    if (!info?.set) return 'Not saved yet';
    const when = info.updatedAt ? ` ${formatWhen(info.updatedAt)}` : '';
    return info.hint ? `Saved${when} · ends in ${info.hint}` : `Saved${when}`;
  }

  const field = 'flex flex-col gap-1 text-sm';
  const label = 'font-medium';
  const legend = 'mb-2 font-mincho text-lg font-bold';
</script>

{#if loadError}
  <p class="c-notice" role="alert">{loadError}</p>
{:else if settings && secrets}
  <form class="flex flex-col gap-10" on:submit|preventDefault={save} data-testid="cleanup-settings">
    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Calibre content server</legend>
      <label class="{field} sm:col-span-2">
        <span class={label}>Address</span>
        <input
          class="c-input"
          type="url"
          placeholder="http://192.168.1.5:8083"
          bind:value={settings.contentServerUrl}
          data-testid="cleanup-content-server"
        />
      </label>
      <label class={field}>
        <span class={label}>User</span>
        <input
          class="c-input"
          autocomplete="off"
          bind:value={settings.calibreUsername}
          data-testid="cleanup-username"
        />
      </label>
      <div class={field}>
        <label class={field}>
          <span class={label}>Password</span>
          <input
            class="c-input"
            type="password"
            autocomplete="new-password"
            placeholder={secrets.calibrePassword.set ? 'Saved; type a new one to change it' : ''}
            value={secretValues.calibrePassword}
            on:input={(e) => setSecretValue('calibrePassword', e.currentTarget.value)}
            data-testid="cleanup-secret-calibrePassword"
          />
        </label>
        <span
          class="flex flex-wrap items-center gap-x-2 text-c-muted"
          data-testid="cleanup-secret-state-calibrePassword"
        >
          {secretState(secrets.calibrePassword)}
          {#if secrets.calibrePassword.set}
            <button
              type="button"
              class="c-btn c-btn-ghost"
              on:click={() => removeSecret('calibrePassword', 'Calibre password')}>Remove</button
            >
          {/if}
        </span>
      </div>
      <p class="text-sm text-c-muted sm:col-span-2">
        The user needs permission to make changes (not read-only) in Calibre’s sharing settings.
      </p>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Library</legend>
      <label class={field}>
        <span class={label}>Library to clean</span>
        <select class="c-input" bind:value={settings.targetLibraryId} data-testid="cleanup-target">
          <option value={null}>The library in “japanese-library”</option>
          {#each libraries as lib (lib.id)}
            <option value={lib.id}>{lib.name} ({lib.folder || 'root'})</option>
          {/each}
        </select>
      </label>
      <div class={field} data-testid="cleanup-server-library">
        <span class={label}>On the content server</span>
        {#if needsServerLibrary && calibre}
          <select class="c-input" bind:value={serverLibrary} data-testid="cleanup-library-id">
            <option value="">Choose…</option>
            {#each calibre.libraries as id (id)}
              <option value={id}>{id}</option>
            {/each}
          </select>
        {:else if calibre?.id}
          <span class="flex min-h-[3rem] items-center">
            {calibre.id}{calibre.auto ? ' (found automatically)' : ''}
          </span>
        {:else}
          <span class="flex min-h-[3rem] items-center text-c-muted">
            Found automatically once the sidecar has reached the content server.
          </span>
        {/if}
      </div>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Your tags and pacing</legend>
      <label class="{field} sm:row-span-2">
        <span class={label}
          >Your own Calibre tags (one per line, * at the end matches any ending)</span
        >
        <textarea
          class="c-input min-h-[8rem] py-2"
          bind:value={customTagsText}
          data-testid="cleanup-tags"
        ></textarea>
        <span class="text-c-muted"
          >Of identical copies, the one with more of these tags stays; the removed copy’s tags from
          this list are added to it.</span
        >
      </label>
      <label class={field}>
        <span class={label}>Reading speed for comparing files (MB/s, 0 = no limit)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          step="1"
          bind:value={settings.pacing.hashMbPerSecond}
        />
      </label>
      <label class={field}>
        <span class={label}>Pause between two copies (seconds)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          step="1"
          bind:value={settings.pacing.itemDelaySeconds}
        />
      </label>
      <label class={field}>
        <span class={label}>Copies per batch (at most 500)</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="500"
          step="1"
          bind:value={settings.pacing.batchSize}
          data-testid="cleanup-batch-size"
        />
      </label>
      <label class={field}>
        <span class={label}>Largest batch (% of the library)</span>
        <input
          class="c-input"
          type="number"
          min="0.1"
          max="10"
          step="0.1"
          bind:value={settings.pacing.maxBatchPercent}
        />
      </label>
      <label class={field}>
        <span class={label}>Stop applying below this accuracy (%)</span>
        <input
          class="c-input"
          type="number"
          min="50"
          max="100"
          step="0.5"
          bind:value={settings.gateThresholdPercent}
        />
      </label>
      <label class={field}>
        <span class={label}>Pause when this share needs review (%)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="100"
          step="1"
          bind:value={settings.reviewAlarmPercent}
        />
      </label>
      <label class={field}>
        <span class={label}>Pause when this share of a batch changed in Calibre (%)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="100"
          step="1"
          data-testid="cleanup-changed-pause"
          bind:value={settings.libraryChangedPausePercent}
        />
      </label>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2" data-testid="cleanup-secrets">
      <legend class={legend}>AI keys (for later stages)</legend>
      {#each KEYS as k (k.name)}
        <div class={field}>
          <label class={field}>
            <span class={label}>{k.label}</span>
            <input
              class="c-input"
              type="password"
              autocomplete="new-password"
              placeholder={secrets[k.name].set ? 'Saved; type a new one to change it' : ''}
              value={secretValues[k.name]}
              on:input={(e) => setSecretValue(k.name, e.currentTarget.value)}
              data-testid="cleanup-secret-{k.name}"
            />
          </label>
          <span
            class="flex flex-wrap items-center gap-x-2 text-c-muted"
            data-testid="cleanup-secret-state-{k.name}"
          >
            {secretState(secrets[k.name])}
            {#if secrets[k.name].set}
              <button
                type="button"
                class="c-btn c-btn-ghost"
                on:click={() => removeSecret(k.name, k.label)}>Remove</button
              >
            {/if}
          </span>
        </div>
      {/each}
      <p class="text-sm text-c-muted sm:col-span-2">
        Kept encrypted on the server and never shown again; type a new one to change it.
      </p>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class={legend}>Models (for later stages)</legend>
      {#each Object.keys(MODEL_LABELS) as task (task)}
        <label class={field}>
          <span class={label}>{MODEL_LABELS[task]}</span>
          <input class="c-input" bind:value={settings.models[task]} />
        </label>
      {/each}
    </fieldset>

    <div class="flex flex-wrap items-center gap-4">
      <button
        class="c-btn c-btn-primary"
        type="submit"
        disabled={saving}
        data-testid="cleanup-save"
      >
        Save settings
      </button>
      {#if saved}<span class="text-sm" role="status">Saved.</span>{/if}
      {#if saveError}<span class="text-sm font-bold" role="alert">{saveError}</span>{/if}
    </div>
  </form>
{:else}
  <p class="c-rule-text text-sm text-c-muted">Loading…</p>
{/if}
