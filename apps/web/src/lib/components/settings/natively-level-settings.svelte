<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings › Library › Book page › Natively level (2026-11-24): the library server reads each
   * linked book's level from its Natively page. Shows how many books have one, the first pass's
   * progress bar and time left while it runs, a wait after Natively refused, and the server's
   * three settings (saved with Save). Needs the library server.
   */
  import { onDestroy, onMount } from 'svelte';
  import { getLibraryStore } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { LibraryApi, type NativelyProgressAnswer, type NativelySettings } from '$lib/library/api';
  import { timeLeftText } from '$lib/library/natively-level';

  let api: LibraryApi | null = null;
  let progress: NativelyProgressAnswer | null = null;
  let saved: NativelySettings | null = null;
  let draft: NativelySettings | null = null;
  let loadError = '';
  let saveError = '';
  let savedNote = '';
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load() {
    if (!api) return;
    try {
      progress = await api.nativelyProgress();
      if (!saved) {
        saved = progress.settings;
        draft = progress.settings;
      }
      loadError = '';
    } catch (err) {
      loadError = `The Natively level can't be shown: ${(err as Error).message}. It needs the library server.`;
    }
  }

  onMount(async () => {
    const c = await getLibraryStore().getConnection();
    if (!c) {
      loadError = 'Connect this device to the library server to see the Natively levels.';
      return;
    }
    const t = Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
    api = new LibraryApi(c.serverUrl, c.token, t);
    await load();
    timer = setInterval(() => void load(), 10_000);
  });

  onDestroy(() => clearInterval(timer));

  $: pass = progress?.pass;
  $: fraction = pass && pass.total ? Math.min(1, pass.done / pass.total) : 0;
  $: dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);

  function num(e: Event, min: number, max: number, fallback: number): number {
    const v = Math.round(Number((e.target as HTMLInputElement).value));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  }

  function change(next: Partial<NativelySettings>) {
    if (!draft) return;
    draft = { ...draft, ...next };
    savedNote = '';
  }

  async function save() {
    if (!api || !draft) return;
    busy = true;
    saveError = '';
    try {
      const r = await api.saveNativelySettings(draft);
      saved = r.settings;
      draft = r.settings;
      savedNote = 'Saved.';
    } catch (err) {
      saveError = `Not saved: ${(err as Error).message}`;
    } finally {
      busy = false;
    }
  }

  function clock(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

{#if loadError}
  <p class="text-sm text-c-muted" data-testid="natively-settings-note">{loadError}</p>
{:else if !progress || !draft}
  <p class="text-sm text-c-muted">Loading…</p>
{:else}
  <div class="space-y-4" data-testid="natively-settings">
    <p class="text-sm" data-testid="natively-saved">
      {progress.saved.toLocaleString()}
      {progress.saved === 1 ? 'book has' : 'books have'} a level.
    </p>
    {#if pass?.running}
      <div class="space-y-1.5" data-testid="natively-pass">
        <div class="flex flex-wrap justify-between gap-2 text-sm">
          <span>Reading levels: {pass.done.toLocaleString()} of {pass.total.toLocaleString()}</span>
          <span class="text-c-muted">{timeLeftText(pass.secondsLeft)}</span>
        </div>
        <div
          class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
          role="progressbar"
          aria-label="Reading Natively levels"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(fraction * 100)}
        >
          <div class="h-full bg-c-fill" style="width: {fraction * 100}%" />
        </div>
      </div>
    {/if}
    {#if progress.waitingUntil}
      <p class="text-sm" role="status" data-testid="natively-waiting">
        Natively didn't answer ({progress.lastError ?? 'no reason given'}). Trying again at {clock(
          progress.waitingUntil
        )}.
      </p>
    {/if}
    <div class="fields">
      <label>
        <span>Read a level again after (days)</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="365"
          value={draft.maxAgeDays}
          data-testid="natively-max-age"
          on:change={(e) => change({ maxAgeDays: num(e, 1, 365, draft?.maxAgeDays ?? 7) })}
        />
      </label>
      <label>
        <span>Seconds between requests</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="600"
          value={draft.requestSeconds}
          data-testid="natively-request-seconds"
          on:change={(e) => change({ requestSeconds: num(e, 1, 600, draft?.requestSeconds ?? 5) })}
        />
      </label>
      <label>
        <span>Longest wait after a refusal (min)</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="1440"
          value={draft.maxBackoffMinutes}
          data-testid="natively-max-backoff"
          on:change={(e) =>
            change({ maxBackoffMinutes: num(e, 1, 1440, draft?.maxBackoffMinutes ?? 60) })}
        />
      </label>
    </div>
    {#if saveError}<p class="text-sm" role="alert">{saveError}</p>{/if}
    {#if dirty || savedNote}
      <div class="flex items-center justify-end gap-3">
        {#if savedNote}<span class="text-sm text-c-muted" role="status">{savedNote}</span>{/if}
        {#if dirty}
          <button type="button" class="c-btn c-btn-ghost" on:click={() => (draft = saved)}
            >Undo changes</button
          >
          <button
            type="button"
            class="c-btn c-btn-primary"
            disabled={busy}
            data-testid="natively-save"
            on:click={save}>Save</button
          >
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .fields {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }

  .fields label {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: 0.875rem;
  }
</style>
