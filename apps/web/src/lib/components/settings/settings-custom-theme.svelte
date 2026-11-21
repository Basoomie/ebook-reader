<script lang="ts">
  /**
   * New or edit a custom reader theme: sections Start from, Colours, Font, Name, and
   * "Save theme" in the footer. ✕, Esc or a click outside cancel, asking first when
   * something was changed (modal.svelte).
   */
  import type { ToggleOption } from '$lib/components/button-toggle-group/toggle-option';
  import Modal from '$lib/components/modal/modal.svelte';
  import ModalSection from '$lib/components/modal/modal-section.svelte';
  import SettingSwitch from '$lib/components/settings/setting-switch.svelte';
  import SettingsCustomThemeInput from '$lib/components/settings/settings-custom-theme-input.svelte';
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

  const id = `custom-theme-${Math.random().toString(36).slice(2, 10)}`;
  const editing = !!selectedTheme && !!$customThemes$[selectedTheme];

  let themeToCopy = existingThemes[0].id;
  let themeName = '';
  let themeNameElm: HTMLInputElement;

  // WP10d: a theme may carry a font and a size, applied when it becomes the active theme.
  let includeFont = false;
  let fontOne = $fontFamilyGroupOne$;
  let fontTwo = $fontFamilyGroupTwo$;
  let includeSize = false;
  let size = $fontSize$;

  // Custom fonts: the server-synced ones (WP13).
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

  /** What the form holds, to tell whether anything was changed since it opened. */
  function snapshot() {
    return JSON.stringify([
      customTheme,
      themeName,
      includeFont,
      fontOne,
      fontTwo,
      includeSize,
      size
    ]);
  }

  let initial = '';
  let saved = false;
  $: dirty =
    !saved &&
    !!initial &&
    initial !==
      JSON.stringify([customTheme, themeName, includeFont, fontOne, fontTwo, includeSize, size]);

  $: themeStyle = `color: ${customTheme.fontColor.rgbaExpression}; background-color: ${customTheme.backgroundColor.rgbaExpression}`;

  onMount(() => {
    const existingThemeObject = $customThemes$[selectedTheme];

    if (!existingThemeObject) {
      initial = snapshot();
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
    initial = snapshot();
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
    saved = true;
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

<Modal
  title={editing ? 'Edit theme' : 'New theme'}
  subtitle={editing ? selectedTheme : ''}
  size="md"
  {dirty}
  testid="custom-theme-dialog"
  on:close={() => dispatch('close')}
>
  <ModalSection title="Start from" hint="Copy the colours of a theme, then change them below.">
    <div class="flex flex-wrap gap-2">
      <select
        class="c-input min-w-0 flex-1 pr-10"
        aria-label="Theme to copy"
        bind:value={themeToCopy}
      >
        {#each existingThemes as theme (theme.id)}
          <option value={theme.id}>
            {theme.id}
          </option>
        {/each}
      </select>
      <button type="button" class="c-btn c-btn-secondary" on:click={handleCopyTheme}>
        Copy colours
      </button>
    </div>
  </ModalSection>

  <ModalSection title="Colours">
    <div class="grid grid-cols-[minmax(0,1fr)_3.5rem_4.5rem] items-center gap-x-3 gap-y-2">
      <span />
      <span class="text-xs text-c-muted">Colour</span>
      <span class="text-xs text-c-muted">Opacity</span>
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
    </div>
  </ModalSection>

  <ModalSection title="Font" hint="Applied when you switch to this theme.">
    <div>
      <div class="c-modal-row">
        <div class="c-modal-row-main c-modal-row-title" id="{id}-font">Include a font</div>
        <SettingSwitch
          bind:checked={includeFont}
          labelledby="{id}-font"
          testid="theme-include-font"
        />
      </div>
      {#if includeFont}
        <div class="grid gap-2 pb-3 sm:grid-cols-2">
          <label class="c-modal-field">
            <span class="c-modal-label">Font (Group 1)</span>
            <select class="c-input w-full pr-10" bind:value={fontOne} data-testid="theme-font-one">
              {#each fontChoicesOne as font (font)}
                <option value={font}>{font}</option>
              {/each}
            </select>
          </label>
          <label class="c-modal-field">
            <span class="c-modal-label">Font (Group 2)</span>
            <select class="c-input w-full pr-10" bind:value={fontTwo} data-testid="theme-font-two">
              {#each fontChoicesTwo as font (font)}
                <option value={font}>{font}</option>
              {/each}
            </select>
          </label>
        </div>
      {/if}
      <div class="c-modal-row">
        <div class="c-modal-row-main c-modal-row-title" id="{id}-size">Include a font size</div>
        <SettingSwitch
          bind:checked={includeSize}
          labelledby="{id}-size"
          testid="theme-include-size"
        />
      </div>
      {#if includeSize}
        <label class="c-modal-field pb-1">
          <span class="c-modal-label">Font size</span>
          <input
            class="c-input w-32"
            type="number"
            min="1"
            step="1"
            bind:value={size}
            data-testid="theme-font-size"
          />
        </label>
      {/if}
    </div>
  </ModalSection>

  <ModalSection title="Name">
    <div class="flex flex-wrap items-center gap-2">
      <input
        class="c-input min-w-[12rem] flex-1"
        type="text"
        aria-label="Theme name"
        placeholder="Theme name"
        bind:value={themeName}
        bind:this={themeNameElm}
      />
      <span
        class="flex h-12 w-20 items-center justify-center rounded-lg border border-c-strong text-lg"
        style={themeStyle}
        aria-label="Preview"
        title="Preview"
      >
        ぁあ
      </span>
    </div>
  </ModalSection>

  <svelte:fragment slot="footer">
    <button type="button" class="c-btn c-btn-primary" on:click={handleSave}>Save theme</button>
  </svelte:fragment>
</Modal>
