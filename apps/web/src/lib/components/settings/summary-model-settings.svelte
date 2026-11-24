<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Settings › Library › Summaries › Models (book summaries session 4): the server's summary
   * settings (`/api/v1/summaries/settings`): the setups in fallback order (one or two models
   * read the book, one writes; the first setup that works makes the summary), who translates,
   * how long a setup may wait before the next is tried, and how many books at the same time.
   * The models come from Settings › AI's list. Reordered with ↑ / ↓ (Alt+↑ / Alt+↓ on a focused
   * row), like the book page's links; saved with Save. Needs the library server.
   */
  import { onMount, tick } from 'svelte';
  import { AiApi } from '$lib/ai/ai-api';
  import { getLibraryStore } from '$lib/library/library-db';
  import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';
  import { SummaryApi, type SummaryServerSettings } from '$lib/summaries/summary-api';
  import { modelName } from '$lib/summaries/summary-page';
  import {
    addSetup,
    MAX_SETUPS,
    moveSetup,
    removeSetup,
    routeProblem,
    setFinder,
    setWriter
  } from '$lib/summaries/summary-route-edit';

  let api: SummaryApi | null = null;
  let models: string[] = [];
  let saved: SummaryServerSettings | null = null;
  let draft: SummaryServerSettings | null = null;
  let loadError = '';
  let saveError = '';
  let savedNote = '';
  let busy = false;
  let list: HTMLElement | undefined;

  onMount(async () => {
    try {
      const c = await getLibraryStore().getConnection();
      if (!c) {
        loadError = 'Connect this device to the library server to choose the models.';
        return;
      }
      const t = Math.max(0, Number(libraryRequestTimeoutSeconds$.getValue()) || 0);
      api = new SummaryApi(c.serverUrl, c.token, t);
      const [s, ai] = await Promise.all([
        api.settings(),
        new AiApi(c.serverUrl, c.token, t).status()
      ]);
      saved = s.settings;
      draft = s.settings;
      models = ai.models.map((m) => m.model);
    } catch (err) {
      loadError = `The models can't be shown: ${(err as Error).message}. They need the library server.`;
    }
  });

  $: dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(saved);
  $: problem = draft ? routeProblem(draft.route, models) : null;

  function change(next: Partial<SummaryServerSettings>) {
    if (!draft) return;
    draft = { ...draft, ...next };
    savedNote = '';
  }
  async function move(i: number, delta: number) {
    if (!draft) return;
    change({ route: moveSetup(draft.route, i, delta) });
    await tick();
    list
      ?.querySelectorAll<HTMLElement>('[data-setup-row]')
      [i + delta]?.focus({ preventScroll: true });
  }
  function onRowKeydown(ev: KeyboardEvent, i: number) {
    if (ev.target !== ev.currentTarget || !ev.altKey) return;
    if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
    ev.preventDefault();
    void move(i, ev.key === 'ArrowUp' ? -1 : 1);
  }
  const pick = (e: Event) => (e.currentTarget as HTMLSelectElement).value;
  function num(e: Event, min: number, max: number): number {
    const n = Math.round(Number((e.currentTarget as HTMLInputElement).value));
    return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
  }

  async function save() {
    if (!api || !draft || problem) return;
    busy = true;
    saveError = '';
    try {
      const { costPer100kChars: _c, ...changes } = draft;
      void _c;
      saved = (await api.saveSettings(changes)).settings;
      draft = saved;
      savedNote = 'Saved.';
    } catch (err) {
      saveError = `Not saved: ${(err as Error).message}`;
    } finally {
      busy = false;
    }
  }
  const optionsFor = (current: string) =>
    models.includes(current) ? models : [current, ...models];
</script>

{#if loadError}
  <p class="text-sm text-c-muted" data-testid="summary-models-note">{loadError}</p>
{:else if !draft}
  <p class="text-sm text-c-muted">Loading…</p>
{:else}
  <div class="space-y-4" data-testid="summary-models">
    <ol class="setups" bind:this={list}>
      {#each draft.route as r, i (i)}
        <!-- A row takes the focus for Alt+↑ / Alt+↓, like the links' rows. -->
        <!-- svelte-ignore a11y-no-noninteractive-tabindex a11y-no-noninteractive-element-interactions -->
        <li
          class="setup"
          tabindex="0"
          data-setup-row
          aria-label="Setup {i + 1}"
          data-testid="summary-setup"
          on:keydown={(e) => onRowKeydown(e, i)}
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-semibold">{i === 0 ? 'First' : `Then ${i + 1}`}</span>
            <span class="flex gap-1">
              <button
                type="button"
                class="c-btn c-btn-ghost c-btn-icon"
                aria-label="Move up"
                disabled={i === 0}
                on:click={() => move(i, -1)}>↑</button
              >
              <button
                type="button"
                class="c-btn c-btn-ghost c-btn-icon"
                aria-label="Move down"
                disabled={i === draft.route.length - 1}
                on:click={() => move(i, 1)}>↓</button
              >
              <button
                type="button"
                class="c-btn c-btn-ghost"
                disabled={draft.route.length <= 1}
                data-testid="summary-setup-remove"
                on:click={() => draft && change({ route: removeSetup(draft.route, i) })}
                >Remove</button
              >
            </span>
          </div>
          <div class="fields">
            <label>
              <span>Reads the book</span>
              <select
                class="c-input"
                value={r.finders[0]}
                data-testid="summary-setup-finder0"
                on:change={(e) => draft && change({ route: setFinder(draft.route, i, 0, pick(e)) })}
              >
                {#each optionsFor(r.finders[0]) as m (m)}<option value={m}>{modelName(m)}</option
                  >{/each}
              </select>
            </label>
            <label>
              <span>And checks with</span>
              <select
                class="c-input"
                value={r.finders[1] ?? ''}
                data-testid="summary-setup-finder1"
                on:change={(e) =>
                  draft && change({ route: setFinder(draft.route, i, 1, pick(e) || null) })}
              >
                <option value="">No second model</option>
                {#each optionsFor(r.finders[1] ?? models[0]) as m (m)}<option value={m}
                    >{modelName(m)}</option
                  >{/each}
              </select>
            </label>
            <label>
              <span>Writes the summary</span>
              <select
                class="c-input"
                value={r.writer}
                data-testid="summary-setup-writer"
                on:change={(e) => draft && change({ route: setWriter(draft.route, i, pick(e)) })}
              >
                {#each optionsFor(r.writer) as m (m)}<option value={m}>{modelName(m)}</option
                  >{/each}
              </select>
            </label>
          </div>
        </li>
      {/each}
    </ol>
    {#if draft.route.length < MAX_SETUPS}
      <button
        type="button"
        class="c-btn c-btn-secondary"
        data-testid="summary-setup-add"
        on:click={() => draft && change({ route: addSetup(draft.route, models[0] ?? '') })}
        >Add a setup</button
      >
    {/if}
    <div class="fields">
      <label>
        <span>Translates</span>
        <select
          class="c-input"
          value={draft.translator}
          data-testid="summary-translator"
          on:change={(e) => change({ translator: pick(e) })}
        >
          {#each optionsFor(draft.translator) as m (m)}<option value={m}>{modelName(m)}</option
            >{/each}
        </select>
      </label>
      <label>
        <span>Try the next setup after waiting (min)</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="1440"
          value={draft.fallbackAfterMinutes}
          on:change={(e) => change({ fallbackAfterMinutes: num(e, 1, 1440) })}
        />
      </label>
      <label>
        <span>Books at the same time</span>
        <input
          class="c-input"
          type="number"
          min="1"
          max="10"
          value={draft.parallelBooks}
          on:change={(e) => change({ parallelBooks: num(e, 1, 10) })}
        />
      </label>
    </div>
    {#if problem}<p class="text-sm" role="alert">{problem}</p>{/if}
    {#if saveError}<p class="text-sm" role="alert">{saveError}</p>{/if}
    <div class="flex items-center justify-end gap-3">
      {#if savedNote}<span class="text-sm text-c-muted" role="status">{savedNote}</span>{/if}
      {#if dirty}
        <button type="button" class="c-btn c-btn-ghost" on:click={() => (draft = saved)}
          >Undo changes</button
        >
      {/if}
      <button
        type="button"
        class="c-btn c-btn-primary"
        disabled={!dirty || !!problem || busy}
        aria-busy={busy}
        data-testid="summary-models-save"
        on:click={save}>{busy ? 'Saving…' : 'Save'}</button
      >
    </div>
  </div>
{/if}

<style>
  .setups {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .setup {
    padding: 0.625rem 0.75rem;
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
  }
  .setup:focus-visible {
    outline: 2px solid var(--c-link);
    outline-offset: 2px;
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
    gap: 0.5rem 0.75rem;
    margin-top: 0.5rem;
  }
  .fields label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
  .fields label > span {
    color: var(--c-muted);
  }
</style>
