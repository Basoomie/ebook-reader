<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19b: the top of a catalogue page in the "Archive" look: a small Japanese label
   * (蔵書一覧), the page's <h1> in mincho, a `meta` slot next to it (a count) and the
   * default slot on the right (a search box, buttons). Stacks on a phone.
   *
   * Optional slots: `back` (a back link, left of the Japanese label) and `sub` (a line
   * under the title: a group's details and its buttons). The title column takes the
   * room the right side leaves, so a long title wraps instead of pushing the search box
   * onto a line of its own.
   */
  export let jp: string;
  export let title: string;
  export let titleTestid = '';
</script>

<div class="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 pb-4 pt-6">
  <div class="c-header-main flex min-w-0 max-w-full flex-col gap-1">
    <div class="flex min-w-0 flex-wrap items-center gap-x-4">
      <slot name="back" />
      <span class="c-jp-label" aria-hidden="true">{jp}</span>
    </div>
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1
        class="break-words font-mincho text-3xl font-bold leading-tight sm:text-[2.75rem]"
        data-testid={titleTestid || undefined}
      >
        {title}
      </h1>
      <slot name="meta" />
    </div>
    <slot name="sub" />
  </div>
  <slot />
</div>

<style>
  /* Grows into the room the right side leaves; wraps under it only when that is less
     than 20rem. */
  .c-header-main {
    flex: 1 1 20rem;
  }
</style>
