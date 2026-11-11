<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import LibrarySyncStatus from '$lib/components/library/library-sync-status.svelte';
  import { buttonClasses, inputClasses } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import { LibraryApi } from '$lib/library/api';
  import { summarizeCharCounts } from '$lib/library/char-counts';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { notifySyncConnectionChanged } from '$lib/sync/sync-service';
  import { onMount } from 'svelte';

  /**
   * The library server connection (WP19a: moved here from the bottom of the Library page):
   * server, this device's name, character counts, the request timeout, record sync and
   * Disconnect. Connecting stays on the Library page (it asks for a pairing code).
   */

  const store = getLibraryStore();
  // The shared input without its transition (e-ink).
  const numberInputClasses = inputClasses.replace(/\s*\btransition\b/, '');

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
    await store.clearConnection();
    notifySyncConnectionChanged();
    connection = null;
    charCounts = '';
  }
</script>

<div class="text-sm" data-testid="connection-settings">
  {#if connection === undefined}
    <p>Loading…</p>
  {:else if connection === null}
    <p>
      This device isn't connected to a library server.
      <a class="underline" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {:else}
    <p>Server: {connection.serverUrl}</p>
    <p>This device: {connection.label}</p>
    {#if charCounts}
      <p data-testid="connection-char-counts">{charCounts}</p>
    {/if}
    <label class="mt-3 block max-w-xs">
      Request timeout (seconds, 0 = none)
      <input
        class={numberInputClasses}
        type="number"
        min="0"
        step="1"
        data-testid="request-timeout"
        bind:value={$libraryRequestTimeoutSeconds$}
      />
    </label>
    <LibrarySyncStatus />
    <p class="mt-6">
      Disconnecting forgets the token on this device. To block it on the server too, run
      <code>token revoke</code> there.
    </p>
    <button
      class="{buttonClasses} mt-2 border border-current"
      data-testid="disconnect"
      on:click={disconnect}
    >
      Disconnect
    </button>
  {/if}
</div>
