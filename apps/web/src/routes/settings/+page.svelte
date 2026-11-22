<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { tap } from 'rxjs';
  import SettingsSearch from '$lib/components/settings/settings-search.svelte';
  import { sectionDomId, settingDomId } from '$lib/settings/settings-catalog';
  import type { SettingsSearchResult } from '$lib/settings/settings-search';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { settingsTabHref, tabFromQuery, type SettingsTab } from '$lib/settings/settings-tab';
  import SettingsContent from '$lib/components/settings/settings-content.svelte';
  import SettingsHeader from '$lib/components/settings/settings-header.svelte';
  import AppBottomBar from '$lib/components/app-nav/app-bottom-bar.svelte';
  import AppHeader from '$lib/components/app-nav/app-header.svelte';
  import CataloguePageHeader from '$lib/components/catalogue-page-header.svelte';
  import {
    addCharactersOnCompletion$,
    adjustStatisticsAfterIdleTime$,
    autoBookmark$,
    autoBookmarkTime$,
    autoPositionOnResize$,
    avoidPageBreak$,
    confirmClose$,
    customReadingPointEnabled$,
    disableWheelNavigation$,
    enableFontVPAL$,
    enableReaderWakeLock$,
    enableTapEdgeToFlip$,
    enableTextJustification$,
    enableTextWrapPretty$,
    enableVerticalFontKerning$,
    firstDimensionMargin$,
    fontFamilyGroupOne$,
    fontFamilyGroupTwo$,
    fontSize$,
    furiganaStyle$,
    hideFurigana$,
    hideSpoilerImage$,
    importHTMLFixMode$,
    lineHeight$,
    manualBookmark$,
    openTrackerOnCompletion$,
    pageColumns$,
    pauseTrackerOnCustomPointChange$,
    prioritizeReaderStyles$,
    restrictImportFixToAnchor$,
    secondDimensionMaxValue$,
    selectionToBookmarkEnabled$,
    showCharacterCounter$,
    showPercentage$,
    showFooterChapterCharacterCounter$,
    showFooterChapterPercentage$,
    startDayHoursForTracker$,
    statsWeekStart$,
    statisticsEnabled$,
    swipeThreshold$,
    mouseDragPageTurn$,
    mouseDragThreshold$,
    jumpHistoryLimit$,
    highlightRefindChars$,
    highlightBarAnySelection$,
    textIndentation$,
    textMarginMode$,
    textMarginValue$,
    theme$,
    trackerAutoPause$,
    trackerBackwardSkipThreshold$,
    trackerForwardSkipThreshold$,
    trackerAutostartTime$,
    trackerIdleTime$,
    trackerLongPressTime$,
    trackerPopupDetection$,
    trackerSkipThresholdAction$,
    verticalTextOrientation$,
    viewMode$,
    writingMode$,
    hideSpoilerImageMode$
  } from '$lib/data/store';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import { pagePath } from '$lib/data/env';
  import { storage } from '$lib/data/window/navigator/storage';
  import { canEstimateStorage, canPersistStorage } from '$lib/functions/secure-context';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import {
    positionPromptEnabled$,
    positionPromptMinChars$,
    readingStatusSettleSeconds$
  } from '$lib/sync/settings';
  import { writableSubject } from '$lib/functions/svelte/store';
  import { reduceToEmptyString } from '$lib/functions/rxjs/reduce-to-empty-string';

  const persistentStorage$ = writableSubject(false);
  let persistentStorageReactive = false;

  // The open tab's sections for the side and top navigation, read from the page itself
  // (some appear only once a panel has loaded, e.g. Audiobooks), and the one being read.
  let contentEl: HTMLDivElement | undefined;
  let sections: { id: string; title: string }[] = [];
  let currentSection = '';
  let sectionWatch: MutationObserver | undefined;
  let scrollQueued = false;

  function readSections() {
    if (!contentEl) return;
    const found = Array.from(
      contentEl.querySelectorAll<HTMLElement>('[data-settings-group]'),
      (el) => ({ id: el.dataset.settingsGroup ?? '', title: el.dataset.title ?? '' })
    );
    const same =
      found.length === sections.length &&
      found.every((s, i) => s.id === sections[i].id && s.title === sections[i].title);
    if (!same) sections = found;
    updateCurrentSection();
  }

  /** The section being read: the last one whose heading has passed under the navigation. */
  function updateCurrentSection() {
    scrollQueued = false;
    if (!sections.length) {
      currentSection = '';
      return;
    }
    const line = window.innerWidth >= 1024 ? 120 : 200;
    let best = sections[0].id;
    for (const s of sections) {
      const el = document.getElementById(sectionDomId(s.id));
      if (el && el.getBoundingClientRect().top <= line) best = s.id;
    }
    const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atEnd && window.scrollY > 0) best = sections[sections.length - 1].id;
    if (best !== currentSection) currentSection = best;
  }

  function onScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(updateCurrentSection);
  }

  /** Opens the result's tab, scrolls to it and points at it for a moment. */
  async function goToResult(result: SettingsSearchResult) {
    if (result.tab !== activeSettings) {
      jumpingToResult = true;
      activeSettings = result.tab;
    }
    await tick();
    const ids =
      result.kind === 'setting'
        ? [settingDomId(result.id), result.parent ? settingDomId(result.parent) : '']
        : [];
    ids.push(sectionDomId(result.section.id));
    // A panel may still be loading (Audiobooks, Anki…): wait up to 4 s for the row.
    const started = performance.now();
    let target: HTMLElement | null = null;
    while (!target && performance.now() - started < 4000) {
      target = ids.map((id) => (id ? document.getElementById(id) : null)).find(Boolean) ?? null;
      // The row itself is best; take the section only once the row can't appear.
      if (target && target.id !== ids[0] && performance.now() - started < 1500) target = null;
      if (!target) await new Promise((r) => setTimeout(r, 100));
    }
    if (!target) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isSection = target.id === sectionDomId(result.section.id);
    target.scrollIntoView({
      behavior: smooth ? 'smooth' : 'auto',
      block: isSection ? 'start' : 'center'
    });
    const flashEl = isSection
      ? (target.querySelector<HTMLElement>('.s-group-head') ?? target)
      : target;
    flashEl.classList.remove('s-flash');
    void flashEl.offsetWidth;
    flashEl.classList.add('s-flash');
    setTimeout(() => flashEl.classList.remove('s-flash'), 2200);
    // Focus the row or section itself (screen readers read it; Tab goes on to its control),
    // not a field in it, which would open the keyboard on a phone.
    if (!flashEl.hasAttribute('tabindex')) flashEl.setAttribute('tabindex', '-1');
    flashEl.focus({ preventScroll: true });
  }

  $: if (tabReady) void afterTabChange(activeSettings);

  let shownTab: SettingsTab | undefined;
  let jumpingToResult = false;

  async function afterTabChange(tab: SettingsTab) {
    await tick();
    // Another tab starts at its top (the page scrolls past the title to the tabs), unless
    // Search settings is taking you to a row of it.
    if (shownTab && shownTab !== tab && !jumpingToResult && contentEl) {
      const top = contentEl.getBoundingClientRect().top + window.scrollY - 140;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
    }
    shownTab = tab;
    jumpingToResult = false;
    readSections();
  }

  onDestroy(() => sectionWatch?.disconnect());

  onMount(() => {
    // The tab comes from the address (/settings?tab=audiobooks), so links and reloads keep it.
    activeSettings = tabFromQuery($page.url.searchParams.get('tab'));
    tabReady = true;
    if (contentEl && typeof MutationObserver !== 'undefined') {
      sectionWatch = new MutationObserver(() => readSections());
      sectionWatch.observe(contentEl, { childList: true, subtree: true });
    }
    // Plain http has no navigator.storage: `storage` is then a stand-in that would read
    // as "Off" and "100 % used", so the Data tab shows a note instead (settings-content).
    if (canPersistStorage()) storage.persisted().then(setPersistentStorage);
    if (canEstimateStorage()) setStorageQuota();
  });

  let prevPage = `${pagePath}${mergeEntries.HOME.routeId}`;

  let activeSettings: SettingsTab = 'Reader';
  let tabReady = false;

  // A tab change rewrites the address in place (no new history entry, no scroll).
  $: if (tabReady) showTabInAddress(activeSettings);

  function showTabInAddress(tab: SettingsTab) {
    const href = settingsTabHref(pagePath, tab);
    if (`${location.pathname}${location.search}` === href) return;
    void goto(href, { replaceState: true, keepFocus: true, noScroll: true });
  }

  let storageQuota = '';

  afterNavigate((navigation) => {
    const { from, to } = navigation;
    // A tab change is a navigation to this same page: Back still goes where it went.
    if (!from || from.url.pathname === to?.url.pathname) return;
    prevPage = `${from.url.pathname}${from.url.search}`;
  });

  const setPersistentStorage$ = persistentStorage$.pipe(
    tap((value) => {
      if (!persistentStorageReactive) return;
      if (!value) {
        setPersistentStorage(true);
        return;
      }

      storage
        .persist()
        .then(setPersistentStorage)
        .finally(() => {
          if (canEstimateStorage()) setStorageQuota();
        });
    }),
    reduceToEmptyString()
  );

  function setPersistentStorage(value: boolean) {
    persistentStorageReactive = false;
    persistentStorage$.next(value);
    persistentStorageReactive = true;
  }

  function setStorageQuota() {
    storage
      .estimate()
      .then((storageData) => {
        const { usage, quota } = storageData;

        if (usage === undefined || quota === undefined) {
          return;
        }

        storageQuota = `${Math.round(((usage / quota) * 100 + Number.EPSILON) * 100) / 100} % used`;
      })
      .catch(() => {
        // no-op
      });
  }
</script>

<svelte:head>
  <title>{formatPageTitle('Settings')}</title>
</svelte:head>

<svelte:window on:scroll={onScroll} on:resize={onScroll} />

<!-- The catalogue's navy header (navigation only); Back, the title and Search settings sit
     under it; then the tabs (a sidebar from 1024 px, a strip above the content narrower). -->
<AppHeader title="Settings" />

<div class="mx-auto max-w-6xl px-4 pb-24 pt-16 md:px-8 xl:pt-14" data-testid="settings-page">
  <CataloguePageHeader jp="設定" title="Settings">
    <a
      slot="back"
      class="c-link inline-flex min-h-[3rem] items-center gap-2 text-sm"
      href={prevPage}
      data-testid="settings-back"
    >
      ← Back
    </a>
    <SettingsSearch on:go={({ detail }) => goToResult(detail)} />
  </CataloguePageHeader>
  <div class="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:items-start lg:gap-12">
    <SettingsHeader bind:activeSettings {sections} bind:current={currentSection} />
    <div class="min-w-0 max-w-[52rem] pt-5 lg:pt-0" bind:this={contentEl}>
      <SettingsContent
        {activeSettings}
        {storageQuota}
        bind:selectedTheme={$theme$}
        bind:fontFamilyGroupOne={$fontFamilyGroupOne$}
        bind:fontFamilyGroupTwo={$fontFamilyGroupTwo$}
        bind:textMarginValue={$textMarginValue$}
        bind:blurImage={$hideSpoilerImage$}
        bind:blurImageMode={$hideSpoilerImageMode$}
        bind:furiganaStyle={$furiganaStyle$}
        bind:writingMode={$writingMode$}
        bind:enableFontKerning={$enableVerticalFontKerning$}
        bind:enableFontVPAL={$enableFontVPAL$}
        bind:verticalTextOrientation={$verticalTextOrientation$}
        bind:prioritizeReaderStyles={$prioritizeReaderStyles$}
        bind:enableTextJustification={$enableTextJustification$}
        bind:enableTextWrapPretty={$enableTextWrapPretty$}
        bind:textMarginMode={$textMarginMode$}
        bind:enableReaderWakeLock={$enableReaderWakeLock$}
        bind:showCharacterCounter={$showCharacterCounter$}
        bind:showPercentage={$showPercentage$}
        bind:showFooterChapterCharacterCounter={$showFooterChapterCharacterCounter$}
        bind:showFooterChapterPercentage={$showFooterChapterPercentage$}
        bind:viewMode={$viewMode$}
        bind:swipeThreshold={$swipeThreshold$}
        bind:mouseDragPageTurn={$mouseDragPageTurn$}
        bind:mouseDragThreshold={$mouseDragThreshold$}
        bind:jumpHistoryLimit={$jumpHistoryLimit$}
        bind:highlightRefindChars={$highlightRefindChars$}
        bind:highlightBarAnySelection={$highlightBarAnySelection$}
        bind:disableWheelNavigation={$disableWheelNavigation$}
        bind:autoPositionOnResize={$autoPositionOnResize$}
        bind:avoidPageBreak={$avoidPageBreak$}
        bind:pauseTrackerOnCustomPointChange={$pauseTrackerOnCustomPointChange$}
        bind:customReadingPointEnabled={$customReadingPointEnabled$}
        bind:selectionToBookmarkEnabled={$selectionToBookmarkEnabled$}
        bind:enableTapEdgeToFlip={$enableTapEdgeToFlip$}
        bind:pageColumns={$pageColumns$}
        bind:persistentStorage={$persistentStorage$}
        bind:confirmClose={$confirmClose$}
        bind:manualBookmark={$manualBookmark$}
        bind:autoBookmark={$autoBookmark$}
        bind:autoBookmarkTime={$autoBookmarkTime$}
        bind:positionPromptEnabled={$positionPromptEnabled$}
        bind:positionPromptMinChars={$positionPromptMinChars$}
        bind:readingStatusSettleSeconds={$readingStatusSettleSeconds$}
        bind:importHTMLFixMode={$importHTMLFixMode$}
        bind:restrictImportFixToAnchor={$restrictImportFixToAnchor$}
        bind:startDayHoursForTracker={$startDayHoursForTracker$}
        bind:statsWeekStart={$statsWeekStart$}
        bind:statisticsEnabled={$statisticsEnabled$}
        bind:trackerAutoPause={$trackerAutoPause$}
        bind:openTrackerOnCompletion={$openTrackerOnCompletion$}
        bind:addCharactersOnCompletion={$addCharactersOnCompletion$}
        bind:trackerAutoStartTime={$trackerAutostartTime$}
        bind:trackerIdleTime={$trackerIdleTime$}
        bind:trackerLongPressTime={$trackerLongPressTime$}
        bind:trackerForwardSkipThreshold={$trackerForwardSkipThreshold$}
        bind:trackerBackwardSkipThreshold={$trackerBackwardSkipThreshold$}
        bind:trackerSkipThresholdAction={$trackerSkipThresholdAction$}
        bind:trackerPopupDetection={$trackerPopupDetection$}
        bind:adjustStatisticsAfterIdleTime={$adjustStatisticsAfterIdleTime$}
      />
    </div>
  </div>
  <AppBottomBar />
</div>
{$setPersistentStorage$ ?? ''}
