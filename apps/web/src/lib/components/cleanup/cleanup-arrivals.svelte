<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Calibre library's new arrivals card on /cleanup (WP20g): books added by hand in Calibre
   * and the daily import from the source folders. Off / Preview / On (asks first), Run now (asks
   * first), Stop, the run's step with its bar and time left from the first step, each source
   * folder's first run with "Add these", the last run's summary and report, and the folded lists
   * (paged, loaded when opened): what would be added, added, copies found, better copies to look
   * at, not imported (with the CSV), waiting, archives, removed by you, books added in Calibre,
   * the add batches (Undo) and the runs.
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    ARRIVALS_HINTS,
    ARRIVALS_MODE_LABELS,
    OUTCOME_LABELS,
    arrivalsBar,
    arrivalsReportLines,
    arrivalsSummary,
    nextRunText,
    pairLine,
    type ArrivalsMode,
    type ArrivalsStatus
  } from '$lib/cleanup/arrivals-text';
  import { bytesText, n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    booksArrivalsOnCopy,
    booksArrivalsRunNowCopy,
    booksArrivalsUndoCopy
  } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;

  const MODES: ArrivalsMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const LISTS: { id: string; title: string }[] = [
    { id: 'new', title: 'Would add' },
    { id: 'added', title: 'Added' },
    { id: 'identical', title: 'Identical to a library book' },
    { id: 'duplicate', title: 'Same text as a library book' },
    { id: 'better', title: 'Better copies' },
    { id: 'reviews', title: 'To look at' },
    { id: 'not_imported', title: 'Not imported' },
    { id: 'too_long', title: 'Too long for a folder name' },
    { id: 'waiting', title: 'Waiting or still downloading' },
    { id: 'archives', title: 'Archives' },
    { id: 'removed', title: 'Removed by you or by Undo' },
    { id: 'hand', title: 'Books added in Calibre' },
    { id: 'batches', title: 'Add batches' },
    { id: 'runs', title: 'Runs' }
  ];
  const PAGE = 25;

  let status: ArrivalsStatus | null = null;
  let error = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let lists: Record<string, { total: number; items: Record<string, unknown>[]; offset: number }> =
    {};

  $: bar = arrivalsBar(status);
  $: running = !!status?.run;

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.arrivals();
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

  async function act(fn: () => Promise<ArrivalsStatus | unknown>) {
    error = '';
    busy = true;
    try {
      const r = await fn();
      if (r && typeof r === 'object' && 'mode' in (r as object)) status = r as ArrivalsStatus;
      else await refresh();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function setMode(mode: ArrivalsMode) {
    if (!status || status.mode === mode) return;
    if (mode === 'on' && !(await confirmDestructive(booksArrivalsOnCopy(arrivalsSummary(status)))))
      return;
    await act(() => api.setArrivalsMode(mode));
  }

  async function runNow() {
    if (!status) return;
    if (
      !(await confirmDestructive(booksArrivalsRunNowCopy(status.mode === 'on' ? 'on' : 'analyse')))
    )
      return;
    await act(() => api.arrivalsRunNow());
  }

  async function load(id: string, offset = 0) {
    try {
      const r = await api.arrivalsList(id, offset, PAGE);
      lists = { ...lists, [id]: { ...r, offset } };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function toggled(id: string, e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !lists[id]) void load(id);
  }

  async function decide(id: number, decision: string) {
    await act(() => api.arrivalsDecide(id, decision));
    await load('reviews', lists.reviews?.offset ?? 0);
  }

  async function undo(batchId: number, books: number) {
    if (!(await confirmDestructive(booksArrivalsUndoCopy(books)))) return;
    await act(() => api.arrivalsUndo(batchId));
    await load('batches', lists.batches?.offset ?? 0);
  }

  async function downloadCsv() {
    try {
      const blob = await api.arrivalsNotImportedFile();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'not-imported.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      error = (err as Error).message;
    }
  }

  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
  const when = (v: unknown) => (typeof v === 'number' && v > 0 ? new Date(v).toLocaleString() : '');
  function source(item: Record<string, unknown>): string {
    const k = str(item.pair_key);
    return k.slice(k.indexOf('|') + 1);
  }
  function detailOf(item: Record<string, unknown>): Record<string, unknown> {
    try {
      return JSON.parse(str(item.detail_json) || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="arrivals-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">New arrivals (books)</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="New arrivals">
        {#each MODES as mode (mode)}
          <button
            class="c-btn {status.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
            role="radio"
            aria-checked={status.mode === mode}
            disabled={busy}
            on:click={() => setMode(mode)}
            data-testid="arrivals-mode-{mode}">{ARRIVALS_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">{ARRIVALS_HINTS[status.mode]}</p>
    {#if status.pause}
      <p class="c-notice text-sm" role="alert" data-testid="arrivals-paused">
        <b>Paused:</b>
        {status.pause.detail ?? status.pause.reason}
        <button
          class="c-btn c-btn-ghost c-btn-sm"
          on:click={() => act(() => api.arrivalsResume())}
          data-testid="arrivals-resume">Resume</button
        >
      </p>
    {/if}
    {#if status.importProblem && status.mode !== 'off'}
      <p class="c-notice text-sm" data-testid="arrivals-import-problem">
        The import is off: {status.importProblem}. Books added in Calibre are still checked.
      </p>
    {/if}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="arrivals-progress">
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
      {#if status.run?.waiting}
        <p class="text-sm text-c-muted" data-testid="arrivals-waiting">{status.run.waiting}</p>
      {/if}
      {#if status.run?.jGate}
        <p class="text-sm" data-testid="arrivals-jgate">
          The {status.run.jGate.design} check on the labeled books: {status.run.jGate.passed
            ? 'passed'
            : `below its bar on ${status.run.jGate.below.join(', ')} (decided with E there)`}.
        </p>
      {/if}
    {/if}
    <p class="text-sm" data-testid="arrivals-summary">{arrivalsSummary(status)}</p>
    {#if nextRunText(status)}<p class="text-sm text-c-muted">{nextRunText(status)}</p>{/if}
    {#each status.pairs as p (p.key)}
      <div class="flex flex-wrap items-center gap-2 text-sm" data-testid="arrivals-pair">
        <span><b>{p.source}</b>: {pairLine(p, status.mode)}</span>
      </div>
    {:else}
      {#if status.mode !== 'off'}
        <p class="text-sm text-c-muted">
          No source folder is set: Settings › New arrivals (books). Books added in Calibre are still
          checked.
        </p>
      {/if}
    {/each}
    {#if status.reviews > 0}
      <p class="text-sm" data-testid="arrivals-open">
        To look at: {n(status.reviews)} (the list below)
      </p>
    {/if}
    {#if status.mode !== 'off'}
      <div class="flex flex-wrap gap-2">
        <button
          class="c-btn c-btn-secondary"
          disabled={busy || running}
          on:click={runNow}
          data-testid="arrivals-run-now">{running ? 'Running…' : 'Run now'}</button
        >
        {#if running}
          <button
            class="c-btn c-btn-ghost"
            disabled={busy}
            on:click={() => act(() => api.arrivalsStop())}
            data-testid="arrivals-stop">Stop the run</button
          >
        {/if}
      </div>
    {/if}
    <details data-testid="arrivals-details">
      <summary class="cursor-pointer text-sm text-c-muted">Details</summary>
      <div class="mt-2 flex flex-col gap-1 text-sm">
        <p>AI setup for new books: {status.design} (Settings › AI).</p>
        {#each arrivalsReportLines(status) as line}<p data-testid="arrivals-report">
            {line}
          </p>{/each}
      </div>
    </details>
    <div class="flex flex-col gap-1">
      {#each LISTS as l (l.id)}
        <details on:toggle={(e) => toggled(l.id, e)} data-testid="arrivals-list-{l.id}">
          <summary class="cursor-pointer text-sm">
            {l.title}{lists[l.id] ? ` (${n(lists[l.id].total)})` : ''}
          </summary>
          {#if lists[l.id]}
            <div class="mt-1 flex flex-col gap-1 text-sm">
              {#if l.id === 'not_imported'}
                <div>
                  <button class="c-btn c-btn-ghost c-btn-sm" on:click={downloadCsv}
                    >Download the list (CSV)</button
                  >
                </div>
              {/if}
              {#each lists[l.id].items as item, i (i)}
                <div class="c-row flex flex-col gap-0.5 border-b border-c-line py-1">
                  {#if l.id === 'reviews'}
                    <span><b>{str(item.kind).replace(/_/g, ' ')}</b> {str(item.rel_path)}</span>
                    {#if item.calibre_id}<span class="text-c-muted"
                        >Library book {str(item.calibre_id)} {str(detailOf(item).title)}</span
                      >{/if}
                    <div class="flex flex-wrap gap-2">
                      {#if item.kind === 'better_copy'}
                        <button
                          class="c-btn c-btn-ghost c-btn-sm"
                          on:click={() => decide(num(item.id), 'keep_library')}
                          >Keep the library’s</button
                        >
                        <button
                          class="c-btn c-btn-ghost c-btn-sm"
                          on:click={() => decide(num(item.id), 'add_new')}>Use the new copy</button
                        >
                        <button
                          class="c-btn c-btn-ghost c-btn-sm"
                          on:click={() => decide(num(item.id), 'keep_both')}>Keep both</button
                        >
                      {:else if item.kind === 'add_failed'}
                        <button
                          class="c-btn c-btn-ghost c-btn-sm"
                          on:click={() => decide(num(item.id), 'retry')}>Add it again</button
                        >
                        <button
                          class="c-btn c-btn-ghost c-btn-sm"
                          on:click={() => decide(num(item.id), 'seen')}>Seen</button
                        >
                      {:else}
                        <button
                          class="c-btn c-btn-ghost c-btn-sm"
                          on:click={() => decide(num(item.id), 'seen')}>Seen</button
                        >
                      {/if}
                    </div>
                  {:else if l.id === 'archives'}
                    <span>{str(item.rel_path)} · {bytesText(item.size)}</span>
                    <span class="text-c-muted"
                      >{str(item.state).replace(/_/g, ' ')}{item.books
                        ? ` · ${n(item.books)} EPUB`
                        : ''}{item.detail ? ` · ${str(item.detail)}` : ''}</span
                    >
                  {:else if l.id === 'hand'}
                    <span>Calibre book {str(item.calibre_id)} · added {when(item.added_at)}</span>
                    <span class="text-c-muted"
                      >{item.run_id
                        ? `checked in run ${str(item.run_id)}`
                        : 'waits until unchanged for a while'}</span
                    >
                  {:else if l.id === 'batches'}
                    <span
                      >{str(item.kind) === 'add' ? 'Add' : 'Undo'} batch {str(item.id)} · {str(
                        item.state
                      )} ·
                      {n(num(item.done))} of {n(num(item.item_count))}{num(item.failed)
                        ? ` · ${n(num(item.failed))} failed`
                        : ''}</span
                    >
                    {#if item.kind === 'add' && item.state === 'done' && !item.undone && num(item.done) > 0}
                      <div>
                        <button
                          class="c-btn c-btn-ghost c-btn-sm"
                          on:click={() => undo(num(item.id), num(item.done))}
                          data-testid="arrivals-undo">Undo…</button
                        >
                      </div>
                    {/if}
                  {:else if l.id === 'runs'}
                    <span
                      >Run {str(item.id)} · {str(item.trigger)} · {str(item.mode) === 'on'
                        ? 'On'
                        : 'Preview'} ·
                      {str(item.state)} · {when(item.started_at)}</span
                    >
                    {#if item.error}<span class="text-c-muted">{str(item.error)}</span>{/if}
                  {:else}
                    <span class="break-all">{str(item.rel_path)}</span>
                    <span class="text-c-muted"
                      >{source(item)} · {str(item.format)} · {bytesText(item.size)} ·
                      {OUTCOME_LABELS[str(item.outcome)] ?? str(item.outcome)}{item.title
                        ? ` · ${str(item.title)}`
                        : ''}{item.calibre_id
                        ? ` · Calibre book ${str(item.calibre_id)}`
                        : ''}{item.added_as ? ` · added as ${str(item.added_as)}` : ''}</span
                    >
                    {#if item.detail}<span class="text-c-muted">{str(item.detail)}</span>{/if}
                  {/if}
                </div>
              {:else}
                <p class="text-c-muted">Nothing here.</p>
              {/each}
              {#if lists[l.id].total > PAGE}
                <div class="flex items-center gap-2">
                  <button
                    class="c-btn c-btn-ghost c-btn-sm"
                    disabled={lists[l.id].offset === 0}
                    on:click={() => load(l.id, Math.max(0, lists[l.id].offset - PAGE))}
                    >Previous</button
                  >
                  <span
                    >{n(lists[l.id].offset + 1)}-{n(
                      Math.min(lists[l.id].total, lists[l.id].offset + PAGE)
                    )} of {n(lists[l.id].total)}</span
                  >
                  <button
                    class="c-btn c-btn-ghost c-btn-sm"
                    disabled={lists[l.id].offset + PAGE >= lists[l.id].total}
                    on:click={() => load(l.id, lists[l.id].offset + PAGE)}>Next</button
                  >
                </div>
              {/if}
            </div>
          {/if}
        </details>
      {/each}
    </div>
  {/if}
</div>
