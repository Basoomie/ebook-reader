<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries session 2: the accuracy test's judging page (its own address, not in the
   * navigation; only on the PC's test copy). Per book, every distinct claim of every setup's
   * summary (the same claim written differently grouped by a model; the grouping can be
   * corrected), marked once right / wrong / unsure, plus what's missing; each setup's scores
   * from those marks, with its cost, time, dropped quotes, cross-checks and refusals.
   */
  import { onDestroy, onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { pagePath } from '$lib/data/env';
  import {
    SummaryTestApi,
    type ClaimGroup,
    type Judging,
    type TestOverview,
    type TestRun
  } from '$lib/summaries/test-api';

  type Filter = 'all' | 'unmarked' | 'wrong' | 'unsure' | 'right';
  const FILTERS: { value: Filter; label: string }[] = [
    { value: 'unmarked', label: 'Not marked' },
    { value: 'all', label: 'All' },
    { value: 'wrong', label: 'Wrong' },
    { value: 'unsure', label: 'Unsure' },
    { value: 'right', label: 'Right' }
  ];
  const SECTIONS: Record<string, string> = {
    overview: 'Overview',
    chapters: 'Chapter by chapter',
    characters: 'Characters',
    relationships: 'Relationships',
    terms: 'Terms',
    threads: 'Open threads'
  };

  let api: SummaryTestApi | null = null;
  let overview: TestOverview | null = null;
  let judging: Judging | null = null;
  let book = '';
  let scope = 'round1';
  let filter: Filter = 'unmarked';
  let open = new Set<number>();
  let error = '';
  let loading = true;
  let missingText = '';
  let moveTo: Record<number, string> = {};
  let timer: ReturnType<typeof setInterval> | null = null;

  onDestroy(() => timer && clearInterval(timer));

  onMount(async () => {
    if (!browser) return;
    book = $page.url.searchParams.get('book') ?? '';
    scope = $page.url.searchParams.get('scope') ?? 'round1';
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

  async function refresh() {
    if (!api) return;
    loading = true;
    error = '';
    try {
      overview = await api.overview();
      const judged = booksWithClaims();
      if (!book && judged.length) book = judged[0];
      judging = book ? await api.judging(book, scope) : null;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function booksWithClaims(): string[] {
    if (!overview) return [];
    const done = new Set(overview.runs.filter((r) => r.state === 'done').map((r) => r.bookKey));
    return overview.books.filter((b) => done.has(b.key)).map((b) => b.key);
  }

  async function pickBook(key: string) {
    book = key;
    open = new Set();
    history.replaceState(history.state, '', `?book=${encodeURIComponent(book)}&scope=${scope}`);
    await refresh();
  }

  async function setMark(g: ClaimGroup, mark: ClaimGroup['mark']) {
    if (!api) return;
    const next = g.mark === mark ? null : mark;
    const before = g.mark;
    const put = (m: ClaimGroup['mark']) => {
      if (judging)
        judging = {
          ...judging,
          groups: judging.groups.map((x) => (x.id === g.id ? { ...x, mark: m } : x))
        };
    };
    put(next);
    try {
      await api.mark(g.id, next);
      const scores = (await api.judging(book, scope)).scores;
      if (judging) judging = { ...judging, scores };
    } catch (e) {
      put(before);
      error = (e as Error).message;
    }
  }

  async function reload() {
    if (!api || !book) return;
    judging = await api.judging(book, scope);
  }

  async function splitOut(claimId: number) {
    if (!api) return;
    try {
      await api.moveClaim(claimId, 'new');
      await reload();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function move(claimId: number) {
    if (!api) return;
    const to = Number(moveTo[claimId]);
    if (!Number.isInteger(to) || to <= 0) return;
    try {
      await api.moveClaim(claimId, to);
      moveTo = { ...moveTo, [claimId]: '' };
      await reload();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function mergeInto(g: ClaimGroup) {
    if (!api) return;
    const to = Number(moveTo[-g.id]);
    if (!Number.isInteger(to) || to <= 0) return;
    try {
      await api.merge(g.id, to);
      moveTo = { ...moveTo, [-g.id]: '' };
      await reload();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function addMissing() {
    if (!api || !missingText.trim()) return;
    await api.addMissing(book, scope, missingText.trim());
    missingText = '';
    await reload();
  }

  async function removeMissing(id: number) {
    if (!api) return;
    await api.removeMissing(id);
    await reload();
  }

  function toggle(id: number) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    open = next;
  }

  function label(runId: string): string {
    return judging?.runs.find((r) => r.id === runId)?.label ?? runId;
  }
  function short(runId: string): string {
    const r = judging?.runs.find((x) => x.id === runId);
    if (!r) return '?';
    const s = r.setup === 'two' ? 'Sonnet+Sol' : r.setup === 'opus' ? 'Opus' : 'gemma';
    return r.background ? `${s} · bg` : s;
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

  $: groups = (judging?.groups ?? []).filter((g) =>
    filter === 'all' ? true : filter === 'unmarked' ? g.mark === null : g.mark === filter
  );
  $: marked = (judging?.groups ?? []).filter((g) => g.mark !== null).length;
  $: runningRuns = (overview?.runs ?? []).filter((r) => r.state === 'running');
  $: bookRuns = (overview?.runs ?? []).filter((r) => r.bookKey === book && r.state === 'done');
</script>

<AppHeader title="Summary accuracy test" />

<div class="{pxScreen} pb-24 pt-16 xl:pt-14" data-testid="summaries-test-page">
  <h1 class="mt-2 text-xl font-bold">Summary accuracy test</h1>

  {#if error}
    <p class="c-notice mt-3 text-sm" role="alert" data-testid="st-error">{error}</p>
  {/if}

  {#if overview}
    <section class="mt-4" data-testid="st-runs">
      <h2 class="font-bold">Runs</h2>
      {#if overview.budget}
        <p class="mt-1 text-sm text-c-muted" data-testid="st-budget">
          Spent {usd(overview.budget.spentUsd)} of the test's {usd(
            overview.budget.limitUsd
          )}{overview.budget.reservedUsd > 0
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
      {#each (overview.runs ?? []).filter((r) => r.state === 'refused' || r.state === 'failed') as r (r.id)}
        <p class="mt-1 text-sm" data-testid="st-run-problem" lang="ja">
          {bookTitle(r.bookKey)} — {overview.setups[r.setup]}: {r.state === 'refused'
            ? 'refused'
            : 'failed'} ({r.error})
        </p>
      {/each}
    </section>

    <section class="mt-6">
      <h2 class="font-bold">Book</h2>
      <div class="mt-2 flex flex-wrap gap-2">
        {#each booksWithClaims() as key (key)}
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
    <section class="mt-6" data-testid="st-summaries">
      <h2 class="font-bold">Each setup's summary</h2>
      <ul class="mt-2 space-y-1 text-sm">
        {#each bookRuns as r (r.id)}
          <li>
            <a
              class="c-link"
              href="{pagePath}/summaries-test/summary?run={encodeURIComponent(r.id)}&lang=ja"
              data-testid="st-summary-link"
              >{overview?.setups[r.setup]}{r.background ? ' · with earlier volumes' : ''}</a
            >
            {#if r.languages.includes('en')}
              ·
              <a
                class="c-link"
                href="{pagePath}/summaries-test/summary?run={encodeURIComponent(r.id)}&lang=en"
                data-testid="st-summary-link-en">English</a
              >
            {/if}
          </li>
        {/each}
      </ul>
    </section>

    <section class="mt-6" data-testid="st-scores">
      <h2 class="font-bold">Scores</h2>
      <p class="mt-1 text-sm text-c-muted">
        {marked} of {judging.groups.length} claims marked. Missed = right claims only other setups made,
        plus what you added as missing.
      </p>
      <div class="mt-2 overflow-x-auto">
        <table class="scores text-sm">
          <thead>
            <tr>
              <th>Setup</th><th>Claims</th><th>Right</th><th>Wrong</th><th>Unsure</th><th
                >Not marked</th
              ><th>Missed</th><th>Cost</th><th>Time</th><th>Quotes dropped</th><th>Cross-checked</th
              ><th>Refusals</th>
            </tr>
          </thead>
          <tbody>
            {#each judging.scores as s (s.runId)}
              <tr data-testid="st-score">
                <td>{s.label}</td>
                <td>{s.claims}</td>
                <td>{s.right}</td>
                <td>{s.wrong}</td>
                <td>{s.unsure}</td>
                <td>{s.unmarked}</td>
                <td>{s.missed}</td>
                <td>{usd(metric(s.metrics, 'costUsd'))}</td>
                <td>{mins(metric(s.metrics, 'seconds'))}</td>
                <td>{dropped(s.metrics)}</td>
                <td>{metric(s.metrics, 'crossChecked')}</td>
                <td>{refusals(s.metrics)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="mt-6" data-testid="st-claims">
      <h2 class="font-bold">Claims</h2>
      <div class="mt-2 flex flex-wrap gap-2" role="group" aria-label="Show">
        {#each FILTERS as f (f.value)}
          <button
            type="button"
            class="c-chip c-chip-sm"
            aria-pressed={filter === f.value}
            data-testid="st-filter-{f.value}"
            on:click={() => (filter = f.value)}>{f.label}</button
          >
        {/each}
      </div>
      {#if !groups.length}
        <p class="mt-3 text-sm" data-testid="st-claims-empty">Nothing here.</p>
      {/if}
      <ol class="mt-3 max-w-3xl">
        {#each groups as g (g.id)}
          <li class="group py-3" data-testid="st-group" data-group={g.id}>
            <div class="flex flex-wrap items-start gap-2">
              <span class="text-xs text-c-muted">#{g.id}</span>
              <p class="min-w-0 flex-1" lang="ja">{g.text}</p>
            </div>
            <div class="mt-1 flex flex-wrap items-center gap-1 text-xs text-c-muted">
              <span>{SECTIONS[g.claims[0]?.section] ?? ''}</span>
              {#each [...new Set(g.claims.map((c) => c.run_id))] as runId (runId)}
                <span class="c-chip c-chip-sm" title={label(runId)}>{short(runId)}</span>
              {/each}
            </div>
            <div class="mt-2 flex flex-wrap gap-2" role="group" aria-label="Mark">
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                aria-pressed={g.mark === 'right'}
                data-testid="st-mark-right"
                on:click={() => setMark(g, 'right')}>Right</button
              >
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                aria-pressed={g.mark === 'wrong'}
                data-testid="st-mark-wrong"
                on:click={() => setMark(g, 'wrong')}>Wrong</button
              >
              <button
                type="button"
                class="c-btn c-btn-secondary c-btn-sm"
                aria-pressed={g.mark === 'unsure'}
                data-testid="st-mark-unsure"
                on:click={() => setMark(g, 'unsure')}>Unsure</button
              >
              <button
                type="button"
                class="c-btn c-btn-ghost c-btn-sm"
                aria-expanded={open.has(g.id)}
                data-testid="st-wordings"
                on:click={() => toggle(g.id)}>Wording by setup ({g.claims.length})</button
              >
            </div>
            {#if open.has(g.id)}
              <ul class="mt-2 space-y-3 border-l pl-3 text-sm" data-testid="st-wording-list">
                {#each g.claims as c (c.id)}
                  <li data-testid="st-claim" data-claim={c.id}>
                    <p class="text-xs text-c-muted">{label(c.run_id)}</p>
                    <p lang="ja">{c.text}</p>
                    {#if c.quote}<p class="text-xs text-c-muted" lang="ja">「{c.quote}」</p>{/if}
                    {#if g.claims.length > 1}
                      <div class="mt-1 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          class="c-btn c-btn-ghost c-btn-sm"
                          data-testid="st-split"
                          on:click={() => splitOut(c.id)}>Not the same claim</button
                        >
                      </div>
                    {/if}
                    <div class="mt-1 flex flex-wrap items-center gap-2">
                      <label class="text-xs text-c-muted"
                        >Same claim as #
                        <input
                          class="c-input w-20"
                          inputmode="numeric"
                          bind:value={moveTo[c.id]}
                          data-testid="st-move-input"
                        />
                      </label>
                      <button
                        type="button"
                        class="c-btn c-btn-ghost c-btn-sm"
                        data-testid="st-move"
                        on:click={() => move(c.id)}>Move</button
                      >
                    </div>
                  </li>
                {/each}
                <li class="flex flex-wrap items-center gap-2">
                  <label class="text-xs text-c-muted"
                    >Whole group is the same claim as #
                    <input
                      class="c-input w-20"
                      inputmode="numeric"
                      bind:value={moveTo[-g.id]}
                      data-testid="st-merge-input"
                    />
                  </label>
                  <button
                    type="button"
                    class="c-btn c-btn-ghost c-btn-sm"
                    data-testid="st-merge"
                    on:click={() => mergeInto(g)}>Merge</button
                  >
                </li>
              </ul>
            {/if}
          </li>
        {/each}
      </ol>
    </section>

    <section class="mt-6 max-w-3xl" data-testid="st-missing">
      <h2 class="font-bold">What's missing</h2>
      <p class="mt-1 text-sm text-c-muted">
        Anything important about this book that no summary has.
      </p>
      <textarea
        class="c-input mt-2 block w-full"
        rows="3"
        lang="ja"
        bind:value={missingText}
        data-testid="st-missing-text"
      />
      <button
        type="button"
        class="c-btn c-btn-primary mt-2"
        disabled={!missingText.trim()}
        data-testid="st-missing-add"
        on:click={addMissing}>Add</button
      >
      <ul class="mt-3 space-y-2">
        {#each judging.missing as m (m.id)}
          <li class="flex items-start gap-2" data-testid="st-missing-item">
            <p class="flex-1" lang="ja">{m.text}</p>
            <button
              type="button"
              class="c-btn c-btn-ghost c-btn-sm"
              data-testid="st-missing-remove"
              on:click={() => removeMissing(m.id)}>Remove</button
            >
          </li>
        {/each}
      </ul>
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
  .group + .group {
    border-top: 1px solid rgba(127, 127, 127, 0.2);
  }
  .scores th,
  .scores td {
    padding: 0.25rem 0.5rem;
    text-align: left;
    white-space: nowrap;
  }
</style>
