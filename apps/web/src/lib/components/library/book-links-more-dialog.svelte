<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The book page's More, as a modal (Settings > Library > More opens as: Modal): the links set
   * to Menu, in the list's order. Closed with ✕, Esc, a click outside or a swipe down
   * (modal.svelte); a link opens in a new tab and closes the dialog.
   */
  import Modal from '$lib/components/modal/modal.svelte';
  import { createEventDispatcher } from 'svelte';
  import type { BookLink } from '$lib/book-links/links';
  import BookLinkMark from './book-link-mark.svelte';
  import NativelyLevelTag from './natively-level.svelte';
  import type { NativelyLevel } from '$lib/library/types';

  export let links: BookLink[];
  /** The book's Natively level, inside its direct Natively link (2026-11-24). */
  export let nativelyLevel: NativelyLevel | null = null;
  /** Set by dialogManager.open (no answer). */
  export let resolver: (value: undefined) => void = () => {};

  const dispatch = createEventDispatcher<{ close: void }>();

  function close() {
    resolver(undefined);
    dispatch('close');
  }
</script>

<Modal title="More stores" size="sm" testid="book-links-more-dialog" on:close={close}>
  <ul class="flex flex-col py-2">
    {#each links as link (link.id)}
      <li>
        <a
          class="c-btn c-btn-ghost w-full justify-between gap-3 px-3 text-left"
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          title={link.kind === 'direct'
            ? `Open this book on ${link.name}`
            : `Search ${link.name} for this title`}
          data-testid="book-link"
          data-link={link.id}
          data-kind={link.kind}
          on:click={close}
        >
          <span
            >{link.name}{#if nativelyLevel && link.id === 'natively' && link.kind === 'direct'}<span
                class="ml-2 text-c-label"
                ><NativelyLevelTag
                  level={nativelyLevel}
                  variant="inline"
                  testid="book-link-natively-level"
                /></span
              >{/if}</span
          >
          <BookLinkMark kind={link.kind} />
        </a>
      </li>
    {/each}
  </ul>
</Modal>
