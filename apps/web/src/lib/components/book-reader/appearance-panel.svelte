<script lang="ts">
  /**
   * WP10e: appearance over the book, applied live. Every value is this device's own setting
   * (the same stores as Settings > Reader); the reader re-lays out or reopens itself in place
   * when one changes (routes/b/+page.svelte). Plain for e-ink: no transitions, 48 px bordered
   * controls, Esc or Close closes; reader keys are suspended while it is open.
   */
  import { createEventDispatcher, onMount } from 'svelte';
  import ButtonToggleGroup from '$lib/components/button-toggle-group/button-toggle-group.svelte';
  import { optionsForToggle } from '$lib/components/button-toggle-group/toggle-option';
  import { LocalFont } from '$lib/data/fonts';
  import { FuriganaStyle } from '$lib/data/furigana-style';
  import {
    customThemes$,
    darkTheme$,
    einkMode$,
    firstDimensionMargin$,
    followSystemTheme$,
    fontFamilyGroupOne$,
    fontFamilyGroupTwo$,
    fontSize$,
    furiganaStyle$,
    hideFurigana$,
    lightTheme$,
    lineHeight$,
    secondDimensionMaxValue$,
    textIndentation$,
    theme$,
    userFonts$,
    viewMode$,
    writingMode$
  } from '$lib/data/store';
  import { availableThemes } from '$lib/data/theme-option';
  import { ViewMode } from '$lib/data/view-mode';
  import { applyAppearanceValues } from './appearance-settings';
  import { planAppearanceCopy, type DeviceAppearance } from '$lib/sync/copy-device-settings';
  import { formatAge } from '$lib/sync/position-prompt';

  const dispatch = createEventDispatcher<{ close: void }>();

  const box = 'min-h-[3rem] rounded border-2 border-current px-3';
  const stepButton =
    'flex h-12 w-12 items-center justify-center rounded border-2 border-current text-xl font-medium';
  const button =
    'flex min-h-[3rem] items-center justify-center rounded border-2 border-current px-4 font-medium';

  let panelEl: HTMLElement;

  // On wide screens the panel leaves the start of the page visible: vertical text starts on
  // the right, so the panel docks on the left there.
  $: dockLeft = $writingMode$ === 'vertical-rl';

  onMount(() => panelEl?.focus());

  $: optionsForTheme = [
    ...Array.from(availableThemes.entries()),
    ...Object.entries($customThemes$)
  ].map(([id, option]) => ({
    id,
    text: 'ぁあ',
    style: { color: option.fontColor, 'background-color': option.backgroundColor },
    thickBorders: true
  }));

  const userFontNames = $userFonts$.map((font) => font.name);
  const fontsOne: string[] = [
    LocalFont.NOTOSERIFJP,
    LocalFont.KZUDMINCHO,
    LocalFont.GENEI,
    LocalFont.SHIPPORIMINCHO,
    LocalFont.KLEEONE,
    LocalFont.KLEEONESEMIBOLD,
    LocalFont.SERIF,
    ...userFontNames
  ];
  const fontsTwo: string[] = [
    LocalFont.NOTOSANSJP,
    LocalFont.KZUDGOTHIC,
    LocalFont.SANSSERIF,
    ...userFontNames
  ];
  const allFonts = [...new Set([...fontsOne, ...fontsTwo])];

  $: fontChoicesOne = fontsOne.includes($fontFamilyGroupOne$)
    ? fontsOne
    : [$fontFamilyGroupOne$, ...fontsOne];
  $: fontChoicesTwo = fontsTwo.includes($fontFamilyGroupTwo$)
    ? fontsTwo
    : [$fontFamilyGroupTwo$, ...fontsTwo];

  const optionsForWriting = [
    { id: 'vertical-rl', text: 'Vertical' },
    { id: 'horizontal-tb', text: 'Horizontal' }
  ];
  const optionsForView = [
    { id: ViewMode.Paginated, text: 'Pages' },
    { id: ViewMode.Continuous, text: 'Scroll' }
  ];
  // Same four styles as Settings > Reader, with plain names.
  const optionsForFurigana = [
    { id: FuriganaStyle.Partial, text: 'Faint' },
    { id: FuriganaStyle.Full, text: 'Show on hover' },
    { id: FuriganaStyle.Toggle, text: 'Show on tap' },
    { id: FuriganaStyle.Hide, text: 'Never' }
  ];

  function step(
    subject: { getValue(): number; next(v: number): void },
    by: number,
    min: number,
    max: number,
    digits = 0
  ) {
    const next = Math.min(max, Math.max(min, +(subject.getValue() + by).toFixed(digits)));
    subject.next(next);
  }

  function setNumber(
    subject: { next(v: number): void },
    event: Event,
    min: number,
    fallback: number
  ) {
    const value = Number((event.target as HTMLInputElement).value);
    subject.next(Number.isFinite(value) && value >= min ? value : fallback);
  }

  // ---- Copy from another device
  let devices: DeviceAppearance[] | undefined;
  let loadingDevices = false;
  let confirming: DeviceAppearance | undefined;
  let copyMessage = '';

  async function loadDevices() {
    loadingDevices = true;
    copyMessage = '';
    try {
      const { listOtherDevicesAppearance } = await import('$lib/sync/sync-service');
      devices = await listOtherDevicesAppearance();
    } catch {
      devices = [];
    } finally {
      loadingDevices = false;
    }
  }

  function deviceLabel(device: DeviceAppearance) {
    return device.name ?? 'Another device';
  }

  function copyFrom(device: DeviceAppearance) {
    confirming = undefined;
    try {
      const plan = planAppearanceCopy(device.values, allFonts);
      const changed = applyAppearanceValues(plan.apply);
      copyMessage = changed.length
        ? `Copied from ${deviceLabel(device)}.`
        : `${deviceLabel(device)} already looks the same.`;
      if (plan.missingFonts.length) {
        copyMessage += ` Kept your font: ${plan.missingFonts.join(', ')} is not on this device.`;
      }
    } catch (error) {
      copyMessage = `Could not copy: ${(error as Error)?.message ?? error}`;
    }
  }

  function onKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (confirming) {
        confirming = undefined;
      } else {
        dispatch('close');
      }
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
  data-testid="appearance-panel"
  aria-label="Appearance"
>
  <div class="mb-3 flex items-center justify-between">
    <h2 class="text-xl font-medium">Appearance</h2>
    <button class={button} on:click={() => dispatch('close')}>Close</button>
  </div>

  <h3 class="mt-2 mb-1 font-medium">Theme</h3>
  {#if $followSystemTheme$}
    <p class="text-sm">When the device is light</p>
    <ButtonToggleGroup options={optionsForTheme} bind:selectedOptionId={$lightTheme$} />
    <p class="mt-2 text-sm">When the device is dark</p>
    <ButtonToggleGroup options={optionsForTheme} bind:selectedOptionId={$darkTheme$} />
  {:else}
    <ButtonToggleGroup options={optionsForTheme} bind:selectedOptionId={$theme$} />
  {/if}
  <div class="mt-3 grid grid-cols-[1fr_auto] items-center gap-2">
    <span>Follow the device's light/dark</span>
    <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={$followSystemTheme$} />
    <span>E-ink (black on white)</span>
    <div data-testid="appearance-eink">
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={$einkMode$} />
    </div>
  </div>

  <h3 class="mt-4 mb-1 font-medium">Text</h3>
  <label class="mb-2 block">
    <span class="block text-sm">Font</span>
    <select
      class="{box} w-full"
      bind:value={$fontFamilyGroupOne$}
      data-testid="appearance-font-one"
    >
      {#each fontChoicesOne as font (font)}
        <option value={font}>{font}</option>
      {/each}
    </select>
  </label>
  <label class="mb-2 block">
    <span class="block text-sm">Second font (headings, emphasis)</span>
    <select class="{box} w-full" bind:value={$fontFamilyGroupTwo$}>
      {#each fontChoicesTwo as font (font)}
        <option value={font}>{font}</option>
      {/each}
    </select>
  </label>
  <div class="grid grid-cols-[1fr_auto_4rem_auto] items-center gap-2">
    <span>Size</span>
    <button
      class={stepButton}
      aria-label="Smaller"
      data-testid="appearance-size-down"
      on:click={() => step(fontSize$, -1, 8, 80)}>−</button
    >
    <span class="text-center" data-testid="appearance-size">{$fontSize$}</span>
    <button
      class={stepButton}
      aria-label="Larger"
      data-testid="appearance-size-up"
      on:click={() => step(fontSize$, 1, 8, 80)}>+</button
    >
    <span>Line height</span>
    <button
      class={stepButton}
      aria-label="Tighter"
      on:click={() => step(lineHeight$, -0.05, 1, 4, 2)}>−</button
    >
    <span class="text-center" data-testid="appearance-line-height">{$lineHeight$.toFixed(2)}</span>
    <button
      class={stepButton}
      aria-label="Looser"
      data-testid="appearance-line-height-up"
      on:click={() => step(lineHeight$, 0.05, 1, 4, 2)}>+</button
    >
  </div>
  <div class="mt-2 grid grid-cols-[1fr_6rem] items-center gap-2">
    <label for="appearance-indent">Indentation (rem)</label>
    <input
      id="appearance-indent"
      class={box}
      type="number"
      step="0.5"
      min="0"
      value={$textIndentation$}
      on:change={(e) => setNumber(textIndentation$, e, 0, 0)}
    />
  </div>

  <h3 class="mt-4 mb-1 font-medium">Page</h3>
  <div class="grid grid-cols-[1fr_auto] items-center gap-2">
    <span>Writing</span>
    <div data-testid="appearance-writing">
      <ButtonToggleGroup options={optionsForWriting} bind:selectedOptionId={$writingMode$} />
    </div>
    <span>Reading</span>
    <div data-testid="appearance-view">
      <ButtonToggleGroup options={optionsForView} bind:selectedOptionId={$viewMode$} />
    </div>
  </div>
  <div class="mt-2 grid grid-cols-[1fr_6rem] items-center gap-2">
    <label for="appearance-margin">Page margin (px)</label>
    <input
      id="appearance-margin"
      class={box}
      type="number"
      step="10"
      min="0"
      value={$firstDimensionMargin$}
      on:change={(e) => setNumber(firstDimensionMargin$, e, 0, 0)}
    />
    <label for="appearance-max">Text width/height limit (px, 0 = none)</label>
    <input
      id="appearance-max"
      class={box}
      type="number"
      step="50"
      min="0"
      value={$secondDimensionMaxValue$}
      on:change={(e) => setNumber(secondDimensionMaxValue$, e, 0, 0)}
    />
  </div>

  <h3 class="mt-4 mb-1 font-medium">Furigana</h3>
  <div class="grid grid-cols-[1fr_auto] items-center gap-2">
    <span>Hide furigana</span>
    <div data-testid="appearance-furigana">
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={$hideFurigana$} />
    </div>
  </div>
  {#if $hideFurigana$}
    <div class="mt-2">
      <ButtonToggleGroup options={optionsForFurigana} bind:selectedOptionId={$furiganaStyle$} />
    </div>
  {/if}

  <h3 class="mt-4 mb-1 font-medium">Copy from another device</h3>
  {#if !devices}
    <button
      class={button}
      disabled={loadingDevices}
      on:click={loadDevices}
      data-testid="appearance-copy-list"
    >
      {loadingDevices ? 'Looking…' : 'Choose a device…'}
    </button>
  {:else if !devices.length}
    <p class="text-sm" data-testid="appearance-copy-none">
      No other device has shared its settings yet (it needs to be connected to the server and to
      have synced).
    </p>
  {:else}
    <ul>
      {#each devices as device (device.deviceId)}
        <li
          class="flex items-center justify-between gap-2 border-t border-black py-2"
          data-testid="appearance-copy-device"
        >
          <span>
            <span class="block font-medium">{deviceLabel(device)}</span>
            <span class="block text-sm">changed {formatAge(Date.now() - device.updatedAt)}</span>
          </span>
          <button class={button} on:click={() => (confirming = device)}>Copy</button>
        </li>
      {/each}
    </ul>
  {/if}
  {#if confirming}
    <div
      class="mt-2 border-2 border-black p-3"
      role="alertdialog"
      data-testid="appearance-copy-confirm"
    >
      <p class="mb-2">
        Use the theme, fonts, sizes and page layout of {deviceLabel(confirming)} on this device? E-ink
        and Zen mode stay as they are.
      </p>
      <div class="flex justify-end gap-2">
        <button class={button} on:click={() => (confirming = undefined)}>Cancel</button>
        <button class={button} on:click={() => confirming && copyFrom(confirming)}>Copy</button>
      </div>
    </div>
  {/if}
  {#if copyMessage}
    <p class="mt-2" role="status" data-testid="appearance-copy-message">{copyMessage}</p>
  {/if}
  <p class="mt-4 text-sm">More options in Settings > Reader.</p>
</section>
