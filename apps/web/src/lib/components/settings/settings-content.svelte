<script lang="ts">
  import { browser } from '$app/environment';
  import { faSpinner } from '@fortawesome/free-solid-svg-icons';
  import {
    TrackerAutoPause,
    TrackerSkipThresholdAction
  } from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker';
  import { pagePath } from '$lib/data/env';
  import { appOpenTarget$, type AppOpenTarget } from '$lib/home/settings';
  import type { ToggleOption } from '$lib/components/button-toggle-group/toggle-option';
  import { WEEKDAY_NAMES } from '$lib/stats/periods';
  import { ON_TRACK_RULES } from '$lib/stats/on-track';
  import SettingsCustomTheme from '$lib/components/settings/settings-custom-theme.svelte';
  import SettingsFontSelector from '$lib/components/settings/settings-font-selector.svelte';
  import {
    bottomBarTimeLeft$,
    onTrackDot$,
    onTrackDotRule$,
    pacerEinkStep$,
    pacerIdleMinutes$,
    pacerLookupResume$,
    pacerTextlessPageSeconds$,
    speedGoalMinMinutes$,
    timeLeftMinMinutes$,
    timeLeftRecentMinutes$
  } from '$lib/data/store';
  import SettingsGroup from '$lib/components/settings/settings-group.svelte';
  import SettingRow from '$lib/components/settings/setting-row.svelte';
  import SettingSwitch from '$lib/components/settings/setting-switch.svelte';
  import SettingChoice from '$lib/components/settings/setting-choice.svelte';
  import SettingField from '$lib/components/settings/setting-field.svelte';
  import ThemePicker from '$lib/components/settings/theme-picker.svelte';
  import AnkiSettings from '$lib/components/anki/anki-settings.svelte';
  import SettingsServerFontsDialog from '$lib/components/settings/settings-server-fonts-dialog.svelte';
  import SettingsExportData from '$lib/components/settings/settings-export-data.svelte';
  import SettingsCopyDevice from '$lib/components/settings/settings-copy-device.svelte';
  import LibraryConnectionSettings from '$lib/components/library/library-connection-settings.svelte';
  import AudiobooksPanel from '$lib/components/audio/audiobooks-panel.svelte';
  import DiagnosticsPanel from '$lib/components/settings/diagnostics-panel.svelte';
  import NotificationsPanel from '$lib/components/settings/notifications-panel.svelte';
  import { NOT_OVER_HTTP } from '$lib/diagnostics/diagnostics-text';
  import { canPersistStorage } from '$lib/functions/secure-context';
  import {
    bookIllustrationsPosition$,
    libraryBulkDownloadMode$,
    libraryDownloadConfirmGb$,
    libraryLook$
  } from '$lib/library/settings';
  import {
    readAloudAheadSeconds$,
    readAloudBottomBarButton$,
    readAloudLookupResume$
  } from '$lib/read-aloud/settings';
  import { customFontNames$ } from '$lib/fonts/server-fonts-browser';
  import { BlurMode } from '$lib/data/blur-mode';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { deleteThemeCopy } from '$lib/confirm/confirm-copy';
  import { LocalFont } from '$lib/data/fonts';
  import type { FuriganaStyle } from '$lib/data/furigana-style';
  import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
  import {
    customThemes$,
    darkTheme$,
    einkMode$,
    followSystemTheme$,
    lightTheme$,
    horizontalCustomReadingPosition$,
    textMarginMode$,
    textMarginValue$,
    theme$,
    verticalCustomReadingPosition$
  } from '$lib/data/store';
  import type { TextMarginMode } from '$lib/data/text-margin-mode';
  import { availableThemes as availableThemesMap } from '$lib/data/theme-option';
  import type { VerticalTextOrientation } from '$lib/data/vertical-text-orientation';
  import type { ViewMode } from '$lib/data/view-mode';
  import type { WritingMode } from '$lib/data/writing-mode';
  import { secondsToMinutes } from '$lib/functions/statistic-util';
  import Fa from 'svelte-fa';
  import { onDestroy } from 'svelte';

  /**
   * The Settings page's tabs. Reader, Data and Statistics are drawn here, in named sections
   * (settings-group.svelte) of rows (setting-row.svelte) whose words come from the settings
   * catalog (lib/settings/settings-catalog.ts, also used by Search settings). The other
   * tabs are panels of their own. A setting that depends on another sits indented under
   * it and shows while that one is on; a setting for one reading mode is always listed,
   * with a tag (Pages mode only, Vertical text only…).
   */

  // Text fields and selects ("Archive" look); number fields are framed by SettingField.
  const textField = 'c-input block w-full sm:w-72';

  // Season 2 pacer
  const optionsForPacerStep = [
    { id: 'sentence', text: 'Sentence' },
    { id: 'line', text: 'Line' }
  ];

  /**
   * A whole number of at least 0 from a number field, else the default. The field shows the
   * value kept (it isn't redrawn when the stored value stays the same).
   */
  function nonNegative(event: Event, fallback: number) {
    const input = event.target as HTMLInputElement;
    const value = Number(input.value);
    const kept =
      input.value !== '' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
    input.value = String(kept);
    return kept;
  }

  export let selectedTheme: string;

  export let viewMode: ViewMode;

  export let fontFamilyGroupOne: string;

  export let fontFamilyGroupTwo: string;

  export let textMarginValue: number;

  export let blurImage: boolean;

  export let blurImageMode: string;

  // The Aa panel inside a book sets furigana; kept for the page's bindings.
  export let furiganaStyle: FuriganaStyle;

  export let writingMode: WritingMode;

  export let enableFontKerning: boolean;

  export let enableFontVPAL: boolean;

  export let verticalTextOrientation: VerticalTextOrientation;

  export let prioritizeReaderStyles: boolean;

  export let enableTextJustification: boolean;

  export let enableTextWrapPretty: boolean;

  export let textMarginMode: TextMarginMode;

  export let enableReaderWakeLock: boolean;

  export let showCharacterCounter: boolean;

  export let showPercentage: boolean;

  export let showFooterChapterCharacterCounter: boolean;

  export let showFooterChapterPercentage: boolean;

  export let swipeThreshold: number;

  export let disableWheelNavigation: boolean;

  export let autoPositionOnResize: boolean;

  export let avoidPageBreak: boolean;

  export let pauseTrackerOnCustomPointChange: boolean;

  export let customReadingPointEnabled: boolean;

  export let selectionToBookmarkEnabled: boolean;

  export let enableTapEdgeToFlip: boolean;

  export let pageColumns: number;

  export let storageQuota: string;

  // Persistent storage and its figures exist only in a secure context (https). The
  // prerendered page keeps the toggle; the browser then shows the note on plain http.
  const storageAvailable = !browser || canPersistStorage();

  export let persistentStorage: boolean;

  export let confirmClose: boolean;

  export let manualBookmark: boolean;

  export let autoBookmark: boolean;

  export let autoBookmarkTime: number;

  export let positionPromptEnabled: boolean;

  export let mouseDragPageTurn: boolean;

  export let mouseDragThreshold: number;

  export let jumpHistoryLimit: number;
  export let highlightRefindChars: number;
  export let highlightBarAnySelection: boolean;
  export let showReturnMarker: boolean;

  export let positionPromptMinChars: number;

  export let readingStatusSettleSeconds: number;

  export let activeSettings: string;

  export let importHTMLFixMode: string;

  export let restrictImportFixToAnchor: boolean;

  export let startDayHoursForTracker: number;

  /** WP12: first day of a stats week (global). */
  export let statsWeekStart: number;

  export let statisticsEnabled: boolean;

  export let trackerAutoPause: string;

  export let openTrackerOnCompletion: boolean;

  export let addCharactersOnCompletion: boolean;

  export let trackerAutoStartTime: number;

  export let trackerIdleTime: number;

  export let trackerLongPressTime: number;

  export let trackerForwardSkipThreshold: number;

  export let trackerBackwardSkipThreshold: number;

  export let trackerSkipThresholdAction: string;

  export let trackerPopupDetection: boolean;

  export let adjustStatisticsAfterIdleTime: boolean;

  $: availableThemes = (
    browser
      ? [...Array.from(availableThemesMap.entries()), ...Object.entries($customThemes$)]
      : Array.from(availableThemesMap.entries())
  ).map(([theme, option]) => ({
    theme,
    option
  }));

  $: optionsForTheme = availableThemes.map(({ theme, option }) => ({
    id: theme,
    text: 'ぁあ',
    style: {
      color: option.fontColor,
      'background-color': option.backgroundColor
    },
    thickBorders: true,
    showIcons: true
  }));

  onDestroy(() => dialogManager.dialogs$.next([]));

  function openThemeEditor(selected?: string) {
    dialogManager.dialogs$.next([
      {
        component: SettingsCustomTheme,
        props: selected
          ? { selectedTheme: selected, existingThemes: optionsForTheme }
          : { existingThemes: optionsForTheme }
      }
    ]);
  }

  async function deleteTheme(themeId: string) {
    // WP19: custom themes are shared settings, so deleting one reaches every device.
    const confirmed = await confirmDestructive({
      ...deleteThemeCopy(themeId),
      testid: 'theme-delete-confirm',
      confirmTestid: 'theme-delete-confirm-button'
    });
    if (!confirmed) return;

    $theme$ = optionsForTheme[optionsForTheme.length - 2]?.id || 'light-theme';

    // WP10d: a deleted theme can't stay the light or dark choice.
    if ($lightTheme$ === themeId) {
      $lightTheme$ = '';
    }

    if ($darkTheme$ === themeId) {
      $darkTheme$ = '';
    }

    delete $customThemes$[themeId];
    $customThemes$ = { ...$customThemes$ };
  }

  const optionsForTimeLeft: ToggleOption<'off' | 'chapter' | 'book' | 'both'>[] = [
    { id: 'off', text: 'Off' },
    { id: 'chapter', text: 'Chapter' },
    { id: 'book', text: 'Book' },
    { id: 'both', text: 'Both' }
  ];

  const optionsForOnTrackRule: ToggleOption<'pace' | 'share'>[] = ON_TRACK_RULES.map((r) => ({
    id: r.rule,
    text: r.label
  }));

  const optionsForAppOpen: ToggleOption<AppOpenTarget>[] = [
    { id: 'last-book', text: 'Last book' },
    { id: 'home', text: 'Home' }
  ];

  // WP19b: light or dark for Home, Library, Collections, Notes and Stats.
  const optionsForLibraryLook: ToggleOption<string>[] = [
    { id: 'auto', text: 'Like the book' },
    { id: 'light', text: 'Light' },
    { id: 'dark', text: 'Dark' }
  ];

  // Season 2 §6: where the book page shows the book's illustrations.
  const optionsForIllustrationsPosition: ToggleOption<string>[] = [
    { id: 'description', text: 'Under the description' },
    { id: 'cover', text: 'Under the cover' }
  ];

  const optionsForVerticalTextOrientation: ToggleOption<VerticalTextOrientation>[] = [
    {
      id: 'mixed',
      text: 'Sideways'
    },
    {
      id: 'upright',
      text: 'Upright'
    }
  ];

  const optionsForTextMarginMode: ToggleOption<TextMarginMode>[] = [
    {
      id: 'auto',
      text: 'Auto'
    },
    {
      id: 'manual',
      text: 'Manual'
    }
  ];

  const optionsForBlurMode: ToggleOption<BlurMode>[] = [
    {
      id: BlurMode.ALL,
      text: 'All'
    },
    {
      id: BlurMode.AFTER_TOC,
      text: 'After the contents'
    }
  ];

  const optionsForImportHTMLFixes: ToggleOption<ImportHTMLFixMode>[] = [
    {
      id: ImportHTMLFixMode.OFF,
      text: 'Off'
    },
    {
      id: ImportHTMLFixMode.STANDARD,
      text: 'Standard'
    },
    {
      id: ImportHTMLFixMode.EXTENDED,
      text: 'Extended'
    }
  ];

  const optionsForTrackerAutoPause: ToggleOption<TrackerAutoPause>[] = [
    {
      id: TrackerAutoPause.OFF,
      text: 'Off'
    },
    {
      id: TrackerAutoPause.MODERATE,
      text: 'Moderate'
    },
    {
      id: TrackerAutoPause.STRICT,
      text: 'Strict'
    }
  ];

  const optionsForTrackerSkipThresholdAction: ToggleOption<TrackerSkipThresholdAction>[] = [
    {
      id: TrackerSkipThresholdAction.IGNORE,
      text: 'Ignore'
    },
    {
      id: TrackerSkipThresholdAction.PAUSE,
      text: 'Pause the tracker'
    }
  ];

  let showSpinner = false;
  let importHTMLFixModeTooltip = '';
  let trackerAutoPauseTooltip = '';

  $: if ($textMarginMode$ === 'auto') {
    $textMarginValue$ = 0;
  }

  $: verticalTextOrientationTooltip =
    verticalTextOrientation === 'mixed'
      ? 'Sideways: they are turned 90° clockwise and run with the line.'
      : 'Upright: they stand up like Japanese characters.';
  $: wakeLockSupported = browser && 'wakeLock' in navigator;
  // Settings for one reading mode (pages or scrolling, vertical or horizontal text) are
  // always listed with a tag; they apply when a book is read that way. writingMode and
  // viewMode stay bound for the page.
  $: void writingMode;
  $: void viewMode;
  $: void furiganaStyle;
  $: persistentStorageTooltip = persistentStorage
    ? 'On: the browser keeps this device’s books and data even when space runs low.'
    : 'Off: the browser may clear this device’s books and data when space runs low. Turning it on may need the bookmark or notification permission.';
  $: switch (importHTMLFixMode) {
    case ImportHTMLFixMode.OFF:
      importHTMLFixModeTooltip = 'Imports EPUB files as they are.';
      break;
    case ImportHTMLFixMode.EXTENDED:
      importHTMLFixModeTooltip =
        'Standard fixes, plus removing control characters, replacing HTML entities and so on.';
      break;
    default:
      importHTMLFixModeTooltip =
        'Fixes common mistakes in EPUB files, such as wrongly self-closed elements.';
      break;
  }
  $: startOfDayHours = `${`${startDayHoursForTracker}`.padStart(2, '0')}:00`;

  $: trackerIdleTimeInMin = secondsToMinutes(trackerIdleTime);

  $: switch (trackerAutoPause) {
    case TrackerAutoPause.OFF:
      trackerAutoPauseTooltip =
        'Off: pauses only for some reader events, such as leaving the book.';
      break;
    case TrackerAutoPause.STRICT:
      trackerAutoPauseTooltip =
        'Strict: also pauses when the page loses focus in any way, a dictionary popup included.';
      break;
    default:
      trackerAutoPauseTooltip = 'Moderate: also pauses when the reader tab loses focus.';
      break;
  }
  $: onTrackRuleTooltip =
    $onTrackDotRule$ === 'share'
      ? 'Today’s share: on track when today’s reading covers what is left of the goal divided by the days left, today included. A daily goal is on track only once it is met.'
      : 'Even pace: on track when you have read at least your share of the goal for the days so far, today included; reading ahead counts. A daily goal is on track only once it is met.';
  $: timeLeftUnit = (n: number) => (n === 1 ? 'minute' : 'minutes');
</script>

<div class="flex flex-col gap-10">
  {#if activeSettings === 'Reader'}
    <p class="s-callout" data-testid="settings-appearance-note">
      Font size, line height, page margins, writing direction, pages or scrolling and furigana are
      set inside a book: open the menu at the top and tap Aa. They apply at once. The settings here
      are saved on this device, except those marked All devices.
    </p>

    <SettingsGroup id="reader-theme">
      {#if !$followSystemTheme$}
        <SettingRow id="theme" layout="stack" let:labelId>
          <ThemePicker
            options={optionsForTheme}
            bind:value={selectedTheme}
            labelledby={labelId}
            allowNew={browser}
            testid="settings-theme"
            on:new={() => openThemeEditor()}
            on:edit={({ detail }) => openThemeEditor(detail)}
            on:delete={({ detail }) => deleteTheme(detail)}
          />
        </SettingRow>
      {/if}
      <SettingRow id="follow-system" layout="inline" let:labelId>
        <SettingSwitch bind:checked={$followSystemTheme$} labelledby={labelId} />
      </SettingRow>
      {#if $followSystemTheme$}
        <!-- WP10d: while following the system, pick a theme for each mode. -->
        <SettingRow id="light-theme" layout="stack" child let:labelId>
          <ThemePicker
            options={optionsForTheme}
            bind:value={$lightTheme$}
            labelledby={labelId}
            allowNew={browser}
            on:new={() => openThemeEditor()}
            on:edit={({ detail }) => openThemeEditor(detail)}
            on:delete={({ detail }) => deleteTheme(detail)}
          />
        </SettingRow>
        <SettingRow id="dark-theme" layout="stack" child let:labelId>
          <ThemePicker
            options={optionsForTheme}
            bind:value={$darkTheme$}
            labelledby={labelId}
            on:edit={({ detail }) => openThemeEditor(detail)}
            on:delete={({ detail }) => deleteTheme(detail)}
          />
        </SettingRow>
      {/if}
      <SettingRow id="eink" layout="inline" let:labelId>
        <svelte:fragment slot="description">
          {#if $einkMode$}
            <p class="mt-1 text-sm font-medium">
              E-ink is on: the book is shown black on white whatever the theme.
            </p>
          {/if}
        </svelte:fragment>
        <SettingSwitch bind:checked={$einkMode$} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="library-look" let:labelId>
        <SettingChoice
          options={optionsForLibraryLook}
          bind:value={$libraryLook$}
          labelledby={labelId}
        />
      </SettingRow>
      {#if wakeLockSupported}
        <SettingRow id="wake-lock" layout="inline" let:labelId>
          <SettingSwitch bind:checked={enableReaderWakeLock} labelledby={labelId} />
        </SettingRow>
      {/if}
    </SettingsGroup>

    <SettingsGroup id="reader-fonts">
      <SettingRow id="font-main" let:labelId>
        <div class="flex items-center gap-1">
          <input
            type="text"
            class={textField}
            placeholder="Noto Serif JP"
            aria-labelledby={labelId}
            bind:value={fontFamilyGroupOne}
          />
          <SettingsFontSelector
            availableFonts={[
              LocalFont.NOTOSERIFJP,
              LocalFont.KZUDMINCHO,
              LocalFont.GENEI,
              LocalFont.SHIPPORIMINCHO,
              LocalFont.KLEEONE,
              LocalFont.KLEEONESEMIBOLD,
              LocalFont.SERIF,
              ...$customFontNames$
            ]}
            bind:fontValue={fontFamilyGroupOne}
          />
        </div>
      </SettingRow>
      <SettingRow id="font-sans" let:labelId>
        <div class="flex items-center gap-1">
          <input
            type="text"
            class={textField}
            placeholder="Noto Sans JP"
            aria-labelledby={labelId}
            bind:value={fontFamilyGroupTwo}
          />
          <SettingsFontSelector
            availableFonts={[
              LocalFont.NOTOSANSJP,
              LocalFont.KZUDGOTHIC,
              LocalFont.SANSSERIF,
              ...$customFontNames$
            ]}
            bind:fontValue={fontFamilyGroupTwo}
          />
        </div>
      </SettingRow>
      <SettingRow id="custom-fonts" layout="inline">
        {#if browser}
          <button
            class="c-btn c-btn-secondary"
            data-testid="open-server-fonts"
            on:click={() => dialogManager.dialogs$.next([{ component: SettingsServerFontsDialog }])}
          >
            Manage fonts
          </button>
        {/if}
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="reader-text">
      <SettingRow id="justify" layout="inline" let:labelId>
        <SettingSwitch bind:checked={enableTextJustification} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="pretty-wrap" layout="inline" let:labelId>
        <SettingSwitch bind:checked={enableTextWrapPretty} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="prioritize-styles" layout="inline" let:labelId>
        <SettingSwitch bind:checked={prioritizeReaderStyles} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="paragraph-spacing" let:labelId>
        <SettingChoice
          options={optionsForTextMarginMode}
          bind:value={textMarginMode}
          labelledby={labelId}
        />
      </SettingRow>
      {#if textMarginMode === 'manual'}
        <SettingRow id="paragraph-margins" child let:labelId>
          <SettingField unit="rem">
            <input
              type="number"
              step=".5"
              min="0"
              aria-labelledby={labelId}
              bind:value={textMarginValue}
              on:blur={() => {
                const newValue = Number.parseFloat(`${textMarginValue ?? 0}`);

                if (isNaN(newValue) || newValue < 1) {
                  textMarginValue = 0;
                }
              }}
            />
          </SettingField>
        </SettingRow>
      {/if}
      <SettingRow id="page-columns" tags={['pages', 'horizontal']} let:labelId>
        <SettingField unit="columns">
          <input
            type="number"
            step="1"
            min="0"
            aria-labelledby={labelId}
            bind:value={pageColumns}
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="avoid-page-break" layout="inline" tags={['pages']} let:labelId>
        <SettingSwitch bind:checked={avoidPageBreak} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="font-kerning" layout="inline" tags={['vertical']} let:labelId>
        <SettingSwitch bind:checked={enableFontKerning} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="font-vpal" layout="inline" tags={['vertical']} let:labelId>
        <SettingSwitch bind:checked={enableFontVPAL} labelledby={labelId} />
      </SettingRow>
      <SettingRow
        id="text-orientation"
        tags={['vertical']}
        description={verticalTextOrientationTooltip}
        let:labelId
      >
        <SettingChoice
          options={optionsForVerticalTextOrientation}
          bind:value={verticalTextOrientation}
          labelledby={labelId}
        />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="reader-pages">
      <SettingRow id="tap-to-flip" layout="inline" tags={['pages']} let:labelId>
        <SettingSwitch bind:checked={enableTapEdgeToFlip} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="swipe-threshold" let:labelId>
        <SettingField unit="px">
          <input
            type="number"
            step="1"
            min="10"
            aria-labelledby={labelId}
            bind:value={swipeThreshold}
            on:blur={() => {
              if (swipeThreshold < 10 || typeof swipeThreshold !== 'number') {
                swipeThreshold = 10;
              }
            }}
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="mouse-drag" layout="inline" let:labelId>
        <SettingSwitch bind:checked={mouseDragPageTurn} labelledby={labelId} />
      </SettingRow>
      {#if mouseDragPageTurn}
        <SettingRow id="mouse-drag-distance" child let:labelId>
          <SettingField unit="px">
            <input
              type="number"
              step="1"
              min="10"
              aria-labelledby={labelId}
              bind:value={mouseDragThreshold}
              on:blur={() => {
                if (mouseDragThreshold < 10 || typeof mouseDragThreshold !== 'number') {
                  mouseDragThreshold = 80;
                }
              }}
            />
          </SettingField>
        </SettingRow>
      {/if}
      <!-- Shown the other way round: the stored setting is "Disable wheel navigation". -->
      <SettingRow id="mouse-wheel" layout="inline" let:labelId>
        <SettingSwitch
          checked={!disableWheelNavigation}
          labelledby={labelId}
          on:change={({ detail }) => (disableWheelNavigation = !detail)}
        />
      </SettingRow>
      <SettingRow id="auto-position" layout="inline" tags={['scroll']} let:labelId>
        <SettingSwitch bind:checked={autoPositionOnResize} labelledby={labelId} />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="reader-bar">
      <SettingRow id="show-chars" layout="inline" let:labelId>
        <SettingSwitch bind:checked={showCharacterCounter} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="show-percent" layout="inline" let:labelId>
        <SettingSwitch bind:checked={showPercentage} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="show-chapter-chars" layout="inline" let:labelId>
        <SettingSwitch bind:checked={showFooterChapterCharacterCounter} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="show-chapter-percent" layout="inline" let:labelId>
        <SettingSwitch bind:checked={showFooterChapterPercentage} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="return-marker" layout="inline" let:labelId>
        <SettingSwitch bind:checked={showReturnMarker} labelledby={labelId} />
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="reader-place">
      <SettingRow id="auto-save" layout="inline" let:labelId>
        <SettingSwitch bind:checked={autoBookmark} labelledby={labelId} />
      </SettingRow>
      {#if autoBookmark}
        <SettingRow id="auto-save-time" child let:labelId>
          <SettingField unit="seconds">
            <input
              type="number"
              step="1"
              min="1"
              aria-labelledby={labelId}
              bind:value={autoBookmarkTime}
              on:blur={() => {
                if (autoBookmarkTime < 1 || typeof autoBookmarkTime !== 'number') {
                  autoBookmarkTime = 3;
                }
              }}
            />
          </SettingField>
        </SettingRow>
      {/if}
      <SettingRow id="manual-save" layout="inline" let:labelId>
        <SettingSwitch bind:checked={manualBookmark} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="selection-place" layout="inline" tags={['pages']} let:labelId>
        <SettingSwitch bind:checked={selectionToBookmarkEnabled} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="custom-point" layout="inline" tags={['scroll']} let:labelId>
        <SettingSwitch bind:checked={customReadingPointEnabled} labelledby={labelId} />
      </SettingRow>
      {#if customReadingPointEnabled}
        <SettingRow id="reset-point" child layout="inline">
          <button
            type="button"
            class="c-btn c-btn-secondary"
            on:click={() => {
              verticalCustomReadingPosition$.next(100);
              horizontalCustomReadingPosition$.next(0);
            }}
          >
            Reset the line
          </button>
        </SettingRow>
      {/if}
      <SettingRow id="confirm-close" layout="inline" let:labelId>
        <SettingSwitch bind:checked={confirmClose} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="jump-history" let:labelId>
        <SettingField unit="places">
          <input
            type="number"
            step="1"
            min="1"
            aria-labelledby={labelId}
            bind:value={jumpHistoryLimit}
            on:blur={() => {
              if (jumpHistoryLimit < 1 || typeof jumpHistoryLimit !== 'number') {
                jumpHistoryLimit = 50;
              }
            }}
          />
        </SettingField>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="reader-opening">
      <SettingRow id="app-open" let:labelId>
        <SettingChoice
          options={optionsForAppOpen}
          bind:value={$appOpenTarget$}
          labelledby={labelId}
        />
      </SettingRow>
      <SettingRow id="continue-prompt" layout="inline" let:labelId>
        <SettingSwitch bind:checked={positionPromptEnabled} labelledby={labelId} />
      </SettingRow>
      {#if positionPromptEnabled}
        <SettingRow id="continue-chars" child let:labelId>
          <SettingField unit="characters">
            <input
              type="number"
              step="1"
              min="0"
              aria-labelledby={labelId}
              bind:value={positionPromptMinChars}
              on:blur={() => {
                if (positionPromptMinChars < 0 || typeof positionPromptMinChars !== 'number') {
                  positionPromptMinChars = 500;
                }
              }}
            />
          </SettingField>
        </SettingRow>
      {/if}
      <SettingRow id="settle-time" let:labelId>
        <SettingField unit="seconds">
          <input
            type="number"
            step="1"
            min="0"
            aria-labelledby={labelId}
            bind:value={readingStatusSettleSeconds}
            on:blur={() => {
              if (
                readingStatusSettleSeconds < 0 ||
                typeof readingStatusSettleSeconds !== 'number'
              ) {
                readingStatusSettleSeconds = 3;
              }
            }}
          />
        </SettingField>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="reader-highlights">
      <SettingRow id="highlight-bar-any" layout="inline" let:labelId>
        <SettingSwitch bind:checked={highlightBarAnySelection} labelledby={labelId} />
      </SettingRow>
      <SettingRow id="highlight-refind" let:labelId>
        <SettingField unit="characters">
          <input
            type="number"
            step="100"
            min="0"
            aria-labelledby={labelId}
            bind:value={highlightRefindChars}
            on:blur={() => {
              if (highlightRefindChars < 0 || typeof highlightRefindChars !== 'number') {
                highlightRefindChars = 2000;
              }
            }}
          />
        </SettingField>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="reader-images">
      <SettingRow id="blur-images" layout="inline" let:labelId>
        <SettingSwitch bind:checked={blurImage} labelledby={labelId} />
      </SettingRow>
      {#if blurImage}
        <SettingRow id="blur-mode" child let:labelId>
          <SettingChoice
            options={optionsForBlurMode}
            bind:value={blurImageMode}
            labelledby={labelId}
          />
        </SettingRow>
      {/if}
      <SettingRow id="illustrations-position" let:labelId>
        <SettingChoice
          options={optionsForIllustrationsPosition}
          bind:value={$bookIllustrationsPosition$}
          labelledby={labelId}
        />
      </SettingRow>
    </SettingsGroup>

    <!-- Season 2 pacer: the rarely changed settings (mode and speed are in the reader). -->
    <SettingsGroup id="reader-pacer">
      <SettingRow id="pacer-eink-step" let:labelId>
        <SettingChoice
          options={optionsForPacerStep}
          bind:value={$pacerEinkStep$}
          labelledby={labelId}
          testid="settings-pacer-eink-step"
        />
      </SettingRow>
      <SettingRow id="pacer-lookup-resume" let:labelId>
        <SettingField unit="seconds">
          <input
            type="number"
            step="1"
            min="0"
            aria-labelledby={labelId}
            data-testid="settings-pacer-lookup-resume"
            value={$pacerLookupResume$}
            on:change={(e) => pacerLookupResume$.next(nonNegative(e, 1))}
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="pacer-idle" let:labelId>
        <SettingField unit="minutes">
          <input
            type="number"
            step="1"
            min="0"
            aria-labelledby={labelId}
            data-testid="settings-pacer-idle"
            value={$pacerIdleMinutes$}
            on:change={(e) => pacerIdleMinutes$.next(nonNegative(e, 0))}
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="pacer-textless" let:labelId>
        <SettingField unit="seconds">
          <input
            type="number"
            step="1"
            min="0"
            aria-labelledby={labelId}
            data-testid="settings-pacer-textless"
            value={$pacerTextlessPageSeconds$}
            on:change={(e) => pacerTextlessPageSeconds$.next(nonNegative(e, 3))}
          />
        </SettingField>
      </SettingRow>
    </SettingsGroup>

    <!-- Season 2 Phase 12 session 3: read-aloud's rarely changed settings (play and speed are in the reader). -->
    <SettingsGroup id="reader-readaloud">
      <SettingRow id="read-aloud-button" layout="inline" let:labelId>
        <SettingSwitch
          bind:checked={$readAloudBottomBarButton$}
          labelledby={labelId}
          testid="settings-read-aloud-button"
        />
      </SettingRow>
      <SettingRow id="read-aloud-ahead" let:labelId>
        <SettingField unit="seconds">
          <input
            type="number"
            step="10"
            min="10"
            aria-labelledby={labelId}
            data-testid="settings-read-aloud-ahead"
            value={$readAloudAheadSeconds$}
            on:change={(e) => readAloudAheadSeconds$.next(Math.max(10, nonNegative(e, 60)))}
          />
        </SettingField>
      </SettingRow>
      <SettingRow id="read-aloud-lookup-resume" let:labelId>
        <SettingField unit="seconds">
          <input
            type="number"
            step="1"
            min="0"
            aria-labelledby={labelId}
            data-testid="settings-read-aloud-lookup-resume"
            value={$readAloudLookupResume$}
            on:change={(e) => readAloudLookupResume$.next(nonNegative(e, 1))}
          />
        </SettingField>
      </SettingRow>
    </SettingsGroup>
  {:else if activeSettings === 'Data'}
    <!-- The library server and record sync (two sections), this device, importing, tools. -->
    {#if browser}
      <LibraryConnectionSettings />
    {/if}
    <SettingsGroup id="data-device" testid="settings-section-device">
      <SettingRow id="copy-device" layout="stack">
        {#if browser}
          <SettingsCopyDevice />
        {/if}
      </SettingRow>
      <SettingRow id="export-data" layout="inline">
        {#if browser}
          <SettingsExportData />
        {/if}
      </SettingRow>
      {#if storageAvailable}
        <SettingRow
          id="persistent-storage"
          layout="inline"
          description={persistentStorageTooltip}
          let:labelId
        >
          <svelte:fragment slot="description">
            {#if storageQuota}
              <p class="mt-1 text-sm text-c-muted">{storageQuota} of this device’s space.</p>
            {/if}
          </svelte:fragment>
          <SettingSwitch bind:checked={persistentStorage} labelledby={labelId} />
        </SettingRow>
      {:else}
        <SettingRow id="persistent-storage">
          <!-- Plain http: the browser has no navigator.storage (secure contexts only). -->
          <p
            slot="description"
            class="mt-1 text-sm text-c-muted"
            data-testid="persistent-storage-unavailable"
          >
            {NOT_OVER_HTTP}
          </p>
        </SettingRow>
      {/if}
    </SettingsGroup>
    <SettingsGroup id="data-downloads">
      <SettingRow id="bulk-download-mode" let:labelId>
        <SettingChoice
          options={[
            { id: 'zip', text: 'One ZIP file' },
            { id: 'files', text: 'Separate files' }
          ]}
          bind:value={$libraryBulkDownloadMode$}
          labelledby={labelId}
          testid="bulk-download-mode"
        />
      </SettingRow>
      <SettingRow id="download-confirm-size" let:labelId>
        <SettingField unit="GB">
          <input
            type="number"
            min="0"
            step="0.5"
            aria-labelledby={labelId}
            data-testid="download-confirm-size"
            bind:value={$libraryDownloadConfirmGb$}
          />
        </SettingField>
      </SettingRow>
    </SettingsGroup>
    <SettingsGroup id="data-import">
      <SettingRow id="epub-fixes" description={importHTMLFixModeTooltip} let:labelId>
        <SettingChoice
          options={optionsForImportHTMLFixes}
          bind:value={importHTMLFixMode}
          labelledby={labelId}
        />
      </SettingRow>
      {#if importHTMLFixMode !== ImportHTMLFixMode.OFF}
        <SettingRow id="restrict-links" layout="inline" child let:labelId>
          <SettingSwitch bind:checked={restrictImportFixToAnchor} labelledby={labelId} />
        </SettingRow>
      {/if}
    </SettingsGroup>
    <!-- WP15e: the old sync is removed; only the link to its migration pages stays.
         WP20a: the Calibre library cleanup has its own page, linked only from here. -->
    <SettingsGroup id="data-tools">
      <SettingRow id="migration" layout="inline" testid="settings-section-old-sync">
        <a class="c-btn c-btn-secondary" href="{pagePath}/migration" data-testid="migration-link">
          Open
        </a>
      </SettingRow>
      <SettingRow id="cleanup" layout="inline" testid="settings-section-cleanup">
        <a class="c-btn c-btn-secondary" href="{pagePath}/cleanup" data-testid="cleanup-link">
          Open
        </a>
      </SettingRow>
    </SettingsGroup>
  {:else if activeSettings === 'Anki'}
    <!-- WP14: "Enrich last Anki card" (its own tab, user 2026-11-12). -->
    <div class="flex flex-col gap-10" data-testid="settings-section-anki">
      {#if browser}
        <AnkiSettings />
      {/if}
    </div>
  {:else if activeSettings === 'Audiobooks'}
    <!-- WP15b: the server's audiobooks folder and the linked books. -->
    {#if browser}
      <AudiobooksPanel />
    {/if}
  {:else if activeSettings === 'Notifications'}
    <!-- Notifications N1: Discord and Gmail, stored on the server (it sends). -->
    {#if browser}
      <NotificationsPanel />
    {/if}
  {:else if activeSettings === 'Diagnostics'}
    <!-- Season 2 §7: read-only status of this device, the devices, the PC, the server. -->
    {#if browser}
      <DiagnosticsPanel />
    {/if}
  {:else}
    <SettingsGroup id="stats-days">
      <SettingRow id="day-start" settingKey="startDayHoursForTracker" let:labelId>
        <div class="flex w-full items-center gap-3 sm:w-72">
          <input
            type="range"
            step="1"
            min="0"
            max="23"
            class="c-range block h-12 w-full"
            aria-labelledby={labelId}
            aria-valuetext={startOfDayHours}
            data-testid="settings-day-starts-at"
            bind:value={startDayHoursForTracker}
          />
          <output class="w-14 text-right font-semibold tabular-nums">{startOfDayHours}</output>
        </div>
      </SettingRow>
      <SettingRow id="week-start" settingKey="statsWeekStart" let:labelId>
        <select
          class={textField}
          aria-labelledby={labelId}
          data-testid="settings-week-starts-on"
          bind:value={statsWeekStart}
        >
          {#each WEEKDAY_NAMES as dayName, index (dayName)}
            <option value={index}>{dayName}</option>
          {/each}
        </select>
      </SettingRow>
    </SettingsGroup>

    <SettingsGroup id="stats-tracker">
      <SettingRow id="stats-enabled" layout="inline" let:labelId>
        <SettingSwitch bind:checked={statisticsEnabled} labelledby={labelId} />
      </SettingRow>
      {#if statisticsEnabled}
        <SettingRow id="auto-pause" child description={trackerAutoPauseTooltip} let:labelId>
          <SettingChoice
            options={optionsForTrackerAutoPause}
            bind:value={trackerAutoPause}
            labelledby={labelId}
          />
        </SettingRow>
        {#if trackerAutoPause !== TrackerAutoPause.OFF}
          <SettingRow id="popup-detection" child layout="inline" let:labelId>
            <SettingSwitch bind:checked={trackerPopupDetection} labelledby={labelId} />
          </SettingRow>
        {/if}
        <SettingRow id="idle-time" child let:labelId>
          <SettingField unit="minutes">
            <input
              type="number"
              step="0.5"
              min="0"
              aria-labelledby={labelId}
              bind:value={trackerIdleTimeInMin}
              on:blur={() => {
                if (!trackerIdleTimeInMin || trackerIdleTimeInMin < 0) {
                  trackerIdleTime = 0;
                } else if (trackerIdleTimeInMin > 43200) {
                  trackerIdleTime = 900;
                } else {
                  trackerIdleTime = Math.floor(trackerIdleTimeInMin * 60);
                }
              }}
            />
          </SettingField>
        </SettingRow>
        {#if trackerIdleTime > 0}
          <SettingRow id="idle-rollback" child layout="inline" let:labelId>
            <SettingSwitch bind:checked={adjustStatisticsAfterIdleTime} labelledby={labelId} />
          </SettingRow>
        {/if}
        <SettingRow id="autostart" child let:labelId>
          <SettingField unit="seconds">
            <input
              type="number"
              step="1"
              min="0"
              aria-labelledby={labelId}
              bind:value={trackerAutoStartTime}
              on:blur={() => {
                const newValue = Number.parseFloat(`${trackerAutoStartTime ?? 0}`);

                if (isNaN(newValue) || newValue < 1) {
                  trackerAutoStartTime = 0;
                }
              }}
            />
          </SettingField>
        </SettingRow>
        <SettingRow id="long-press" child let:labelId>
          <SettingField unit="ms">
            <input
              type="number"
              step="50"
              min="200"
              aria-labelledby={labelId}
              bind:value={trackerLongPressTime}
              on:blur={() => {
                const newValue = Number.parseFloat(`${trackerLongPressTime ?? 0}`);

                if (isNaN(newValue) || newValue < 200) {
                  trackerLongPressTime = 500;
                }
              }}
            />
          </SettingField>
        </SettingRow>
        <SettingRow id="open-on-done" child layout="inline" let:labelId>
          <SettingSwitch bind:checked={openTrackerOnCompletion} labelledby={labelId} />
        </SettingRow>
        <SettingRow
          id="add-on-done"
          child
          layout="inline"
          settingKey="addCharactersOnCompletion"
          let:labelId
        >
          <SettingSwitch bind:checked={addCharactersOnCompletion} labelledby={labelId} />
        </SettingRow>
        <SettingRow id="custom-point-pause" child layout="inline" tags={['scroll']} let:labelId>
          <SettingSwitch bind:checked={pauseTrackerOnCustomPointChange} labelledby={labelId} />
        </SettingRow>
      {/if}
    </SettingsGroup>

    <SettingsGroup id="stats-skipping">
      {#if !statisticsEnabled}
        <p class="s-needs">Turn on Track reading time above to use these.</p>
      {:else}
        <SettingRow id="forward-skip" let:labelId>
          <SettingField unit="characters">
            <input
              type="number"
              step="1"
              min="0"
              aria-labelledby={labelId}
              bind:value={trackerForwardSkipThreshold}
              on:blur={() => {
                if (trackerForwardSkipThreshold === 0) {
                  trackerForwardSkipThreshold = 0;
                } else if (!trackerForwardSkipThreshold || trackerForwardSkipThreshold < 0) {
                  trackerForwardSkipThreshold = 2700;
                }
              }}
            />
          </SettingField>
        </SettingRow>
        <SettingRow id="backward-skip" let:labelId>
          <SettingField unit="characters">
            <input
              type="number"
              step="1"
              aria-labelledby={labelId}
              bind:value={trackerBackwardSkipThreshold}
              on:blur={() => {
                if (trackerBackwardSkipThreshold < 0) {
                  trackerBackwardSkipThreshold = Math.abs(trackerBackwardSkipThreshold);
                } else if (trackerBackwardSkipThreshold === 0) {
                  trackerBackwardSkipThreshold = 0;
                } else if (!trackerBackwardSkipThreshold) {
                  trackerBackwardSkipThreshold = 2700;
                }
              }}
            />
          </SettingField>
        </SettingRow>
        {#if trackerForwardSkipThreshold || trackerBackwardSkipThreshold}
          <SettingRow id="skip-action" let:labelId>
            <SettingChoice
              options={optionsForTrackerSkipThresholdAction}
              bind:value={trackerSkipThresholdAction}
              labelledby={labelId}
            />
          </SettingRow>
        {/if}
      {/if}
    </SettingsGroup>

    <!-- WP12c: goals are set on the Stats page; these are their rules. -->
    <SettingsGroup id="stats-goals">
      {#if !statisticsEnabled}
        <p class="s-needs">Turn on Track reading time above to use these.</p>
      {:else}
        <SettingRow id="speed-goal-min" settingKey="speedGoalMinMinutes" let:labelId>
          <SettingField unit="minutes">
            <input
              type="number"
              step="1"
              min="0"
              aria-labelledby={labelId}
              data-testid="settings-speed-goal-min"
              bind:value={$speedGoalMinMinutes$}
            />
          </SettingField>
        </SettingRow>
      {/if}
    </SettingsGroup>

    <SettingsGroup id="stats-bar">
      {#if !statisticsEnabled}
        <p class="s-needs">Turn on Track reading time above to use these.</p>
      {:else}
        <SettingRow id="time-left" let:labelId>
          <SettingChoice
            options={optionsForTimeLeft}
            bind:value={$bottomBarTimeLeft$}
            labelledby={labelId}
          />
        </SettingRow>
        {#if $bottomBarTimeLeft$ !== 'off'}
          <SettingRow id="time-left-recent" child let:labelId>
            <SettingField unit={timeLeftUnit($timeLeftRecentMinutes$)}>
              <input
                type="number"
                step="5"
                min="1"
                aria-labelledby={labelId}
                data-testid="settings-time-left-recent"
                bind:value={$timeLeftRecentMinutes$}
              />
            </SettingField>
          </SettingRow>
          <SettingRow id="time-left-min" child let:labelId>
            <SettingField unit={timeLeftUnit($timeLeftMinMinutes$)}>
              <input
                type="number"
                step="1"
                min="0"
                aria-labelledby={labelId}
                data-testid="settings-time-left-min"
                bind:value={$timeLeftMinMinutes$}
              />
            </SettingField>
          </SettingRow>
        {/if}
        <!-- Season 2 §9: the on-track dot at the right end of the reader's bottom bar. -->
        <SettingRow id="on-track-dot" layout="inline" let:labelId>
          <SettingSwitch bind:checked={$onTrackDot$} labelledby={labelId} />
        </SettingRow>
        {#if $onTrackDot$}
          <SettingRow id="on-track-rule" child description={onTrackRuleTooltip} let:labelId>
            <SettingChoice
              options={optionsForOnTrackRule}
              bind:value={$onTrackDotRule$}
              labelledby={labelId}
            />
          </SettingRow>
        {/if}
      {/if}
    </SettingsGroup>
  {/if}
  {#if showSpinner}
    <div class="tap-highlight-transparent fixed inset-0 bg-black/[.2]" />
    <div class="fixed inset-0 flex h-full w-full items-center justify-center text-7xl">
      <Fa icon={faSpinner} spin />
    </div>
  {/if}
</div>

<style>
  .s-callout {
    padding: 0.75rem 1rem;
    border: var(--c-border-width) solid var(--c-line);
    border-left: 3px solid var(--c-gold);
    border-radius: 0.375rem;
    background-color: var(--c-raised);
    font-size: 0.875rem;
  }

  .s-needs {
    padding: 0.875rem 1.25rem;
    font-size: 0.875rem;
    color: var(--c-muted);
  }
</style>
