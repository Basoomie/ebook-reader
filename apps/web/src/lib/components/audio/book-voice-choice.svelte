<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: the book page's "PC voice for this book" (Audiobook section): the voice
   * and model the PC reads this book with: Enrich's sentence audio while the book has no
   * audiobook, and where "Make an audiobook on the PC" starts (decided with the user,
   * 2026-11-15: one choice for both). Default: the one in Settings > Anki.
   */
  import { createEventDispatcher } from 'svelte';
  import PcVoiceChoice from '$lib/components/audio/pc-voice-choice.svelte';
  import type { AudioLink } from '$lib/audio/audio-types';
  import type { BookVoiceChoices } from '$lib/audio/tts-types';
  import type { LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;
  export let bookId: string;
  export let link: AudioLink | null;

  const dispatch = createEventDispatcher<{ changed: BookVoiceChoices }>();

  $: hasAudiobook = link?.state === 'linked';
</script>

<div class="c-vpanel mt-4 rounded px-5 py-4" data-testid="book-pc-voice">
  <p class="text-xs text-c-muted">How the PC voices read this book</p>
  <p class="font-medium">PC voice</p>
  <p class="mt-1 max-w-3xl text-sm text-c-muted">
    {#if hasAudiobook}
      "Make an audiobook on the PC" starts with it. Sentence audio for Anki comes from the linked
      audiobook.
    {:else}
      Enrich's sentence audio for Anki is read by the PC with it while the book has no audiobook,
      and "Make an audiobook on the PC" starts with it.
    {/if}
  </p>
  {#key bookId}
    <PcVoiceChoice
      {api}
      {bookId}
      testid="book-pc-voice-choice"
      on:changed={(e) => e.detail && dispatch('changed', e.detail)}
    />
  {/key}
</div>

<style>
  .c-vpanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }
</style>
