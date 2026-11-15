<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Season 2 Phase 9: the book's audio on this device, in the book page's Audiobook
   * section. "Download audio" (progress, Stop, Continue), "Remove audio from this device",
   * and what is stored when the server can't be reached. The download itself lives in the
   * app-wide manager (audio-offline.ts), so it goes on when this page is left. Nothing is
   * removed without a tap; removing asks first.
   */
  import { onDestroy } from 'svelte';
  import type { AudioLink } from '$lib/audio/audio-types';
  import { canDownloadAudio, getAudioDownloads } from '$lib/audio/offline/audio-offline';
  import type { CopyView } from '$lib/audio/offline/audio-download';
  import { deviceAudioView } from '$lib/audio/offline/offline-audio-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { removeAudioCopy, replaceAudioCopy } from '$lib/confirm/confirm-copy';
  import { formatBytes } from '$lib/diagnostics/diagnostics-text';
  import { logger } from '$lib/data/logger';

  export let bookId: string;
  export let link: AudioLink | null;
  /** The link was read from the server (false while it can't be reached). */
  export let linkKnown: boolean;
  /** The book's own copy is on this device. */
  export let bookOnDevice: boolean;
  /** Bound up: whether anything is stored (the section shows itself for it). */
  export let hasCopy = false;

  const downloads = getAudioDownloads();
  const views = downloads.views;
  const secure = canDownloadAudio();

  let message = '';
  let refreshedFor = '';

  $: if (bookId && bookId !== refreshedFor) {
    refreshedFor = bookId;
    void downloads.refresh(bookId).catch((err) => {
      logger.warn(`Offline audio: ${(err as Error)?.message ?? err}`);
    });
  }

  $: current = ($views[bookId] ?? { copy: null, running: false, problem: null }) as CopyView;
  $: hasCopy = !!current.copy;
  $: view = deviceAudioView({
    copy: current.copy,
    running: current.running,
    problem: current.problem,
    link,
    linkKnown,
    bookOnDevice,
    secure
  });

  let destroyed = false;
  onDestroy(() => (destroyed = true));

  function start(mode: 'continue' | 'replace' = 'continue') {
    message = '';
    void downloads.start(bookId, mode);
  }

  async function replace() {
    const copy = current.copy;
    if (!copy) return;
    const confirmed = await confirmDestructive({
      ...replaceAudioCopy(copy.fileName, formatBytes(copy.size)),
      testid: 'audio-device-replace-confirm',
      confirmTestid: 'audio-device-replace-confirm-button'
    });
    if (confirmed && !destroyed) start('replace');
  }

  async function remove() {
    const copy = current.copy;
    if (!copy) return;
    const confirmed = await confirmDestructive({
      ...removeAudioCopy(formatBytes(copy.size)),
      testid: 'audio-device-remove-confirm',
      confirmTestid: 'audio-device-remove-confirm-button'
    });
    if (!confirmed) return;
    message = '';
    try {
      await downloads.remove(bookId);
    } catch (err) {
      message = `Not removed: ${(err as Error)?.message ?? err}`;
    }
  }
</script>

{#if view.state !== 'hidden' || view.note || message}
  <div class="c-apanel mt-4 rounded px-5 py-4" data-testid="audio-device" data-state={view.state}>
    <div class="text-xs text-c-muted">On this device</div>
    {#if view.state === 'ready'}
      <p class="text-sm">Download the audio to listen without the library server.</p>
    {:else if view.text}
      <p
        class="break-words text-sm font-medium"
        role={view.state === 'downloading' ? 'status' : undefined}
        aria-live={view.state === 'downloading' ? 'polite' : undefined}
        data-testid="audio-device-text"
      >
        {view.text}
      </p>
    {/if}
    {#if view.state === 'downloading' || view.state === 'stopped'}
      <div
        class="c-mbar mt-2"
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.percent}
        data-testid="audio-device-bar"
      >
        <div style="width: {view.percent}%" />
      </div>
    {/if}
    {#if view.note}
      <p class="mt-2 text-sm" data-testid="audio-device-note">{view.note}</p>
    {/if}
    {#if view.state === 'downloading'}
      <p class="mt-2 text-sm text-c-muted">
        The download goes on while you use the app. If it stops, it continues from where it stopped.
      </p>
    {/if}
    {#if message}
      <p class="c-notice mt-2" role="alert" data-testid="audio-device-message">{message}</p>
    {/if}

    {#if view.canDownload || view.canStop || view.canContinue || view.canRestart || view.canReplace || view.canRemove}
      <div class="mt-3 flex flex-wrap gap-2">
        {#if view.canDownload}
          <button
            class="c-btn c-btn-primary c-round"
            data-testid="audio-device-download"
            on:click={() => start()}
          >
            {view.text}
          </button>
        {/if}
        {#if view.canStop}
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audio-device-stop"
            on:click={() => downloads.stop(bookId)}
          >
            Stop download
          </button>
        {/if}
        {#if view.canContinue}
          <button
            class="c-btn c-btn-primary c-round"
            data-testid="audio-device-continue"
            on:click={() => start()}
          >
            Continue download
          </button>
        {/if}
        {#if view.canRestart}
          <button
            class="c-btn c-btn-primary c-round"
            data-testid="audio-device-restart"
            on:click={() => start('replace')}
          >
            Start again
          </button>
        {/if}
        {#if view.canReplace}
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audio-device-replace"
            on:click={replace}
          >
            Download the current audio
          </button>
        {/if}
        {#if view.canRemove}
          <button
            class="c-btn c-btn-secondary c-round"
            data-testid="audio-device-remove"
            on:click={remove}
          >
            Remove audio from this device
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .c-apanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }

  .c-round {
    border-radius: 0.75rem;
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
