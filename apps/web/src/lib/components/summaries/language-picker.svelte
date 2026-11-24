<script lang="ts">
  /**
   * @license BSD-3-Clause
   * Copyright (c) 2026, ッツ Reader Authors
   * All rights reserved.
   */

  /**
   * The language choice of the summary and the description on a phone: a small button that
   * shows the language's name and opens a menu of the choices.
   *
   * Yomitan scans the text under a touch, also inside buttons and selects, and when it finds
   * some it opens its popup and cancels the tap (the menu never opens). So the visible names
   * are not text in the page: each is drawn by CSS from a data attribute (`.lp-text`), and
   * the real name sits off screen for screen readers (`sr-only`), nowhere near a finger.
   */
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';
  import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';
  import DropdownMenu from '$lib/components/dropdown-menu.svelte';
  import type { LanguageChoice } from '$lib/summaries/summary-page';

  export let choices: LanguageChoice[];
  export let lang: string;
  export let label: string;
  export let testid: string;
  /** A choice that can't be picked now (a translation while editing the original). */
  export let disabled: (c: LanguageChoice) => boolean = () => false;

  const dispatch = createEventDispatcher<{ choose: string }>();

  let open = false;

  /** "日本語 (original)" → "日本語": the button stays short, the menu has the full names. */
  const short = (c: LanguageChoice | undefined) => (c?.label ?? '').split(' (')[0];

  $: current = choices.find((c) => c.lang === lang);
</script>

<DropdownMenu
  buttonClass="c-btn c-btn-secondary c-btn-sm select-none gap-2 px-3"
  align="right"
  {label}
  {testid}
  panelWidth="w-60"
  rootClass="langs-picker"
  bind:open
  let:close
>
  <svelte:fragment slot="button">
    <span class="lp-text" aria-hidden="true" data-text={short(current)} />
    <span class="sr-only">{label}: {short(current)}</span>
    <Fa icon={open ? faChevronUp : faChevronDown} size="xs" />
  </svelte:fragment>
  <div class="flex flex-col gap-1">
    {#each choices as c (c.lang)}
      <button
        type="button"
        class="c-btn c-btn-ghost w-full select-none justify-start px-3 text-left"
        aria-pressed={lang === c.lang}
        disabled={disabled(c)}
        data-testid="{testid}-{c.lang}"
        on:click={() => {
          dispatch('choose', c.lang);
          close();
        }}
      >
        <span class="lp-text" aria-hidden="true" data-text={c.label} />
        <span class="sr-only">{c.label}</span>
      </button>
    {/each}
  </div>
</DropdownMenu>

<style>
  .lp-text::before {
    content: attr(data-text);
  }
</style>
