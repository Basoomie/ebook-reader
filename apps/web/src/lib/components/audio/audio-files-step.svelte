<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP15f: an audiobook in several files. Lists each file with its length, and offers:
   * - "Use this file": links that one file (plays at once; fixes duplicate copies);
   * - "Merge into one file": the ticked files, in the order set here, are joined by the
   *   server into one new file next to them (asks first).
   * Shows a hint when the files look like copies of one audiobook. Nothing happens until a
   * button is pressed; the parent links the file or follows the merge.
   */
  import { faArrowDown, faArrowUp } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Fa from 'svelte-fa';
  import {
    COPIES_HINT,
    fileCountLabel,
    fileDetails,
    mergeSelection,
    mergeSizeEstimate,
    moveItem
  } from '$lib/audio/audio-link';
  import type {
    AudioFolderDetail,
    AudioFolderSummary,
    AudioMergeJob
  } from '$lib/audio/audio-types';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { mergeAudiobookCopy } from '$lib/confirm/confirm-copy';
  import { formatFileSize } from '$lib/library/book-details';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import { logger } from '$lib/data/logger';

  export let api: LibraryApi;
  export let bookId: string;
  export let folder: AudioFolderSummary;
  /** The linked file when it is in this folder, shown as "Linked now". */
  export let currentFileName: string | null = null;
  /** Merging on this server: available, or why not. */
  export let merge: { available: boolean; reason: string | null } | undefined;
  export let busy = false;

  const dispatch = createEventDispatcher<{
    useFile: { folder: AudioFolderSummary; fileName: string };
    mergeStarted: AudioMergeJob;
    cancel: void;
  }>();

  const iconButton = 'c-btn c-btn-secondary h-12 w-12 shrink-0 p-0';

  let detail: AudioFolderDetail | null = null;
  let loadError = '';
  let message = '';
  let starting = false;
  let order: string[] = [];
  let ticked = new Set<string>();
  let destroyed = false;
  let loadedFor = 0;

  $: if (folder && folder.id !== loadedFor) void load(folder.id);
  $: selection = mergeSelection(order, ticked);
  $: detailsByName = new Map((detail?.files ?? []).map((f) => [f.name, fileDetails(f)]));
  $: mergeAvailable = merge?.available ?? false;
  $: mergeOffReason = merge?.reason ?? "The server can't merge audiobooks.";

  onDestroy(() => {
    destroyed = true;
  });

  function describe(err: unknown): string {
    if (err instanceof LibraryApiError) {
      if (err.kind === 'unreachable' || err.kind === 'timeout') {
        return 'The library server cannot be reached (offline, or the server is down).';
      }
    }
    return (err as Error).message;
  }

  async function load(id: number) {
    loadedFor = id;
    detail = null;
    loadError = '';
    message = '';
    try {
      const d = await api.audioFolder(id);
      if (destroyed || loadedFor !== id) return;
      detail = d;
      order = d.files.map((f) => f.name);
      // Copies are not merged by default; parts are.
      ticked = new Set(d.looksLikeCopies ? [] : order);
    } catch (err) {
      if (destroyed || loadedFor !== id) return;
      loadError = describe(err);
    }
  }

  function toggle(name: string, on: boolean) {
    const next = new Set(ticked);
    if (on) next.add(name);
    else next.delete(name);
    ticked = next;
  }

  function move(index: number, delta: -1 | 1) {
    order = moveItem(order, index, delta);
  }

  async function startMerge() {
    if (!detail || selection.length < 2 || starting) return;
    const size = formatFileSize(mergeSizeEstimate(detail.files, selection));
    const ok = await confirmDestructive({
      ...mergeAudiobookCopy(folder.name, selection.length, size),
      testid: 'audio-merge-confirm',
      confirmTestid: 'audio-merge-confirm-button'
    });
    if (!ok) return;
    starting = true;
    message = '';
    try {
      const job = await api.startAudioMerge(bookId, folder.id, selection);
      dispatch('mergeStarted', job);
    } catch (err) {
      message = describe(err);
      logger.warn(`Details: merge could not start: ${message}`);
    } finally {
      starting = false;
    }
  }
</script>

<div class="mt-4" data-testid="audio-files-step">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 class="break-words font-mincho text-lg font-bold">{folder.name}</h3>
    <button
      class="c-link min-h-[2.75rem] text-sm"
      data-testid="audio-files-cancel"
      on:click={() => dispatch('cancel')}>Cancel</button
    >
  </div>
  {#if folder.parentName}
    <div class="break-words text-xs text-c-muted">in {folder.parentName}</div>
  {/if}
  <p class="mt-1 text-sm text-c-muted">
    This audiobook is in {fileCountLabel(folder.fileCount)}. Use one file on its own, or merge files
    into one.
  </p>

  {#if loadError}
    <p class="c-notice mt-3" role="alert" data-testid="audio-files-error">
      {loadError}
      <button class="c-link ml-2 min-h-[2.75rem]" on:click={() => load(folder.id)}>Try again</button
      >
    </p>
  {:else if !detail}
    <p class="mt-3 text-sm text-c-muted">Reading the files…</p>
  {:else}
    {#if detail.looksLikeCopies}
      <p class="mt-3 text-sm font-semibold" data-testid="audio-copies-hint">{COPIES_HINT}</p>
    {/if}

    <ul class="mt-2 divide-y divide-dashed divide-c-line" data-testid="audio-files">
      {#each detail.files as file (file.name)}
        <li
          class="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
          data-testid="audio-file"
          data-name={file.name}
        >
          <div class="min-w-0 grow basis-60">
            <div class="break-all text-[15px] font-bold leading-snug">{file.name}</div>
            <div class="mt-0.5 text-sm text-c-muted" data-testid="audio-file-details">
              {fileDetails(file)}
            </div>
          </div>
          {#if currentFileName === file.name}
            <span class="text-sm text-c-muted" data-testid="audio-file-current">Linked now</span>
          {:else}
            <button
              class="c-btn c-btn-secondary c-round shrink-0 px-5"
              data-testid="audio-file-use"
              disabled={busy || starting}
              on:click={() => dispatch('useFile', { folder, fileName: file.name })}
            >
              Use this file
            </button>
          {/if}
        </li>
      {/each}
    </ul>

    <h4 class="mt-6 font-mincho text-base font-bold">Merge into one file</h4>
    <p class="text-sm text-c-muted">
      Tick the files to join and put them in order. Each file becomes a chapter of a new file saved
      next to them; the originals are not changed.
    </p>
    <ol class="mt-2 divide-y divide-dashed divide-c-line" data-testid="audio-merge-list">
      {#each order as name, i (name)}
        <li class="flex items-center gap-2 py-2" data-testid="audio-merge-item" data-name={name}>
          <label class="flex min-h-[3rem] min-w-0 grow items-center gap-3">
            <input
              type="checkbox"
              class="h-6 w-6 shrink-0"
              checked={ticked.has(name)}
              disabled={busy || starting}
              data-testid="audio-merge-tick"
              on:change={(ev) => toggle(name, ev.currentTarget.checked)}
            />
            <span class="min-w-0">
              <span class="block break-all text-sm font-medium">{i + 1}. {name}</span>
              {#if detailsByName.has(name)}
                <span class="block text-xs text-c-muted">{detailsByName.get(name)}</span>
              {/if}
            </span>
          </label>
          <button
            class={iconButton}
            title="Move up"
            aria-label="Move up: {name}"
            disabled={busy || starting || i === 0}
            data-testid="audio-merge-up"
            on:click={() => move(i, -1)}
          >
            <Fa icon={faArrowUp} />
          </button>
          <button
            class={iconButton}
            title="Move down"
            aria-label="Move down: {name}"
            disabled={busy || starting || i === order.length - 1}
            data-testid="audio-merge-down"
            on:click={() => move(i, 1)}
          >
            <Fa icon={faArrowDown} />
          </button>
        </li>
      {/each}
    </ol>
    {#if !mergeAvailable}
      <p class="mt-2 text-sm text-c-muted" data-testid="audio-merge-off">
        Merging isn't available: {mergeOffReason}.
      </p>
    {/if}
    {#if message}
      <p class="c-notice mt-3" role="alert" data-testid="audio-merge-message">{message}</p>
    {/if}
    <div class="mt-3">
      <button
        class="c-btn c-btn-secondary c-round"
        data-testid="audio-merge-start"
        disabled={busy || starting || !mergeAvailable || selection.length < 2}
        on:click={startMerge}
      >
        {selection.length >= 2
          ? `Merge ${selection.length} files into one`
          : 'Merge into one file (tick 2 or more)'}
      </button>
    </div>
  {/if}
</div>

<style>
  .c-round {
    border-radius: 0.75rem;
  }
</style>
