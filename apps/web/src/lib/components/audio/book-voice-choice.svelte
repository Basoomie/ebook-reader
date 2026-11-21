<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: the book's TTS voice (called "PC voice" until the 2026-11-20 redesign),
   * in the Text-to-speech row of the book page's Audiobook section: the voice and model the PC
   * reads this book with: Read aloud, Enrich's sentence audio while the book has no audiobook,
   * and "Make an audiobook with this voice", which has no voice choice of its own (decided with
   * the user, 2026-11-15 and 2026-11-20: one choice for all). Default: the one in Settings >
   * Anki. `changed` fires with the new choices after each save. The row's header says what
   * the voice is used for.
   */
  import { createEventDispatcher } from 'svelte';
  import PcVoiceChoice from '$lib/components/audio/pc-voice-choice.svelte';
  import type { BookVoiceChoices } from '$lib/audio/tts-types';
  import type { LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;
  export let bookId: string;

  const dispatch = createEventDispatcher<{ changed: BookVoiceChoices }>();
</script>

<div data-testid="book-pc-voice">
  {#key bookId}
    <PcVoiceChoice
      {api}
      {bookId}
      testid="book-pc-voice-choice"
      on:changed={(e) => e.detail && dispatch('changed', e.detail)}
    />
  {/key}
</div>
