<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Replaced books on /cleanup: the library books a new arrival replaced, and the values each new
   * copy takes over from the book it replaced. Off / Preview / On (On asks first), the write's
   * bar with the time left, the counts per field, and the list (paged).
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    INHERIT_HINTS,
    INHERIT_MODE_LABELS,
    inheritBar,
    inheritItemLine,
    inheritLines,
    inheritState,
    type InheritMode,
    type InheritStatus
  } from '$lib/cleanup/inherit-text';
  import { n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { inheritOnCopy } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;

  const MODES: InheritMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const PAGE = 50;

  let status: InheritStatus | null = null;
  let error = '';
  let busy = false;
  let offset = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  $: bar = inheritBar(status);
  $: lines = inheritLines(status);

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.inherit(offset);
      error = '';
    } catch (err) {
      error = (err as Error).message;
    }
    if (!destroyed)
      timer = setTimeout(
        () => void refresh(),
        document.visibilityState === 'hidden' ? POLL_MS * 6 : POLL_MS
      );
  }

  onMount(() => void refresh());
  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
  });

  async function setMode(mode: InheritMode) {
    if (!status || status.mode === mode || busy) return;
    if (mode === 'on') {
      const values = (status.counts.proposed ?? 0) + (status.counts.queued ?? 0);
      const ok = await confirmDestructive(inheritOnCopy(values, status.books.proposed ?? 0));
      if (!ok) return;
    }
    error = '';
    busy = true;
    try {
      status = await api.setInheritMode(mode);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  function page(to: number) {
    offset = Math.max(0, to);
    void refresh();
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="inherit-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">Replaced books</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Replaced books">
        {#each MODES as mode (mode)}
          <button
            class="c-btn {status.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
            role="radio"
            aria-checked={status.mode === mode}
            disabled={busy}
            on:click={() => setMode(mode)}
            data-testid="inherit-mode-{mode}">{INHERIT_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">
      A new arrival kept over a library book of the same text gets the values the old book had and
      the new copy lacks: its series, store ids, publisher, languages, illustrators and your tags. A
      value the new copy has is never replaced.
    </p>
    <p class="text-sm text-c-muted">{INHERIT_HINTS[status.mode]}</p>
    {#if status.waiting && status.mode === 'on'}
      <p class="text-sm" data-testid="inherit-waiting">Waiting: {status.waiting}</p>
    {/if}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="inherit-progress">
        <div class="flex flex-wrap justify-between gap-x-4 text-sm">
          <span>{bar.label}</span>
          <span>{Math.floor(bar.fraction * 100)} %{bar.eta ? ` · ${bar.eta}` : ''}</span>
        </div>
        <div
          class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
          role="progressbar"
          aria-label={bar.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(bar.fraction * 100)}
        >
          <div class="h-full bg-c-fill" style="width: {bar.fraction * 100}%" />
        </div>
      </div>
    {/if}
    <ul class="text-sm" data-testid="inherit-lines">
      {#each lines as line (line)}<li>{line}</li>{/each}
    </ul>
    {#if status.total > 0}
      <details data-testid="inherit-list">
        <summary class="cursor-pointer text-sm">The values ({n(status.total)})</summary>
        <ul class="mt-2 flex flex-col gap-1 text-sm">
          {#each status.items as item (item.id)}
            <li class="flex flex-col">
              <span class="font-bold"
                >{item.title} <span class="text-c-muted">({item.calibreId})</span></span
              >
              <span>{inheritItemLine(item)} · {inheritState(item)}</span>
            </li>
          {/each}
        </ul>
        {#if status.total > PAGE}
          <div class="mt-2 flex items-center gap-2 text-sm">
            <button
              class="c-btn c-btn-ghost c-btn-sm"
              disabled={offset === 0}
              on:click={() => page(offset - PAGE)}>Previous</button
            >
            <span
              >{n(offset + 1)}–{n(Math.min(offset + PAGE, status.total))} of {n(status.total)}</span
            >
            <button
              class="c-btn c-btn-ghost c-btn-sm"
              disabled={offset + PAGE >= status.total}
              on:click={() => page(offset + PAGE)}>Next</button
            >
          </div>
        {/if}
      </details>
    {/if}
  {/if}
</div>
