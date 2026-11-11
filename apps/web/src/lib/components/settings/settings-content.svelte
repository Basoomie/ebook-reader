<script lang="ts">
  import { browser } from '$app/environment';
  import { faPlus, faSpinner } from '@fortawesome/free-solid-svg-icons';
  import {
    TrackerAutoPause,
    TrackerSkipThresholdAction
  } from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker';
  import ButtonToggleGroup from '$lib/components/button-toggle-group/button-toggle-group.svelte';
  import { pagePath } from '$lib/data/env';
  import { appOpenTarget$, type AppOpenTarget } from '$lib/home/settings';
  import {
    optionsForToggle,
    type ToggleOption
  } from '$lib/components/button-toggle-group/toggle-option';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import { WEEKDAY_NAMES } from '$lib/stats/periods';
  import Ripple from '$lib/components/ripple.svelte';
  import SettingsCustomTheme from '$lib/components/settings/settings-custom-theme.svelte';
  import SettingsFontSelector from '$lib/components/settings/settings-font-selector.svelte';
  import {
    bottomBarTimeLeft$,
    speedGoalMinMinutes$,
    timeLeftMinMinutes$,
    timeLeftRecentMinutes$
  } from '$lib/data/store';
  import SettingsItemGroup from '$lib/components/settings/settings-item-group.svelte';
  import SettingsStorageSourceList from '$lib/components/settings/settings-storage-source-list.svelte';
  import SettingsServerFontsDialog from '$lib/components/settings/settings-server-fonts-dialog.svelte';
  import SettingsExportData from '$lib/components/settings/settings-export-data.svelte';
  import { customFontNames$ } from '$lib/fonts/server-fonts-browser';
  import { inputClasses } from '$lib/css-classes';
  import { BlurMode } from '$lib/data/blur-mode';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { LocalFont } from '$lib/data/fonts';
  import { FuriganaStyle } from '$lib/data/furigana-style';
  import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';
  import { logger } from '$lib/data/logger';
  import { MergeMode } from '$lib/data/merge-mode';
  import { isAppDefault } from '$lib/data/storage/storage-source-manager';
  import { defaultStorageSources } from '$lib/data/storage/storage-types';
  import { isStorageSourceAvailable } from '$lib/data/storage/storage-view';
  import {
    customThemes$,
    darkTheme$,
    database,
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
  import { ViewMode } from '$lib/data/view-mode';
  import type { WritingMode } from '$lib/data/writing-mode';
  import { secondsToMinutes } from '$lib/functions/statistic-util';
  import { dummyFn } from '$lib/functions/utils';
  import {
    ReplicationSaveBehavior,
    AutoReplicationType
  } from '$lib/functions/replication/replication-options';
  import { map } from 'rxjs';
  import Fa from 'svelte-fa';
  import { onDestroy } from 'svelte';

  export let selectedTheme: string;

  export let viewMode: ViewMode;

  export let fontFamilyGroupOne: string;

  export let fontFamilyGroupTwo: string;

  export let textMarginValue: number;

  export let blurImage: boolean;

  export let blurImageMode: string;

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

  export let cacheStorageData: boolean;

  export let autoReplication: string;

  export let replicationSaveBehavior: string;

  export let showExternalPlaceholder: boolean;

  export let startDayHoursForTracker: number;

  /** WP12: first day of a stats week (global). */
  export let statsWeekStart: number;

  export let statisticsMergeMode: string;

  export let readingGoalsMergeMode: string;

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

  function deleteTheme(themeId: string) {
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

  const optionsForAppOpen: ToggleOption<AppOpenTarget>[] = [
    { id: 'last-book', text: 'Last book' },
    { id: 'home', text: 'Home' }
  ];

  const optionsForFuriganaStyle: ToggleOption<FuriganaStyle>[] = [
    {
      id: FuriganaStyle.Hide,
      text: 'Hide'
    },
    {
      id: FuriganaStyle.Partial,
      text: 'Partial'
    },
    {
      id: FuriganaStyle.Toggle,
      text: 'Toggle'
    },
    {
      id: FuriganaStyle.Full,
      text: 'Full'
    }
  ];

  const optionsForWritingMode: ToggleOption<WritingMode>[] = [
    {
      id: 'horizontal-tb',
      text: 'Horizontal'
    },
    {
      id: 'vertical-rl',
      text: 'Vertical'
    }
  ];

  const optionsForVerticalTextOrientation: ToggleOption<VerticalTextOrientation>[] = [
    {
      id: 'mixed',
      text: 'Mixed'
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

  const optionsForViewMode: ToggleOption<ViewMode>[] = [
    {
      id: ViewMode.Continuous,
      text: 'Continuous'
    },
    {
      id: ViewMode.Paginated,
      text: 'Paginated'
    }
  ];

  const optionsForBlurMode: ToggleOption<BlurMode>[] = [
    {
      id: BlurMode.ALL,
      text: 'All'
    },
    {
      id: BlurMode.AFTER_TOC,
      text: 'After ToC'
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

  const optionsForAutoReplicationType: ToggleOption<AutoReplicationType>[] = [
    {
      id: AutoReplicationType.Off,
      text: 'Off'
    },
    {
      id: AutoReplicationType.Up,
      text: 'Up'
    },
    {
      id: AutoReplicationType.Down,
      text: 'Down'
    },
    {
      id: AutoReplicationType.All,
      text: 'All'
    }
  ];

  const optionsForReplicationSaveBehavior: ToggleOption<ReplicationSaveBehavior>[] = [
    {
      id: ReplicationSaveBehavior.NewOnly,
      text: 'New Only'
    },
    {
      id: ReplicationSaveBehavior.Overwrite,
      text: 'Overwrite'
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
      text: 'Pause Tracker'
    }
  ];

  const optionsForMergeMode: ToggleOption<MergeMode>[] = [
    {
      id: MergeMode.MERGE,
      text: 'Merge'
    },
    {
      id: MergeMode.REPLACE,
      text: 'Replace'
    }
  ];

  const storageSources$ = database.storageSourcesChanged$.pipe(
    map((storageSources) => [
      ...defaultStorageSources
        .filter((defaultStorageSource) =>
          isStorageSourceAvailable(defaultStorageSource.type, defaultStorageSource.name, window)
        )
        .map((defaultStorageSource) => ({
          name: defaultStorageSource.name,
          type: defaultStorageSource.type,
          storedInManager: false,
          encryptionDisabled: false,
          data: new ArrayBuffer(0),
          lastSourceModified: 0
        })),
      ...storageSources.filter((storageSource) => !isAppDefault(storageSource.name))
    ])
  );

  let showSpinner = false;
  let furiganaStyleTooltip = '';
  let importHTMLFixModeTooltip = '';
  let autoReplicationTypeTooltip = '';
  let trackerAutoPauseTooltip = '';

  $: if ($textMarginMode$ === 'auto') {
    $textMarginValue$ = 0;
  }

  $: verticalTextOrientationTooltip =
    verticalTextOrientation === 'mixed'
      ? 'Rotates the characters of horizontal scripts 90° clockwise'
      : 'Lays out the characters of horizontal scripts naturally (upright), as well as the glyphs for vertical scripts.';
  $: autoBookmarkTooltip = `If enabled saves your place after ${autoBookmarkTime} seconds without scrolling/page change`;
  $: wakeLockSupported = browser && 'wakeLock' in navigator;
  $: verticalMode = writingMode === 'vertical-rl';
  $: switch (furiganaStyle) {
    case FuriganaStyle.Hide:
      furiganaStyleTooltip = 'Always hidden';
      break;
    case FuriganaStyle.Toggle:
      furiganaStyleTooltip = 'Hidden by default, can be toggled on click';
      break;
    case FuriganaStyle.Full:
      furiganaStyleTooltip = 'Hidden by default, show on hover or click';
      break;
    default:
      furiganaStyleTooltip = 'Display furigana as grayed out text';
      break;
  }
  $: avoidPageBreakTooltip = avoidPageBreak
    ? 'Avoids breaking words/sentences into different pages'
    : 'Allow words/sentences to break into different pages';
  $: persistentStorageTooltip = persistentStorage
    ? 'Reader uses higher storage limit for local data'
    : 'Uses lower temporary storage for local data.\nMay require bookmark or notification permissions for enablement';
  $: switch (importHTMLFixMode) {
    case ImportHTMLFixMode.OFF:
      importHTMLFixModeTooltip = 'Imports epub files as is';
      break;
    case ImportHTMLFixMode.EXTENDED:
      importHTMLFixModeTooltip =
        'Applies additional fixes for epub imports like removing control characters, replacing html entities etc.';
      break;
    default:
      importHTMLFixModeTooltip =
        'Applies fixes for epub imports like wrong self closing elements etc.';
      break;
  }
  $: cacheStorageDataTooltip = cacheStorageData
    ? 'Storage data is cached. Saves network traffic/latency but requires to reload current/open a new tab to retrieve data changes'
    : 'Storage data is refetched on every action. May consume more network traffic/latency but ensures current data';
  $: replicationSaveBehaviorTooltip =
    replicationSaveBehavior === ReplicationSaveBehavior.Overwrite
      ? 'Data will always be overwritten'
      : 'Data will only be written if none exist on target, no time data is present or if target data is older';
  $: switch (autoReplication) {
    case AutoReplicationType.Up:
      autoReplicationTypeTooltip =
        'Updated data will be exported to sync target when reading once per minute';
      break;
    case AutoReplicationType.Down:
      autoReplicationTypeTooltip = 'Data will be imported from sync target when opening a book';
      break;
    case AutoReplicationType.All:
      autoReplicationTypeTooltip = 'Data will be synced in both directions';
      break;
    default:
      autoReplicationTypeTooltip = 'No automatic import/export of data';
      break;
  }
  $: showExternalPlaceholderToolTip = showExternalPlaceholder
    ? 'Placeholder data for external books is shown in the browser source manager'
    : 'Placeholder data for external books is hidden';

  $: startOfDayHours = `${`${startDayHoursForTracker}`.padStart(2, '0')}:00`;

  $: trackerIdleTimeInMin = secondsToMinutes(trackerIdleTime);

  $: switch (trackerAutoPause) {
    case TrackerAutoPause.OFF:
      trackerAutoPauseTooltip = 'Tracker does not auto pause except for certain reader events';
      break;
    case TrackerAutoPause.STRICT:
      trackerAutoPauseTooltip =
        'Tracker will auto pause on certain reader events and any kind of site focus loss (e. g. dictionary popup)';
      break;
    default:
      trackerAutoPauseTooltip =
        'Tracker will auto pause on certain reader events and when the reader tab loses focus';
      break;
  }

  $: if ((activeSettings === 'Data' || activeSettings === 'Statistics') && !$storageSources$) {
    database
      .getStorageSources()
      .then((storageSources) => {
        database.storageSourcesChanged$.next(storageSources);
      })
      .catch((error) => {
        logger.error(`Failed to retrieve storage sources: ${error.message}`);
        database.storageSourcesChanged$.next([]);
      });
  }
</script>

<div class="grid grid-cols-1 items-center sm:grid-cols-2 sm:gap-6 lg:md:gap-8 lg:grid-cols-3">
  {#if activeSettings === 'Reader'}
    <p class="pb-6 sm:col-span-2 lg:col-span-3" data-testid="settings-appearance-note">
      Font size, line height, page margins, writing direction, pages or scrolling and furigana are
      set inside a book: open the menu at the top and tap Aa. They apply at once.
    </p>
    <div class="lg:col-span-2">
      {#if $followSystemTheme$}
        <!-- WP10d: while following the system, pick a theme for each mode. -->
        <SettingsItemGroup
          title="Light Theme"
          tooltip="Used while your device is set to light. Choosing a theme here also switches the reader right away when the device is light."
        >
          <ButtonToggleGroup
            options={optionsForTheme}
            bind:selectedOptionId={$lightTheme$}
            on:edit={({ detail }) => openThemeEditor(detail)}
            on:delete={({ detail }) => deleteTheme(detail)}
          >
            {#if browser}
              <button
                class="m-1 rounded-md border-2 border-gray-400 p-2 text-lg"
                on:click={() => openThemeEditor()}
              >
                <Fa icon={faPlus} class="mx-2" />
                <Ripple />
              </button>
            {/if}
          </ButtonToggleGroup>
        </SettingsItemGroup>
        <SettingsItemGroup title="Dark Theme" tooltip="Used while your device is set to dark.">
          <ButtonToggleGroup
            options={optionsForTheme}
            bind:selectedOptionId={$darkTheme$}
            on:edit={({ detail }) => openThemeEditor(detail)}
            on:delete={({ detail }) => deleteTheme(detail)}
          />
        </SettingsItemGroup>
      {:else}
        <SettingsItemGroup title="Theme">
          <ButtonToggleGroup
            options={optionsForTheme}
            bind:selectedOptionId={selectedTheme}
            on:edit={({ detail }) => openThemeEditor(detail)}
            on:delete={({ detail }) => deleteTheme(detail)}
          >
            {#if browser}
              <button
                class="m-1 rounded-md border-2 border-gray-400 p-2 text-lg"
                on:click={() => openThemeEditor()}
              >
                <Fa icon={faPlus} class="mx-2" />
                <Ripple />
              </button>
            {/if}
          </ButtonToggleGroup>
        </SettingsItemGroup>
      {/if}
      {#if $einkMode$}
        <p class="px-1 text-sm">
          E-ink is on: the book is shown black on white whatever the theme.
        </p>
      {/if}
    </div>
    <SettingsItemGroup
      title="Follow System Light/Dark"
      tooltip="Switch between a light and a dark theme with your device's light/dark setting"
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={$followSystemTheme$} />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="E-ink"
      tooltip="This device only: pure black on white everywhere, no grays, shadows or animations. The book ignores the theme while it is on."
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={$einkMode$} />
    </SettingsItemGroup>
    <SettingsItemGroup title="Font family (Group 1)">
      <div slot="header" class="flex items-center">
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
      <input
        type="text"
        class={inputClasses}
        placeholder="Noto Serif JP"
        bind:value={fontFamilyGroupOne}
      />
    </SettingsItemGroup>
    <SettingsItemGroup title="Font family (Group 2)">
      <div slot="header" class="flex items-center">
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
      <input
        type="text"
        class={inputClasses}
        placeholder="Noto Sans JP"
        bind:value={fontFamilyGroupTwo}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Custom Fonts"
      tooltip="Add a font once on the library server; every device gets it and keeps it for reading offline. Each device chooses its own font above."
    >
      {#if browser}
        <button
          class="m-1 min-h-[3rem] rounded-md border-2 border-gray-400 px-4 font-medium"
          data-testid="open-server-fonts"
          on:click={() => dialogManager.dialogs$.next([{ component: SettingsServerFontsDialog }])}
        >
          Manage fonts
        </button>
      {/if}
    </SettingsItemGroup>
    {#if textMarginMode === 'manual'}
      <SettingsItemGroup title="Paragraph Margins" tooltip="# of rem added as margin to paragraphs">
        <input
          type="number"
          class={inputClasses}
          step=".5"
          min="0"
          bind:value={textMarginValue}
          on:blur={() => {
            const newValue = Number.parseFloat(`${textMarginValue ?? 0}`);

            if (isNaN(newValue) || newValue < 1) {
              textMarginValue = 0;
            }
          }}
        />
      </SettingsItemGroup>
    {/if}
    <SettingsItemGroup
      title="Swipe Threshold"
      tooltip={'Distance which you need to swipe in order trigger a navigation'}
    >
      <input
        type="number"
        step="1"
        min="10"
        class={inputClasses}
        bind:value={swipeThreshold}
        on:blur={() => {
          if (swipeThreshold < 10 || typeof swipeThreshold !== 'number') {
            swipeThreshold = 10;
          }
        }}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Mouse Drag to Turn Pages"
      tooltip="Drag sideways with the mouse to turn the page. A drag that selects text only selects it."
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={mouseDragPageTurn} />
    </SettingsItemGroup>
    {#if mouseDragPageTurn}
      <SettingsItemGroup
        title="Mouse Drag Distance"
        tooltip="How far (in pixels) the mouse must move sideways to turn the page"
      >
        <input
          type="number"
          step="1"
          min="10"
          class={inputClasses}
          bind:value={mouseDragThreshold}
          on:blur={() => {
            if (mouseDragThreshold < 10 || typeof mouseDragThreshold !== 'number') {
              mouseDragThreshold = 80;
            }
          }}
        />
      </SettingsItemGroup>
    {/if}
    <SettingsItemGroup
      title="Jump History Length"
      tooltip="How many places Back ([) and Forward (]) remember after jumps (search, contents, saved place, bookmarks, highlights, Jump, Continue there)"
    >
      <input
        type="number"
        step="1"
        min="1"
        class={inputClasses}
        bind:value={jumpHistoryLimit}
        on:blur={() => {
          if (jumpHistoryLimit < 1 || typeof jumpHistoryLimit !== 'number') {
            jumpHistoryLimit = 50;
          }
        }}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Highlight Bar for Any Selection"
      tooltip="Normally the highlight bar appears after you long-press text or select it with the mouse. Turn this on if it never appears on this device: then any text selection in the book shows it."
    >
      <ButtonToggleGroup
        options={optionsForToggle}
        bind:selectedOptionId={highlightBarAnySelection}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Find Moved Highlights Within"
      tooltip="When a book's file changed, a highlight whose text is still in the book but whose surrounding text changed is placed again only within this many characters of its old place. Otherwise it is listed as 'couldn't place in the current file' and kept."
    >
      <input
        type="number"
        step="100"
        min="0"
        class={inputClasses}
        bind:value={highlightRefindChars}
        on:blur={() => {
          if (highlightRefindChars < 0 || typeof highlightRefindChars !== 'number') {
            highlightRefindChars = 2000;
          }
        }}
      />
    </SettingsItemGroup>
    {#if autoBookmark}
      <SettingsItemGroup title="Auto Save Place Time" tooltip={'Time in s for Auto Save Place'}>
        <input
          type="number"
          step="1"
          min="1"
          class={inputClasses}
          bind:value={autoBookmarkTime}
          on:blur={() => {
            if (autoBookmarkTime < 1 || typeof autoBookmarkTime !== 'number') {
              autoBookmarkTime = 3;
            }
          }}
        />
      </SettingsItemGroup>
    {/if}
    {#if verticalMode}
      <SettingsItemGroup
        title="Enable Font Kerning"
        tooltip={'Can lead to better visual balance for vertical spacing of text if font and browser supports it'}
      >
        <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={enableFontKerning} />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Enable VPAL"
        tooltip={'Can lead to more natural spacing for vertically laid-out text if font and browser supports it'}
      >
        <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={enableFontVPAL} />
      </SettingsItemGroup>
      <SettingsItemGroup title="Text Orientation" tooltip={verticalTextOrientationTooltip}>
        <ButtonToggleGroup
          options={optionsForVerticalTextOrientation}
          bind:selectedOptionId={verticalTextOrientation}
        />
      </SettingsItemGroup>
    {/if}
    <SettingsItemGroup
      title="Prioritize Reader Styles"
      tooltip={'When enabled the "important" declaration is added to certain rules like margins or justification which makes it more likely to be applied in case of conflicting book styles'}
    >
      <ButtonToggleGroup
        options={optionsForToggle}
        bind:selectedOptionId={prioritizeReaderStyles}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Enable Text Justification"
      tooltip={'When enabled the reader adds styles to justify text content of paragraphs'}
    >
      <ButtonToggleGroup
        options={optionsForToggle}
        bind:selectedOptionId={enableTextJustification}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Enable Pretty Text Wrap"
      tooltip={'When enabled the reader adds the pretty text wrap style to supported browsers'}
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={enableTextWrapPretty} />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Paragraph Margin Mode"
      tooltip={'When set to manual it allows to specify a margin value which should be applied to paragraphs'}
    >
      <ButtonToggleGroup
        options={optionsForTextMarginMode}
        bind:selectedOptionId={textMarginMode}
      />
    </SettingsItemGroup>
    {#if wakeLockSupported}
      <SettingsItemGroup
        title="Enable Screen Lock"
        tooltip={'When enabled the reader site attempts to request a WakeLock that prevents device screens from dimming or locking'}
      >
        <ButtonToggleGroup
          options={optionsForToggle}
          bind:selectedOptionId={enableReaderWakeLock}
        />
      </SettingsItemGroup>
    {/if}
    <SettingsItemGroup title="Show Character Counter">
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={showCharacterCounter} />
    </SettingsItemGroup>
    <SettingsItemGroup title="Show Percentage">
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={showPercentage} />
    </SettingsItemGroup>
    <SettingsItemGroup title="Show Footer Chapter Characters">
      <ButtonToggleGroup
        options={optionsForToggle}
        bind:selectedOptionId={showFooterChapterCharacterCounter}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Show Return Marker"
      tooltip="After a jump (search, contents, a highlight or bookmark), the bottom bar shows where you were reading; tap it to go back there"
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={showReturnMarker} />
    </SettingsItemGroup>
    <SettingsItemGroup title="Show Footer Chapter Percentage">
      <ButtonToggleGroup
        options={optionsForToggle}
        bind:selectedOptionId={showFooterChapterPercentage}
      />
    </SettingsItemGroup>
    <SettingsItemGroup title="Disable Wheel Navigation">
      <ButtonToggleGroup
        options={optionsForToggle}
        bind:selectedOptionId={disableWheelNavigation}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Close Confirmation"
      tooltip={`When enabled asks for confirmation on closing/reloading a reader tab and unsaved changes were detected`}
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={confirmClose} />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Manual Save Place"
      tooltip={'If enabled your place is not saved when leaving the reader via menu elements'}
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={manualBookmark} />
    </SettingsItemGroup>
    <SettingsItemGroup title="Auto Save Place" tooltip={autoBookmarkTooltip}>
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={autoBookmark} />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="When the App Opens"
      tooltip={'Last book: go straight back into the book you were reading. Home: show the Home page.'}
    >
      <ButtonToggleGroup options={optionsForAppOpen} bind:selectedOptionId={$appOpenTarget$} />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Continue From Other Devices"
      tooltip={'For books opened from the library: asks whether to continue where another device is further along (needs record sync)'}
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={positionPromptEnabled} />
    </SettingsItemGroup>
    {#if positionPromptEnabled}
      <SettingsItemGroup
        title="Continue: Characters Ahead"
        tooltip={'Ask only when the other device is at least this many characters further along (0 = any amount)'}
      >
        <input
          type="number"
          step="1"
          min="0"
          class={inputClasses}
          bind:value={positionPromptMinChars}
          on:blur={() => {
            if (positionPromptMinChars < 0 || typeof positionPromptMinChars !== 'number') {
              positionPromptMinChars = 500;
            }
          }}
        />
      </SettingsItemGroup>
    {/if}
    <SettingsItemGroup
      title="Reading Status: Settle Time (sec)"
      tooltip={'A library book becomes Reading on its first page turn. Page changes within this many seconds of the previous one while the book opens count as loading, not as a page turn'}
    >
      <input
        type="number"
        step="1"
        min="0"
        class={inputClasses}
        bind:value={readingStatusSettleSeconds}
        on:blur={() => {
          if (readingStatusSettleSeconds < 0 || typeof readingStatusSettleSeconds !== 'number') {
            readingStatusSettleSeconds = 3;
          }
        }}
      />
    </SettingsItemGroup>
    <SettingsItemGroup title="Blur image">
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={blurImage} />
    </SettingsItemGroup>
    {#if blurImage}
      <SettingsItemGroup
        title="Blur Mode"
        tooltip="Determines if all or only images after the table of contents will be blurred"
      >
        <ButtonToggleGroup options={optionsForBlurMode} bind:selectedOptionId={blurImageMode} />
      </SettingsItemGroup>
    {/if}
    {#if statisticsEnabled}
      <SettingsItemGroup
        title="Custom Point pauses Tracker"
        tooltip={'When enabled the tracker will auto pause and unpause while setting a custom reading point'}
      >
        <ButtonToggleGroup
          options={optionsForToggle}
          bind:selectedOptionId={pauseTrackerOnCustomPointChange}
        />
      </SettingsItemGroup>
    {/if}
    {#if viewMode === ViewMode.Continuous}
      <SettingsItemGroup
        title="Custom Reading Point"
        tooltip={'Allows to set a persistent custom point in the reader from which the current progress and bookmark is calculated when enabled'}
      >
        <div class="flex items-center">
          <ButtonToggleGroup
            options={optionsForToggle}
            bind:selectedOptionId={customReadingPointEnabled}
          />
          {#if customReadingPointEnabled}
            <div
              tabindex="0"
              role="button"
              class="ml-4 hover:underline"
              on:click={() => {
                verticalCustomReadingPosition$.next(100);
                horizontalCustomReadingPosition$.next(0);
              }}
              on:keyup={dummyFn}
            >
              Reset Points
            </div>
          {/if}
        </div>
      </SettingsItemGroup>
      <SettingsItemGroup title="Auto position on resize">
        <ButtonToggleGroup
          options={optionsForToggle}
          bind:selectedOptionId={autoPositionOnResize}
        />
      </SettingsItemGroup>
    {:else}
      <SettingsItemGroup title="Avoid Page Break" tooltip={avoidPageBreakTooltip}>
        <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={avoidPageBreak} />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Selection to Saved Place"
        tooltip={'When enabled Save my place (B) saves the paragraph near the current/previous selected text instead of the page start'}
      >
        <ButtonToggleGroup
          options={optionsForToggle}
          bind:selectedOptionId={selectionToBookmarkEnabled}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Tap to Flip"
        tooltip="Reserves small margins on the left and right on which you can tap to turn pages"
      >
        <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={enableTapEdgeToFlip} />
      </SettingsItemGroup>
      {#if !verticalMode}
        <SettingsItemGroup title="Page Columns" tooltip="# of text columns rendered">
          <input type="number" class={inputClasses} step="1" min="0" bind:value={pageColumns} />
        </SettingsItemGroup>
      {/if}
    {/if}
  {:else if activeSettings === 'Data'}
    <SettingsItemGroup
      title="Old sync manager"
      tooltip={'The book manager of the old sync: import into this browser, storage sources, export and delete. Stays here until the old sync is retired.'}
    >
      <a
        class="inline-flex min-h-[3rem] items-center rounded border-2 border-current px-4 font-medium"
        href="{pagePath}/manage"
        data-testid="old-sync-manager"
      >
        Open the old sync manager
      </a>
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Export my data"
      tooltip="One readable file (JSON) with everything synced for you: reading places, statuses and times read, highlights, notes, bookmarks, collections, statistics and the settings of every device. Book and font files are not in it."
    >
      {#if browser}
        <SettingsExportData />
      {/if}
    </SettingsItemGroup>
    <SettingsItemGroup title="Persistent storage" tooltip={persistentStorageTooltip}>
      <div class="flex items-center">
        <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={persistentStorage} />
        {#if storageQuota}
          <div class="ml-4">{storageQuota}</div>
        {/if}
      </div>
    </SettingsItemGroup>
    <SettingsItemGroup title="Epub Import Fixes" tooltip={importHTMLFixModeTooltip}>
      <ButtonToggleGroup
        options={optionsForImportHTMLFixes}
        bind:selectedOptionId={importHTMLFixMode}
      />
    </SettingsItemGroup>
    {#if importHTMLFixMode !== ImportHTMLFixMode.OFF}
      <SettingsItemGroup
        title="Restrict to Links"
        tooltip="Restricts epub fixes for self closing tags to links only"
      >
        <ButtonToggleGroup
          options={optionsForToggle}
          bind:selectedOptionId={restrictImportFixToAnchor}
        />
      </SettingsItemGroup>
    {/if}
    <SettingsItemGroup title="Cache Data" tooltip={cacheStorageDataTooltip}>
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={cacheStorageData} />
    </SettingsItemGroup>
    <SettingsItemGroup title="Auto Import/Export" tooltip={autoReplicationTypeTooltip}>
      <ButtonToggleGroup
        options={optionsForAutoReplicationType}
        bind:selectedOptionId={autoReplication}
      />
    </SettingsItemGroup>
    <SettingsItemGroup title="Import/Export Behavior" tooltip={replicationSaveBehaviorTooltip}>
      <ButtonToggleGroup
        options={optionsForReplicationSaveBehavior}
        bind:selectedOptionId={replicationSaveBehavior}
      />
    </SettingsItemGroup>
    <SettingsItemGroup title="Show Placeholder" tooltip={showExternalPlaceholderToolTip}>
      <ButtonToggleGroup
        options={optionsForToggle}
        bind:selectedOptionId={showExternalPlaceholder}
      />
    </SettingsItemGroup>
    <SettingsStorageSourceList storageSources={$storageSources$} />
  {:else}
    <SettingsItemGroup
      title={`Day Starts At: ${startOfDayHours}`}
      tooltip={'The same on every device. Reading before this time counts for the previous day.\nApplies to reading recorded from now on; days from before device tracking keep their date.'}
    >
      <input
        type="range"
        step="1"
        min="0"
        max="23"
        class={inputClasses}
        data-testid="settings-day-starts-at"
        bind:value={startDayHoursForTracker}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Week Starts On"
      tooltip={'The same on every device. Used by the Stats page (and weekly goals).'}
    >
      <select
        class="{inputClasses} min-h-[3rem]"
        data-testid="settings-week-starts-on"
        bind:value={statsWeekStart}
      >
        {#each WEEKDAY_NAMES as dayName, index (dayName)}
          <option value={index}>{dayName}</option>
        {/each}
      </select>
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Statistics Merge"
      tooltip={`Determines if statistics will be merged entry by entry or replaced completely on a sync`}
    >
      <ButtonToggleGroup
        options={optionsForMergeMode}
        bind:selectedOptionId={statisticsMergeMode}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Reading Goals Merge"
      tooltip={`Determines if reading goals will be merged entry by entry or replaced completely on a sync`}
    >
      <ButtonToggleGroup
        options={optionsForMergeMode}
        bind:selectedOptionId={readingGoalsMergeMode}
      />
    </SettingsItemGroup>
    <SettingsItemGroup
      title="Enable Statistics"
      tooltip="Enables the tracker icon in the bottom left corner of the reader which you need to use to start tracking your reading session"
    >
      <ButtonToggleGroup options={optionsForToggle} bind:selectedOptionId={statisticsEnabled} />
    </SettingsItemGroup>
    {#if statisticsEnabled}
      <SettingsItemGroup title="Tracker Auto Pause" tooltip={trackerAutoPauseTooltip}>
        <ButtonToggleGroup
          options={optionsForTrackerAutoPause}
          bind:selectedOptionId={trackerAutoPause}
        />
      </SettingsItemGroup>
      <SettingsItemGroup title="Open Tracker on Completion">
        <ButtonToggleGroup
          options={optionsForToggle}
          bind:selectedOptionId={openTrackerOnCompletion}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Update on Completion"
        tooltip={`Determines if the missing amount of characters between the current position and the book total will be added to the statistics or not`}
      >
        <ButtonToggleGroup
          options={optionsForToggle}
          bind:selectedOptionId={addCharactersOnCompletion}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Autostart tracker (sec)"
        tooltip={'Starts the tracker on the first page turn after opening a book. Page changes during the first seconds (position restore, layout) are ignored until the character count has not changed for this many seconds (0 = disabled)'}
      >
        <input
          type="number"
          class={inputClasses}
          step="1"
          min="0"
          bind:value={trackerAutoStartTime}
          on:blur={() => {
            const newValue = Number.parseFloat(`${trackerAutoStartTime ?? 0}`);

            if (isNaN(newValue) || newValue < 1) {
              trackerAutoStartTime = 0;
            }
          }}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Idle Time (min)"
        tooltip={'Time in minutes after which the tracker will auto pause without page interaction. The next page turn or scroll resumes it (0 = disabled, max 12h)'}
      >
        <input
          type="number"
          class={inputClasses}
          step="0.5"
          min="0"
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
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Tracker Long-press (ms)"
        tooltip={'Tap the tracker icon to pause or resume. Holding it this long opens the tracker menu'}
      >
        <input
          type="number"
          class={inputClasses}
          step="50"
          min="200"
          bind:value={trackerLongPressTime}
          on:blur={() => {
            const newValue = Number.parseFloat(`${trackerLongPressTime ?? 0}`);

            if (isNaN(newValue) || newValue < 200) {
              trackerLongPressTime = 500;
            }
          }}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Forward Skip Threshold"
        tooltip={'Amount of positive characters passed between a tick after which a threshold action is triggered (0 = disabled)'}
      >
        <input
          type="number"
          class={inputClasses}
          step="1"
          min="0"
          bind:value={trackerForwardSkipThreshold}
          on:blur={() => {
            if (trackerForwardSkipThreshold === 0) {
              trackerForwardSkipThreshold = 0;
            } else if (!trackerForwardSkipThreshold || trackerForwardSkipThreshold < 0) {
              trackerForwardSkipThreshold = 2700;
            }
          }}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Backward Skip Threshold"
        tooltip={'Amount of negative characters passed between a tick after which a threshold action is triggered (0 = disabled)'}
      >
        <input
          type="number"
          class={inputClasses}
          step="1"
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
      </SettingsItemGroup>
      {#if trackerForwardSkipThreshold || trackerBackwardSkipThreshold}
        <SettingsItemGroup
          title="Threshold Action"
          tooltip={`Determines what action will be executed in case a skip threshold was triggered`}
        >
          <ButtonToggleGroup
            options={optionsForTrackerSkipThresholdAction}
            bind:selectedOptionId={trackerSkipThresholdAction}
          />
        </SettingsItemGroup>
      {/if}
      {#if trackerAutoPause !== TrackerAutoPause.OFF}
        <SettingsItemGroup
          title="Dictionary Detection"
          tooltip={`If enabled auto pause is skipped if open yomitan/jpdb-browser-reader was detected - yomitan requires disabled 'Secure Container' settings`}
        >
          <ButtonToggleGroup
            options={optionsForToggle}
            bind:selectedOptionId={trackerPopupDetection}
          />
        </SettingsItemGroup>
      {/if}
      {#if trackerIdleTime > 0}
        <SettingsItemGroup
          title="Rollback Statistics on Idle"
          tooltip={`If enabled attempts to rollback statistics by subtracting the idled time value back from the session`}
        >
          <ButtonToggleGroup
            options={optionsForToggle}
            bind:selectedOptionId={adjustStatisticsAfterIdleTime}
          />
        </SettingsItemGroup>
      {/if}
      <!-- WP12c: goals are set on the Stats page; these are their rules. -->
      <SettingsItemGroup
        title="Speed Goal Counts After (min)"
        tooltip={'The same on every device. A speed goal counts for a day, week or month only after this much tracked reading in it.'}
      >
        <input
          type="number"
          step="1"
          min="0"
          class={inputClasses}
          data-testid="settings-speed-goal-min"
          bind:value={$speedGoalMinMinutes$}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Time Left in the Bottom Bar"
        tooltip={'This device only. Shows how long the chapter and/or the book will take at your recent speed in the book.'}
      >
        <ButtonToggleGroup
          options={optionsForTimeLeft}
          bind:selectedOptionId={$bottomBarTimeLeft$}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Time Left: Recent Reading (min)"
        tooltip={'This device only. Time left uses this many minutes of your newest reading in the book.'}
      >
        <input
          type="number"
          step="5"
          min="1"
          class={inputClasses}
          data-testid="settings-time-left-recent"
          bind:value={$timeLeftRecentMinutes$}
        />
      </SettingsItemGroup>
      <SettingsItemGroup
        title="Time Left: Overall Speed Below (min)"
        tooltip={'This device only. With less reading than this in a book, time left uses your overall speed instead.'}
      >
        <input
          type="number"
          step="1"
          min="0"
          class={inputClasses}
          data-testid="settings-time-left-min"
          bind:value={$timeLeftMinMinutes$}
        />
      </SettingsItemGroup>
    {/if}
  {/if}
  {#if showSpinner}
    <div class="tap-highlight-transparent fixed inset-0 bg-black/[.2]" />
    <div class="fixed inset-0 flex h-full w-full items-center justify-center text-7xl">
      <Fa icon={faSpinner} spin />
    </div>
  {/if}
</div>
