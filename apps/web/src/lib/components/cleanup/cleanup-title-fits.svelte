<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Titles shortened to fit Calibre's folder names (decided with the user 2026-11-22): every
   * title the cleanup shortened or cut because the disk refuses names over 255 bytes, with the
   * original and the title written, to correct by hand in Calibre. A later stage never replaces
   * a title changed by hand.
   */
  import { onMount } from 'svelte';
  import type { CleanupApi, TitleFit } from '$lib/cleanup/cleanup-api';
  import { n } from '$lib/cleanup/cleanup-text';
  import ListPager from '$lib/components/list-pager.svelte';

  export let api: CleanupApi;

  const PAGE = 20;
  let page = 1;
  let total = 0;
  let items: TitleFit[] = [];
  let loading = false;
  let error = '';
  $: pages = Math.max(1, Math.ceil(total / PAGE));

  const STAGE: Record<number, string> = {
    0: 'New book from the source folders',
    2: 'Title from the book’s file',
    4: 'Title from the online sources',
    5: 'Written with the genres and tags'
  };
  const STATE: Record<string, string> = {
    proposed: 'Not written yet',
    queued: 'Being written',
    applied: 'Written',
    undone: 'Undone',
    skipped: 'Not written',
    kept: 'Kept as is',
    new: 'Not added yet',
    pending: 'Not added yet',
    waiting: 'Not added yet',
    added: 'Added'
  };

  async function load() {
    loading = true;
    error = '';
    try {
      const r = await api.titleFits((page - 1) * PAGE, PAGE);
      items = r.items;
      total = r.total;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(load);
</script>

<p class="max-w-prose text-sm text-c-muted">
  Calibre names each book’s folder and file after its title, and the disk takes at most 255 bytes
  per name. These titles were too long, so the cleanup shortened them (dropped a subtitle or a
  label) or, as a last resort, cut them with “…”. The volume number is always kept. Correct any of
  them in Calibre; the cleanup never changes a title you edited.
</p>
{#if error}<p class="text-sm" role="alert">{error}</p>{/if}
<p class="text-sm text-c-muted" data-testid="cleanup-title-fits-count">
  {loading ? 'Loading…' : `${n(total)} titles`}
</p>
<ul class="flex flex-col gap-2 text-sm" data-testid="cleanup-title-fits-list">
  {#each items as t (t.id)}
    <li class="flex min-w-0 flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
      <span class="break-words font-medium">{t.written}</span>
      <span class="break-words text-c-muted">Was: {t.original}</span>
      <span class="text-c-muted">
        {t.step === 'cut' ? 'Cut' : 'Shortened'} · {STAGE[t.stage] ?? `Stage ${t.stage}`} ·
        {STATE[t.state] ?? t.state}{t.calibreId ? ` · Calibre ${t.calibreId}` : ''}
      </span>
      {#if t.now && t.now !== t.written && t.state === 'applied'}
        <span class="break-words">Now in Calibre: {t.now}</span>
      {/if}
    </li>
  {/each}
</ul>
{#if pages > 1}
  <ListPager
    {page}
    {pages}
    label="Shortened titles"
    testid="cleanup-title-fits"
    on:go={(e) => ((page = e.detail), load())}
  />
{/if}
