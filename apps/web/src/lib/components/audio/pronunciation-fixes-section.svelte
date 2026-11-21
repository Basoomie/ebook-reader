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
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import PagedList from '$lib/components/settings/paged-list.svelte';
  import PronunciationFixList from '$lib/components/audio/pronunciation-fix-list.svelte';
  import type { FixList, PronunciationFix } from '$lib/audio/pronunciation/fix-types';
  import { compareText, type ListSort } from '$lib/settings/paged-list';

  // The server's order (as the list was), or by the written word or its reading.
  const fixSorts: ListSort<PronunciationFix>[] = [
    { id: 'server', label: 'As added', compare: () => 0 },
    { id: 'match', label: 'Word', compare: (a, b) => compareText(a.match, b.match) },
    { id: 'reading', label: 'Reading', compare: (a, b) => compareText(a.reading, b.reading) }
  ];
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
  <p class="c-notice" role="alert" data-testid="pron-fixes-error">{error}</p>
{/if}
{#if list?.available}
  <SettingsGroup id="audio-fixes" testid="pron-fixes">
    <svelte:fragment slot="actions">
      {#if list.entries.length}
        <span class="c-count">{list.entries.length.toLocaleString('en-US')}</span>
      {/if}
    </svelte:fragment>
    <p slot="intro" class="mt-1 max-w-prose text-sm text-c-muted">
      A word is fixed wherever it appears; when two fixes match the same place, the longer one wins.
      A pattern is a JavaScript regular expression (for example 日本(?!橋)); $1 in its reading puts
      in what its first group matched. Audiobooks already made stay as they are: make a new one to
      hear a change.
    </p>
    <PagedList
      items={list.entries}
      pageSize={10}
      text={(f) => `${f.match} ${f.reading}`}
      searchLabel="Search words or readings"
      sorts={fixSorts}
      label="Fixes"
      slotWhenEmpty
      testid="pron-fixes-pages"
      let:rows
      let:query
    >
      <div class="px-4 pb-4 sm:px-5">
        <PronunciationFixList
          {api}
          bookId={null}
          entries={rows}
          limits={list.limits}
          testid="pron-fixes-global"
          emptyText={query ? `Nothing matches “${query}”.` : 'No fixes yet. Add one below.'}
          on:changed={load}
        />
      </div>
    </PagedList>
  </SettingsGroup>
{/if}
