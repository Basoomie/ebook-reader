<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: Settings > Anki, "Sentence audio read by TTS": the voice and model the
   * PC reads Enrich's sentence with when a book has no audiobook (one choice for every book;
   * a book's page can choose its own). Off until a voice is chosen (decided with the user,
   * 2026-11-15).
   */
  import { onMount } from 'svelte';
  import PcVoiceChoice from '$lib/components/audio/pc-voice-choice.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import { LibraryApi } from '$lib/library/api';
  import { getLibraryStore } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';

  let api: LibraryApi | null = null;
  let loaded = false;

  onMount(async () => {
    try {
      const connection = await getLibraryStore().getConnection();
      if (connection) {
        const timeout = Math.max(0, Number($libraryRequestTimeoutSeconds$) || 0);
        api = new LibraryApi(connection.serverUrl, connection.token, timeout);
      }
    } finally {
      loaded = true;
    }
  });
</script>

<SettingRow id="anki-pc-audio" layout="stack" shared testid="anki-pc-audio">
  {#if api}
    <PcVoiceChoice {api} testid="anki-pc-voice" />
  {:else if loaded}
    <p class="text-sm text-c-muted">Connect this device to the library server first.</p>
  {/if}
</SettingRow>
