<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries, Replace ▾ › Write my own (session 4): a whole summary typed by the user,
   * section by section; saved with the server's Write my own (it becomes the current summary,
   * the one before is kept under Earlier versions). Answers what was typed, or nothing.
   * A first, simple form; session 5 reviews it with the user.
   */
  import { createEventDispatcher, onDestroy } from 'svelte';
  import Modal from '$lib/components/modal/modal.svelte';
  import type { OwnSummaryInput, SummaryItemInput } from '$lib/summaries/summary-api';
  import { SUMMARY_TABS, type SummarySectionKey } from '$lib/summaries/summary-types';

  export let title: string;
  export let lang = 'ja';
  export let resolver: (value: OwnSummaryInput | undefined) => void;

  const dispatch = createEventDispatcher<{ close: void }>();
  let answered = false;
  function answer(v: OwnSummaryInput | undefined) {
    if (answered) return;
    answered = true;
    resolver(v);
    dispatch('close');
  }
  onDestroy(() => {
    if (!answered) resolver(undefined);
    answered = true;
  });

  interface Row {
    text: string;
    heading: string;
    a: string;
    b: string;
    label: string;
    chapter: string;
  }
  const blank = (): Row => ({ text: '', heading: '', a: '', b: '', label: '', chapter: '' });
  type Key = Exclude<SummarySectionKey, 'overview'>;
  const KEYS: Key[] = ['chapters', 'characters', 'relationships', 'terms', 'threads'];
  const label = (k: SummarySectionKey) => SUMMARY_TABS.find((t) => t.key === k)?.label ?? k;

  let overview = '';
  let rows: Record<Key, Row[]> = {
    chapters: [],
    characters: [],
    relationships: [],
    terms: [],
    threads: []
  };

  function add(k: Key) {
    rows = { ...rows, [k]: [...rows[k], blank()] };
  }
  function drop(k: Key, i: number) {
    rows = { ...rows, [k]: rows[k].filter((_, j) => j !== i) };
  }
  function set(k: Key, i: number, field: keyof Row, value: string) {
    rows = { ...rows, [k]: rows[k].map((r, j) => (j === i ? { ...r, [field]: value } : r)) };
  }
  const val = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;

  function complete(k: Key, r: Row): boolean {
    if (!r.text.trim()) return false;
    if ((k === 'characters' || k === 'terms') && !r.heading.trim()) return false;
    if (k === 'relationships' && (!r.a.trim() || !r.b.trim())) return false;
    return true;
  }
  $: dirty = !!overview.trim() || KEYS.some((k) => rows[k].some((r) => r.text.trim()));
  $: incomplete = KEYS.some((k) => rows[k].some((r) => r.text.trim() && !complete(k, r)));
  $: ready = dirty && !incomplete;

  function save() {
    if (!ready) return;
    // Chapter items: numbered by their chapter's name, in the order the names first appear.
    const chapterNames: string[] = [];
    const sections = KEYS.map((k) => ({
      key: k,
      items: rows[k]
        .filter((r) => complete(k, r))
        .map((r): SummaryItemInput => {
          const out: SummaryItemInput = { text: r.text };
          if (k === 'characters' || k === 'terms') out.heading = r.heading;
          if (k === 'relationships') {
            out.between = [r.a, r.b];
            out.label = r.label.trim() || null;
          }
          if (k === 'chapters') {
            const name = r.chapter.trim() || 'Chapter 1';
            if (!chapterNames.includes(name)) chapterNames.push(name);
            out.chapter = chapterNames.indexOf(name);
            out.chapterTitle = name;
          }
          return out;
        })
    })).filter((s) => s.items.length);
    answer({ overview: overview.trim() || undefined, sections });
  }
</script>

<Modal
  title="Write my own summary"
  subtitle={title}
  size="lg"
  {dirty}
  testid="summary-write"
  on:close={() => answer(undefined)}
>
  <div class="space-y-5 pt-2" {lang}>
    <label class="field">
      <span>Overview</span>
      <textarea
        class="c-input"
        rows="6"
        maxlength="4000"
        bind:value={overview}
        data-testid="summary-write-overview"
      />
    </label>
    {#each KEYS as k (k)}
      <section>
        <h3 class="font-bold">{label(k)}</h3>
        {#each rows[k] as r, i}
          <div class="row" data-testid="summary-write-row-{k}">
            {#if k === 'chapters'}
              <input
                class="c-input"
                placeholder="Chapter"
                value={r.chapter}
                on:input={(e) => set(k, i, 'chapter', val(e))}
              />
            {/if}
            {#if k === 'characters' || k === 'terms'}
              <input
                class="c-input"
                placeholder={k === 'characters' ? 'Name' : 'Term'}
                value={r.heading}
                on:input={(e) => set(k, i, 'heading', val(e))}
                data-testid="summary-write-heading"
              />
            {/if}
            {#if k === 'relationships'}
              <div class="pair">
                <input
                  class="c-input"
                  placeholder="Person"
                  value={r.a}
                  on:input={(e) => set(k, i, 'a', val(e))}
                />
                <input
                  class="c-input"
                  placeholder="Person"
                  value={r.b}
                  on:input={(e) => set(k, i, 'b', val(e))}
                />
              </div>
              <input
                class="c-input"
                placeholder="Label (one or two words)"
                maxlength="40"
                value={r.label}
                on:input={(e) => set(k, i, 'label', val(e))}
              />
            {/if}
            <textarea
              class="c-input"
              rows="2"
              maxlength="4000"
              placeholder="Text"
              value={r.text}
              on:input={(e) => set(k, i, 'text', val(e))}
              data-testid="summary-write-text"
            />
            <button
              type="button"
              class="c-btn c-btn-ghost c-btn-sm self-end"
              on:click={() => drop(k, i)}>Remove</button
            >
          </div>
        {/each}
        <button
          type="button"
          class="c-btn c-btn-secondary c-btn-sm mt-2"
          data-testid="summary-write-add-{k}"
          on:click={() => add(k)}>Add to {label(k)}</button
        >
      </section>
    {/each}
    {#if incomplete}
      <p class="text-sm text-c-muted">
        Each item needs its text, and a name, a term or the two people where the section has them.
      </p>
    {/if}
  </div>
  <svelte:fragment slot="footer">
    <button
      type="button"
      class="c-btn c-btn-primary"
      disabled={!ready}
      data-testid="summary-write-save"
      on:click={save}>Save summary</button
    >
  </svelte:fragment>
</Modal>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field > span {
    color: var(--c-muted);
    font-size: 0.875rem;
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin-top: 0.5rem;
    padding: 0.625rem;
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.375rem;
  }
</style>
