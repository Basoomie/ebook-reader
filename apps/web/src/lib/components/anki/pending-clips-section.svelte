<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import { onDestroy, onMount } from 'svelte';
  import { pendingStatus, type PendingClip } from '$lib/anki/pending/pending-clip';
  import InlineConfirm from '$lib/components/confirm/inline-confirm.svelte';
  import PagedList from '$lib/components/settings/paged-list.svelte';
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import { cancelPendingClipCopy } from '$lib/confirm/confirm-copy';
  import { formatWhen } from '$lib/sync/position-prompt';

  /**
   * Settings > Anki > This device (Season 2 §3): sentence audio that Enrich couldn't add
   * because the library server couldn't be reached, waiting to be added to its card. The
   * only place that shows them (decided with the user, 2026-11-15): an added clip leaves the
   * list, one that couldn't be added stays with the reason until dismissed.
   */

  type Service = typeof import('$lib/anki/pending/pending-service');

  let service: Service | undefined;
  let clips: PendingClip[] = [];
  let loaded = false;
  let loadError = '';
  let trying = false;
  let tryMessage = '';
  let confirming: PendingClip | undefined;
  let busy = false;
  let stop: (() => void) | undefined;
  let now = Date.now();

  async function refresh() {
    if (!service) return;
    try {
      clips = await service.listPendingClips();
      loadError = '';
    } catch (error) {
      loadError = `Couldn't read the waiting sentence audio: ${(error as Error)?.message ?? error}`;
    } finally {
      loaded = true;
      now = Date.now();
    }
  }

  onMount(() => {
    import('$lib/anki/pending/pending-service')
      .then((s) => {
        service = s;
        stop = s.onPendingClipsChange(() => void refresh());
        return refresh();
      })
      .catch((error) => {
        loaded = true;
        loadError = `Couldn't read the waiting sentence audio: ${(error as Error)?.message ?? error}`;
      });
  });

  onDestroy(() => stop?.());

  async function tryNow() {
    if (!service) return;
    trying = true;
    tryMessage = '';
    try {
      const report = await service.runPendingClipsSoon();
      await refresh();
      const waiting = clips.filter((c) => c.state !== 'failed').length;
      tryMessage = report?.added
        ? `Added sentence audio to ${report.added === 1 ? '1 card' : `${report.added} cards`}.`
        : waiting
          ? 'Still waiting.'
          : '';
    } finally {
      trying = false;
    }
  }

  async function remove(clip: PendingClip) {
    if (!service) return;
    busy = true;
    try {
      await service.removePendingClip(clip.id);
      confirming = undefined;
      await refresh();
    } finally {
      busy = false;
    }
  }

  function sentence(clip: PendingClip): string {
    const text = clip.source.text;
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }

  $: waitingCount = clips.filter((c) => c.state !== 'failed').length;
</script>

<SettingsGroup
  id="anki-pending"
  testid="anki-pending"
  description="When the library server can't be reached, or the PC reads the sentence for a book without an audiobook, Enrich adds everything else and keeps the sentence audio here. It is added to its card by itself once it is ready and Anki answers (when the app starts or comes back to the front, after a sync, or with Try now), as the field was set up when you enriched the card."
>
  <svelte:fragment slot="actions">
    {#if waitingCount}
      <span class="c-count">{waitingCount} waiting</span>
    {/if}
  </svelte:fragment>
  {#if !loaded}
    <p class="px-5 py-4 text-sm text-c-muted">Loading…</p>
  {:else if loadError}
    <p class="px-5 py-4" role="status">{loadError}</p>
  {:else if !clips.length}
    <p class="px-5 py-4" data-testid="anki-pending-empty">Nothing waiting.</p>
  {:else}
    <PagedList
      items={clips}
      pageSize={5}
      text={(c) => `${c.word} ${c.bookTitle} ${c.source.text}`}
      searchLabel="Search waiting audio"
      label="Waiting sentence audio"
      let:rows
    >
      <ul data-testid="anki-pending-list">
        {#each rows as clip (clip.id)}
          <li class="s-item" data-testid="anki-pending-row">
            <div class="s-item-main">
              <p class="break-words">
                <span class="font-medium">「{clip.word || 'card'}」</span>
                · {clip.bookTitle}
              </p>
              <p class="s-item-meta break-words">{sentence(clip)}</p>
              <p class="s-item-meta">Since {formatWhen(clip.createdAt, now)}</p>
              <p class="mt-1 break-words text-sm" data-testid="anki-pending-status">
                {pendingStatus(clip)}
              </p>
              {#if clip.state !== 'failed' && clip.problem}
                <p class="s-item-meta break-words" data-testid="anki-pending-problem">
                  Last try: {clip.problem}.
                </p>
              {/if}
              {#if confirming?.id === clip.id}
                <div class="mt-2">
                  <InlineConfirm
                    {...cancelPendingClipCopy(clip.word)}
                    {busy}
                    testid="anki-pending-cancel-confirm"
                    confirmTestid="anki-pending-cancel-confirm-button"
                    on:confirm={() => remove(clip)}
                    on:cancel={() => (confirming = undefined)}
                  />
                </div>
              {/if}
            </div>
            {#if confirming?.id !== clip.id}
              <div class="s-item-actions">
                {#if clip.state === 'failed'}
                  <button
                    class="c-btn c-btn-secondary min-h-[2.75rem]"
                    data-testid="anki-pending-dismiss"
                    disabled={busy}
                    on:click={() => remove(clip)}
                  >
                    Dismiss
                  </button>
                {:else}
                  <button
                    class="c-btn c-btn-secondary min-h-[2.75rem]"
                    data-testid="anki-pending-cancel"
                    on:click={() => (confirming = clip)}
                  >
                    Cancel…
                  </button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </PagedList>
    {#if waitingCount || tryMessage}
      <div class="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
        {#if waitingCount}
          <button
            class="c-btn c-btn-secondary"
            data-testid="anki-pending-try"
            disabled={trying}
            on:click={tryNow}
          >
            {trying ? 'Trying…' : 'Try now'}
          </button>
        {/if}
        {#if tryMessage}
          <p role="status" data-testid="anki-pending-try-message">{tryMessage}</p>
        {/if}
      </div>
    {/if}
  {/if}
</SettingsGroup>
