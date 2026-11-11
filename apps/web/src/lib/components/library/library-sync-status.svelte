<script lang="ts">
  import {
    recordSyncEnabled$,
    syncDebounceSeconds$,
    syncIntervalMinutes$
  } from '$lib/sync/settings';
  import { getSyncRunner } from '$lib/sync/sync-service';
  import type { RunnerStatus } from '$lib/sync/sync-runner';
  import { onDestroy } from 'svelte';

  /**
   * Record sync status and per-device settings (WP4), shown under Settings > Data >
   * Library server (WP19a; before, the Library page's Connection panel). In this phase sync only carries device names,
   * published device settings and positions for Calibre books; reading data
   * still uses the existing file sync.
   */

  // The catalogue's field (Settings page, "Archive" look).
  const fieldClasses = 'c-input mt-1 block w-full max-w-[15rem] text-base';

  const runner = getSyncRunner();
  let status: RunnerStatus | null = null;
  let syncing = false;

  const subscription = runner?.status$.subscribe((s) => (status = s));
  onDestroy(() => subscription?.unsubscribe());

  const stateText: Record<RunnerStatus['state'], string> = {
    idle: 'Up to date',
    syncing: 'Syncing…',
    off: 'Off on this device',
    disconnected: 'Not connected',
    error: 'Last sync failed'
  };

  function formatTime(ms: number | null): string {
    return ms ? new Date(ms).toLocaleString() : 'never';
  }

  async function syncNow() {
    if (!runner) return;
    syncing = true;
    try {
      await runner.syncNow();
    } finally {
      syncing = false;
    }
  }
</script>

<div>
  <h3 class="mb-1 font-mincho text-lg font-bold">Record sync</h3>
  {#if status}
    <p>
      {stateText[status.state]}{#if status.pending}, {status.pending} change(s) waiting{/if}
    </p>
    <p>Last sync: {formatTime(status.lastSyncAt)}</p>
    {#if status.lastError}
      <p role="alert">Error: {status.lastError}</p>
    {/if}
    {#if status.rejected}
      <p>{status.rejected} change(s) refused by the server (kept for the bug report).</p>
    {/if}
  {/if}
  <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
    <button class="c-btn c-btn-secondary" disabled={syncing || !runner} on:click={syncNow}>
      Sync now
    </button>
    <label class="flex min-h-[3rem] items-center gap-2">
      <input type="checkbox" bind:checked={$recordSyncEnabled$} />
      Sync records on this device
    </label>
  </div>
  <label class="mt-3 block text-sm text-c-muted">
    Wait after a change before syncing (seconds)
    <input class={fieldClasses} type="number" min="0" step="1" bind:value={$syncDebounceSeconds$} />
  </label>
  <label class="mt-3 block text-sm text-c-muted">
    Check for other devices' changes every (minutes, 0 = only on changes)
    <input class={fieldClasses} type="number" min="0" step="1" bind:value={$syncIntervalMinutes$} />
  </label>
  {#if status?.deviceId}
    <p class="mt-3 break-all text-xs text-c-muted">Device id: {status.deviceId}</p>
  {/if}
</div>
