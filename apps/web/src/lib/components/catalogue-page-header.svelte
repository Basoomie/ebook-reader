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
   */
  export let jp: string;
  export let title: string;
  export let titleTestid = '';
</script>

<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-2 pt-6">
  <div class="flex min-w-0 max-w-full flex-col gap-1">
    <span class="c-jp-label" aria-hidden="true">{jp}</span>
    <div class="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1
        class="break-words font-mincho text-3xl font-bold leading-tight sm:text-[2.75rem]"
        data-testid={titleTestid || undefined}
      >
        {title}
      </h1>
      <slot name="meta" />
    </div>
  </div>
  <slot />
</div>
