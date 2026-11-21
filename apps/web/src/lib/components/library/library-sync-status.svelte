<script lang="ts">
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingSwitch from '$lib/components/settings/setting-switch.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import {
    recordSyncEnabled$,
    syncDebounceSeconds$,
    syncIntervalMinutes$
  } from '$lib/sync/settings';
  import { getSyncRunner } from '$lib/sync/sync-service';
  import type { RunnerStatus } from '$lib/sync/sync-runner';
  import { SYNC_STATE_TEXT } from '$lib/sync/sync-state-text';
  import { onDestroy } from 'svelte';

  /**
   * Record sync status and per-device settings (WP4), shown under Settings > Data, "Record
   * sync" (WP19a; before, the Library page's Connection panel): rows of the section card.
   */

  const runner = getSyncRunner();
  let status: RunnerStatus | null = null;
  let syncing = false;

  const subscription = runner?.status$.subscribe((s) => (status = s));
  onDestroy(() => subscription?.unsubscribe());

  const stateText = SYNC_STATE_TEXT;

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

<SettingRow id="sync-status" layout="inline">
  <svelte:fragment slot="description">
    {#if status}
      <p class="mt-0.5 text-sm">
        {stateText[status.state]}{#if status.pending}, {status.pending} change(s) waiting{/if}
      </p>
      <p class="text-sm text-c-muted">Last sync: {formatTime(status.lastSyncAt)}</p>
      {#if status.lastError}
        <p class="text-sm font-semibold" role="alert">Error: {status.lastError}</p>
      {/if}
      {#if status.rejected}
        <p class="text-sm text-c-muted">
          {status.rejected} change(s) refused by the server (kept for the bug report).
        </p>
      {/if}
    {/if}
  </svelte:fragment>
  <button class="c-btn c-btn-secondary" disabled={syncing || !runner} on:click={syncNow}>
    Sync now
  </button>
</SettingRow>
<SettingRow id="record-sync" layout="inline" let:labelId>
  <SettingSwitch bind:checked={$recordSyncEnabled$} labelledby={labelId} />
</SettingRow>
{#if $recordSyncEnabled$}
  <SettingRow id="sync-debounce" child let:labelId>
    <SettingField unit="seconds">
      <input
        type="number"
        min="0"
        step="1"
        aria-labelledby={labelId}
        bind:value={$syncDebounceSeconds$}
      />
    </SettingField>
  </SettingRow>
  <SettingRow id="sync-interval" child let:labelId>
    <SettingField unit="minutes">
      <input
        type="number"
        min="0"
        step="1"
        aria-labelledby={labelId}
        bind:value={$syncIntervalMinutes$}
      />
    </SettingField>
  </SettingRow>
{/if}
{#if status?.deviceId}
  <SettingRow title="Device id" layout="info">
    <span class="break-all text-sm">{status.deviceId}</span>
  </SettingRow>
{/if}
