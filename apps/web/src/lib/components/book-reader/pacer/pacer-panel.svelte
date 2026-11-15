<script lang="ts">
  /**
   * Season 2 pacer: its panel over the book (reader menu > Pacer). Every value is this
   * device's own setting and applies at once, also while the pacer runs, so the panel
   * doesn't pause it and keeps the reader keys (S, ",", ".") working: it has buttons only,
   * no text fields. Plain for e-ink like the Aa panel: 48 px bordered controls, Esc or
   * Close closes.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import ButtonToggleGroup from '$lib/components/button-toggle-group/button-toggle-group.svelte';
  import { optionsForToggle } from '$lib/components/button-toggle-group/toggle-option';
  import {
    pacerKeepBehind$,
    pacerMode$,
    pacerSpeed$,
    pacerTurnPages$,
    viewMode$,
    writingMode$
  } from '$lib/data/store';
  import { ViewMode } from '$lib/data/view-mode';
  import type { SpeedEstimate } from '$lib/stats/time-left';
  import { clampSpeed, stepSpeed } from './pacer-clock';

  export let supported = true;
  export let running = false;
  export let pausedFor: string[] = [];
  export let ended = false;
  export let failed = false;
  /** Your recent speed in this book (the "Time left" estimate). */
  export let loadSpeed: () => Promise<SpeedEstimate | null> = async () => null;

  const dispatch = createEventDispatcher<{ close: void; toggle: void }>();

  const stepButton =
    'flex h-12 w-12 items-center justify-center rounded border-2 border-current text-xl font-medium';
  const button =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';

  let panelEl: HTMLElement;
  let estimate: SpeedEstimate | null | undefined;

  $: dockLeft = $writingMode$ === 'vertical-rl';
  $: continuous = $viewMode$ === ViewMode.Continuous;

  const modes = [
    { id: 'off', text: 'Off' },
    { id: 'paragraph', text: 'Paragraph' },
    { id: 'reveal', text: 'Reveal' },
    { id: 'disappear', text: 'Disappear' },
    { id: 'reveal-disappear', text: 'Both' }
  ];

  const modeHelp: Record<string, string> = {
    off: 'The pacer is off.',
    paragraph: 'The paragraph you are reading stays clear, the others are dimmed.',
    reveal: 'Text appears at your speed.',
    disappear: 'Text fades away behind you at your speed.',
    'reveal-disappear': 'Only the stretch you are reading shows.'
  };

  $: disappearing = $pacerMode$ === 'disappear' || $pacerMode$ === 'reveal-disappear';

  $: status = failed
    ? 'Stopped: something went wrong (see the log).'
    : ended
      ? 'At the end of the book.'
      : !running
        ? 'Paused.'
        : pausedFor.includes('lookup')
          ? 'Waiting: dictionary open.'
          : pausedFor.length
            ? 'Waiting.'
            : 'Running.';

  const format = (n: number) => Math.round(n).toLocaleString('en-US');

  onMount(() => {
    panelEl?.focus();
    loadSpeed()
      .then((value) => {
        estimate = value;
      })
      .catch(() => {
        estimate = null;
      });
  });

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      dispatch('close');
    }
  }
</script>

<svelte:window on:keydown={onKeydown} />

<section
  bind:this={panelEl}
  tabindex="-1"
  class="writing-horizontal-tb fixed inset-x-0 bottom-0 z-[55] max-h-[65vh] overflow-y-auto border-t-2 border-black bg-white p-4 text-black outline-none md:inset-y-0 md:max-h-none md:w-[26rem] md:border-t-0"
  class:md:left-auto={!dockLeft}
  class:md:right-0={!dockLeft}
  class:md:border-l-2={!dockLeft}
  class:md:right-auto={dockLeft}
  class:md:left-0={dockLeft}
  class:md:border-r-2={dockLeft}
  data-testid="pacer-panel"
  aria-label="Pacer"
>
  <div class="mb-3 flex items-center justify-between">
    <h2 class="text-xl font-medium">Pacer</h2>
    <button class={button} on:click={() => dispatch('close')}>Close</button>
  </div>

  {#if !supported}
    <p data-testid="pacer-unsupported">
      This browser can't show the pacer (it has no CSS Custom Highlight API).
    </p>
  {:else}
    <div data-testid="pacer-mode">
      <ButtonToggleGroup options={modes} bind:selectedOptionId={$pacerMode$} />
    </div>
    <p class="mt-1 text-sm">{modeHelp[$pacerMode$] ?? ''}</p>

    {#if $pacerMode$ !== 'off'}
      <div class="mt-3 flex items-center gap-3">
        <button
          class="{button} min-w-[7rem]"
          data-testid="pacer-toggle"
          on:click={() => dispatch('toggle')}>{running ? 'Pause' : 'Start'}</button
        >
        <span data-testid="pacer-status">{status}</span>
      </div>
    {/if}

    <h3 class="mt-4 mb-1 font-medium">Speed (characters per hour)</h3>
    <div class="grid grid-cols-[auto_1fr_auto] items-center gap-2">
      <button
        class={stepButton}
        aria-label="Slower"
        data-testid="pacer-slower"
        on:click={() => pacerSpeed$.next(stepSpeed($pacerSpeed$, -1))}>−</button
      >
      <span class="text-center text-lg" data-testid="pacer-speed"
        >{format(clampSpeed($pacerSpeed$))} / h</span
      >
      <button
        class={stepButton}
        aria-label="Faster"
        data-testid="pacer-faster"
        on:click={() => pacerSpeed$.next(stepSpeed($pacerSpeed$, 1))}>+</button
      >
    </div>
    <p class="mt-1 text-sm">
      {format(clampSpeed($pacerSpeed$) / 60)} a minute. Keys: "," slower, "." faster, S start or pause.
    </p>
    {#if estimate}
      <div class="mt-2 flex flex-wrap items-center gap-2">
        <span class="text-sm" data-testid="pacer-my-speed"
          >{estimate.source === 'book' ? 'Your recent speed in this book' : 'Your overall speed'}: {format(
            estimate.speed
          )} / h</span
        >
        <button
          class={button}
          data-testid="pacer-use-speed"
          on:click={() => estimate && pacerSpeed$.next(clampSpeed(estimate.speed))}
          >Use my speed</button
        >
      </div>
    {:else if estimate === null}
      <p class="mt-2 text-sm">Not enough tracked reading yet to know your speed.</p>
    {/if}

    <div class="mt-4 grid grid-cols-[1fr_auto] items-center gap-2">
      <span
        >{continuous ? 'Scroll by itself at the end of the screen' : 'Turn pages by itself'}</span
      >
      <div data-testid="pacer-turn-pages">
        <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={$pacerTurnPages$} />
      </div>
    </div>

    {#if disappearing}
      <h3 class="mt-4 mb-1 font-medium">Characters kept behind you</h3>
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <button
          class={stepButton}
          aria-label="Fewer"
          on:click={() => pacerKeepBehind$.next(Math.max(5, Math.round($pacerKeepBehind$) - 10))}
          >−</button
        >
        <span class="text-center" data-testid="pacer-keep">{Math.round($pacerKeepBehind$)}</span>
        <button
          class={stepButton}
          aria-label="More"
          on:click={() => pacerKeepBehind$.next(Math.min(500, Math.round($pacerKeepBehind$) + 10))}
          >+</button
        >
      </div>
    {/if}

    <p class="mt-4 text-sm">
      More pacer settings (E-ink steps, after a lookup, pause when idle) are in Settings &gt;
      Reader.
    </p>
  {/if}
</section>
