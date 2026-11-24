<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Calibre records without files (tier 4, decided with the user 2026-11-23): records Calibre's
   * import made while the disk refused their folder (a name over 255 bytes). Each one is deleted
   * once its EPUB is in Calibre as a new book; until then it stays and is listed here.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import type { CleanupApi, EmptyRecord } from '$lib/cleanup/cleanup-api';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { deleteEmptyRecordsCopy } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;

  const dispatch = createEventDispatcher<{ changed: void }>();

  let records: EmptyRecord[] = [];
  let loading = false;
  let busy = false;
  let error = '';
  $: ready = records.filter((r) => r.state === 'ready');

  const STATE: Record<EmptyRecord['state'], string> = {
    waiting: 'Waiting for its book',
    ready: 'Its book is in Calibre',
    held: 'Kept',
    deleting: 'Being deleted',
    deleted: 'Deleted',
    failed: 'Not deleted'
  };

  async function load() {
    loading = true;
    error = '';
    try {
      records = (await api.emptyRecords()).records;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      loading = false;
    }
  }

  async function deleteReady() {
    if (!(await confirmDestructive(deleteEmptyRecordsCopy(ready.length)))) return;
    busy = true;
    error = '';
    try {
      await api.deleteEmptyRecords(ready.map((r) => r.calibreId));
      dispatch('changed');
      await load();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  onMount(load);
</script>

<p class="max-w-prose text-sm text-c-muted">
  Calibre made these records when it imported a book whose folder name was too long for the disk, so
  each has no file. Once the book is in Calibre as a new book with its EPUB (the new arrivals add it
  with a shorter title), its record without files can be deleted. Until then it stays.
</p>
{#if error}<p class="text-sm" role="alert">{error}</p>{/if}
<p class="text-sm text-c-muted" data-testid="cleanup-empty-records-count">
  {loading ? 'Loading…' : `${records.length} records · ${ready.length} ready to delete`}
</p>
{#if ready.length > 0}
  <div>
    <button
      class="c-btn c-btn-secondary c-btn-sm"
      disabled={busy}
      on:click={deleteReady}
      data-testid="cleanup-empty-records-delete"
    >
      Delete the {ready.length === 1 ? 'record' : `${ready.length} records`} whose book is in
    </button>
  </div>
{/if}
<ul class="flex flex-col gap-2 text-sm" data-testid="cleanup-empty-records-list">
  {#each records as r (r.uuid)}
    <li class="flex min-w-0 flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
      <span class="break-words font-medium">{r.title}</span>
      <span class="text-c-muted">
        Calibre {r.calibreId} · {r.authors.join(', ') || 'Unknown'} · {STATE[r.state]}
      </span>
      {#if r.newBook}
        <span class="break-words">
          Its book: Calibre {r.newBook.calibreId}, “{r.newBook.title}”
        </span>
      {/if}
      {#if r.reason}<span class="break-words text-c-muted">{r.reason}</span>{/if}
      {#if r.state === 'deleted'}
        <span class="text-c-muted">
          Saved in the quarantine folder; it can’t be brought back (it had no files).
        </span>
      {/if}
    </li>
  {/each}
</ul>
