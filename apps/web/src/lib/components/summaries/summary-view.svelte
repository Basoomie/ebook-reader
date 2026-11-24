<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Book summaries: a summary as the app shows it (book-summaries.md "UI", option C, approved
   * mockups): tabs Overview, Chapter by chapter, Characters, Relationships, Terms, Open threads
   * (only those with content); quotes only where the summary marks them, each with a link into
   * the reader at its place. Session 4 (the book page): this device's Characters and
   * Relationships layouts, "edited by you", and Edit (change, delete or add items in place; the
   * overview as one text; every tab while editing). Session 2's judging page passes `marks`.
   */
  import { createEventDispatcher } from 'svelte';
  import { readerLinkPath } from '$lib/anki/reader-link';
  import { pagePath } from '$lib/data/env';
  import type { SummaryItemInput } from '$lib/summaries/summary-api';
  import { chapterButtonLabel, quoteLinkText } from '$lib/summaries/summary-page';
  import { einkMode$ } from '$lib/data/store';
  import type { SummaryCharacterLayout, SummaryRelationshipLayout } from '$lib/summaries/settings';
  import {
    SUMMARY_TABS,
    quotePlace,
    type ItemMark,
    type Summary,
    type SummaryItem,
    type SummarySectionKey
  } from '$lib/summaries/summary-types';
  import EnglishLine from './english-line.svelte';
  import ItemMarks from './item-marks.svelte';
  import RubyHeading from './ruby-heading.svelte';
  import SummaryCharacters from './summary-characters.svelte';
  import SummaryExtras from './summary-extras.svelte';
  import SummaryItemEdit from './summary-item-edit.svelte';
  import SummaryItemForm from './summary-item-form.svelte';
  import SummaryRelationships from './summary-relationships.svelte';

  export let summary: Summary;
  /** The book's id in this app (quote links), or null: no links. */
  export let bookId: string | null = null;
  /** The judging page: the book's chapters for "Chapter 3 · 41 %". */
  export let chapters: { index: number; title?: string; start: number }[] = [];
  export let characters = 0;
  /** The book page: the book's character count, for the quote link's "41 %". */
  export let charCount: number | null = null;
  export let characterLayout: SummaryCharacterLayout = 'cards';
  export let relationshipLayout: SummaryRelationshipLayout = 'list';
  /** The book page shows the model line above the tabs itself. */
  export let showMade = true;
  /** Edit (the book page): every item gets Change and Delete, every tab Add. */
  export let editing = false;
  /** Edit: saves a change; resolves to an error to show, or null. */
  export let saveItem: (
    item: SummaryItem,
    input: SummaryItemInput
  ) => Promise<string | null> = async () => null;
  export let removeItem: (item: SummaryItem) => Promise<string | null> = async () => null;
  export let addItem: (
    section: SummarySectionKey,
    input: SummaryItemInput
  ) => Promise<string | null> = async () => null;
  /**
   * The accuracy test's judging (session 2): each item's mark, by ref; null = no judging. Each
   * item gets the mark buttons and each tab says how many of its items are marked.
   */
  export let marks: Record<string, ItemMark> | null = null;
  /** Judging: items whose mark was copied from the same item in another summary (ref → label). */
  export let copied: Record<string, string> | null = null;
  /** Judging: the English translation of each item, shown under the original (ref → line). */
  export let english: Record<string, { head: string | null; text: string }> | null = null;
  /** Judging: Claude's check of each item against the book (ref → check). */
  export let checks: Record<
    string,
    { verdict: ItemMark; reason: string | null; spot: boolean }
  > | null = null;
  /** Judging: show only these items (the ones waiting for you); null = every item. */
  export let only: string[] | null = null;

  const dispatch = createEventDispatcher<{ mark: { ref: string; mark: ItemMark | null } }>();
  function counted(
    key: SummarySectionKey,
    marks: Record<string, ItemMark> | null,
    only: string[] | null
  ): string {
    if (!marks) return '';
    const refs = (summary.sections.find((s) => s.key === key)?.groups ?? []).flatMap((g) =>
      g.items.map((i) => i.ref)
    );
    if (only) return ` · ${refs.filter((r) => only.includes(r)).length}`;
    return ` ${refs.filter((r) => marks[r]).length}/${refs.length}`;
  }
  $: shown = (it: SummaryItem) => !only || only.includes(it.ref);
  /** The language shown: a translation's, else the book's. */
  $: lang = summary.viewLang ?? summary.lang;
  $: ruby = lang === 'ja';
  /** Quotes are always the book's own words. */
  $: quoteLang = summary.lang;

  $: hasChapters = summary.sections.some((s) => s.key === 'chapters');
  $: present = SUMMARY_TABS.filter((t) =>
    editing ? t.key !== 'chapters' || hasChapters : summary.sections.some((s) => s.key === t.key)
  );
  /** The open tab (the accuracy test's page reads it for its notes). */
  export let tab: SummarySectionKey = 'overview';
  $: if (!present.some((t) => t.key === tab) && present.length) tab = present[0].key;
  $: section = summary.sections.find((s) => s.key === tab) ?? { key: tab, groups: [] };
  $: flat = (section.groups[0]?.items ?? []).filter(shown);
  /** Plain rendering for judging and Edit; the device's layouts otherwise. */
  $: plain = !!marks || editing;
  $: chapterChoices = (summary.sections.find((s) => s.key === 'chapters')?.groups ?? [])
    .filter((g) => g.chapter !== undefined)
    .map((g) => ({
      chapter: g.chapter as number,
      title: g.title ?? `Chapter ${(g.chapter ?? 0) + 1}`
    }));

  /**
   * Chapter by chapter shows one chapter at a time, chosen with a row of chapter buttons (user,
   * 2026-11-23: the list ran to dozens of screens), or All. The judging page keeps the whole
   * list. Opens on the first chapter; a chapter that goes away (an edit) falls back to it.
   */
  $: chapterGroups = section.groups.filter((g) => g.items.some(shown));
  $: chapterButtons = !marks && chapterGroups.length > 1;
  let chapterPick: number | 'all' | null = null;
  $: if (
    chapterPick !== 'all' &&
    (chapterPick === null || !chapterGroups.some((g) => g.chapter === chapterPick))
  )
    chapterPick = chapterGroups[0]?.chapter ?? null;
  $: shownGroups =
    !chapterButtons || chapterPick === 'all'
      ? chapterGroups
      : chapterGroups.filter((g) => g.chapter === chapterPick);
  let chapterRow: HTMLElement | undefined;
  function pickChapter(c: number | 'all', i: number) {
    chapterPick = c;
    // Keep the chosen button in view in its row (no animation on E-ink).
    chapterRow?.querySelectorAll<HTMLElement>('[data-chapter-button]')[i]?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: $einkMode$ ? 'auto' : 'smooth'
    });
  }

  function hrefOf(it: SummaryItem): string | null {
    return bookId && it.position !== null && it.showQuote && it.quote
      ? `${pagePath}${readerLinkPath(bookId, it.position)}`
      : null;
  }
  function linkTextOf(it: SummaryItem): string {
    if (it.position === null) return '';
    // The judging page knows the chapters; the book page the item's chapter and the length.
    if (chapters.length) return quotePlace(it.position, chapters, characters);
    return quoteLinkText(it.position, charCount, it.chapterTitle);
  }
  function made(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  let adding: SummarySectionKey | null = null;
  let addBusy = false;
  let addError = '';
  async function onAdd(input: SummaryItemInput) {
    addBusy = true;
    addError = '';
    const e = await addItem(tab, input);
    addBusy = false;
    if (e) addError = e;
    else adding = null;
  }
  $: if (!editing) adding = null;
  $: tabLabel = SUMMARY_TABS.find((t) => t.key === tab)?.label ?? '';
</script>

<section class="summary" data-testid="summary-view">
  <div class="c-modal-tabs c-strip tabs" role="tablist" aria-label="Summary sections">
    {#each present as t (t.key)}
      <button
        type="button"
        class="c-modal-tab tab"
        role="tab"
        aria-selected={tab === t.key}
        data-testid="summary-tab-{t.key}"
        on:click={() => (tab = t.key)}
      >
        {t.label}{counted(t.key, marks, only)}
      </button>
    {/each}
  </div>

  <div class="mt-4" {lang} data-testid="summary-section-{section.key}">
    {#if section.key === 'overview'}
      {#each flat as it (it.ref)}
        <p class="overview leading-relaxed" data-ref={it.ref}>
          {it.text}<SummaryExtras item={it} />
        </p>
        {#if editing}<SummaryItemEdit
            item={it}
            section="overview"
            {lang}
            save={saveItem}
            remove={null}
          />{/if}
        {#if english?.[it.ref]}<EnglishLine line={english[it.ref]} />{/if}
        {#if marks}<ItemMarks
            ref={it.ref}
            mark={marks[it.ref] ?? null}
            copiedFrom={copied?.[it.ref] ?? null}
            check={checks?.[it.ref] ?? null}
            on:mark={(e) => dispatch('mark', e.detail)}
          />{/if}
      {/each}
    {:else if section.key === 'chapters'}
      {#if chapterButtons}
        <div
          class="c-strip chapters"
          role="group"
          aria-label="Chapters"
          bind:this={chapterRow}
          data-testid="summary-chapter-buttons"
        >
          {#each chapterGroups as g, i (g.chapter)}
            <button
              type="button"
              class="c-chip c-chip-sm shrink-0"
              aria-pressed={chapterPick === g.chapter}
              title={g.title}
              data-chapter-button
              data-testid="summary-chapter-button"
              on:click={() => pickChapter(g.chapter ?? 0, i)}
              >{chapterButtonLabel(g.title ?? '', g.chapter ?? 0)}</button
            >
          {/each}
          <button
            type="button"
            class="c-chip c-chip-sm shrink-0"
            aria-pressed={chapterPick === 'all'}
            data-chapter-button
            data-testid="summary-chapter-all"
            on:click={() => pickChapter('all', chapterGroups.length)}>All</button
          >
        </div>
      {/if}
      {#each shownGroups as g (g.chapter)}
        <h3 class="mt-4 font-bold first:mt-0">{g.title}</h3>
        <ul class="mt-1 list-disc pl-5">
          {#each g.items.filter(shown) as it (it.ref)}
            <li class="mt-1" data-ref={it.ref}>
              {it.text}<SummaryExtras item={it} />
              {#if editing}<SummaryItemEdit
                  item={it}
                  section="chapters"
                  {lang}
                  save={saveItem}
                  remove={removeItem}
                />{/if}
              {#if english?.[it.ref]}<EnglishLine line={english[it.ref]} />{/if}
              <SummaryExtras
                part="quote"
                item={it}
                {quoteLang}
                href={hrefOf(it)}
                linkText={linkTextOf(it)}
              />
              {#if marks}<ItemMarks
                  ref={it.ref}
                  mark={marks[it.ref] ?? null}
                  copiedFrom={copied?.[it.ref] ?? null}
                  check={checks?.[it.ref] ?? null}
                  on:mark={(e) => dispatch('mark', e.detail)}
                />{/if}
            </li>
          {/each}
        </ul>
      {/each}
    {:else if section.key === 'characters' && !plain}
      <SummaryCharacters
        items={flat}
        alsoMentioned={summary.alsoMentioned}
        layout={characterLayout}
        {lang}
        {ruby}
        {quoteLang}
        {hrefOf}
        {linkTextOf}
      />
    {:else if section.key === 'relationships' && !plain}
      <SummaryRelationships
        items={flat}
        layout={relationshipLayout}
        {ruby}
        {quoteLang}
        {hrefOf}
        {linkTextOf}
      />
    {:else}
      <ul
        class:cards={section.key === 'characters' && !editing}
        class:rows={(section.key !== 'characters' &&
          section.key !== 'terms' &&
          section.key !== 'threads') ||
          editing}
        class:glossary={section.key === 'terms'}
        class:threads={section.key === 'threads'}
      >
        {#each flat as it (it.ref)}
          <li
            class:card={section.key === 'characters' && !editing}
            data-ref={it.ref}
            data-testid={section.key === 'characters' ? 'summary-character' : undefined}
          >
            {#if it.heading}<h3 class="font-bold">
                <RubyHeading text={it.heading} pieces={ruby ? it.ruby : null} />
              </h3>{/if}
            {#if it.between}<h3 class="font-bold">
                <RubyHeading text={it.between[0]} pieces={ruby ? it.betweenRuby?.[0] : null} /> –
                <RubyHeading text={it.between[1]} pieces={ruby ? it.betweenRuby?.[1] : null} />
                {#if it.label}<span class="ml-2 text-sm font-normal text-c-muted">{it.label}</span
                  >{/if}
              </h3>{/if}
            <p class:mt-1={!!(it.heading || it.between)} class="leading-relaxed">
              {it.text}<SummaryExtras item={it} />
            </p>
            {#if editing}<SummaryItemEdit
                item={it}
                section={section.key}
                {lang}
                save={saveItem}
                remove={removeItem}
              />{/if}
            {#if english?.[it.ref]}<EnglishLine line={english[it.ref]} />{/if}
            <SummaryExtras
              part="quote"
              item={it}
              {quoteLang}
              href={hrefOf(it)}
              linkText={linkTextOf(it)}
            />
            {#if marks}<ItemMarks
                ref={it.ref}
                mark={marks[it.ref] ?? null}
                copiedFrom={copied?.[it.ref] ?? null}
                check={checks?.[it.ref] ?? null}
                on:mark={(e) => dispatch('mark', e.detail)}
              />{/if}
          </li>
        {/each}
      </ul>
      {#if section.key === 'characters' && summary.alsoMentioned.length}
        <p class="mt-3 text-sm text-c-muted" data-testid="summary-also">
          Also mentioned: {summary.alsoMentioned.join(lang === 'ja' ? '、' : ', ')}
        </p>
      {/if}
    {/if}

    {#if editing && (section.key !== 'overview' || !flat.length)}
      {#if adding === section.key}
        <SummaryItemForm
          section={section.key}
          {lang}
          chapters={chapterChoices}
          busy={addBusy}
          error={addError}
          saveLabel="Add"
          on:save={(e) => onAdd(e.detail)}
          on:cancel={() => {
            adding = null;
            addError = '';
          }}
        />
      {:else}
        <button
          type="button"
          class="c-btn c-btn-secondary mt-3"
          data-testid="summary-add-{section.key}"
          on:click={() => (adding = section.key)}
          >{section.key === 'overview' ? 'Add an overview' : `Add to ${tabLabel}`}</button
        >
      {/if}
    {/if}
  </div>

  {#if showMade}
    <p class="mt-6 text-xs text-c-muted" data-testid="summary-made">
      Generated by {summary.models.join(' + ')} on {made(summary.madeAt)}
    </p>
  {/if}
</section>

<style>
  .chapters {
    display: flex;
    gap: 0.5rem;
    padding-bottom: 0.25rem;
    margin-bottom: 0.5rem;
  }
  /* 48 px on touch and E-ink, like the buttons. */
  .chapters .c-chip {
    min-height: var(--c-btn-h);
  }
  .tab {
    min-height: var(--c-btn-h);
    flex-shrink: 0;
  }
  .tabs {
    display: flex;
    overflow-x: auto;
  }
  .cards {
    columns: 18rem;
    column-gap: 1rem;
  }
  .card {
    break-inside: avoid;
    display: inline-block;
    width: 100%;
    margin-bottom: 1rem;
    padding: 0.75rem 1rem;
    border-radius: 10px;
    background: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }
  .rows > li + li {
    margin-top: 0.75rem;
  }
  .overview {
    white-space: pre-line;
  }
  /* Terms: the name in a left column, the definition beside it, a hairline between entries. */
  .glossary > li {
    display: grid;
    grid-template-columns: minmax(7rem, 11rem) minmax(0, 1fr);
    column-gap: 1.25rem;
    padding: 0.75rem 0;
    border-top: var(--c-border-width) solid var(--c-line);
  }
  .glossary > li:first-child {
    border-top: none;
  }
  .glossary > li > :global(h3) {
    grid-column: 1;
    grid-row: 1 / span 20;
  }
  .glossary > li > :global(:not(h3)) {
    grid-column: 2;
  }
  .glossary > li > :global(p) {
    margin-top: 0;
  }
  @media (max-width: 40rem) {
    .glossary > li {
      grid-template-columns: minmax(0, 1fr);
    }
    .glossary > li > :global(h3),
    .glossary > li > :global(:not(h3)) {
      grid-column: 1;
      grid-row: auto;
    }
    .glossary > li > :global(p) {
      margin-top: 0.25rem;
    }
  }
  /* Open threads: one numbered card each. */
  .threads {
    counter-reset: thread;
  }
  .threads > li {
    counter-increment: thread;
    display: grid;
    grid-template-columns: 1.75rem minmax(0, 1fr);
    column-gap: 0.75rem;
    margin-bottom: 0.5rem;
    padding: 0.75rem 0.875rem;
    border-radius: 10px;
    background: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
  }
  .threads > li::before {
    content: counter(thread);
    grid-column: 1;
    grid-row: 1 / span 20;
    align-self: start;
    margin-top: 0.15rem;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 500;
    background: var(--c-line);
    color: var(--c-muted, inherit);
  }
  .threads > li > :global(*) {
    grid-column: 2;
  }
</style>
