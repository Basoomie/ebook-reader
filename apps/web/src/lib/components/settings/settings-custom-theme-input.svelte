<script lang="ts">
  /** One colour of a custom theme: its name, a colour picker and its opacity (0-1). */
  import type { CustomThemeValue, ThemeOption } from '$lib/data/theme-option';
  import { createEventDispatcher } from 'svelte';

  export let label: string;
  export let attribute: keyof ThemeOption;
  export let values: CustomThemeValue;

  const dispatch = createEventDispatcher<{
    color: { attribute: keyof ThemeOption; value: string };
    alpha: { attribute: keyof ThemeOption; value: number };
  }>();

  function handleColorChange(event: Event) {
    const target = event.target as HTMLInputElement;

    dispatch('color', { attribute, value: target.value });
  }

  function handleAlphaChange(event: Event) {
    const target = event.target as HTMLInputElement;

    let value = target.value ? parseFloat(target.value) : undefined;

    if (value === undefined || value < 0 || value > 1) {
      value = 1;
      target.value = '1';
    }

    dispatch('alpha', { attribute, value });
  }
</script>

<span class="min-w-0 text-sm">{label}</span>
<input
  type="color"
  class="h-10 w-14 cursor-pointer rounded border border-c-strong bg-transparent p-0.5"
  aria-label="{label} colour"
  value={values.hexExpression}
  on:change={handleColorChange}
/>
<input
  type="number"
  class="c-input w-full !min-h-[2.5rem] px-2"
  aria-label="{label} opacity"
  step="0.1"
  min="0"
  max="1"
  value={values.alphaValue}
  on:change={handleAlphaChange}
/>
