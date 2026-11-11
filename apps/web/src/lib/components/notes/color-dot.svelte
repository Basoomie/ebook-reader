<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * WP19d: one highlight color as a round dot (the Notes page's filter and card menus).
   * Picked: a ring around it. E-ink: a white dot with "あ" underlined in the color's
   * style (the five colors look alike in black and white).
   */
  import { EINK_UNDERLINES } from '$lib/components/book-reader/highlight-colors';
  import type { HighlightColor } from '$lib/notes/highlights';
  import { HIGHLIGHT_SOLIDS } from '$lib/notes/swatch';

  export let color: HighlightColor;
  export let eink = false;
  export let picked = false;
  /** Dot size in px (the button around it gives the tap area). */
  export let size = 28;
</script>

<span
  class="c-dot flex shrink-0 items-center justify-center rounded-full text-sm font-bold"
  class:c-dot-picked={picked}
  style="width: {size}px; height: {size}px; {eink
    ? `background-color: #fff; color: #000; border: 2px solid #000; text-decoration: underline ${EINK_UNDERLINES[color]} #000; text-decoration-thickness: 2px; text-underline-offset: 3px;`
    : `background-color: ${HIGHLIGHT_SOLIDS[color]};`}"
  aria-hidden="true">{eink ? 'あ' : ''}</span
>

<style>
  .c-dot-picked {
    box-shadow:
      0 0 0 2px var(--c-raised),
      0 0 0 4px var(--c-ink);
  }
</style>
