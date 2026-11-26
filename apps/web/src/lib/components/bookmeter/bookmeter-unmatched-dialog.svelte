<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Bookmeter sync's "Not matched" (2026-11-25, docs/design/bookmeter-sync.md): the entries of
   * an account's 読書メーター lists no reader book matched, read books first (with the day you
   * read them). Each shows the closest books by the same author or title; Link makes it that
   * book, Not in my library stops asking. Your choice is never decided again; Forget my choice
   * (under "Not in my library") lets the rules try again.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import type {
    BookmeterNearBook,
    BookmeterUnmatchedAnswer,
    BookmeterUnmatchedEntry,
    LibraryApi
  } from '$lib/library/api';

  export let api: LibraryApi;
  export let accountId: string;
  export let accountName: string;
  export let resolver: (changed: boolean | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  const LIST: Record<string, string> = {
    read: '読んだ本',
    reading: '読んでる本',
    stacked: '積読本',
    wish: '読みたい本'
  };

  let answer: BookmeterUnmatchedAnswer | null = null;
  let error = '';
  let busy = '';
  let changed = false;
  /** The entry whose search box is open, its text and results. */
  let searching: string | null = null;
  let query = '';
  let results: BookmeterNearBook[] = [];
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  async function load() {
    try {
      answer = await api.bookmeterUnmatched(accountId);
      error = '';
    } catch (err) {
      error = `Can't be shown: ${(err as Error).message}`;
    }
  }

  onMount(load);

  async function choose(e: BookmeterUnmatchedEntry, bookId: string | null | undefined) {
    busy = e.listingId;
    try {
      await api.bookmeterChoose(accountId, e.listingId, bookId);
      changed = true;
      searching = null;
      await load();
    } catch (err) {
      error = `Not saved: ${(err as Error).message}`;
    } finally {
      busy = '';
    }
  }

  function openSearch(e: BookmeterUnmatchedEntry) {
    searching = e.listingId;
    query = e.title.replace(/\s*[(（][^)）]*[)）]\s*$/u, '');
    results = [];
    void search();
  }

  function typed() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void search(), 300);
  }

  async function search() {
    const q = query.trim();
    if (!q) {
      results = [];
      return;
    }
    try {
      results = (await api.bookmeterSearchBooks(accountId, q)).books;
    } catch (err) {
      error = `Search failed: ${(err as Error).message}`;
    }
  }

  function close() {
    resolver(changed);
    dispatch('close');
  }

  function when(e: BookmeterUnmatchedEntry): string {
    return e.date ? `${LIST[e.list]} · read ${e.date.replaceAll('-', '/')}` : LIST[e.list];
  }
</script>

<Modal
  title="Not matched"
  subtitle="{accountName}: books on your 読書メーター lists that no book in the library matched"
  size="lg"
  testid="bookmeter-unmatched"
  on:close={close}
>
  {#if error}<ModalSection>
      <div class="min-w-0"><p class="text-red-500" role="alert">{error}</p></div>
    </ModalSection>{/if}
  {#if !answer}
    <ModalSection>
      <div class="min-w-0"><p class="text-sm text-c-muted">Loading…</p></div>
    </ModalSection>
  {:else}
    <ModalSection title="To match ({answer.unmatched.length})">
      <div class="min-w-0">
        {#if answer.unmatched.length === 0}
          <p class="text-sm text-c-muted" data-testid="bookmeter-unmatched-none">
            Every book on your lists is matched or marked Not in my library.
          </p>
        {/if}
        <ul class="flex flex-col divide-y divide-c-line" data-testid="bookmeter-unmatched-list">
          {#each answer.unmatched as e (e.listingId)}
            <li class="flex gap-3 py-3" data-testid="bookmeter-unmatched-item">
              {#if e.cover}
                <img
                  src={e.cover}
                  alt=""
                  class="h-20 w-14 shrink-0 rounded object-cover"
                  loading="lazy"
                />
              {/if}
              <div class="min-w-0 grow">
                <a
                  class="font-medium hover:underline"
                  href={e.url}
                  target="_blank"
                  rel="noopener noreferrer">{e.title}</a
                >
                <div class="text-sm text-c-muted">
                  {e.authors.join(', ')} · {when(e)}
                </div>
                {#if e.near.length}
                  <div class="mt-2 flex flex-col gap-1">
                    {#each e.near as b (b.id)}
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          class="c-btn c-btn-secondary c-btn-sm shrink-0"
                          disabled={busy === e.listingId}
                          data-testid="bookmeter-link-near"
                          on:click={() => choose(e, b.id)}
                        >
                          Link
                        </button>
                        <span class="min-w-0 truncate text-sm">{b.title}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
                {#if searching === e.listingId}
                  <div class="mt-2">
                    <input
                      type="search"
                      class="w-full"
                      placeholder="Search the library by title"
                      aria-label="Search the library by title"
                      bind:value={query}
                      on:input={typed}
                    />
                    <div class="mt-1 flex flex-col gap-1">
                      {#each results as b (b.id)}
                        <div class="flex items-center gap-2">
                          <button
                            type="button"
                            class="c-btn c-btn-secondary c-btn-sm shrink-0"
                            disabled={busy === e.listingId}
                            on:click={() => choose(e, b.id)}
                          >
                            Link
                          </button>
                          <span class="min-w-0 truncate text-sm"
                            >{b.title}
                            <span class="text-c-muted">· {b.authors.join(', ')}</span></span
                          >
                        </div>
                      {:else}
                        {#if query.trim()}<p class="text-sm text-c-muted">
                            No book with that title.
                          </p>{/if}
                      {/each}
                    </div>
                  </div>
                {/if}
                <div class="mt-2 flex flex-wrap gap-2">
                  {#if searching !== e.listingId}
                    <button
                      type="button"
                      class="c-btn c-btn-ghost c-btn-sm"
                      on:click={() => openSearch(e)}
                    >
                      Find another book…
                    </button>
                  {/if}
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    disabled={busy === e.listingId}
                    data-testid="bookmeter-not-in-library"
                    on:click={() => choose(e, null)}
                  >
                    Not in my library
                  </button>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    </ModalSection>
    {#if answer.notInLibrary.length}
      <ModalSection title="Not in my library ({answer.notInLibrary.length})">
        <div class="min-w-0">
          <ul class="flex flex-col divide-y divide-c-line">
            {#each answer.notInLibrary as e (e.listingId)}
              <li class="flex items-center gap-3 py-2">
                <div class="min-w-0 grow">
                  <a class="hover:underline" href={e.url} target="_blank" rel="noopener noreferrer"
                    >{e.title}</a
                  >
                  <div class="text-sm text-c-muted">{when(e)}</div>
                </div>
                <button
                  type="button"
                  class="c-btn c-btn-ghost c-btn-sm shrink-0"
                  disabled={busy === e.listingId}
                  on:click={() => choose(e, undefined)}
                >
                  Forget my choice
                </button>
              </li>
            {/each}
          </ul>
        </div>
      </ModalSection>
    {/if}
  {/if}
</Modal>
