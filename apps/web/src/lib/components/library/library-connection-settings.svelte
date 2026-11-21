<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import LibrarySyncStatus from '$lib/components/library/library-sync-status.svelte';
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import { pagePath } from '$lib/data/env';
  import { LibraryApi } from '$lib/library/api';
  import { summarizeCharCounts } from '$lib/library/char-counts';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$, libraryServerCheckSeconds$ } from '$lib/library/settings';
  import { notifySyncConnectionChanged } from '$lib/sync/sync-service';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { disconnectCopy } from '$lib/confirm/confirm-copy';
  import { onMount } from 'svelte';

  /**
   * Settings > Data, "Library server" and "Record sync" (WP19a: moved here from the bottom
   * of the Library page): the server, this device's name, character counts, the request
   * timeout, the quick server check and Disconnect; then record sync. Connecting stays on
   * the Library page (it asks for a pairing code).
   */

  const store = getLibraryStore();

  let connection: LibraryConnection | null | undefined;
  let charCounts = '';

  onMount(async () => {
    connection = (await store.getConnection()) ?? null;
    if (!connection) return;
    try {
      const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
      const api = new LibraryApi(connection.serverUrl, connection.token, timeout);
      const enabled = (await api.libraries()).libraries.filter((l) => l.enabled);
      charCounts = summarizeCharCounts(enabled);
    } catch {
      // No counts shown; the Library page reports connection problems.
    }
  });

  async function disconnect() {
    // WP19: ask first; reconnecting needs a new pairing code.
    const confirmed = await confirmDestructive({
      ...disconnectCopy(),
      testid: 'disconnect-confirm',
      confirmTestid: 'disconnect-confirm-button'
    });
    if (!confirmed) return;
    await store.clearConnection();
    notifySyncConnectionChanged();
    connection = null;
    charCounts = '';
  }
</script>

<SettingsGroup id="data-server" testid="settings-section-server">
  <div data-testid="connection-settings">
    {#if connection === undefined}
      <p class="px-5 py-4 text-c-muted">Loading…</p>
    {:else if connection === null}
      <p class="px-5 py-4">
        This device isn't connected to a library server.
        <a class="c-link underline" href="{pagePath}/library">Connect on the Library page</a>.
      </p>
    {:else}
      <SettingRow id="server-address" layout="info">
        <span class="break-all">{connection.serverUrl}</span>
      </SettingRow>
      <SettingRow title="This device" layout="info">
        <span>{connection.label}</span>
      </SettingRow>
      {#if charCounts}
        <SettingRow title="Characters counted" layout="info">
          <!-- The row's title already says what the figure is. -->
          <span data-testid="connection-char-counts"
            >{charCounts.replace(/^Character counts:\s*/, '')}</span
          >
        </SettingRow>
      {/if}
      <SettingRow id="request-timeout" settingKey="libraryRequestTimeoutSeconds" let:labelId>
        <SettingField unit="seconds">
          <input
            type="number"
            min="0"
            step="1"
            aria-labelledby={labelId}
            data-testid="request-timeout"
            bind:value={$libraryRequestTimeoutSeconds$}
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="server-check" settingKey="libraryServerCheckSeconds" let:labelId>
        <SettingField unit="seconds">
          <input
            type="number"
            min="0"
            step="1"
            aria-labelledby={labelId}
            data-testid="server-check-seconds"
            bind:value={$libraryServerCheckSeconds$}
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="disconnect" layout="inline">
        <button class="c-btn c-btn-secondary" data-testid="disconnect" on:click={disconnect}>
          Disconnect…
        </button>
      </SettingRow>
    {/if}
  </div>
</SettingsGroup>

{#if connection}
  <SettingsGroup id="data-sync">
    <LibrarySyncStatus />
  </SettingsGroup>
{/if}
