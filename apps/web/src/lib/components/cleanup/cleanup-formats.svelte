<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Books without an EPUB on /cleanup (non-epub-books.md): Off / Preview / On (On only after the
   * spot check, and it asks first), a bar with the time left for each step (converted, checked,
   * compared, written), what was found, the 30-book spot check (each EPUB can be downloaded and
   * opened; Right / Wrong), the near copies to decide (Fold it / Its own book / Leave it), and the
   * books listed and left (by reason, paged).
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    FORMATS_HINTS,
    FORMATS_MODE_LABELS,
    FORMATS_PHASES,
    barFraction,
    barLine,
    bookFacts,
    bookLine,
    formatsLines,
    type FormatsBook,
    type FormatsList,
    type FormatsMode,
    type FormatsStatus
  } from '$lib/cleanup/formats-text';
  import { n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { formatsOnCopy } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;

  const MODES: FormatsMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const PAGE = 20;

  let status: FormatsStatus | null = null;
  let error = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let spot: FormatsBook[] | null = null;
  let list: { which: FormatsList; total: number; books: FormatsBook[]; offset: number } | null =
    null;
  let reason: string | null = null;
  let downloading: string | null = null;

  $: lines = formatsLines(status);
  $: spotOpen =
    status !== null && status.progress.phase !== 'write' && status.progress.phase !== 'done';
  $: listed = status?.counts?.listed ?? {};
  $: listedTotal = Object.values(listed).reduce((a, b) => a + b, 0);
  $: reviewCount = Object.entries(status?.counts?.proposals ?? {})
    .filter(([k]) => k.startsWith('fold:review:proposed'))
    .reduce((a, [, v]) => a + v, 0);

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.formats();
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

  function toWrite(s: FormatsStatus, field: string): number {
    const p = s.counts?.proposals ?? {};
    return (p[`${field}:auto:proposed`] ?? 0) + (p[`${field}:auto:queued`] ?? 0);
  }

  async function setMode(mode: FormatsMode) {
    if (!status || status.mode === mode || busy) return;
    if (mode === 'on') {
      const ok = await confirmDestructive(
        formatsOnCopy(toWrite(status, 'epub'), toWrite(status, 'fold'))
      );
      if (!ok) return;
    }
    await act(() => api.setFormatsMode(mode));
  }

  async function act(fn: () => Promise<FormatsStatus>) {
    error = '';
    busy = true;
    try {
      status = await fn();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function loadSpot() {
    try {
      spot = (await api.formatsSpot()).books;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function loadList(which: FormatsList, offset = 0) {
    try {
      const r = await api.formatsBooks(which, which === 'listed' ? reason : null, offset, PAGE);
      list = { which, ...r, offset };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function mark(book: FormatsBook, v: 'right' | 'wrong') {
    await act(() => api.setFormatsVerdict(book.uuid, book.mark === v ? null : v));
    await loadSpot();
  }

  async function choose(book: FormatsBook, choice: 'fold' | 'convert' | 'leave') {
    if (!book.change) return;
    await act(() => api.chooseFormats(book.change!.id, choice));
    if (list) await loadList(list.which, list.offset);
  }

  function pickReason(r: string | null) {
    reason = r;
    void loadList('listed', 0);
  }

  /** Downloads the checked EPUB (with the token), so it can be opened in a reader. */
  async function download(book: FormatsBook) {
    downloading = book.uuid;
    try {
      const blob = await api.formatsEpub(book.uuid);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${book.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)}.epub`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      downloading = null;
    }
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="formats-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">Books without an EPUB</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Books without an EPUB">
        {#each MODES as mode (mode)}
          <button
            class="c-btn {status.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
            role="radio"
            aria-checked={status.mode === mode}
            disabled={busy || (mode === 'on' && status.mode !== 'on' && !status.spotPassed)}
            title={mode === 'on' && !status.spotPassed
              ? 'On waits for the spot check: every book marked, none wrong'
              : undefined}
            on:click={() => setMode(mode)}
            data-testid="formats-mode-{mode}">{FORMATS_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">{FORMATS_HINTS[status.mode]}</p>
    {#if status.pausedReason}
      <div class="c-notice flex flex-wrap items-center gap-2 text-sm" role="alert">
        <span>Paused: {status.pausedDetail ?? status.pausedReason}</span>
        <button
          class="c-btn c-btn-secondary c-btn-sm"
          disabled={busy}
          on:click={() => act(() => api.formatsResume())}
          data-testid="formats-resume">Resume</button
        >
      </div>
    {/if}
    {#if status.mode !== 'off'}
      <p class="text-sm" data-testid="formats-phase">
        {status.mode === 'analyse' && status.progress.phase === 'spot'
          ? 'Done: the books wait for the spot check and On'
          : FORMATS_PHASES[status.progress.phase]}
      </p>
    {/if}
    {#each status.bars as bar (bar.phase)}
      <div class="flex flex-col gap-1" data-testid="formats-bar-{bar.phase}">
        <div class="flex flex-wrap justify-between gap-x-4 text-sm">
          <span>{barLine(bar)}</span>
          <span>{Math.floor(barFraction(bar) * 100)} %</span>
        </div>
        <div
          class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
          role="progressbar"
          aria-label={bar.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(barFraction(bar) * 100)}
        >
          <div class="h-full bg-c-fill" style="width: {barFraction(bar) * 100}%" />
        </div>
        {#if bar.note}<span class="text-sm text-c-muted">{bar.note}</span>{/if}
      </div>
    {/each}
    {#each lines as line}<p class="text-sm" data-testid="formats-line">{line}</p>{/each}
    {#if status.mode !== 'off' && status.progress.phase !== 'write'}
      <div>
        <button
          class="c-btn c-btn-ghost c-btn-sm"
          disabled={busy}
          on:click={() => act(() => api.formatsAgain())}
          data-testid="formats-again">Look again from the start</button
        >
      </div>
    {/if}
    {#if status.spot.total > 0}
      <details
        on:toggle={(e) => {
          if (e.currentTarget.open && !spot) void loadSpot();
        }}
        data-testid="formats-spot"
      >
        <summary class="cursor-pointer text-sm"
          >The spot check ({n(status.spot.total - status.spot.open)} of {n(status.spot.total)} marked)</summary
        >
        <p class="mt-1 text-sm text-c-muted">
          Download each EPUB, open it, and mark it: Right when it reads as the book should (the
          whole text, or every page of a picture book, in order), Wrong when anything is missing or
          garbled.
        </p>
        {#if spot}
          <ul class="mt-1 flex flex-col gap-2">
            {#each spot as book (book.uuid)}
              <li
                class="c-tile flex flex-col gap-1 rounded p-2 text-sm"
                data-testid="formats-spot-book"
              >
                <span class="font-bold">{bookLine(book)}</span>
                <span class="text-c-muted">{bookFacts(book)}</span>
                <div class="flex flex-wrap gap-2">
                  {#if book.hasEpub}
                    <button
                      class="c-btn c-btn-ghost c-btn-sm"
                      disabled={downloading === book.uuid}
                      on:click={() => download(book)}
                      data-testid="formats-download"
                      >{downloading === book.uuid ? 'Downloading…' : 'Download the EPUB'}</button
                    >
                  {/if}
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={book.mark === 'right'}
                    disabled={busy || !spotOpen}
                    on:click={() => mark(book, 'right')}
                    data-testid="formats-right">Right</button
                  >
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={book.mark === 'wrong'}
                    disabled={busy || !spotOpen}
                    on:click={() => mark(book, 'wrong')}
                    data-testid="formats-wrong">Wrong</button
                  >
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </details>
    {/if}
    {#if status.counts}
      <div class="flex flex-wrap gap-2" role="group" aria-label="Show the books">
        {#if reviewCount > 0}
          <button
            class="c-chip c-chip-sm"
            aria-pressed={list?.which === 'review'}
            on:click={() => loadList('review')}
            data-testid="formats-show-review">Near copies to decide ({n(reviewCount)})</button
          >
        {/if}
        <button
          class="c-chip c-chip-sm"
          aria-pressed={list?.which === 'convert'}
          on:click={() => loadList('convert')}
          data-testid="formats-show-convert">EPUBs for their own book</button
        >
        <button
          class="c-chip c-chip-sm"
          aria-pressed={list?.which === 'fold'}
          on:click={() => loadList('fold')}
          data-testid="formats-show-fold">Copies to fold</button
        >
        {#if listedTotal > 0}
          <button
            class="c-chip c-chip-sm"
            aria-pressed={list?.which === 'listed'}
            on:click={() => pickReason(null)}
            data-testid="formats-show-listed">Listed and left ({n(listedTotal)})</button
          >
        {/if}
      </div>
      {#if list}
        <div class="flex flex-col gap-2" data-testid="formats-list">
          {#if list.which === 'listed'}
            <div class="flex flex-wrap gap-2" role="group" aria-label="Reason">
              <button
                class="c-chip c-chip-sm"
                aria-pressed={reason === null}
                on:click={() => pickReason(null)}>All</button
              >
              {#each Object.entries(listed) as [r, count] (r)}
                <button
                  class="c-chip c-chip-sm"
                  aria-pressed={reason === r}
                  data-testid="formats-reason-{r}"
                  on:click={() => pickReason(r)}>{status.listedText[r] ?? r} ({n(count)})</button
                >
              {/each}
            </div>
          {/if}
          <ul class="flex flex-col gap-2">
            {#each list.books as book (book.uuid)}
              <li class="c-tile flex flex-col gap-1 rounded p-2 text-sm" data-testid="formats-book">
                <span class="font-bold">{bookLine(book)}</span>
                <span class="text-c-muted"
                  >{book.formats.join(', ') || 'no file'}{bookFacts(book)
                    ? ` · ${bookFacts(book)}`
                    : ''}</span
                >
                {#if book.detail && book.state === 'listed'}<span>{book.detail}</span>{/if}
                {#if book.twin}
                  <span
                    >{book.reason ?? ''} — EPUB book: {book.twin.title} (Calibre #{book.twin
                      .calibreId})</span
                  >
                {/if}
                {#if book.change && book.change.reason && book.change.state !== 'applied'}
                  <span class="text-c-muted">{book.change.reason}</span>
                {/if}
                {#if list.which === 'review' && book.change && (book.change.state === 'proposed' || book.change.state === 'kept')}
                  <div class="flex flex-wrap gap-2">
                    {#if book.hasEpub}
                      <button
                        class="c-btn c-btn-ghost c-btn-sm"
                        disabled={downloading === book.uuid}
                        on:click={() => download(book)}>Download the EPUB</button
                      >
                    {/if}
                    <button
                      class="c-btn c-btn-secondary c-btn-sm"
                      aria-pressed={book.change.klass === 'auto' && book.change.field === 'fold'}
                      disabled={busy}
                      on:click={() => choose(book, 'fold')}
                      data-testid="formats-fold">Fold it into the EPUB book</button
                    >
                    {#if book.hasEpub}
                      <button
                        class="c-btn c-btn-secondary c-btn-sm"
                        aria-pressed={book.change.field === 'epub'}
                        disabled={busy}
                        on:click={() => choose(book, 'convert')}
                        data-testid="formats-own">Its own book</button
                      >
                    {/if}
                    <button
                      class="c-btn c-btn-secondary c-btn-sm"
                      aria-pressed={book.change.state === 'kept'}
                      disabled={busy}
                      on:click={() => choose(book, 'leave')}
                      data-testid="formats-leave">Leave it</button
                    >
                  </div>
                {/if}
              </li>
            {:else}
              <li class="text-sm text-c-muted">Nothing here.</li>
            {/each}
          </ul>
          {#if list.total > PAGE}
            <div class="flex items-center gap-2 text-sm">
              <button
                class="c-btn c-btn-ghost c-btn-sm"
                disabled={list.offset === 0}
                on:click={() => list && loadList(list.which, Math.max(0, list.offset - PAGE))}
                >Previous</button
              >
              <span
                >{n(list.offset + 1)}-{n(Math.min(list.total, list.offset + PAGE))} of {n(
                  list.total
                )}</span
              >
              <button
                class="c-btn c-btn-ghost c-btn-sm"
                disabled={list.offset + PAGE >= list.total}
                on:click={() => list && loadList(list.which, list.offset + PAGE)}>Next</button
              >
            </div>
          {/if}
        </div>
      {/if}
    {/if}
  {/if}
</div>
