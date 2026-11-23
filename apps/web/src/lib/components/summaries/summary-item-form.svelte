<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries, Edit (session 4): the fields of one item, for a change or a new item. The
   * text always; the name or term for Characters and Terms; the two people and the label for
   * Relationships; the chapter for a new item of Chapter by chapter.
   */
  import { createEventDispatcher } from 'svelte';
  import type { SummaryItemInput } from '$lib/summaries/summary-api';
  import type { SummarySectionKey } from '$lib/summaries/summary-types';

  export let section: SummarySectionKey;
  export let initial: SummaryItemInput = { text: '' };
  /** A new item of Chapter by chapter: the chapters it can go under. */
  export let chapters: { chapter: number; title: string }[] = [];
  export let busy = false;
  export let error = '';
  export let saveLabel = 'Save';
  export let lang = 'ja';

  const dispatch = createEventDispatcher<{ save: SummaryItemInput; cancel: void }>();
  let text = initial.text ?? '';
  let heading = initial.heading ?? '';
  let a = initial.between?.[0] ?? '';
  let b = initial.between?.[1] ?? '';
  let label = initial.label ?? '';
  let chapter = String(initial.chapter ?? chapters[0]?.chapter ?? '');

  $: needsHeading = section === 'characters' || section === 'terms';
  $: ready =
    !!text.trim() &&
    (!needsHeading || !!heading.trim()) &&
    (section !== 'relationships' || (!!a.trim() && !!b.trim()));

  function save() {
    if (!ready || busy) return;
    const out: SummaryItemInput = { text };
    if (needsHeading) out.heading = heading;
    if (section === 'relationships') {
      out.between = [a, b];
      out.label = label.trim() || null;
    }
    if (section === 'chapters' && chapters.length) {
      const c = chapters.find((x) => String(x.chapter) === chapter) ?? chapters[0];
      out.chapter = c.chapter;
      out.chapterTitle = c.title;
    }
    dispatch('save', out);
  }
</script>

<form class="form" on:submit|preventDefault={save} data-testid="summary-item-form">
  {#if section === 'chapters' && chapters.length && initial.chapter === undefined}
    <label class="field">
      <span>Chapter</span>
      <select class="c-input" bind:value={chapter} data-testid="summary-form-chapter">
        {#each chapters as c (c.chapter)}
          <option value={String(c.chapter)}>{c.title}</option>
        {/each}
      </select>
    </label>
  {/if}
  {#if needsHeading}
    <label class="field">
      <span>{section === 'characters' ? 'Name' : 'Term'}</span>
      <input
        class="c-input"
        {lang}
        bind:value={heading}
        maxlength="300"
        data-testid="summary-form-heading"
      />
    </label>
  {/if}
  {#if section === 'relationships'}
    <div class="pair">
      <label class="field">
        <span>Person</span>
        <input class="c-input" {lang} bind:value={a} maxlength="200" data-testid="summary-form-a" />
      </label>
      <label class="field">
        <span>Person</span>
        <input class="c-input" {lang} bind:value={b} maxlength="200" data-testid="summary-form-b" />
      </label>
    </div>
    <label class="field">
      <span>Label on the diagram (one or two words)</span>
      <input
        class="c-input"
        {lang}
        bind:value={label}
        maxlength="40"
        data-testid="summary-form-label"
      />
    </label>
  {/if}
  <label class="field">
    <span>{section === 'overview' ? 'Overview' : 'Text'}</span>
    <textarea
      class="c-input"
      {lang}
      rows={section === 'overview' ? 8 : 3}
      maxlength="4000"
      bind:value={text}
      data-testid="summary-form-text"
    />
  </label>
  {#if error}<p class="text-sm" role="alert">{error}</p>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <button type="button" class="c-btn c-btn-ghost" on:click={() => dispatch('cancel')}
      >Cancel</button
    >
    <button
      type="submit"
      class="c-btn c-btn-primary"
      disabled={!ready || busy}
      aria-busy={busy}
      data-testid="summary-form-save">{busy ? 'Saving…' : saveLabel}</button
    >
  </div>
</form>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0.5rem 0;
    padding: 0.75rem;
    border-radius: 10px;
    border: var(--c-border-width) solid var(--c-line);
    background: var(--c-raised);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
  }
  .field > span {
    color: var(--c-muted);
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  textarea {
    resize: vertical;
    min-height: 5rem;
  }
</style>
