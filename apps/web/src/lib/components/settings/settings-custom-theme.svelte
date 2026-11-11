<script lang="ts">
  import type { ToggleOption } from '$lib/components/button-toggle-group/toggle-option';
  import DialogTemplate from '$lib/components/dialog-template.svelte';
  import Ripple from '$lib/components/ripple.svelte';
  import SettingsCustomThemeInput from '$lib/components/settings/settings-custom-theme-input.svelte';
  import { buttonClasses } from '$lib/css-classes';
  import {
    customThemes$,
    fontFamilyGroupOne$,
    fontFamilyGroupTwo$,
    fontSize$,
    theme$
  } from '$lib/data/store';
  import { customFontNames$ } from '$lib/fonts/server-fonts-browser';
  import { LocalFont } from '$lib/data/fonts';
  import {
    availableThemes,
    THEME_COLOR_KEYS,
    type CustomTheme,
    type CustomThemeValue,
    type ThemeOption
  } from '$lib/data/theme-option';
  import { createEventDispatcher, onMount } from 'svelte';

  export let selectedTheme: string;
  export let existingThemes: ToggleOption<string>[] = [];

  const dispatch = createEventDispatcher<{
    close: void;
  }>();

  let customTheme: Record<keyof ThemeOption, CustomThemeValue> = {
    fontColor: { hexExpression: '#ffffff', alphaValue: 1, rgbaExpression: 'rgba(255,255,255,1)' },
    backgroundColor: {
      hexExpression: '#000000',
      alphaValue: 1,
      rgbaExpression: 'rgba(0,0,0,1)'
    },
    selectionFontColor: {
      hexExpression: '#ffffff',
      alphaValue: 1,
      rgbaExpression: 'rgba(255,255,255,1)'
    },
    selectionBackgroundColor: {
      hexExpression: '#ffffff',
      alphaValue: 1,
      rgbaExpression: 'rgba(255,255,255,1)'
    },
    hintFuriganaShadowColor: {
      hexExpression: '#ffffff',
      alphaValue: 1,
      rgbaExpression: 'rgba(255,255,255,1)'
    },
    hintFuriganaFontColor: {
      hexExpression: '#ffffff',
      alphaValue: 1,
      rgbaExpression: 'rgba(255,255,255,1)'
    },
    tooltipTextFontColor: {
      hexExpression: '#ffffff',
      alphaValue: 1,
      rgbaExpression: 'rgba(255,255,255,1)'
    }
  };

  let themeToCopy = existingThemes[0].id;
  let themeName = '';
  let themeNameElm: HTMLInputElement;

  // WP10d: a theme may carry a font and a size, applied when it becomes the active theme.
  let includeFont = false;
  let fontOne = $fontFamilyGroupOne$;
  let fontTwo = $fontFamilyGroupTwo$;
  let includeSize = false;
  let size = $fontSize$;

  // Custom fonts: server-synced ones (WP13) and this browser's own.
  $: userFontNames = $customFontNames$;
  $: fontsOne = [
    LocalFont.NOTOSERIFJP,
    LocalFont.KZUDMINCHO,
    LocalFont.GENEI,
    LocalFont.SHIPPORIMINCHO,
    LocalFont.KLEEONE,
    LocalFont.KLEEONESEMIBOLD,
    LocalFont.SERIF,
    ...userFontNames
  ];
  $: fontsTwo = [LocalFont.NOTOSANSJP, LocalFont.KZUDGOTHIC, LocalFont.SANSSERIF, ...userFontNames];

  $: fontChoicesOne = fontsOne.includes(fontOne) ? fontsOne : [fontOne, ...fontsOne];
  $: fontChoicesTwo = fontsTwo.includes(fontTwo) ? fontsTwo : [fontTwo, ...fontsTwo];

  $: themeStyle = `color: ${customTheme.fontColor.rgbaExpression}; background-color: ${customTheme.backgroundColor.rgbaExpression}`;

  onMount(() => {
    const existingThemeObject = $customThemes$[selectedTheme];

    if (!existingThemeObject) {
      return;
    }

    customTheme = getThemeData(existingThemeObject);
    themeName = selectedTheme;

    if (existingThemeObject.fontFamilyGroupOne || existingThemeObject.fontFamilyGroupTwo) {
      includeFont = true;
      fontOne = existingThemeObject.fontFamilyGroupOne || fontOne;
      fontTwo = existingThemeObject.fontFamilyGroupTwo || fontTwo;
    }

    if (typeof existingThemeObject.fontSize === 'number') {
      includeSize = true;
      size = existingThemeObject.fontSize;
    }
  });

  function getThemeData(referenceObject: ThemeOption): Record<keyof ThemeOption, CustomThemeValue> {
    const result: any = {};
    // Colours only: a WP10d theme can also hold a font and a size.
    const entries = THEME_COLOR_KEYS.map((key) => [key, referenceObject[key]] as const);

    for (let index = 0, { length } = entries; index < length; index += 1) {
      const [key, value] = entries[index];
      const [r, g, b, a] = (value.match(/rgba\((.+)\)/)?.[1] || '0,0,0,1')
        .split(',')
        .map((x: string) => parseFloat(x.trim()));

      result[key as keyof ThemeOption] = {
        hexExpression: `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
          .toString(16)
          .padStart(2, '0')}`,
        alphaValue: a,
        rgbaExpression: value
      };
    }

    return result;
  }

  function handleCopyTheme() {
    copyTheme(availableThemes.get(themeToCopy) || $customThemes$[themeToCopy]);
  }

  function handleColorValueChange(
    event: CustomEvent<{ attribute: keyof ThemeOption; value: string }>
  ) {
    const { attribute, value } = event.detail;
    const entry = customTheme[attribute];

    customTheme = {
      ...customTheme,
      ...{
        [attribute]: {
          hexExpression: value,
          alphaValue: entry.alphaValue,
          rgbaExpression: hexToRGB(value, entry.alphaValue)
        }
      }
    };
  }

  function handleAlphaValueChange(
    event: CustomEvent<{ attribute: keyof ThemeOption; value: number }>
  ) {
    const { attribute, value } = event.detail;
    const entry = customTheme[attribute];

    customTheme = {
      ...customTheme,
      ...{
        [attribute]: {
          hexExpression: entry.hexExpression,
          alphaValue: value,
          rgbaExpression: hexToRGB(entry.hexExpression, value)
        }
      }
    };
  }

  function handleSave() {
    themeNameElm.setCustomValidity('');

    if (!themeName) {
      themeNameElm.setCustomValidity('You have to enter a Name!');
      themeNameElm.reportValidity();
      return;
    }

    if (availableThemes.has(themeName)) {
      themeNameElm.setCustomValidity('This Name is reserved!');
      themeNameElm.reportValidity();
      return;
    }

    const newTheme: any = {};
    const entries = [...Object.entries(customTheme)];

    for (let index = 0, { length } = entries; index < length; index += 1) {
      const [key, value] = entries[index];

      newTheme[key] = value.rgbaExpression;
    }

    if (includeFont) {
      newTheme.fontFamilyGroupOne = fontOne;
      newTheme.fontFamilyGroupTwo = fontTwo;
    }

    if (includeSize && Number(size) > 0) {
      newTheme.fontSize = Number(size);
    }

    if (selectedTheme && selectedTheme !== themeName) {
      delete $customThemes$[selectedTheme];
    }

    const wasActive = $theme$ === themeName;

    $customThemes$ = { ...$customThemes$, ...{ [themeName]: newTheme as CustomTheme } };
    $theme$ = themeName;

    // Switching applies a theme's font and size (appearance-effects.ts); the theme that is
    // already active is not switched to, so apply them here.
    if (wasActive) {
      if (includeFont) {
        $fontFamilyGroupOne$ = fontOne;
        $fontFamilyGroupTwo$ = fontTwo;
      }

      if (includeSize && Number(size) > 0) {
        $fontSize$ = Number(size);
      }
    }
    dispatch('close');
  }

  function copyTheme(theme: Record<keyof ThemeOption, string> | undefined) {
    if (!theme) {
      return;
    }

    customTheme = getThemeData(theme);
  }

  function hexToRGB(h: string, alpha: number) {
    let r = '0';
    let g = '0';
    let b = '0';

    if (h.length === 4) {
      r = `0x${h[1]}${h[1]}`;
      g = `0x${h[2]}${h[2]}`;
      b = `0x${h[3]}${h[3]}`;
    } else if (h.length === 7) {
      r = `0x${h[1]}${h[2]}`;
      g = `0x${h[3]}${h[4]}`;
      b = `0x${h[5]}${h[6]}`;
    }

    return `rgba(${+r},${+g},${+b},${alpha})`;
  }
</script>

<DialogTemplate>
  <div slot="content">
    <div
      class="grid grid-cols-1 gap-2 items-center overflow-auto max-h-[60vh] sm:grid-cols-[auto_auto_5rem] sm:gap-4"
    >
      <select class="sm:col-span-2" bind:value={themeToCopy}>
        {#each existingThemes as theme (theme.id)}
          <option value={theme.id}>
            {theme.id}
          </option>
        {/each}
      </select>
      <button class={buttonClasses} on:click={handleCopyTheme}
        >Copy
        <Ripple />
      </button>
      <span class="hidden sm:block">Attribute</span>
      <span class="hidden sm:block">Color</span>
      <span class="hidden sm:block">Alpha</span>
      <SettingsCustomThemeInput
        label="Font"
        attribute="fontColor"
        values={customTheme.fontColor}
        on:color={handleColorValueChange}
        on:alpha={handleAlphaValueChange}
      />
      <SettingsCustomThemeInput
        label="Background"
        attribute="backgroundColor"
        values={customTheme.backgroundColor}
        on:color={handleColorValueChange}
        on:alpha={handleAlphaValueChange}
      />
      <SettingsCustomThemeInput
        label="Furigana Partial Hide Font"
        attribute="hintFuriganaFontColor"
        values={customTheme.hintFuriganaFontColor}
        on:color={handleColorValueChange}
        on:alpha={handleAlphaValueChange}
      />
      <SettingsCustomThemeInput
        label="Furigana Partial/Full Hide Shadow"
        attribute="hintFuriganaShadowColor"
        values={customTheme.hintFuriganaShadowColor}
        on:color={handleColorValueChange}
        on:alpha={handleAlphaValueChange}
      />
      <SettingsCustomThemeInput
        label="Footer Font"
        attribute="tooltipTextFontColor"
        values={customTheme.tooltipTextFontColor}
        on:color={handleColorValueChange}
        on:alpha={handleAlphaValueChange}
      />
      <label class="flex items-center gap-2 sm:col-span-3" data-testid="theme-include-font">
        <input type="checkbox" bind:checked={includeFont} />
        Include font (applied when you switch to this theme)
      </label>
      {#if includeFont}
        <span>Font (Group 1)</span>
        <select class="sm:col-span-2" bind:value={fontOne} data-testid="theme-font-one">
          {#each fontChoicesOne as font (font)}
            <option value={font}>{font}</option>
          {/each}
        </select>
        <span>Font (Group 2)</span>
        <select class="sm:col-span-2" bind:value={fontTwo} data-testid="theme-font-two">
          {#each fontChoicesTwo as font (font)}
            <option value={font}>{font}</option>
          {/each}
        </select>
      {/if}
      <label class="flex items-center gap-2 sm:col-span-3" data-testid="theme-include-size">
        <input type="checkbox" bind:checked={includeSize} />
        Include font size
      </label>
      {#if includeSize}
        <span>Font size</span>
        <input
          class="sm:col-span-2"
          type="number"
          min="1"
          step="1"
          bind:value={size}
          data-testid="theme-font-size"
        />
      {/if}
      <input
        class="sm:col-span-2"
        type="text"
        placeholder="Theme Name"
        bind:value={themeName}
        bind:this={themeNameElm}
      />
      <button
        class="flex justify-center items-center rounded-md border-2 border-gray-400 p-2 text-lg"
        style={themeStyle}
      >
        ぁあ
        <Ripple />
      </button>
    </div>
    <div class="flex mt-4" />
  </div>
  <div class="mt-2 flex grow justify-between" slot="footer">
    <button class={buttonClasses} on:click={() => dispatch('close')}>
      Cancel
      <Ripple />
    </button>
    <button class={buttonClasses} on:click={handleSave}>
      Save
      <Ripple />
    </button>
  </div>
</DialogTemplate>
