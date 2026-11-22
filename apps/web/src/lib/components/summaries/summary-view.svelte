<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries: a summary as the app shows it (book-summaries.md "UI", option C, approved
   * mockups): tabs Overview, Chapter by chapter, Characters, Relationships, Terms, Open threads
   * (only those with content); characters as cards flowing in columns; quotes only where the
   * summary marks them, each with its place in the book and a link into the reader there.
   * Session 2 shows it on the accuracy test's page; session 4 puts it on the book page with
   * the per-device layouts and the spoiler blur.
   */
  import { createEventDispatcher } from 'svelte';
  import { readerLinkPath } from '$lib/anki/reader-link';
  import ItemMarks from './item-marks.svelte';
  import { pagePath } from '$lib/data/env';
  import {
    SUMMARY_TABS,
    quotePlace,
    type ItemMark,
    type Summary,
    type SummaryItem,
    type SummarySectionKey
  } from '$lib/summaries/summary-types';

  export let summary: Summary;
  /** The book's id in this app (quote links), or null: no links. */
  export let bookId: string | null = null;
  export let chapters: { index: number; title?: string; start: number }[] = [];
  export let characters = 0;
  /**
   * The accuracy test's judging (session 2): each item's mark, by ref; null = no judging. Each
   * item gets the mark buttons and each tab says how many of its items are marked.
   */
  export let marks: Record<string, ItemMark> | null = null;

  const dispatch = createEventDispatcher<{ mark: { ref: string; mark: ItemMark | null } }>();
  function counted(key: SummarySectionKey, marks: Record<string, ItemMark> | null): string {
    if (!marks) return '';
    const refs = (summary.sections.find((s) => s.key === key)?.groups ?? []).flatMap((g) =>
      g.items.map((i) => i.ref)
    );
    return ` ${refs.filter((r) => marks[r]).length}/${refs.length}`;
  }

  $: present = SUMMARY_TABS.filter((t) => summary.sections.some((s) => s.key === t.key));
  /** The open tab (the accuracy test's page reads it for its notes). */
  export let tab: SummarySectionKey = 'overview';
  $: if (!present.some((t) => t.key === tab) && present.length) tab = present[0].key;
  $: section = summary.sections.find((s) => s.key === tab) ?? null;
  $: lang = summary.lang;

  function place(it: SummaryItem): string {
    return it.position === null ? '' : quotePlace(it.position, chapters, characters);
  }
  function href(it: SummaryItem): string | null {
    return bookId && it.position !== null
      ? `${pagePath}${readerLinkPath(bookId, it.position)}`
      : null;
  }
  function made(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
</script>

<section class="summary" data-testid="summary-view">
  <div class="c-modal-tabs tabs" role="tablist">
    {#each present as t (t.key)}
      <button
        type="button"
        class="c-modal-tab"
        role="tab"
        aria-selected={tab === t.key}
        data-testid="summary-tab-{t.key}"
        on:click={() => (tab = t.key)}
      >
        {t.label}{counted(t.key, marks)}
      </button>
    {/each}
  </div>

  {#if section}
    <div class="mt-4" {lang} data-testid="summary-section-{section.key}">
      {#if section.key === 'overview'}
        {#each section.groups[0]?.items ?? [] as it (it.ref)}
          <p class="leading-relaxed" data-ref={it.ref}>{it.text}</p>
          {#if marks}<ItemMarks
              ref={it.ref}
              mark={marks[it.ref] ?? null}
              on:mark={(e) => dispatch('mark', e.detail)}
            />{/if}
        {/each}
      {:else if section.key === 'chapters'}
        {#each section.groups as g (g.chapter)}
          <h3 class="mt-4 font-bold first:mt-0">{g.title}</h3>
          <ul class="mt-1 list-disc pl-5">
            {#each g.items as it (it.ref)}
              <li class="mt-1" data-ref={it.ref}>
                {it.text}
                {#if it.showQuote && it.quote}
                  <blockquote class="quote">
                    「{it.quote}」
                    {#if href(it)}
                      <a class="c-link text-xs" href={href(it)} data-testid="summary-quote-link"
                        >{place(it)}</a
                      >
                    {/if}
                  </blockquote>
                {/if}
                {#if marks}<ItemMarks
                    ref={it.ref}
                    mark={marks[it.ref] ?? null}
                    on:mark={(e) => dispatch('mark', e.detail)}
                  />{/if}
              </li>
            {/each}
          </ul>
        {/each}
      {:else if section.key === 'characters'}
        <div class="cards">
          {#each section.groups[0]?.items ?? [] as it (it.ref)}
            <article class="card" data-ref={it.ref} data-testid="summary-character">
              <h3 class="font-bold">{it.heading}</h3>
              <p class="mt-1">{it.text}</p>
              {#if it.showQuote && it.quote}
                <blockquote class="quote">
                  「{it.quote}」
                  {#if href(it)}
                    <a class="c-link text-xs" href={href(it)} data-testid="summary-quote-link"
                      >{place(it)}</a
                    >
                  {/if}
                </blockquote>
              {/if}
              {#if marks}<ItemMarks
                  ref={it.ref}
                  mark={marks[it.ref] ?? null}
                  on:mark={(e) => dispatch('mark', e.detail)}
                />{/if}
            </article>
          {/each}
        </div>
        {#if summary.alsoMentioned.length}
          <p class="mt-3 text-sm text-c-muted" data-testid="summary-also">
            Also mentioned: {summary.alsoMentioned.join(lang === 'ja' ? '、' : ', ')}
          </p>
        {/if}
      {:else}
        <ul class="space-y-3">
          {#each section.groups[0]?.items ?? [] as it (it.ref)}
            <li data-ref={it.ref}>
              {#if it.heading}<span class="font-bold">{it.heading}</span>{/if}
              {#if it.between}<span class="font-bold">{it.between[0]} – {it.between[1]}</span>{/if}
              <p class:mt-1={!!(it.heading || it.between)}>{it.text}</p>
              {#if it.showQuote && it.quote}
                <blockquote class="quote">
                  「{it.quote}」
                  {#if href(it)}
                    <a class="c-link text-xs" href={href(it)} data-testid="summary-quote-link"
                      >{place(it)}</a
                    >
                  {/if}
                </blockquote>
              {/if}
              {#if marks}<ItemMarks
                  ref={it.ref}
                  mark={marks[it.ref] ?? null}
                  on:mark={(e) => dispatch('mark', e.detail)}
                />{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <p class="mt-6 text-xs text-c-muted" data-testid="summary-made">
    Generated by {summary.models.join(' + ')} on {made(summary.madeAt)}
  </p>
</section>

<style>
  .tabs {
    overflow-x: auto;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .cards {
    columns: 18rem;
    column-gap: 1rem;
  }
  .card {
    break-inside: avoid;
    margin-bottom: 1rem;
    padding: 0.75rem 1rem;
    border-radius: 10px;
    background: var(--c-surface-2, rgba(127, 127, 127, 0.08));
  }
  .quote {
    margin-top: 0.35rem;
    padding-left: 0.75rem;
    border-left: 3px solid rgba(127, 127, 127, 0.35);
    font-size: 0.9em;
    opacity: 0.9;
  }
</style>
