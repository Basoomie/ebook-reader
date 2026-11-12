<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import { faEllipsisVertical } from '@fortawesome/free-solid-svg-icons';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';

  /**
   * WP19b: the ⋮ of a book (card corner or list row): Continue reading / Read, then Book
   * status… and Add to collection…, and (WP15e) Remove from this device when this device
   * has a copy. The book itself is opened by tapping its cover or title; this menu keeps
   * the rest one tap away.
   */
  export let title: string;
  /** "Continue reading" when the book is part-read, else "Read". */
  export let readLabel = 'Read';
  /** Round button over a cover (card) or a plain one (row). */
  export let variant: 'cover' | 'row' = 'cover';
  /** Bound up: the menu is open (keeps the corner button visible). */
  export let open = false;
  /** WP19c: the book's details page ('' = no Details item, e.g. on that page itself). */
  export let detailsHref = '';
  /** WP15e: this device has a copy (offers Remove from this device). */
  export let onDevice = false;

  const dispatch = createEventDispatcher<{
    read: void;
    state: void;
    collect: void;
    remove: void;
  }>();

  const item = 'c-btn c-btn-ghost w-full justify-start px-3 text-left';
</script>

<DropdownMenu
  buttonClass={variant === 'cover'
    ? 'c-btn c-btn-secondary h-9 min-h-0 w-9 rounded-full p-0'
    : 'c-btn c-btn-ghost h-12 w-12 p-0'}
  align="right"
  label="Book: {title}"
  testid="book-menu"
  panelWidth="w-56"
  floating
  bind:open
  let:close
>
  <span slot="button" class="flex items-center justify-center" title="More">
    <Fa icon={faEllipsisVertical} />
    <span class="sr-only">More: {title}</span>
  </span>
  <div class="flex flex-col gap-1">
    <button
      type="button"
      class="c-btn c-btn-primary w-full justify-start px-3"
      data-testid="book-menu-read"
      on:click={() => {
        close();
        dispatch('read');
      }}
    >
      {readLabel}
    </button>
    {#if detailsHref}
      <a class={item} href={detailsHref} data-testid="book-menu-details" on:click={close}>
        Details
      </a>
    {/if}
    <div class="my-1 border-t" style="border-color: var(--c-line)" />
    <button
      type="button"
      class={item}
      data-testid="row-state"
      on:click={() => {
        close();
        dispatch('state');
      }}
    >
      Book status…
    </button>
    <button
      type="button"
      class={item}
      data-testid="book-menu-collect"
      on:click={() => {
        close();
        dispatch('collect');
      }}
    >
      Add to collection…
    </button>
    {#if onDevice}
      <div class="my-1 border-t" style="border-color: var(--c-line)" />
      <button
        type="button"
        class={item}
        data-testid="book-menu-remove-device"
        on:click={() => {
          close();
          dispatch('remove');
        }}
      >
        Remove from this device…
      </button>
    {/if}
  </div>
</DropdownMenu>
