<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * /cleanup settings (WP20a). Everything the cleanup needs is entered here and kept on the
   * server: the Calibre content server and login, the library to clean, the backup record,
   * your own tags, pacing, the gate threshold, the AI keys and models (stored now, used by
   * later stages). Keys and the password are write-only: the page never gets them back,
   * only whether one is saved (and the last 4 characters of an API key).
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import type {
    CleanupApi,
    CleanupSettings,
    SecretInfo,
    SecretName
  } from '$lib/cleanup/cleanup-api';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeCleanupSecretCopy, replaceCleanupSecretCopy } from '$lib/confirm/confirm-copy';
  import { formatWhen } from '$lib/notes/notes-format';

  export let api: CleanupApi;
  export let libraries: { id: string; name: string; folder: string }[] = [];

  const dispatch = createEventDispatcher<{ saved: void }>();

  const SECRETS: { name: SecretName; label: string; hint: string }[] = [
    {
      name: 'calibrePassword',
      label: 'Calibre password',
      hint: 'The content server user’s password.'
    },
    {
      name: 'anthropicApiKey',
      label: 'Anthropic API key',
      hint: 'Used from the online-sources stage on.'
    },
    {
      name: 'openaiApiKey',
      label: 'OpenAI API key',
      hint: 'Used from the online-sources stage on.'
    }
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
  let secretError: Partial<Record<SecretName, string>> = {};
  let customTagsText = '';
  let backupDone = false;

  onMount(load);

  async function load() {
    try {
      const answer = await api.settings();
      settings = answer.settings;
      secrets = answer.secrets;
      customTagsText = settings.customTags.join('\n');
      backupDone = settings.backup.confirmedAt !== null;
      loadError = '';
    } catch (err) {
      loadError = (err as Error).message;
    }
  }

  async function save() {
    if (!settings) return;
    saving = true;
    saveError = '';
    saved = false;
    try {
      const answer = await api.saveSettings({
        contentServerUrl: settings.contentServerUrl,
        calibreLibraryId: settings.calibreLibraryId,
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
        backup: {
          path: settings.backup.path,
          verifiedOn: settings.backup.verifiedOn,
          confirmedAt: backupDone ? (settings.backup.confirmedAt ?? Date.now()) : null
        }
      });
      settings = answer.settings;
      secrets = answer.secrets;
      customTagsText = settings.customTags.join('\n');
      saved = true;
      dispatch('saved');
    } catch (err) {
      saveError = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  /**
   * The app compiles with `immutable: true`: a value changed inside an object is not redrawn,
   * so each keystroke replaces the object (otherwise Save stays disabled).
   */
  function setSecretValue(name: SecretName, value: string) {
    secretValues = { ...secretValues, [name]: value };
  }

  async function saveSecret(name: SecretName, label: string) {
    const value = secretValues[name];
    if (!value.trim()) return;
    if (secrets?.[name].set && !(await confirmDestructive(replaceCleanupSecretCopy(label)))) return;
    try {
      secrets = (await api.saveSecret(name, value)).secrets;
      secretValues = { ...secretValues, [name]: '' };
      secretError = { ...secretError, [name]: '' };
      dispatch('saved');
    } catch (err) {
      secretError = { ...secretError, [name]: (err as Error).message };
    }
  }

  async function removeSecret(name: SecretName, label: string) {
    if (!(await confirmDestructive(removeCleanupSecretCopy(label)))) return;
    try {
      secrets = (await api.removeSecret(name)).secrets;
      dispatch('saved');
    } catch (err) {
      secretError = { ...secretError, [name]: (err as Error).message };
    }
  }

  function secretState(info: SecretInfo | undefined): string {
    if (!info?.set) return 'Not saved';
    const when = info.updatedAt ? ` (${formatWhen(info.updatedAt)})` : '';
    return info.hint ? `Saved · ends in ${info.hint}${when}` : `Saved${when}`;
  }

  const field = 'flex flex-col gap-1 text-sm';
  const label = 'font-medium';
</script>

{#if loadError}
  <p class="c-notice" role="alert">{loadError}</p>
{:else if settings && secrets}
  <form class="flex flex-col gap-8" on:submit|preventDefault={save} data-testid="cleanup-settings">
    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class="mb-2 font-mincho text-lg font-bold">Calibre</legend>
      <label class={field}>
        <span class={label}>Content server address</span>
        <input
          class="c-input"
          type="url"
          placeholder="http://192.168.1.5:8083"
          bind:value={settings.contentServerUrl}
          data-testid="cleanup-content-server"
        />
      </label>
      <label class={field}>
        <span class={label}>Calibre library id</span>
        <input
          class="c-input"
          placeholder="japanese-library"
          bind:value={settings.calibreLibraryId}
          data-testid="cleanup-library-id"
        />
      </label>
      <label class={field}>
        <span class={label}>Content server user</span>
        <input
          class="c-input"
          autocomplete="off"
          bind:value={settings.calibreUsername}
          data-testid="cleanup-username"
        />
      </label>
      <label class={field}>
        <span class={label}>Library to clean</span>
        <select class="c-input" bind:value={settings.targetLibraryId} data-testid="cleanup-target">
          <option value={null}>The library in “japanese-library”</option>
          {#each libraries as lib (lib.id)}
            <option value={lib.id}>{lib.name} ({lib.folder || 'root'})</option>
          {/each}
        </select>
      </label>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class="mb-2 font-mincho text-lg font-bold">Backup</legend>
      <label class={field}>
        <span class={label}>Full library backup folder</span>
        <input class="c-input" bind:value={settings.backup.path} />
      </label>
      <label class={field}>
        <span class={label}>Checked on</span>
        <input class="c-input" bind:value={settings.backup.verifiedOn} />
      </label>
      <label class="flex min-h-[3rem] items-center gap-3 sm:col-span-2">
        <input
          type="checkbox"
          class="h-5 w-5"
          bind:checked={backupDone}
          data-testid="cleanup-backup-done"
        />
        <span>The full library backup is done and checked</span>
      </label>
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class="mb-2 font-mincho text-lg font-bold">Your tags and pacing</legend>
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
    </fieldset>

    <fieldset class="grid gap-4 sm:grid-cols-2">
      <legend class="mb-2 font-mincho text-lg font-bold">Models (for later stages)</legend>
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

  <div class="mt-10 flex flex-col gap-6" data-testid="cleanup-secrets">
    <h3 class="font-mincho text-lg font-bold">Password and keys</h3>
    <p class="text-sm text-c-muted">
      Kept encrypted on the server. They are never shown again; type a new one to replace it.
    </p>
    {#each SECRETS as s (s.name)}
      <div class="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <label class={field}>
          <span class={label}>{s.label}</span>
          <input
            class="c-input"
            type="password"
            autocomplete="new-password"
            placeholder={secrets[s.name].set ? 'Type a new one to replace it' : ''}
            value={secretValues[s.name]}
            on:input={(e) => setSecretValue(s.name, e.currentTarget.value)}
            data-testid="cleanup-secret-{s.name}"
          />
          <span class="text-c-muted" data-testid="cleanup-secret-state-{s.name}">
            {secretState(secrets[s.name])} · {s.hint}
          </span>
          {#if secretError[s.name]}<span class="font-bold" role="alert">{secretError[s.name]}</span
            >{/if}
        </label>
        <div class="flex gap-2">
          <button
            class="c-btn c-btn-secondary"
            type="button"
            disabled={!secretValues[s.name].trim()}
            on:click={() => saveSecret(s.name, s.label)}
            data-testid="cleanup-secret-save-{s.name}"
          >
            Save
          </button>
          {#if secrets[s.name].set}
            <button
              class="c-btn c-btn-ghost"
              type="button"
              on:click={() => removeSecret(s.name, s.label)}
            >
              Remove
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{:else}
  <p class="c-rule-text text-sm text-c-muted">Loading…</p>
{/if}
