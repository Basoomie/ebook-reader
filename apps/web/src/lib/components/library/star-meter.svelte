<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * Other readers' average as five stars filled to the tenth (4.3 = four stars and a third),
   * in the seal's gold; E-ink draws it black. Decorative: the number beside it is what is read
   * aloud.
   */
  export let avg: number;
  export let size = 16;

  const STAR = 'M12 2.8l2.8 6 6.5.7-4.9 4.4 1.4 6.4L12 17l-5.8 3.3 1.4-6.4L2.7 9.5l6.5-.7z';
  const uid = Math.random().toString(36).slice(2, 8);

  $: width = (Math.max(0, Math.min(5, avg)) / 5) * 120;
</script>

<svg
  class="c-star-meter shrink-0"
  viewBox="0 0 120 24"
  width={size * 5}
  height={size}
  aria-hidden="true"
>
  <defs>
    <clipPath id="c-meter-{uid}"><rect x="0" y="0" {width} height="24" /></clipPath>
  </defs>
  {#each [0, 1, 2, 3, 4] as i (i)}
    <path class="c-star-meter-outline" transform="translate({i * 24} 0)" d={STAR} />
  {/each}
  <g clip-path="url(#c-meter-{uid})">
    {#each [0, 1, 2, 3, 4] as i (i)}
      <path class="c-star-meter-fill" transform="translate({i * 24} 0)" d={STAR} />
    {/each}
  </g>
</svg>

<style>
  .c-star-meter {
    color: var(--c-gold);
  }

  .c-star-meter-outline {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linejoin: round;
  }

  .c-star-meter-fill {
    fill: currentColor;
  }
</style>
