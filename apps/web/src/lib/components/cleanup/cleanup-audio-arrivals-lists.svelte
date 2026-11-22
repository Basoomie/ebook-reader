<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Stage 7's lists (WP21f-1): the last run's recordings by outcome, the plan's folders, the
   * archives, the items to look at (with their choices: only recorded; "Add anyway" is applied by
   * the next run, a better copy by WP21f-2), and the runs. Reloads when `run` changes.
   */
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    ARCHIVE_STATE,
    ARRIVAL_LISTS,
    LIBRARY_STATE,
    REVIEW_CHOICES,
    REVIEW_KIND,
    changeLines,
    fieldLabel
  } from '$lib/cleanup/audio-arrivals-text';
  import type { LibraryChangeItem } from '$lib/cleanup/cleanup-api';
  import { bytesText, n } from '$lib/cleanup/cleanup-text';
  import { formatWhen } from '$lib/notes/notes-format';

  export let api: CleanupApi;
  /** The run and its phase: the list reloads when it changes. */
  export let run: string;

  const PAGE = 50;
  let list = ARRIVAL_LISTS[0].id;
  let data: { total: number; items: Record<string, unknown>[] } | null = null;
  let offset = 0;
  let error = '';
  let loadedFor = '';

  $: if (run !== loadedFor) {
    loadedFor = run;
    void load(offset);
  }

  async function load(at: number) {
    error = '';
    try {
      data = await api.audioArrivals(list, at, PAGE);
      offset = at;
    } catch (err) {
      data = null;
      error = (err as Error).message;
    }
  }

  async function decide(id: number, decision: string) {
    error = '';
    try {
      await api.audioArrivalsDecide(id, decision);
      await load(offset);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  /** WP21f-2: a review choice for a book of the library changes (applied at the next run). */
  async function choose(bookId: number, field: string, choice: string) {
    error = '';
    try {
      await api.audioLibraryChoice(bookId, field, choice);
      await load(offset);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  const change = (it: Record<string, unknown>) => it as unknown as LibraryChangeItem;

  const s = (v: unknown) =>
    typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  /** A review item's reason (from its details). */
  function reasonOf(it: Record<string, unknown>): string {
    const d = it.detail;
    return d && typeof d === 'object' ? s((d as Record<string, unknown>).reason) : '';
  }

  function report(v: unknown): string {
    try {
      const r = JSON.parse(s(v)) as { added?: number; planned?: number; newReview?: number };
      return `${n(r.added ?? 0)} added, ${n(r.planned ?? 0)} planned, ${n(r.newReview ?? 0)} new to look at`;
    } catch {
      return '';
    }
  }
</script>

<label class="flex flex-col gap-1 text-sm">
  <span class="font-medium">List</span>
  <select
    class="c-input"
    bind:value={list}
    on:change={() => load(0)}
    data-testid="audio-arrivals-list"
  >
    {#each ARRIVAL_LISTS as l (l.id)}
      <option value={l.id}>{l.label}</option>
    {/each}
  </select>
</label>
{#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
{#if data}
  <p class="text-sm text-c-muted" data-testid="audio-arrivals-total">{n(data.total)}</p>
  <ul class="flex flex-col text-sm" data-testid="audio-arrivals-items">
    {#each data.items as it, i (i)}
      <li class="flex flex-col gap-0.5 border-b py-2" style="border-color: var(--c-line)">
        {#if list === 'archives'}
          <span class="break-all font-medium">{s(it.rel)}</span>
          <span class="text-c-muted">
            {ARCHIVE_STATE[s(it.state)] ?? s(it.state)} · {bytesText(it.size)}{it.entries !== null
              ? ` · ${n(it.entries)} entries, ${n(it.audio_entries)} audio (${bytesText(it.audio_bytes)})`
              : ''}{it.encoding === 'cp932' ? ' · names read as CP932' : ''}
          </span>
          {#if it.detail}<span class="text-c-muted">{s(it.detail)}</span>{/if}
        {:else if list === 'review'}
          <span class="font-medium">{REVIEW_KIND[s(it.kind)] ?? s(it.kind)}: {s(it.title)}</span>
          {#if reasonOf(it)}
            <span class="text-c-muted">{reasonOf(it)}</span>
          {/if}
          <span class="flex flex-wrap gap-2">
            {#each REVIEW_CHOICES[s(it.kind)] ?? [] as c (c.id)}
              <button
                class="c-btn {it.decision === c.id ? 'c-btn-primary' : 'c-btn-ghost'}"
                on:click={() => decide(num(it.id), c.id)}
                data-testid="audio-arrivals-decide-{c.id}">{c.label}</button
              >
            {/each}
            {#if it.decision}
              <button class="c-btn c-btn-ghost" on:click={() => decide(num(it.id), 'clear')}
                >Forget my choice</button
              >
            {/if}
          </span>
        {:else if list === 'library_changes' || list === 'library_review' || list === 'library_kept'}
          <span class="break-all font-medium">{s(it.folderFrom)}</span>
          <span class="text-c-muted">{LIBRARY_STATE[s(it.state)] ?? s(it.state)}</span>
          {#each changeLines(change(it)) as line, j (j)}
            <span class="break-all text-c-muted">{line}</span>
          {/each}
          {#if list === 'library_review'}
            <span class="flex flex-wrap gap-2">
              {#each change(it).conflicts as c (c.field)}
                <button
                  class="c-btn c-btn-ghost"
                  on:click={() => choose(change(it).bookId, c.field, 'mine')}
                  data-testid="library-choice-mine">Keep yours ({fieldLabel(c.field)})</button
                >
                <button
                  class="c-btn c-btn-ghost"
                  on:click={() => choose(change(it).bookId, c.field, 'ours')}
                  data-testid="library-choice-ours"
                  >Use the cleanup’s ({fieldLabel(c.field)})</button
                >
              {/each}
              {#each change(it).absKept ?? [] as c (c.field)}
                <button
                  class="c-btn c-btn-ghost"
                  on:click={() => choose(change(it).bookId, c.field, 'mine')}
                  data-testid="library-choice-keep-abs"
                  >Keep Audiobookshelf’s ({fieldLabel(c.field)})</button
                >
                <button
                  class="c-btn c-btn-ghost"
                  on:click={() => choose(change(it).bookId, c.field, 'ours')}
                  data-testid="library-choice-ours-abs"
                  >Use the cleanup’s ({fieldLabel(c.field)})</button
                >
              {/each}
              {#if change(it).renamesHeld}
                <button
                  class="c-btn c-btn-ghost"
                  on:click={() => choose(change(it).bookId, 'rename', 'now')}
                  data-testid="library-choice-rename">Rename now (the place moves)</button
                >
              {/if}
            </span>
          {/if}
        {:else if list === 'library_reader'}
          <span class="break-all font-medium">{s(it.rel)}</span>
          <span class="break-all text-c-muted"
            >→ torrents/…/{s(it.dst)} · {bytesText(it.size)} · {s(it.state) === 'done'
              ? 'Done'
              : 'Planned'}</span
          >
        {:else if list === 'library_links'}
          <span class="break-all font-medium">{s(it.old_folder)}/{s(it.old_file)}</span>
          <span class="break-all text-c-muted"
            >→ {s(it.new_folder)}/{s(it.new_file)} · {s(it.status) === 'remapped'
              ? 'Moved'
              : 'Planned'}</span
          >
        {:else if list === 'plan'}
          <span class="break-all font-medium">{s(it.folder)}</span>
          <span class="text-c-muted">
            {s(it.state) === 'built' ? 'Added' : 'Planned'} · {n(it.files)} files{num(it.pdfs)
              ? ` · ${n(it.pdfs)} PDFs`
              : ''} · setup {s(it.design)}{it.abs_item_id ? ' · in Audiobookshelf' : ''}
          </span>
        {:else if list === 'runs'}
          <span class="font-medium"
            >Run {n(it.id)} · {s(it.mode) === 'on' ? 'On' : 'Preview'} · {s(it.trigger) === 'now'
              ? 'Run now'
              : 'daily'} · {formatWhen(num(it.started_at))}</span
          >
          <span class="text-c-muted"
            >{s(it.state)}{it.error ? `: ${s(it.error)}` : ''}{it.report_json
              ? ` · ${report(it.report_json)}`
              : ''}</span
          >
        {:else}
          <span class="break-all font-medium">{s(it.name)}</span>
          <span class="text-c-muted"
            >{s(it.reason)}{it.design ? ` · setup ${s(it.design)}` : ''}</span
          >
        {/if}
      </li>
    {/each}
  </ul>
  {#if data.total > PAGE}
    <div class="flex flex-wrap items-center gap-2">
      <button
        class="c-btn c-btn-secondary"
        disabled={offset === 0}
        on:click={() => load(Math.max(0, offset - PAGE))}>Previous</button
      >
      <span class="text-sm"
        >{n(offset + 1)}–{n(Math.min(data.total, offset + PAGE))} of {n(data.total)}</span
      >
      <button
        class="c-btn c-btn-secondary"
        disabled={offset + PAGE >= data.total}
        on:click={() => load(offset + PAGE)}>Next</button
      >
    </div>
  {/if}
{/if}
