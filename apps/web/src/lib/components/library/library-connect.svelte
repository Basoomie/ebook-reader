<script lang="ts">
  import { buttonClasses, inputClasses } from '$lib/css-classes';
  import { LibraryApi, LibraryApiError, normalizeServerUrl, pairDevice } from '$lib/library/api';
  import type { LibraryConnection } from '$lib/library/library-db';
  import { createEventDispatcher } from 'svelte';

  /** Prefilled server address (from the self-hosted sync source, if any). */
  export let serverUrl = '';
  /** Shown when an earlier token stopped working. */
  export let notice = '';
  export let timeoutSeconds = 20;

  const dispatch = createEventDispatcher<{ connected: LibraryConnection }>();

  let code = '';
  let busy = false;
  let error = '';

  async function connect() {
    error = '';
    busy = true;
    try {
      const url = normalizeServerUrl(serverUrl);
      const input = code.trim();
      if (!input) throw new Error('Enter the pairing code');
      let token: string;
      let label: string;
      if (input.startsWith('ttsu_')) {
        // A full token pasted instead of a code.
        token = input;
        label = (await new LibraryApi(url, token, timeoutSeconds).me()).token.label;
      } else {
        ({ token, label } = await pairDevice(url, input, { timeoutSeconds }));
      }
      dispatch('connected', { serverUrl: url, token, label, connectedAt: Date.now() });
    } catch (e) {
      if (e instanceof LibraryApiError && e.code === 'invalid_code') {
        error = 'That code is unknown, already used or expired. Make a new one and try again.';
      } else if (e instanceof LibraryApiError && e.code === 'too_many_attempts') {
        error = 'Too many wrong codes. Wait a minute, then try again.';
      } else if (e instanceof LibraryApiError && e.kind === 'unauthorized') {
        error = 'The server does not accept that token.';
      } else {
        error = (e as Error).message;
      }
    } finally {
      busy = false;
    }
  }
</script>

<form class="mx-auto max-w-lg py-8" on:submit|preventDefault={connect}>
  <h2 class="mb-2 text-lg font-medium">Connect this device to the library</h2>
  {#if notice}
    <p class="mb-4 font-medium">{notice}</p>
  {/if}
  <p class="mb-6 text-sm">
    On the NAS, run
    <code class="whitespace-nowrap">node dist/cli.js token pair "Device name"</code>
    in the storage-server container and enter the code it prints. A full
    <code>ttsu_</code> token also works.
  </p>
  <label class="mb-6 block">
    <span class="text-sm">Server address</span>
    <input
      class={inputClasses}
      type="text"
      autocomplete="url"
      placeholder="http://tower:3081"
      bind:value={serverUrl}
    />
  </label>
  <label class="mb-6 block">
    <span class="text-sm">Pairing code</span>
    <input
      class="{inputClasses} text-xl tracking-widest"
      type="text"
      autocomplete="off"
      autocapitalize="characters"
      spellcheck="false"
      placeholder="XXXX-XXXX"
      bind:value={code}
    />
  </label>
  {#if error}
    <p class="mb-4 font-medium text-red-700" role="alert">{error}</p>
  {/if}
  <button class="{buttonClasses} border border-current" type="submit" disabled={busy}>
    {busy ? 'Connecting…' : 'Connect'}
  </button>
</form>
