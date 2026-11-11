<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import LibrarySyncStatus from '$lib/components/library/library-sync-status.svelte';
  import { pagePath } from '$lib/data/env';
  import { LibraryApi } from '$lib/library/api';
  import { summarizeCharCounts } from '$lib/library/char-counts';
  import { getLibraryStore, type LibraryConnection } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { notifySyncConnectionChanged } from '$lib/sync/sync-service';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { disconnectCopy } from '$lib/confirm/confirm-copy';
  import { onMount } from 'svelte';

  /**
   * The library server connection (WP19a: moved here from the bottom of the Library page):
   * server, this device's name, character counts, the request timeout, record sync and
   * Disconnect. Connecting stays on the Library page (it asks for a pairing code).
   */

  const store = getLibraryStore();
  // The catalogue's field (no transition, so E-ink stays plain).
  const fieldClasses = 'c-input mt-1 block w-full max-w-[15rem] text-base';

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

<!-- Settings page, "Archive" look: a panel, two columns on wide screens (the connection |
     record sync), stacked on narrower ones. -->
<div class="c-tile rounded-lg p-4 sm:px-7 sm:py-6" data-testid="connection-settings">
  {#if connection === undefined}
    <p>Loading…</p>
  {:else if connection === null}
    <p>
      This device isn't connected to a library server.
      <a class="c-link underline" href="{pagePath}/library">Connect on the Library page</a>.
    </p>
  {:else}
    <div class="grid grid-cols-1 gap-y-6 lg:grid-cols-2 lg:gap-x-12">
      <div>
        <p>Server: {connection.serverUrl}</p>
        <p>This device: {connection.label}</p>
        {#if charCounts}
          <p data-testid="connection-char-counts">{charCounts}</p>
        {/if}
        <label class="mt-4 block text-sm text-c-muted">
          Request timeout (seconds, 0 = none)
          <input
            class={fieldClasses}
            type="number"
            min="0"
            step="1"
            data-testid="request-timeout"
            bind:value={$libraryRequestTimeoutSeconds$}
          />
        </label>
        <p class="mt-6 text-sm text-c-muted">
          Disconnecting forgets the token on this device. To block it on the server too, run
          <code>token revoke</code> there.
        </p>
        <button class="c-btn c-btn-secondary mt-2" data-testid="disconnect" on:click={disconnect}>
          Disconnect
        </button>
      </div>
      <div class="border-c-line border-t pt-6 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
        <LibrarySyncStatus />
      </div>
    </div>
  {/if}
</div>
