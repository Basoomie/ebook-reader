<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The Natively level (2026-11-24): "Level 29", and "Level 25??" with a small raised "??" when
   * Natively marks it temporary (as Natively shows it). Not a link. `variant`: 'tag' (the small
   * tag on the series line, C) or 'inline' (inside the Natively link button, D).
   */
  import type { NativelyLevel } from '$lib/library/types';

  export let level: NativelyLevel;
  export let variant: 'tag' | 'inline' = 'tag';
  export let testid = 'natively-level';

  $: title = level.temporary
    ? `Natively level ${level.level} (temporary: few gradings yet)`
    : `Natively level ${level.level}`;
</script>

<span
  class="c-nlevel"
  class:c-nlevel-tag={variant === 'tag'}
  {title}
  data-testid={testid}
  data-level={level.level}
  data-temporary={level.temporary ? 'true' : 'false'}
  >Level {level.level}{#if level.temporary}<sup class="c-nlevel-mark">??</sup>{/if}</span
>

<style>
  .c-nlevel {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .c-nlevel-tag {
    display: inline-flex;
    align-items: baseline;
    padding: 0.125rem 0.5rem;
    border-radius: 0.375rem;
    background-color: var(--c-soft-bg);
    color: var(--c-ink);
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: normal;
    line-height: 1.4;
  }

  .c-nlevel-mark {
    margin-left: 0.0625rem;
    font-size: 0.7em;
    line-height: 0;
  }
</style>
