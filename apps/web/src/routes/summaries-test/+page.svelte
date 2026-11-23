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
    TAB_GRADES,
    type ItemJudging,
    type ItemRun,
    type TabGrade,
    type TestOverview,
    type TestRun
  } from '$lib/summaries/test-api';

  let api: SummaryTestApi | null = null;
  let overview: TestOverview | null = null;
  let judging: ItemJudging | null = null;
  let book = '';
  let runId = '';
  /** The round judged: the first engine (round1) or the fixed one (v2). */
  let scope = '';
  let error = '';
  let loading = true;
  let missingText = '';
  let timer: ReturnType<typeof setInterval> | null = null;

  onDestroy(() => timer && clearInterval(timer));

  onMount(async () => {
    if (!browser) return;
    book = $page.url.searchParams.get('book') ?? '';
    runId = $page.url.searchParams.get('run') ?? '';
    scope = $page.url.searchParams.get('round') ?? '';
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
      if (!rounds().includes(scope)) scope = rounds().includes('v2') ? 'v2' : 'round1';
      judging = book ? await api.items(book, scope) : null;
      if (judging && !judging.runs.some((r) => r.id === runId)) runId = judging.runs[0]?.id ?? '';
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  /** The rounds the open book has finished runs of. */
  function rounds(): string[] {
    const set = new Set(
      (overview?.runs ?? [])
        .filter((r) => r.bookKey === book && r.state === 'done')
        .map((r) => r.round)
    );
    return ['round1', 'v2'].filter((x) => set.has(x));
  }

  function remember() {
    history.replaceState(
      history.state,
      '',
      `?book=${encodeURIComponent(book)}&round=${scope}&run=${encodeURIComponent(runId)}&tab=${tab}`
    );
  }

  async function pickRound(r: string) {
    scope = r;
    runId = '';
    kept = [];
    await refresh();
    remember();
  }

  async function pickBook(key: string) {
    book = key;
    runId = '';
    scope = '';
    kept = [];
    await refresh();
    remember();
  }

  function pickRun(id: string) {
    runId = id;
    kept = [];
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
    // An item you mark stays in view while "Only what needs you" is on.
    if (!kept.includes(ref)) kept = [...kept, ref];
    try {
      await api.markItem(id, ref, mark);
      const fresh = await api.items(book, scope);
      if (judging) judging = { ...judging, runs: fresh.runs };
    } catch (err) {
      put(before);
      error = (err as Error).message;
    }
  }

  async function addMissing() {
    if (!api || !missingText.trim() || !current) return;
    try {
      await api.addMissing(book, scope, missingText.trim(), current.id, tab);
      missingText = '';
      judging = await api.items(book, scope);
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
      judging = await api.items(book, scope);
    } catch (e) {
      error = (e as Error).message;
    }
  }

  async function removeMissing(id: number) {
    if (!api) return;
    await api.removeMissing(id);
    judging = await api.items(book, scope);
  }

  async function grade(run: ItemRun, g: TabGrade) {
    if (!api) return;
    const next = run.grades[tab] === g ? null : g;
    try {
      await api.gradeTab(run.id, tab, next);
      judging = await api.items(book, scope);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  function gradeSummary(r: ItemRun): string {
    const n = (g: TabGrade) => Object.values(r.grades).filter((x) => x === g).length;
    const parts = TAB_GRADES.map((g) => (n(g.value) ? `${g.label} ${n(g.value)}` : '')).filter(
      Boolean
    );
    return parts.join(' · ') || '—';
  }

  // Only the items waiting for you (flagged by Claude, not checked, spot checks), plus the ones
  // you marked since; remembered on this device.
  const ONLY_KEY = 'summaries-test.only';
  let onlyNeeds = false;
  try {
    onlyNeeds = browser && localStorage.getItem(ONLY_KEY) === '1';
  } catch {
    // no storage: off
  }
  let kept: string[] = [];
  function toggleOnly() {
    onlyNeeds = !onlyNeeds;
    kept = [];
    try {
      localStorage.setItem(ONLY_KEY, onlyNeeds ? '1' : '0');
    } catch {
      // not kept
    }
  }
  $: hasChecks = !!current && Object.keys(current.checks ?? {}).length > 0;
  $: only = onlyNeeds && current && hasChecks ? [...current.needsYou, ...kept] : null;

  // Side by side: the same tab of every setup's summary, to grade them against each other.
  let compare = false;

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

  // English under each item (the engine's own translation), on or off; remembered on this device.
  const ENGLISH_KEY = 'summaries-test.english';
  let showEnglish = false;
  try {
    showEnglish = browser && localStorage.getItem(ENGLISH_KEY) === '1';
  } catch {
    // no storage: off
  }
  let englishOf: Record<string, Record<string, { head: string | null; text: string }> | 'none'> =
    {};
  function toggleEnglish() {
    showEnglish = !showEnglish;
    try {
      localStorage.setItem(ENGLISH_KEY, showEnglish ? '1' : '0');
    } catch {
      // not kept
    }
  }
  async function loadEnglish(id: string) {
    if (!api || englishOf[id]) return;
    try {
      const page = await api.summary(id, 'en');
      const lines: Record<string, { head: string | null; text: string }> = {};
      for (const sec of page.summary.sections)
        for (const g of sec.groups)
          for (const it of g.items)
            lines[it.ref] = {
              head: it.heading ?? (it.between ? `${it.between[0]} – ${it.between[1]}` : null),
              text: it.text
            };
      englishOf = { ...englishOf, [id]: lines };
    } catch {
      englishOf = { ...englishOf, [id]: 'none' };
    }
  }
  $: if (showEnglish && current) void loadEnglish(current.id);
  $: if (showEnglish && compare && judging) for (const r of judging.runs) void loadEnglish(r.id);
  $: english = showEnglish && current ? (englishOf[current.id] ?? null) : null;
  function englishFor(id: string, map: typeof englishOf) {
    const e = map[id];
    return showEnglish && e && e !== 'none' ? e : null;
  }
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
    {#if rounds().length > 1}
      <section class="mt-4">
        <h2 class="font-bold">Engine</h2>
        <div class="mt-2 flex flex-wrap gap-2">
          {#each rounds() as r (r)}
            <button
              type="button"
              class="c-chip"
              aria-pressed={scope === r}
              data-testid="st-round"
              on:click={() => pickRound(r)}>{r === 'v2' ? 'Fixed engine' : 'First engine'}</button
            >
          {/each}
        </div>
      </section>
    {/if}
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
            >{r.label} · {Object.keys(r.checks ?? {}).length
              ? `${r.score.needsYou} for you`
              : `${r.score.items - r.score.unmarked}/${r.score.items}`}</button
          >
        {/each}
      </div>
      {#if hasChecks}
        <p class="mt-3 text-sm text-c-muted" data-testid="st-checked-help">
          Claude checked every item against the book. Turn on <b>Only what needs you</b> and mark
          those: the items Claude flagged (with its reason) and 10 spot checks per summary (items
          Claude found right, to measure its checks). Items Claude found right count as Right unless
          you mark them. Then grade each tab against the other setups' (<b>Side by side</b>
          shows them together) and add notes on what's missing.
        </p>
      {/if}
      <p class="mt-3 text-sm text-c-muted">
        Mark every item: <b>Right</b> (correct and worth keeping), <b>Has a mistake</b> (it needs a
        change: something wrong, made up, or missing), <b>Not needed</b> (vague, filler, or not
        important enough for a summary), <b>Unsure</b>. Tapping a pressed button clears it.
      </p>
      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="c-btn c-btn-secondary c-btn-sm"
          aria-pressed={showEnglish}
          data-testid="st-english"
          on:click={toggleEnglish}>English under each item</button
        >
        {#if hasChecks}
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-sm"
            aria-pressed={onlyNeeds}
            data-testid="st-only"
            on:click={toggleOnly}>Only what needs you ({current?.score.needsYou ?? 0})</button
          >
        {/if}
        {#if judging.runs.length > 1}
          <button
            type="button"
            class="c-btn c-btn-secondary c-btn-sm"
            aria-pressed={compare}
            data-testid="st-compare"
            on:click={() => (compare = !compare)}>Side by side</button
          >
        {/if}
      </div>
      {#if showEnglish && english === 'none'}
        <p class="mt-2 text-sm text-c-muted" data-testid="st-english-none">
          This summary has no English yet.
        </p>
      {/if}
    </section>

    {#if compare}
      <div class="compare mt-4" data-testid="st-compare-view">
        {#each judging.runs as r (r.id)}
          <div class="compare-col" data-testid="st-compare-col">
            <h3 class="font-bold">{r.label}</h3>
            <div class="mt-1 flex flex-wrap gap-2" role="group" aria-label="Grade this tab">
              {#each TAB_GRADES as g (g.value)}
                <button
                  type="button"
                  class="c-btn c-btn-secondary c-btn-sm"
                  aria-pressed={r.grades?.[tab] === g.value}
                  data-testid="st-grade-{g.value}"
                  on:click={() => grade(r, g.value)}>{g.label}</button
                >
              {/each}
            </div>
            <div class="mt-2">
              <SummaryView
                summary={r.summary}
                bookId={judging.book.readerId}
                chapters={judging.chapters}
                characters={judging.characters}
                english={englishFor(r.id, englishOf)}
                bind:tab
              />
            </div>
          </div>
        {/each}
      </div>
    {:else if current}
      <div class="mt-4 max-w-3xl" data-testid="st-summary">
        <SummaryView
          summary={current.summary}
          bookId={judging.book.readerId}
          chapters={judging.chapters}
          characters={judging.characters}
          marks={current.marks}
          copied={current.copied}
          checks={hasChecks ? current.checks : null}
          {only}
          english={english && english !== 'none' ? english : null}
          bind:tab
          on:mark={onMark}
        />
      </div>
      <section class="mt-6 max-w-3xl" data-testid="st-grade">
        <h2 class="font-bold">Grade {tabLabel}</h2>
        <p class="mt-1 text-sm text-c-muted">
          Against the other setups' {tabLabel}: is {current.label}'s the best, good, or weak?
        </p>
        <div class="mt-2 flex flex-wrap gap-2" role="group" aria-label="Grade this tab">
          {#each TAB_GRADES as g (g.value)}
            <button
              type="button"
              class="c-btn c-btn-secondary c-btn-sm"
              aria-pressed={current.grades?.[tab] === g.value}
              data-testid="st-grade-{g.value}"
              on:click={() => current && grade(current, g.value)}>{g.label}</button
            >
          {/each}
        </div>
      </section>
    {/if}

    {#if current && !compare}
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
              ><th>Refusals</th><th>Your notes</th><th>Claude: right</th><th>Claude: flagged</th><th
                >For you</th
              ><th>Spot checks agreed</th><th>Tab grades</th>
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
                <td>{r.score.claudeRight ?? 0}</td>
                <td>{r.score.claudeFlagged ?? 0}</td>
                <td>{r.score.needsYou ?? 0}</td>
                <td>{r.score.spotMarked ? `${r.score.spotAgreed}/${r.score.spotMarked}` : '—'}</td>
                <td>{gradeSummary(r)}</td>
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
  .compare {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: 1.25rem;
  }
  .compare-col {
    min-width: 0;
  }
  .scores th,
  .scores td {
    padding: 0.25rem 0.5rem;
    text-align: left;
    white-space: nowrap;
  }
</style>
