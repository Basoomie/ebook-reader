<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book page's Links (外部リンク, docs/design/calibre-metadata-display.md): a Calibre
   * book's store and book-site links in the device's order (Settings > Library > Links), those
   * set to Menu behind "More (N)" (a dropdown or a modal, per device). A direct link (the
   * book's saved id) has the small external-link mark, a search link (title and first author)
   * the magnifier. Nothing is drawn for an uploaded book, or when no link has anything to show.
   *
   * `variant`: 'section' (a full-width section below the description), 'buttons' (under the
   * book's buttons) or 'panel' (an own panel under About this book).
   */
  import { faChevronDown } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { resolveLinks } from '$lib/book-links/link-layout';
  import { bookLinks, type BookForLinks, type BookLink } from '$lib/book-links/links';
  import { bookLinks$, bookLinksMoreAs$, bookLinksSearch$ } from '$lib/book-links/settings';
  import BookLinkMark from './book-link-mark.svelte';
  import BookLinksMoreDialog from './book-links-more-dialog.svelte';

  export let book: BookForLinks;
  export let variant: 'section' | 'buttons' | 'panel' = 'section';

  $: placed = bookLinks(book, resolveLinks($bookLinks$), $bookLinksSearch$ !== false);
  $: anySearch = [...placed.buttons, ...placed.menu].some((l) => l.kind === 'search');
  $: moreAsModal = $bookLinksMoreAs$ === 'modal';
  $: shown = placed.buttons.length + placed.menu.length > 0;

  $: linkClass =
    variant === 'section'
      ? 'c-btn c-btn-secondary c-blink-tile justify-between gap-3'
      : 'c-btn c-btn-secondary c-btn-sm gap-2 px-3.5';

  function titleOf(link: BookLink): string {
    return link.kind === 'direct'
      ? `Open this book on ${link.name}`
      : `Search ${link.name} for this title`;
  }

  function openModal() {
    void dialogManager.open(BookLinksMoreDialog, { links: placed.menu });
  }
</script>

{#if shown}
  <section
    class="c-blinks min-w-0"
    class:c-blinks-section={variant === 'section'}
    class:c-blinks-buttons={variant === 'buttons'}
    class:c-blinks-panel={variant === 'panel'}
    class:c-dpanel={variant === 'panel'}
    class:rounded={variant === 'panel'}
    aria-labelledby="details-links"
    data-testid="book-links"
    data-variant={variant}
  >
    {#if variant === 'section'}
      <div class="flex items-center gap-4">
        <h2 id="details-links" class="flex items-baseline gap-3">
          <span class="font-mincho text-lg font-bold text-c-label">外部リンク</span>
          <span class="text-sm text-c-muted">Links</span>
        </h2>
        <span class="c-section-rule" />
      </div>
    {:else if variant === 'panel'}
      <h2 id="details-links" class="flex items-baseline gap-3">
        <span class="font-mincho text-lg font-bold text-c-label">外部リンク</span>
        <span class="text-sm text-c-muted">Links</span>
      </h2>
    {:else}
      <h2 id="details-links" class="text-xs font-normal text-c-muted">
        <span class="font-mincho font-bold text-c-label">外部</span> Links
      </h2>
    {/if}

    <div class="c-blinks-row" data-testid="book-links-row">
      {#each placed.buttons as link (link.id)}
        <a
          class={linkClass}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          title={titleOf(link)}
          data-testid="book-link"
          data-link={link.id}
          data-kind={link.kind}
        >
          <span>{link.name}</span>
          <BookLinkMark kind={link.kind} />
        </a>
      {/each}
      {#if placed.menu.length}
        {#if moreAsModal}
          <button
            type="button"
            class="{linkClass} text-c-muted"
            aria-haspopup="dialog"
            data-testid="book-links-more"
            on:click={openModal}
          >
            <span>More ({placed.menu.length})</span>
            <Fa icon={faChevronDown} size="xs" />
          </button>
        {:else}
          <DropdownMenu
            buttonClass="{linkClass} text-c-muted"
            rootClass="c-blink-more"
            align="left"
            label="More stores"
            testid="book-links-more"
            panelWidth="w-64"
            let:close
          >
            <span slot="button" class="flex w-full items-center justify-between gap-3">
              <span>More ({placed.menu.length})</span>
              <Fa icon={faChevronDown} size="xs" />
            </span>
            <ul class="flex flex-col">
              {#each placed.menu as link (link.id)}
                <li>
                  <a
                    class="c-btn c-btn-ghost w-full justify-between gap-3 px-3 text-left"
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={titleOf(link)}
                    data-testid="book-link"
                    data-link={link.id}
                    data-kind={link.kind}
                    on:click={close}
                  >
                    <span>{link.name}</span>
                    <BookLinkMark kind={link.kind} />
                  </a>
                </li>
              {/each}
            </ul>
          </DropdownMenu>
        {/if}
      {/if}
    </div>

    {#if anySearch}
      <p
        class="mt-2.5 flex items-center gap-1.5 text-xs text-c-muted"
        data-testid="book-links-note"
      >
        <BookLinkMark kind="search" />
        Search link: no direct link for this store yet
      </p>
    {/if}
  </section>
{/if}

<style>
  .c-blinks-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .c-blinks-section {
    margin-top: 2.5rem;
  }

  .c-blinks-section .c-blinks-row {
    margin-top: 0.875rem;
  }

  .c-blinks-buttons {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .c-blinks-panel {
    margin-top: 1.25rem;
    padding: 1.125rem 1.5rem;
  }

  .c-blinks-panel .c-blinks-row {
    margin-top: 0.625rem;
  }

  /* The section's tiles: wide enough that the names line up, the mark at the right. */
  :global(.c-blink-tile) {
    min-width: 9.5rem;
  }

  /* The panel's frame (as About this book's; the page's own rule is scoped to it). */
  .c-dpanel {
    background-color: var(--c-raised);
    border: var(--c-border-width) solid var(--c-line);
    border-top: 3px double var(--c-gold);
    border-bottom: 3px double var(--c-gold);
  }

  /* Phones: the section's tiles two to a row. */
  @media (max-width: 599px) {
    .c-blinks-section .c-blinks-row > :global(*) {
      flex: 1 1 calc(50% - 0.25rem);
      min-width: 0;
    }

    .c-blinks-section :global(.c-blink-more > button) {
      width: 100%;
    }
  }
</style>
