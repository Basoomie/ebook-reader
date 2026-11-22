<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries session 2: the accuracy test's judging page (its own address, not in the
   * navigation; only on the PC's test copy). Per book, each setup's summary as the app shows
   * it, every item marked Right / Has a mistake / Not needed / Unsure (decided with the user
   * 2026-11-22: whole items keep their context; split-up claims were too many and too vague),
   * plus what's missing; each setup's scores from those marks, with its cost, time, dropped
   * quotes, cross-checks and refusals.
   */
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import SummaryView from '$lib/components/summaries/summary-view.svelte';
  import { pxScreen } from '$lib/css-classes';
  import {
    SUMMARY_TABS,
    type ItemMark,
    type SummarySectionKey
  } from '$lib/summaries/summary-types';
  import {
    SummaryTestApi,
    type ItemJudging,
    type TestOverview,
    type TestRun
  } from '$lib/summaries/test-api';

  let api: SummaryTestApi | null = null;
  let overview: TestOverview | null = null;
  let judging: ItemJudging | null = null;
  let book = '';
  let runId = '';
  let error = '';
  let loading = true;
  let missingText = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  onDestroy(() => timer && clearInterval(timer));

  onMount(async () => {
    if (!browser) return;
    book = $page.url.searchParams.get('book') ?? '';
    runId = $page.url.searchParams.get('run') ?? '';
    const t = $page.url.searchParams.get('tab');
    if (t && SUMMARY_TABS.some((x) => x.key === t)) tab = t as SummarySectionKey;
    api = await SummaryTestApi.connect();
    if (!api) {
      error = 'Connect this device to the library server first (Settings > Data).';
      loading = false;
      return;
    }
    await refresh();
    timer = setInterval(() => void refreshRuns(), 5000);
  });

  async function refreshRuns() {
    if (!api) return;
    try {
      overview = await api.overview();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  function booksDone(): string[] {
    if (!overview) return [];
    const done = new Set(overview.runs.filter((r) => r.state === 'done').map((r) => r.bookKey));
    return overview.books.filter((b) => done.has(b.key)).map((b) => b.key);
  }

  async function refresh() {
    if (!api) return;
    loading = true;
    error = '';
    try {
      overview = await api.overview();
      if (!book && booksDone().length) book = booksDone()[0];
      judging = book ? await api.items(book) : null;
      if (judging && !judging.runs.some((r) => r.id === runId)) runId = judging.runs[0]?.id ?? '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function remember() {
    history.replaceState(
      history.state,
      '',
      `?book=${encodeURIComponent(book)}&run=${encodeURIComponent(runId)}&tab=${tab}`
    );
  }

  async function pickBook(key: string) {
    book = key;
    runId = '';
    await refresh();
    remember();
  }

  function pickRun(id: string) {
    runId = id;
    remember();
  }

  async function onMark(e: CustomEvent<{ ref: string; mark: ItemMark | null }>) {
    if (!api || !judging || !current) return;
    const { ref, mark } = e.detail;
    const id = current.id;
    const put = (m: ItemMark | null) => {
      if (!judging) return;
      judging = {
        ...judging,
        runs: judging.runs.map((r) => {
          if (r.id !== id) return r;
          const marks = { ...r.marks };
          if (m) marks[ref] = m;
          else delete marks[ref];
          return { ...r, marks };
        })
      };
    };
    const before = current.marks[ref] ?? null;
    put(mark);
    try {
      await api.markItem(id, ref, mark);
      const fresh = await api.items(book);
      if (judging) judging = { ...judging, runs: fresh.runs };
    } catch (err) {
      put(before);
      error = (err as Error).message;
    }
  }

  async function addMissing() {
    if (!api || !missingText.trim() || !current) return;
    try {
      await api.addMissing(book, 'round1', missingText.trim(), current.id, tab);
      missingText = '';
      judging = await api.items(book);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  let editing: number | null = null;
  let editText = '';
  function startEdit(id: number, text: string) {
    editing = id;
    editText = text;
  }
  async function saveNote(id: number) {
    if (!api || !editText.trim()) return;
    try {
      await api.updateMissing(id, editText);
      editing = null;
      judging = await api.items(book);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function removeMissing(id: number) {
    if (!api) return;
    await api.removeMissing(id);
    judging = await api.items(book);
  }

  function bookTitle(key: string): string {
    return overview?.books.find((b) => b.key === key)?.title ?? key;
  }
  function usd(v: unknown): string {
    const n = Number(v ?? 0);
    return n > 0 && n < 0.1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  }
  function mins(s: unknown): string {
    const n = Number(s ?? 0);
    return n < 90 ? `${Math.round(n)} s` : `${(n / 60).toFixed(1)} min`;
  }
  function left(r: TestRun): string {
    const s = r.progress.secondsLeft;
    if (s === null) return 'estimating time left';
    return s < 60 ? 'under a minute left' : `about ${Math.round(s / 60)} min left`;
  }
  function metric(m: Record<string, unknown> | null, k: string): number {
    return Number((m ?? {})[k] ?? 0);
  }
  function dropped(m: Record<string, unknown> | null): number {
    const ex = (m?.extracted ?? {}) as Record<string, { quoteNotFound: number }>;
    return Object.values(ex).reduce((a, x) => a + (x.quoteNotFound ?? 0), 0);
  }
  function refusals(m: Record<string, unknown> | null): number {
    return ((m?.refusals as unknown[]) ?? []).length;
  }

  $: current = judging?.runs.find((r) => r.id === runId) ?? null;
  let tab: SummarySectionKey = 'overview';
  $: tabLabel = SUMMARY_TABS.find((t) => t.key === tab)?.label ?? tab;
  // The open tab stays in the address, so a reload keeps your place.
  $: if (browser && current && tab) remember();
  $: tabNotes = (current?.notes ?? []).filter((n) => (n.section ?? 'overview') === tab);
  $: runningRuns = (overview?.runs ?? []).filter((r) => r.state === 'running');
</script>

<AppHeader title="Summary accuracy test" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="summaries-test-page">
  <h1 class="mt-2 text-xl font-bold">Summary accuracy test</h1>

  {#if error}
    <p class="c-notice mt-3 text-sm" role="alert" data-testid="st-error">{error}</p>
  {/if}

  {#if overview}
    {#if overview.budget}
      <p class="mt-1 text-sm text-c-muted" data-testid="st-budget">
        Spent {usd(overview.budget.spentUsd)} of the test's {usd(overview.budget.limitUsd)}{overview
          .budget.reservedUsd > 0
          ? ` (${usd(overview.budget.reservedUsd)} in requests now)`
          : ''}
        {#if overview.wait?.kind === 'limit_reached'}
          · waiting: the budget is used up{/if}
      </p>
    {/if}
    {#each runningRuns as r (r.id)}
      <div class="mt-2 max-w-3xl" data-testid="st-run-running">
        <p class="text-sm" lang="ja">
          {bookTitle(r.bookKey)} — {overview.setups[r.setup]}{r.background
            ? ' · with earlier volumes'
            : ''}: {r.phase ?? ''}, {left(r)}
        </p>
        <div class="bar" role="progressbar" aria-valuenow={Math.round(r.progress.done * 100)}>
          <div style="width: {Math.round(r.progress.done * 100)}%" />
        </div>
      </div>
    {/each}

    <section class="mt-4">
      <h2 class="font-bold">Book</h2>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each booksDone() as key (key)}
          <button
            type="button"
            class="c-chip book-chip"
            aria-pressed={book === key}
            title={bookTitle(key)}
            lang="ja"
            data-testid="st-book"
            on:click={() => pickBook(key)}>{bookTitle(key)}</button
          >
        {/each}
      </div>
    </section>
  {/if}

  {#if loading}
    <p class="mt-4 text-sm" role="status">Loading</p>
  {:else if judging}
    <section class="mt-5 max-w-3xl">
      <h2 class="font-bold">Summary</h2>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each judging.runs as r (r.id)}
          <button
            type="button"
            class="c-chip"
            aria-pressed={runId === r.id}
            data-testid="st-run"
            on:click={() => pickRun(r.id)}
            >{r.label} · {r.score.items - r.score.unmarked}/{r.score.items}</button
          >
        {/each}
      </div>
      <p class="mt-3 text-sm text-c-muted">
        Mark every item: <b>Right</b> (correct and worth keeping), <b>Has a mistake</b> (anything in
        it is wrong or made up), <b>Not needed</b> (vague, filler, or not important enough for a
        summary), <b>Unsure</b>. Tapping a pressed button clears it.
      </p>
    </section>

    {#if current}
      <div class="mt-4 max-w-3xl" data-testid="st-summary">
        <SummaryView
          summary={current.summary}
          bookId={judging.book.readerId}
          chapters={judging.chapters}
          characters={judging.characters}
          marks={current.marks}
          copied={current.copied}
          bind:tab
          on:mark={onMark}
        />
      </div>
    {/if}

    {#if current}
      <section class="mt-8 max-w-3xl" data-testid="st-missing">
        <h2 class="font-bold">Your notes on {tabLabel}</h2>
        <p class="mt-1 text-sm text-c-muted">
          Mistakes, what it misses, what should go: anything about this tab of {current.label}'s
          summary. Each tab has its own notes.
        </p>
        <ul class="mt-3 space-y-3">
          {#each tabNotes as m (m.id)}
            <li data-testid="st-missing-item">
              {#if editing === m.id}
                <textarea
                  class="c-input block w-full"
                  rows="6"
                  lang="ja"
                  bind:value={editText}
                  data-testid="st-note-edit-text"
                />
                <div class="mt-2 flex gap-2">
                  <button
                    type="button"
                    class="c-btn c-btn-primary c-btn-sm"
                    disabled={!editText.trim()}
                    data-testid="st-note-save"
                    on:click={() => saveNote(m.id)}>Save</button
                  >
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    data-testid="st-note-cancel"
                    on:click={() => (editing = null)}>Cancel</button
                  >
                </div>
              {:else}
                <p class="whitespace-pre-wrap" lang="ja" data-testid="st-note-text">{m.text}</p>
                <div class="mt-1 flex gap-2">
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    data-testid="st-note-edit"
                    on:click={() => startEdit(m.id, m.text)}>Edit</button
                  >
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    data-testid="st-missing-remove"
                    on:click={() => removeMissing(m.id)}>Remove</button
                  >
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        <textarea
          class="c-input mt-3 block w-full"
          rows="4"
          lang="ja"
          placeholder="Add a note"
          bind:value={missingText}
          data-testid="st-missing-text"
        />
        <button
          type="button"
          class="c-btn c-btn-primary mt-2"
          disabled={!missingText.trim()}
          data-testid="st-missing-add"
          on:click={addMissing}>Add note</button
        >
      </section>
    {/if}

    <section class="mt-8" data-testid="st-scores">
      <h2 class="font-bold">Scores</h2>
      <div class="mt-2 overflow-x-auto">
        <table class="scores text-sm">
          <thead>
            <tr>
              <th>Setup</th><th>Items</th><th>Right</th><th>Has a mistake</th><th>Not needed</th><th
                >Unsure</th
              ><th>Not marked</th><th>Cost</th><th>Time</th><th>Quotes dropped</th><th
                >Cross-checked</th
              ><th>Refusals</th><th>Your notes</th>
            </tr>
          </thead>
          <tbody>
            {#each judging.runs as r (r.id)}
              <tr data-testid="st-score">
                <td>{r.label}</td>
                <td>{r.score.items}</td>
                <td>{r.score.right}</td>
                <td>{r.score.mistake}</td>
                <td>{r.score.notNeeded}</td>
                <td>{r.score.unsure}</td>
                <td>{r.score.unmarked}</td>
                <td>{usd(metric(r.metrics, 'costUsd'))}</td>
                <td>{mins(metric(r.metrics, 'seconds'))}</td>
                <td>{dropped(r.metrics)}</td>
                <td>{metric(r.metrics, 'crossChecked')}</td>
                <td>{refusals(r.metrics)}</td>
                <td>{r.score.notes}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="mt-2 text-xs text-c-muted">
        What each setup missed (from your notes, plus right items only other setups have) is counted
        after you finish judging.
      </p>
    </section>
  {/if}
</div>

<style>
  .bar {
    height: 6px;
    border-radius: 10px;
    background: rgba(127, 127, 127, 0.2);
    overflow: hidden;
    margin-top: 0.25rem;
  }
  .bar > div {
    height: 100%;
    background: currentColor;
    opacity: 0.6;
  }
  .book-chip {
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .scores th,
  .scores td {
    padding: 0.25rem 0.5rem;
    text-align: left;
    white-space: nowrap;
  }
</style>
