<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Manga part A on /cleanup: "Move manga to the manga library". Off / Preview / On (On only
   * after the spot check, and it asks first), the step with its bar and time left, what was found,
   * the 30-book spot check (Right / Wrong, each book linked to its page), and the books held for
   * review (by reason, paged) with Move it anyway / Keep it here.
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    MOVE_HINTS,
    MOVE_HOLDS,
    MOVE_MODE_LABELS,
    MOVE_PHASES,
    holdLine,
    moveBar,
    moveBookLine,
    moveLines,
    type MoveBook,
    type MoveHold,
    type MoveMode,
    type MoveStatus
  } from '$lib/cleanup/move-text';
  import { n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { moveOnCopy } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;

  const MODES: MoveMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const PAGE = 20;

  let status: MoveStatus | null = null;
  let error = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let spot: MoveBook[] | null = null;
  let held: { total: number; books: MoveBook[]; offset: number } | null = null;
  let reason: MoveHold | null = null;

  $: bar = moveBar(status);
  $: lines = moveLines(status);
  $: heldCount = status
    ? Object.values(status.progress.counts.held).reduce((a, b) => a + (b ?? 0), 0)
    : 0;
  $: spotOpen =
    status !== null && status.progress.phase !== 'write' && status.progress.phase !== 'done';

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.move();
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

  async function setMode(mode: MoveMode) {
    if (!status || status.mode === mode || busy) return;
    if (mode === 'on') {
      const books =
        (status.proposals['auto:proposed'] ?? 0) + (status.proposals['auto:queued'] ?? 0);
      const ok = await confirmDestructive(
        moveOnCopy(books, status.progress.counts.withData, status.target.folder)
      );
      if (!ok) return;
    }
    await act(() => api.setMoveMode(mode));
  }

  async function act(fn: () => Promise<MoveStatus>) {
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
      spot = (await api.moveSpot()).books;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function loadHeld(offset = 0) {
    try {
      const r = await api.moveHeld(reason, offset, PAGE);
      held = { ...r, offset };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function verdict(book: MoveBook, v: 'right' | 'wrong') {
    await act(() => api.setMoveVerdict(book.uuid, book.verdict === v ? null : v));
    await loadSpot();
  }

  async function choose(book: MoveBook, choice: 'move' | 'keep') {
    await act(() => api.chooseMove(book.changeId, choice));
    await loadHeld(held?.offset ?? 0);
  }

  function pickReason(r: MoveHold | null) {
    reason = r;
    void loadHeld(0);
  }

  const bookHref = (b: MoveBook) =>
    b.readerBookId ? `/library/book?id=${encodeURIComponent(b.readerBookId)}` : null;
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="move-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">Move manga to the manga library</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Move manga">
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
            data-testid="move-mode-{mode}">{MOVE_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">{MOVE_HINTS[status.mode]}</p>
    {#if status.pausedReason}
      <div class="c-notice flex flex-wrap items-center gap-2 text-sm" role="alert">
        <span>Paused: {status.pausedDetail ?? status.pausedReason}</span>
        <button
          class="c-btn c-btn-secondary c-btn-sm"
          disabled={busy}
          on:click={() => act(() => api.moveResume())}
          data-testid="move-resume">Resume</button
        >
      </div>
    {/if}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="move-progress">
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
    {:else if status.mode !== 'off'}
      <p class="text-sm" data-testid="move-phase">
        {status.mode === 'analyse' && status.progress.phase === 'spot'
          ? 'Done: the books wait for the spot check and On'
          : MOVE_PHASES[status.progress.phase]}
      </p>
    {/if}
    {#if status.progress.write.waiting && status.mode === 'on' && status.progress.phase === 'write'}
      <p class="text-sm text-c-muted" data-testid="move-waiting">{status.progress.write.waiting}</p>
    {/if}
    {#each lines as line}<p class="text-sm" data-testid="move-line">{line}</p>{/each}
    {#if status.mode !== 'off' && status.progress.phase !== 'write'}
      <div>
        <button
          class="c-btn c-btn-ghost c-btn-sm"
          disabled={busy}
          on:click={() => act(() => api.moveAgain())}
          data-testid="move-again">Select again</button
        >
      </div>
    {/if}
    {#if status.spot.total > 0}
      <details
        on:toggle={(e) => {
          if (e.currentTarget.open && !spot) void loadSpot();
        }}
        data-testid="move-spot"
      >
        <summary class="cursor-pointer text-sm"
          >The spot check ({n(status.spot.total - status.spot.open)} of {n(status.spot.total)} marked)</summary
        >
        <p class="mt-1 text-sm text-c-muted">
          Open each book and mark it: Right when it is manga or a picture book that belongs in the
          manga library, Wrong when it is a book with text.
        </p>
        {#if spot}
          <ul class="mt-1 flex flex-col gap-2">
            {#each spot as book (book.uuid)}
              <li
                class="c-tile flex flex-col gap-1 rounded p-2 text-sm"
                data-testid="move-spot-book"
              >
                {#if bookHref(book)}
                  <a
                    class="font-bold underline"
                    href={bookHref(book)}
                    target="_blank"
                    rel="noopener">{moveBookLine(book)}</a
                  >
                {:else}
                  <span class="font-bold">{moveBookLine(book)}</span>
                {/if}
                <span class="text-c-muted">{book.matched.join(', ')}</span>
                <div class="flex flex-wrap gap-2">
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={book.verdict === 'right'}
                    disabled={busy || !spotOpen}
                    on:click={() => verdict(book, 'right')}
                    data-testid="move-right">Right</button
                  >
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={book.verdict === 'wrong'}
                    disabled={busy || !spotOpen}
                    on:click={() => verdict(book, 'wrong')}
                    data-testid="move-wrong">Wrong</button
                  >
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </details>
    {/if}
    {#if heldCount > 0}
      <details
        on:toggle={(e) => {
          if (e.currentTarget.open && !held) void loadHeld();
        }}
        data-testid="move-held"
      >
        <summary class="cursor-pointer text-sm">Held for you ({n(heldCount)})</summary>
        <div class="mt-1 flex flex-col gap-2">
          <div class="flex flex-wrap gap-2" role="group" aria-label="Show">
            <button
              class="c-chip c-chip-sm"
              aria-pressed={reason === null}
              on:click={() => pickReason(null)}>All</button
            >
            {#each MOVE_HOLDS.filter((h) => (status?.progress.counts.held[h.hold] ?? 0) > 0) as h (h.hold)}
              <button
                class="c-chip c-chip-sm"
                aria-pressed={reason === h.hold}
                data-testid="move-held-{h.hold}"
                on:click={() => pickReason(h.hold)}
                >{h.label} ({n(status?.progress.counts.held[h.hold] ?? 0)})</button
              >
            {/each}
          </div>
          {#if held}
            <ul class="flex flex-col gap-2">
              {#each held.books as book (book.changeId)}
                <li
                  class="c-tile flex flex-col gap-1 rounded p-2 text-sm"
                  data-testid="move-held-book"
                >
                  {#if bookHref(book)}
                    <a
                      class="font-bold underline"
                      href={bookHref(book)}
                      target="_blank"
                      rel="noopener">{moveBookLine(book)}</a
                    >
                  {:else}
                    <span class="font-bold">{moveBookLine(book)}</span>
                  {/if}
                  <span class="text-c-muted">{holdLine(book)}</span>
                  {#if book.state === 'proposed' || book.state === 'kept'}
                    <div class="flex flex-wrap gap-2">
                      {#if book.formats.includes('EPUB')}
                        <button
                          class="c-btn c-btn-secondary c-btn-sm"
                          aria-pressed={book.klass === 'auto'}
                          disabled={busy}
                          on:click={() => choose(book, 'move')}
                          data-testid="move-anyway">Move it anyway</button
                        >
                      {/if}
                      <button
                        class="c-btn c-btn-secondary c-btn-sm"
                        aria-pressed={book.state === 'kept'}
                        disabled={busy}
                        on:click={() => choose(book, 'keep')}
                        data-testid="move-keep">Keep it here</button
                      >
                    </div>
                  {/if}
                </li>
              {:else}
                <li class="text-sm text-c-muted">Nothing here.</li>
              {/each}
            </ul>
            {#if held.total > PAGE}
              <div class="flex items-center gap-2 text-sm">
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={held.offset === 0}
                  on:click={() => loadHeld(Math.max(0, (held?.offset ?? 0) - PAGE))}
                  >Previous</button
                >
                <span
                  >{n(held.offset + 1)}-{n(Math.min(held.total, held.offset + PAGE))} of {n(
                    held.total
                  )}</span
                >
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={held.offset + PAGE >= held.total}
                  on:click={() => loadHeld((held?.offset ?? 0) + PAGE)}>Next</button
                >
              </div>
            {/if}
          {/if}
        </div>
      </details>
    {/if}
  {/if}
</div>
