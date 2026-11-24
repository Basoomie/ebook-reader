<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * More direct links on /cleanup: Off / Preview / On (On only after the spot check passed, and
   * it asks first), the step with its bar and time left, what was found per site, the spot check
   * (links to open and mark Right or Wrong), the folded list of the new links (paged, by site),
   * and the saved links a series' list disagrees with (listed only).
   */
  import { onDestroy, onMount } from 'svelte';
  import type { CleanupApi } from '$lib/cleanup/cleanup-api';
  import {
    HOW_LABELS,
    LINKS_HINTS,
    LINKS_MODE_LABELS,
    LINKS_PHASES,
    SITE_LABELS,
    linksBar,
    linksLines,
    linksSpotLine,
    picksOf,
    type LinkItem,
    type LinkSite,
    type LinkState,
    type LinksMode,
    type LinksStatus
  } from '$lib/cleanup/links-text';
  import { n } from '$lib/cleanup/cleanup-text';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { linksOnCopy } from '$lib/confirm/confirm-copy';
  import CleanupLinkItem from './cleanup-link-item.svelte';

  export let api: CleanupApi;

  const MODES: LinksMode[] = ['off', 'analyse', 'on'];
  const POLL_MS = 5000;
  const PAGE = 20;
  const SITES: LinkSite[] = ['amazon', 'ranobedb', 'bookwalker'];

  let status: LinksStatus | null = null;
  let error = '';
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  let spot: LinkItem[] | null = null;
  let list: { total: number; items: LinkItem[]; offset: number } | null = null;
  let site: LinkSite | null = null;
  let saved: { total: number; items: LinkItem[]; offset: number } | null = null;

  $: bar = linksBar(status);
  $: lines = linksLines(status);
  $: spotText = linksSpotLine(status);
  $: found = status ? picksOf(status, 'ok') : null;
  $: canLookAgain =
    !!status && status.mode !== 'off' && ['spot', 'done'].includes(status.progress.phase);

  async function refresh() {
    clearTimeout(timer);
    try {
      status = await api.links();
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

  async function setMode(mode: LinksMode) {
    if (!status || status.mode === mode || busy) return;
    if (
      mode === 'on' &&
      !(await confirmDestructive(
        linksOnCopy((status.proposals.proposed ?? 0) + (status.proposals.queued ?? 0))
      ))
    )
      return;
    error = '';
    busy = true;
    try {
      status = await api.setLinksMode(mode);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function lookAgain() {
    if (busy) return;
    error = '';
    busy = true;
    try {
      status = await api.linksAgain();
      spot = null;
      list = null;
      saved = null;
    } catch (err) {
      error = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function loadSpot() {
    try {
      spot = (await api.linksSpot()).items;
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function spotToggled(e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !spot) void loadSpot();
  }

  async function mark(m: LinkItem, verdict: 'right' | 'wrong') {
    const next = m.verdict === verdict ? null : verdict;
    error = '';
    try {
      const r = await api.setLinksVerdict(m.uuid, m.site, next);
      // A new list (the app compiles Svelte immutable: never change an item in place).
      spot = (spot ?? []).map((x) =>
        x.uuid === m.uuid && x.site === m.site ? { ...x, verdict: next } : x
      );
      if (status) status = { ...status, spot: r.counts, spotPassed: r.passed };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  async function load(state: LinkState, offset = 0) {
    try {
      const r = await api.linksList(state, state === 'ok' ? site : null, offset, PAGE);
      if (state === 'ok') list = { ...r, offset };
      else saved = { ...r, offset };
    } catch (err) {
      error = (err as Error).message;
    }
  }

  function listToggled(e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !list) void load('ok');
  }

  function savedToggled(e: Event) {
    if ((e.currentTarget as HTMLDetailsElement).open && !saved) void load('saved');
  }

  function pickSite(s: LinkSite | null) {
    site = s;
    void load('ok', 0);
  }
</script>

<div class="c-tile flex flex-col gap-2 rounded p-3" data-testid="links-card">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h3 class="font-mincho font-bold">More direct links</h3>
    {#if status}
      <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="More direct links">
        {#each MODES as mode (mode)}
          <button
            class="c-btn {status.mode === mode ? 'c-btn-primary' : 'c-btn-secondary'}"
            role="radio"
            aria-checked={status.mode === mode}
            disabled={busy || (mode === 'on' && status.mode !== 'on' && !status.spotPassed)}
            title={mode === 'on' && !status.spotPassed
              ? 'On needs the spot check first (every link marked, none wrong)'
              : undefined}
            on:click={() => setMode(mode)}
            data-testid="links-mode-{mode}">{LINKS_MODE_LABELS[mode]}</button
          >
        {/each}
      </div>
    {/if}
  </div>
  {#if error}<p class="c-notice text-sm" role="alert">{error}</p>{/if}
  {#if status}
    <p class="text-sm text-c-muted">{LINKS_HINTS[status.mode]}</p>
    {#if status.pausedReason}
      <p class="c-notice text-sm" role="alert" data-testid="links-paused">
        <b>Paused:</b>
        {status.pausedDetail ?? status.pausedReason}
      </p>
    {/if}
    {#if bar}
      <div class="flex flex-col gap-1" data-testid="links-progress">
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
      <p class="text-sm" data-testid="links-phase">{LINKS_PHASES[status.progress.phase]}</p>
    {/if}
    {#if status.progress.write.waiting && status.progress.phase === 'write'}
      <p class="text-sm text-c-muted">{status.progress.write.waiting}</p>
    {/if}
    {#each lines as line}<p class="text-sm" data-testid="links-line">{line}</p>{/each}
    {#if spotText}
      <p class="text-sm" data-testid="links-spot-line">{spotText}</p>
    {/if}
    {#if status.spot.size > 0}
      <details on:toggle={spotToggled} data-testid="links-spot">
        <summary class="cursor-pointer text-sm"
          >The spot check ({n(status.spot.size)} links)</summary
        >
        {#if spot}
          <div class="mt-1 flex flex-col">
            {#each spot as m, i (m.uuid + m.site)}
              <div
                class="c-row flex flex-col gap-1 border-b border-c-line py-2"
                data-testid="links-spot-item"
              >
                <span class="text-xs text-c-muted"
                  >{i + 1} · {SITE_LABELS[m.site]} · from {HOW_LABELS[m.how]}</span
                >
                <CleanupLinkItem {m} />
                <div class="flex flex-wrap gap-2">
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={m.verdict === 'right'}
                    on:click={() => mark(m, 'right')}
                    data-testid="links-right">Right</button
                  >
                  <button
                    class="c-btn c-btn-secondary c-btn-sm"
                    aria-pressed={m.verdict === 'wrong'}
                    on:click={() => mark(m, 'wrong')}
                    data-testid="links-wrong">Wrong</button
                  >
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </details>
    {/if}
    {#if found && found.all > 0}
      <details on:toggle={listToggled} data-testid="links-list">
        <summary class="cursor-pointer text-sm">New links ({n(found.all)})</summary>
        <div class="mt-1 flex flex-col gap-1">
          <div class="flex flex-wrap gap-2" role="group" aria-label="Site">
            <button
              class="c-chip c-chip-sm"
              aria-pressed={site === null}
              on:click={() => pickSite(null)}>All</button
            >
            {#each SITES as s (s)}
              <button
                class="c-chip c-chip-sm"
                aria-pressed={site === s}
                on:click={() => pickSite(s)}>{SITE_LABELS[s]} ({n(found[s])})</button
              >
            {/each}
          </div>
          {#if list}
            {#each list.items as m (m.uuid + m.site)}
              <div class="c-row border-b border-c-line py-2"><CleanupLinkItem {m} /></div>
            {:else}
              <p class="text-sm text-c-muted">Nothing here.</p>
            {/each}
            {#if list.total > PAGE}
              <div class="flex items-center gap-2 text-sm">
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={list.offset === 0}
                  on:click={() => load('ok', Math.max(0, (list?.offset ?? 0) - PAGE))}
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
                  on:click={() => load('ok', (list?.offset ?? 0) + PAGE)}>Next</button
                >
              </div>
            {/if}
          {/if}
        </div>
      </details>
    {/if}
    {#if status.progress.series.saved > 0}
      <details on:toggle={savedToggled} data-testid="links-saved">
        <summary class="cursor-pointer text-sm"
          >Saved links that differ from their series' list ({n(
            status.progress.series.saved
          )})</summary
        >
        <div class="mt-1 flex flex-col gap-1">
          <p class="text-sm text-c-muted">
            Nothing here is changed. Open both pages; to fix one, edit the book's details.
          </p>
          {#if saved}
            {#each saved.items as m (m.uuid + m.site)}
              <div class="c-row border-b border-c-line py-2"><CleanupLinkItem {m} /></div>
            {/each}
            {#if saved.total > PAGE}
              <div class="flex items-center gap-2 text-sm">
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={saved.offset === 0}
                  on:click={() => load('saved', Math.max(0, (saved?.offset ?? 0) - PAGE))}
                  >Previous</button
                >
                <span
                  >{n(saved.offset + 1)}-{n(Math.min(saved.total, saved.offset + PAGE))} of {n(
                    saved.total
                  )}</span
                >
                <button
                  class="c-btn c-btn-ghost c-btn-sm"
                  disabled={saved.offset + PAGE >= saved.total}
                  on:click={() => load('saved', (saved?.offset ?? 0) + PAGE)}>Next</button
                >
              </div>
            {/if}
          {/if}
        </div>
      </details>
    {/if}
    {#if canLookAgain}
      <div>
        <button
          class="c-btn c-btn-ghost c-btn-sm"
          disabled={busy}
          on:click={lookAgain}
          data-testid="links-again">Look again from the start</button
        >
      </div>
    {/if}
  {/if}
</div>
