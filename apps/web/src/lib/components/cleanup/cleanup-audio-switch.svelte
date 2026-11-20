<!--
  @license BSD-3-Clause
  Copyright (c) 2026, ッツ Reader Authors
  All rights reserved.
-->
<script lang="ts">
  /**
   * WP21e-2: the switch to the new audiobook library, under stage 6's card on /cleanup. Switch,
   * Undo, Delete japanese-old and Set the covers each ask first; a pause shows why with Continue
   * (and Cancel while nothing is renamed or deleted yet); the report and its CSV.
   */
  import type {
    AudioStatus,
    AudioSwitchStatus,
    CleanupApi,
    SwitchAction
  } from '$lib/cleanup/cleanup-api';
  import {
    coversLines,
    SWITCH_HINT,
    switchBar,
    switchLines,
    switchPauseLine,
    switchStateLine
  } from '$lib/cleanup/audio-switch-text';
  import { bytesText } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import {
    deleteOldCopy,
    setCoversCopy,
    switchCopy,
    undoSwitchCopy
  } from '$lib/confirm/confirm-copy';

  export let api: CleanupApi;
  export let sw: AudioSwitchStatus;
  /** Bytes of the old library (from stage 6's walk), for the deletion's question. */
  export let oldBytes: number | null = null;
  export let onStatus: (s: AudioStatus) => void;

  let busy = false;
  let error = '';

  $: state = sw.state ?? 'none';
  $: p = sw.progress ?? null;
  $: bar = switchBar(sw);
  $: covers = coversLines(sw);
  $: lines = switchLines(p);

  async function run(fn: () => Promise<AudioStatus>) {
    error = '';
    busy = true;
    try {
      onStatus(await fn());
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function start(action: SwitchAction) {
    const copy =
      action === 'switch'
        ? switchCopy()
        : action === 'undo'
          ? undoSwitchCopy()
          : deleteOldCopy(oldBytes ? bytesText(oldBytes) : null);
    if (!(await confirmDestructive(copy))) return;
    await run(() => api.audioSwitchStart(action));
  }

  async function startCovers() {
    if (!(await confirmDestructive(setCoversCopy()))) return;
    await run(() => api.audioCovers('start'));
  }

  async function downloadReport() {
    error = '';
    try {
      const blob = await api.audioSwitchLinksCsv();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'audiobooks-switch-links.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      error = (err as Error).message;
    }
  }
</script>

<div
  class="flex flex-col gap-2 border-t pt-3"
  style="border-color: var(--c-line)"
  data-testid="audio-switch"
>
  <p class="font-medium">The switch to the new library</p>
  <p class="text-sm" data-testid="audio-switch-state">{switchStateLine(sw)}</p>
  {#if bar}
    <div class="flex flex-col gap-1" data-testid="audio-switch-progress">
      <div class="flex flex-wrap justify-between gap-x-4 text-sm">
        <span class="break-all">{bar.label}</span>
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
  {#if p?.waiting && state === 'running' && !sw.pause}
    <p class="text-sm text-c-muted" data-testid="audio-switch-waiting">{p.waiting}</p>
  {/if}
  {#if sw.pause}
    <div class="c-notice flex flex-col gap-2 text-sm" role="alert" data-testid="audio-switch-pause">
      <p class="break-words">{switchPauseLine(sw)}</p>
      <div class="flex flex-wrap gap-2">
        <button
          class="c-btn c-btn-ghost"
          disabled={busy}
          on:click={() => run(() => api.audioSwitchResume())}>Continue</button
        >
        {#if sw.cancellable}
          <button
            class="c-btn c-btn-ghost"
            disabled={busy}
            on:click={() => run(() => api.audioSwitchCancel())}
            data-testid="audio-switch-cancel">Cancel (nothing is renamed yet)</button
          >
        {/if}
      </div>
    </div>
  {/if}
  <div class="flex flex-wrap gap-2" data-testid="audio-switch-actions">
    {#if state === 'none'}
      <button
        class="c-btn c-btn-primary"
        disabled={busy || !!sw.refusals?.switch.length}
        on:click={() => start('switch')}
        data-testid="audio-switch-start">Switch to the new library</button
      >
    {/if}
    {#if state === 'switched'}
      <button
        class="c-btn c-btn-ghost"
        disabled={busy || !!sw.refusals?.undo.length}
        on:click={() => start('undo')}
        data-testid="audio-switch-undo">Undo the switch</button
      >
      <button
        class="c-btn c-btn-ghost"
        disabled={busy || !!sw.covers?.refusals.length}
        on:click={startCovers}
        data-testid="audio-switch-covers">Set the missing covers</button
      >
      <button
        class="c-btn c-btn-danger"
        disabled={busy || !!sw.refusals?.delete.length}
        on:click={() => start('delete')}
        data-testid="audio-switch-delete">Delete japanese-old</button
      >
    {/if}
    {#if state === 'deleted'}
      <button
        class="c-btn c-btn-ghost"
        disabled={busy || !!sw.covers?.refusals.length}
        on:click={startCovers}
        data-testid="audio-switch-covers">Set the missing covers</button
      >
    {/if}
    {#if p}
      <button class="c-btn c-btn-ghost" on:click={downloadReport} data-testid="audio-switch-report"
        >Download the links report (CSV)</button
      >
    {/if}
  </div>
  {#if state === 'none' && sw.refusals?.switch.length}
    <p class="text-sm text-c-muted" data-testid="audio-switch-refusals">
      Can’t switch yet: {sw.refusals.switch.join('; ')}
    </p>
  {/if}
  {#if state === 'switched' && sw.refusals?.delete.length}
    <p class="text-sm text-c-muted">
      Can’t delete japanese-old yet: {sw.refusals.delete.join('; ')}
    </p>
  {/if}
  {#if covers.bar}
    <div class="flex flex-col gap-1" data-testid="audio-covers-progress">
      <div class="flex flex-wrap justify-between gap-x-4 text-sm">
        <span>{covers.bar.label}</span>
        <span
          >{Math.floor(covers.bar.fraction * 100)} %{covers.bar.eta
            ? ` · ${covers.bar.eta}`
            : ''}</span
        >
      </div>
      <div
        class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
        role="progressbar"
        aria-label={covers.bar.label}
      >
        <div class="h-full bg-c-fill" style="width: {covers.bar.fraction * 100}%" />
      </div>
    </div>
  {/if}
  {#if sw.covers?.pause}
    <p class="text-sm">
      <button
        class="c-btn c-btn-ghost"
        disabled={busy}
        on:click={() => run(() => api.audioCovers('resume'))}>Continue the covers</button
      >
    </p>
  {/if}
  {#if error}
    <p class="c-notice text-sm" role="alert">{error}</p>
  {/if}
  <details data-testid="audio-switch-details">
    <summary class="cursor-pointer text-sm text-c-muted">Details of the switch</summary>
    <div class="mt-2 flex flex-col gap-1 text-sm">
      <p class="text-c-muted">{SWITCH_HINT}</p>
      {#each lines as line}<p class="break-words">{line}</p>{/each}
      {#each covers.lines as line}<p class="break-words" data-testid="audio-covers-line">
          {line}
        </p>{/each}
    </div>
  </details>
</div>
