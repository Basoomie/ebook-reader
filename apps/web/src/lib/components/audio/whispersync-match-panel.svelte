<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Whispersync "Match" on the book page (2026-11-21), in the Audiobook section's Subtitles row
   * when an audiobook and a subtitle file are linked. Match / Match again / Reset match, with
   * whispersync's own matcher and the reader's save and reset steps
   * ($lib/audio/whispersync-book-match.ts). A book that isn't on this device is downloaded
   * first; offline it says so and does nothing. The page never reloads: `state` (bound up, the
   * row's summary shows it) follows the saved match on the server.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { resetMatchCopy } from '$lib/confirm/confirm-copy';
  import { logger } from '$lib/data/logger';
  import { LibraryApiError, type LibraryApi } from '$lib/library/api';
  import type { LibraryStore } from '$lib/library/library-db';
  import type { OpenStage, OpenTarget } from '$lib/library/open-calibre-book';
  import { openCatalogBook } from '$lib/library/open-from-catalog';
  import type { CatalogLibrary } from '$lib/library/types';
  import {
    NO_LINES_NOTE,
    OFFLINE_NOTE,
    PENDING_NOTE,
    PICKED_FILE_NOTE,
    START_POINT_NOTE,
    figureText,
    levelCopy,
    loadLines,
    resetBookMatch,
    runMatch,
    saveMatch,
    timeLeftText,
    type BookMatch
  } from '$lib/audio/whispersync-book-match';
  import type { BookRef } from '$lib/audio/whispersync-sync';
  import { downloadFile } from '$lib/whispersync/lib/util';
  import { unmatchedListName, unmatchedListText } from '$lib/whispersync/lib/match';

  export let api: LibraryApi;
  export let bookId: string;
  export let book: OpenTarget;
  export let store: LibraryStore;
  export let libraries: readonly CatalogLibrary[];
  /** Bound up: the saved match on the server (null while it is read). */
  export let state: 'matched' | 'not-matched' | 'pending' | null = null;

  const dispatch = createEventDispatcher<{ stored: void }>();

  type Phase = 'idle' | 'download' | 'prepare' | 'matching' | 'results' | 'saving' | 'resetting';
  let phase: Phase = 'idle';
  let message = '';
  let stage: OpenStage | null = null;
  let progress = 0;
  let startedAt = 0;
  let now = Date.now();
  let match: BookMatch | null = null;
  /** The copy the shown result was matched on (Save stores it there). */
  let bookRef: BookRef | null = null;
  let controller: AbortController | null = null;
  let loadedFor = '';
  let destroyed = false;
  let clock: ReturnType<typeof setInterval> | undefined;

  const isIOS =
    typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      navigator.platform === 'iPad' ||
      navigator.platform === 'iPhone' ||
      navigator.platform === 'iPod');

  $: if (bookId && bookId !== loadedFor) void loadState(bookId);
  $: busy = phase !== 'idle' && phase !== 'results';
  $: matched = state === 'matched' || state === 'pending';
  $: downloadLeft =
    stage?.stage === 'download' && stage.total
      ? timeLeftText(now - startedAt, (stage.loaded / stage.total) * 100)
      : '';
  $: matchLeft = phase === 'matching' ? timeLeftText(now - startedAt, progress) : '';

  onDestroy(() => {
    destroyed = true;
    controller?.abort();
    clearInterval(clock);
  });

  async function loadState(id: string) {
    loadedFor = id;
    state = null;
    try {
      const { matchStateOf } = await import('$lib/audio/whispersync-book-match-browser');
      const found = await matchStateOf(id);
      if (!destroyed && id === loadedFor) state = found;
    } catch (err) {
      logger.warn(`Details: whispersync match state: ${(err as Error).message}`);
      if (!destroyed && id === loadedFor) state = 'not-matched';
    }
  }

  function tick(on: boolean) {
    clearInterval(clock);
    now = Date.now();
    startedAt = now;
    if (on) clock = setInterval(() => (now = Date.now()), 1000);
  }

  function mb(bytes: number) {
    return (bytes / 1_000_000).toFixed(1);
  }

  function offline(err: unknown) {
    return err instanceof LibraryApiError && (err.kind === 'unreachable' || err.kind === 'timeout');
  }

  /** This device's copy of the book, downloaded first when it isn't here. */
  async function copyHere(signal: AbortSignal): Promise<BookRef | 'stop'> {
    const { bookRefOnDevice } = await import('$lib/audio/whispersync-book-match-browser');
    const here = await bookRefOnDevice(bookId);
    if (here) return here;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      message = OFFLINE_NOTE;
      return 'stop';
    }
    phase = 'download';
    stage = null;
    tick(true);
    try {
      const outcome = await openCatalogBook(book, api, store, libraries, signal, (s) => {
        if (s.stage === 'download' && stage?.stage !== 'download') tick(true);
        stage = s;
      });
      if (outcome.status === 'refused') {
        message = outcome.message;
        return 'stop';
      }
      if (outcome.status !== 'opened') return 'stop';
    } catch (err) {
      message = offline(err) ? OFFLINE_NOTE : (err as Error).message;
      return 'stop';
    }
    dispatch('stored');
    return (await bookRefOnDevice(bookId)) ?? 'stop';
  }

  async function start() {
    if (busy) return;
    message = '';
    match = null;
    controller = new AbortController();
    const signal = controller.signal;
    phase = 'prepare';
    try {
      const ref = await copyHere(signal);
      if (ref === 'stop' || signal.aborted) return;
      phase = 'prepare';
      const { bookMatchDeps, fetchLatest } = await import(
        '$lib/audio/whispersync-book-match-browser'
      );
      const deps = await bookMatchDeps(api, bookId);
      // The reader's opening sync: newer data from other devices comes in first.
      await fetchLatest();
      for (const problem of await levelCopy(deps, ref)) logger.warn(`Whispersync: ${problem}`);
      const lines = await loadLines(deps, ref);
      if (lines.kind === 'picked-file') {
        message = PICKED_FILE_NOTE;
        return;
      }
      if (lines.kind === 'none') {
        message = NO_LINES_NOTE;
        return;
      }
      phase = 'matching';
      progress = 0;
      tick(true);
      const found = await runMatch(deps, ref.localId, lines, signal, (p) => (progress = p));
      if (destroyed) return;
      match = found;
      bookRef = ref;
      phase = 'results';
    } catch (err) {
      const error = err as Error;
      if (!signal.aborted && error?.name !== 'AbortError') {
        // whispersync's own words for a failed match ("Failed to match: …").
        message = `Failed to match: ${error?.message ?? err}`;
        logger.warn(`Details: whispersync match: ${message}`);
      }
    } finally {
      tick(false);
      if (phase !== 'results') phase = 'idle';
      stage = null;
      controller = null;
    }
  }

  function cancel() {
    if (phase === 'results') {
      match = null;
      phase = 'idle';
      return;
    }
    controller?.abort();
  }

  async function save() {
    if (!match || !bookRef) return;
    phase = 'saving';
    message = '';
    try {
      const { bookMatchDeps } = await import('$lib/audio/whispersync-book-match-browser');
      const outcome = await saveMatch(await bookMatchDeps(api, bookId), bookRef, match);
      state = outcome === 'uploaded' ? 'matched' : 'pending';
      match = null;
      phase = 'idle';
    } catch (err) {
      message = `Failed to save data: ${(err as Error).message}`;
      phase = 'results';
    }
  }

  async function reset() {
    if (busy) return;
    const ok = await confirmDestructive({
      ...resetMatchCopy({ reload: false }),
      testid: 'ws-match-reset-confirm',
      confirmTestid: 'ws-match-reset-confirm-button'
    });
    if (!ok) return;
    phase = 'resetting';
    message = '';
    try {
      const { bookMatchDeps, bookRefOnDevice, fetchLatest } = await import(
        '$lib/audio/whispersync-book-match-browser'
      );
      const deps = await bookMatchDeps(api, bookId);
      const ref = await bookRefOnDevice(bookId);
      await fetchLatest();
      if (ref)
        for (const problem of await levelCopy(deps, ref)) logger.warn(`Whispersync: ${problem}`);
      await resetBookMatch(deps, {
        bookId,
        localId: ref?.localId ?? null,
        title: ref?.title ?? book.title
      });
      // The removal is in this device's outbox. The reader's Reset reloads, which sends it at
      // once; this page stays, so send it now (at most the library request time).
      await fetchLatest();
      state = 'not-matched';
    } catch (err) {
      message = `Failed to reset book: ${(err as Error).message}`;
    } finally {
      phase = 'idle';
    }
  }

  function downloadUnplaced() {
    if (!match) return;
    downloadFile(
      document,
      new Blob([unmatchedListText(match.result.unmatchedSubtitles)], {
        type: 'text/plain;charset=utf-8'
      }),
      unmatchedListName(match.subtitleName),
      isIOS
    );
  }
</script>

<div class="mt-3" data-testid="ws-match" data-phase={phase}>
  {#if phase === 'idle'}
    <div class="flex flex-wrap gap-2">
      {#if !matched}
        <button
          class="c-btn c-btn-secondary"
          data-testid="ws-match-start"
          disabled={state === null}
          on:click={start}
        >
          Match
        </button>
      {:else}
        <button class="c-btn c-btn-secondary" data-testid="ws-match-again" on:click={start}>
          Match again
        </button>
        <button class="c-btn c-btn-ghost" data-testid="ws-match-reset" on:click={reset}>
          Reset match
        </button>
      {/if}
    </div>
    {#if state === 'pending'}
      <p class="mt-2 text-sm text-c-muted" data-testid="ws-match-pending">{PENDING_NOTE}</p>
    {/if}
  {:else if phase === 'download'}
    <p class="text-sm" role="status" aria-live="polite" data-testid="ws-match-download-text">
      {#if stage?.stage === 'download'}
        Downloading the book to this device: {stage.total
          ? `${mb(stage.loaded)} of ${mb(stage.total)} MB`
          : `${mb(stage.loaded)} MB`}{downloadLeft ? `, ${downloadLeft}` : ''}
      {:else if stage?.stage === 'prepare'}
        Preparing the book…
      {:else if stage?.stage === 'save'}
        Saving the book on this device…
      {:else if stage?.stage === 'audiobook'}
        Getting audiobook data…
      {:else}
        Checking…
      {/if}
    </p>
    <div
      class="c-mbar mt-2"
      role="progressbar"
      aria-label="Download progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={stage?.stage === 'download' && stage.total
        ? Math.floor((stage.loaded / stage.total) * 100)
        : 0}
      data-testid="ws-match-download-bar"
    >
      <div
        style="width: {stage?.stage === 'download' && stage.total
          ? Math.floor((stage.loaded / stage.total) * 100)
          : stage && stage.stage !== 'download'
            ? 100
            : 0}%"
      />
    </div>
    <div class="mt-2">
      <button class="c-btn c-btn-secondary" data-testid="ws-match-cancel" on:click={cancel}>
        Cancel
      </button>
    </div>
  {:else if phase === 'prepare'}
    <p class="text-sm" role="status" aria-live="polite" data-testid="ws-match-prepare">
      Getting the book and its subtitles ready…
    </p>
  {:else if phase === 'matching'}
    <p class="text-sm" role="status" aria-live="polite" data-testid="ws-match-progress-text">
      Matching: {progress}%{matchLeft ? `, ${matchLeft}` : ''}
    </p>
    <div
      class="c-mbar mt-2"
      role="progressbar"
      aria-label="Match progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      data-testid="ws-match-bar"
    >
      <div style="width: {progress}%" />
    </div>
    <div class="mt-2">
      <button class="c-btn c-btn-secondary" data-testid="ws-match-cancel" on:click={cancel}>
        Cancel
      </button>
    </div>
  {:else if (phase === 'results' || phase === 'saving') && match}
    <dl class="ws-figures text-sm" data-testid="ws-match-results">
      <dt class="text-c-muted">Lines matched</dt>
      <dd class="font-medium" data-testid="ws-match-lines" data-value={match.result.lineMatchRate}>
        {figureText(match.result.lineMatchRate)}
      </dd>
      <dt class="text-c-muted">Lines that differ from the book</dt>
      <dd
        class="font-medium"
        data-testid="ws-match-diff"
        data-value={match.result.bookSubtitleDiffRate}
      >
        {figureText(match.result.bookSubtitleDiffRate)}
      </dd>
    </dl>
    <span class="hidden" data-testid="ws-match-total" data-value={`${match.lineCount}`} />
    <p class="mt-2 text-sm text-c-muted" data-testid="ws-match-start-note">{START_POINT_NOTE}</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button
        class="c-btn c-btn-primary"
        data-testid="ws-match-save"
        disabled={phase === 'saving'}
        on:click={save}
      >
        {phase === 'saving' ? 'Saving…' : 'Save'}
      </button>
      <button
        class="c-btn c-btn-secondary"
        data-testid="ws-match-discard"
        disabled={phase === 'saving'}
        on:click={cancel}
      >
        Cancel
      </button>
      {#if match.result.unmatchedSubtitles.length}
        <button
          class="c-btn c-btn-ghost"
          data-testid="ws-match-download"
          disabled={phase === 'saving'}
          on:click={downloadUnplaced}
        >
          Download the lines it couldn't place ({match.result.unmatchedSubtitles.length.toLocaleString(
            'en-US'
          )})
        </button>
      {/if}
    </div>
  {:else if phase === 'resetting'}
    <p class="text-sm" role="status" aria-live="polite">Resetting the match…</p>
  {/if}

  {#if message}
    <p class="mt-2 text-sm font-semibold" role="alert" data-testid="ws-match-message">
      {message}
    </p>
  {/if}
</div>

<style>
  .ws-figures {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 1rem;
    row-gap: 0.25rem;
  }

  .c-mbar {
    height: 0.75rem;
    border: var(--c-border-width) solid currentColor;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .c-mbar > div {
    height: 100%;
    background-color: currentColor;
    transition: width 0.3s;
  }
</style>
