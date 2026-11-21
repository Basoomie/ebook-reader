<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 12: Settings > Audiobooks, "Pronunciation fixes": the global list, used
   * in every book the PC voices read (decided with the user, 2026-11-14/15). A book's own
   * list is on its page and wins over this one. Fixes change only audio made afterwards.
   */
  import SettingsSection from '$lib/components/settings/settings-section.svelte';
  import PronunciationFixList from '$lib/components/audio/pronunciation-fix-list.svelte';
  import type { FixList } from '$lib/audio/pronunciation/fix-types';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';

  export let api: LibraryApi;

  let list: FixList | null = null;
  let error = '';
  let started = false;

  $: if (api && !started) {
    started = true;
    void load();
  }

  async function load() {
    try {
      list = await api.pronunciationFixes(null);
      error = '';
    } catch (err) {
      error =
        err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout')
          ? 'The library server cannot be reached (offline, or the server is down).'
          : (err as Error).message;
    }
  }
</script>

{#if error}
  <p class="c-notice mt-4" role="alert" data-testid="pron-fixes-error">{error}</p>
{/if}
{#if list?.available}
  <section class="mt-10" aria-label="Pronunciation fixes" data-testid="pron-fixes">
    <SettingsSection
      jp="読み方"
      title="Pronunciation fixes"
      note={list.entries.length ? String(list.entries.length) : ''}
      tooltip="How text-to-speech should read a word, in every book. A book's own list (on its page) wins over this one, and the book's own furigana wins over both."
    />
    <p class="mt-2 max-w-3xl text-sm text-c-muted">
      Used for every book the PC reads aloud. A word is fixed wherever it appears; when two fixes
      match the same place, the longer one wins. A pattern is a JavaScript regular expression (for
      example 日本(?!橋)); $1 in its reading puts in what its first group matched. Audiobooks
      already made stay as they are: make a new one to hear a change.
    </p>
    <PronunciationFixList
      {api}
      bookId={null}
      entries={list.entries}
      limits={list.limits}
      testid="pron-fixes-global"
      emptyText="No fixes yet. Add one below."
      on:changed={load}
    />
  </section>
{/if}
