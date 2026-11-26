<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings › Library › Book page › Store ratings (2026-11-25, docs/design/store-ratings.md).
   * This device: which figures the book page shows. The library server: how many books have
   * figures, the first fill's progress bar (from the cleanup's cached store pages), the refresher
   * (Off until switched on: it fetches through the cleanup's fetch container), 読書メーター (off
   * until its links are fixed), how often figures are read again, and the Rating sort's pull.
   */
  import { onDestroy, onMount } from 'svelte';
  import { getLibraryStore } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { LibraryApi, type RatingSettings, type RatingsProgressAnswer } from '$lib/library/api';
  import { timeLeftText } from '$lib/library/natively-level';
  import {
    PART_LABELS,
    RATING_PARTS,
    bookRatingParts$,
    formatCount,
    refreshLeftText,
    type RatingPart
  } from '$lib/library/store-ratings';

  let api: LibraryApi | null = null;
  let progress: RatingsProgressAnswer | null = null;
  let saved: RatingSettings | null = null;
  let draft: RatingSettings | null = null;
  let loadError = '';
  let saveError = '';
  let savedNote = '';
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const SITE_NAMES: Record<string, string> = {
    amazon_jp: 'Amazon',
    bookwalker: 'BOOK☆WALKER',
    bookmeter: '読書メーター',
    natively: 'Natively'
  };

  async function load() {
    if (!api) return;
    try {
      progress = await api.ratingsProgress();
      if (!saved) {
        saved = progress.settings;
        draft = progress.settings;
      }
      loadError = '';
    } catch (err) {
      loadError = `Store ratings can't be shown: ${(err as Error).message}. They need the library server.`;
    }
  }

  onMount(async () => {
    const c = await getLibraryStore().getConnection();
    if (!c) {
      loadError = 'Connect this device to the library server to see the store ratings.';
      return;
    }
    const t = Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
    api = new LibraryApi(c.serverUrl, c.token, t);
    await load();
    timer = setInterval(() => void load(), 10_000);
  });

  onDestroy(() => clearInterval(timer));

  $: fill = progress?.fill;
  $: fraction = fill && fill.total ? Math.min(1, fill.done / fill.total) : 0;
  $: dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  $: shownParts = new Set($bookRatingParts$);
  // Left to fetch: due and not yet asked, plus waiting in the fetch queue.
  $: dueTotal = progress
    ? Object.values(progress.refresh.due).reduce((a, b) => a + b, 0) + progress.refresh.waiting
    : 0;
  $: readCount = progress?.refresh.read ?? 0;
  $: refreshFraction =
    readCount + dueTotal > 0 ? Math.min(1, readCount / (readCount + dueTotal)) : 1;

  function togglePart(part: RatingPart, on: boolean) {
    const next = RATING_PARTS.filter((p) => (p === part ? on : shownParts.has(p)));
    bookRatingParts$.next(next);
  }

  function num(e: Event, min: number, max: number, fallback: number): number {
    const v = Math.round(Number((e.target as HTMLInputElement).value));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  }

  function change(next: Partial<RatingSettings>) {
    if (!draft) return;
    draft = { ...draft, ...next };
    savedNote = '';
  }

  async function save() {
    if (!api || !draft) return;
    busy = true;
    saveError = '';
    try {
      const r = await api.saveRatingSettings(draft);
      saved = r.settings;
      draft = r.settings;
      savedNote = 'Saved.';
      await load();
    } catch (err) {
      saveError = `Not saved: ${(err as Error).message}`;
    } finally {
      busy = false;
    }
  }
</script>

<div class="space-y-4" data-testid="ratings-settings">
  <fieldset class="space-y-2">
    <legend class="mb-1 text-sm">Shown on the book page (this device)</legend>
    {#each RATING_PARTS as part (part)}
      <label class="flex min-h-[2.75rem] items-center gap-3 text-sm">
        <input
          type="checkbox"
          class="h-5 w-5"
          checked={shownParts.has(part)}
          on:change={(e) => togglePart(part, e.currentTarget.checked)}
          data-testid="ratings-part-{part}"
        />
        <span>{PART_LABELS[part]}</span>
      </label>
    {/each}
  </fieldset>

  {#if loadError}
    <p class="text-sm text-c-muted" data-testid="ratings-settings-note">{loadError}</p>
  {:else if !progress || !draft}
    <p class="text-sm text-c-muted">Loading…</p>
  {:else}
    <p class="text-sm" data-testid="ratings-saved">
      {Object.entries(progress.saved)
        .map(([site, n]) => `${SITE_NAMES[site] ?? site} ${formatCount(n)}`)
        .join(' · ') || 'No figures yet.'}
    </p>
    {#if fill?.running}
      <div class="space-y-1.5" data-testid="ratings-fill">
        <div class="flex flex-wrap justify-between gap-2 text-sm">
          <span
            >Reading saved store pages: {formatCount(fill.done)} of {formatCount(fill.total)}</span
          >
          <span class="text-c-muted">{timeLeftText(fill.secondsLeft)}</span>
        </div>
        <div
          class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
          role="progressbar"
          aria-label="Reading saved store pages"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(fraction * 100)}
        >
          <div class="h-full bg-c-fill" style="width: {fraction * 100}%" />
        </div>
      </div>
    {/if}
    {#if progress.refresh.on}
      {#if !progress.refresh.available || dueTotal === 0}
        <p class="text-sm text-c-muted" data-testid="ratings-refresh-status">
          {#if !progress.refresh.available}
            The library cleanup isn't running on the server, so nothing is fetched.
          {:else}
            Every store figure is up to date.
          {/if}
        </p>
      {:else}
        <div class="space-y-1.5" data-testid="ratings-refresh-bar">
          <div class="flex flex-wrap justify-between gap-2 text-sm">
            <span
              >Fetching ratings: {formatCount(readCount)} of {formatCount(
                readCount + dueTotal
              )}</span
            >
            <span class="text-c-muted">{refreshLeftText(progress.refresh.secondsLeft)}</span>
          </div>
          <div
            class="c-progress h-2 overflow-hidden rounded-full bg-c-track"
            role="progressbar"
            aria-label="Fetching ratings"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(refreshFraction * 100)}
          >
            <div class="h-full bg-c-fill" style="width: {refreshFraction * 100}%" />
          </div>
        </div>
      {/if}
    {/if}
    {#if progress.lastError}
      <p class="text-sm" role="status">Last problem: {progress.lastError}</p>
    {/if}

    <label class="flex min-h-[2.75rem] items-center gap-3 text-sm">
      <input
        type="checkbox"
        class="h-5 w-5"
        checked={draft.refresh}
        on:change={(e) => change({ refresh: e.currentTarget.checked })}
        data-testid="ratings-refresh"
      />
      <span>Fetch ratings (through the library cleanup's fetch container, behind its own work)</span
      >
    </label>

    <div class="fields">
      <label>
        <span>Read again after (days): published in the last 6 months</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="365"
          value={draft.newDays}
          data-testid="ratings-new-days"
          on:change={(e) => change({ newDays: num(e, 1, 365, draft?.newDays ?? 7) })}
        />
      </label>
      <label>
        <span>… in the last 2 years</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="730"
          value={draft.recentDays}
          data-testid="ratings-recent-days"
          on:change={(e) => change({ recentDays: num(e, 1, 730, draft?.recentDays ?? 30) })}
        />
      </label>
      <label>
        <span>… older</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="1825"
          value={draft.oldDays}
          data-testid="ratings-old-days"
          on:change={(e) => change({ oldDays: num(e, 1, 1825, draft?.oldDays ?? 90) })}
        />
      </label>
      <label>
        <span>A book page asks again after (days)</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="3650"
          value={draft.openMaxAgeDays}
          data-testid="ratings-open-days"
          on:change={(e) =>
            change({ openMaxAgeDays: num(e, 1, 3650, draft?.openMaxAgeDays ?? 30) })}
        />
      </label>
      <label>
        <span>Rating sort: ratings a book needs to count fully</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="1000"
          value={draft.scoreRatings}
          data-testid="ratings-score"
          on:change={(e) => change({ scoreRatings: num(e, 0, 1000, draft?.scoreRatings ?? 20) })}
        />
      </label>
      <label>
        <span>New books wait for the cleanup's lookup (hours)</span>
        <input
          class="c-input"
          type="number"
          min="0"
          max="720"
          value={draft.newBookWaitHours}
          data-testid="ratings-new-wait"
          on:change={(e) =>
            change({ newBookWaitHours: num(e, 0, 720, draft?.newBookWaitHours ?? 48) })}
        />
      </label>
    </div>
    <p class="text-sm text-c-muted">
      The Rating sort pulls books with few ratings toward the middle ({progress.score.m.toFixed(
        1
      )}), as if each had {draft.scoreRatings} more ratings there.
    </p>
    {#if saveError}<p class="text-sm" role="alert">{saveError}</p>{/if}
    {#if dirty || savedNote}
      <div class="flex items-center justify-end gap-3">
        {#if savedNote}<span class="text-sm text-c-muted" role="status">{savedNote}</span>{/if}
        {#if dirty}
          <button type="button" class="c-btn c-btn-ghost" on:click={() => (draft = saved)}
            >Undo changes</button
          >
          <button
            type="button"
            class="c-btn c-btn-primary"
            disabled={busy}
            data-testid="ratings-save"
            on:click={save}>Save</button
          >
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .fields {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }

  .fields label {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: 0.875rem;
  }
</style>
