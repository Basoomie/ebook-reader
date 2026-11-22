<script lang="ts">
  import { browser } from '$app/environment';
  import { faBookmark as farBookmark } from '@fortawesome/free-regular-svg-icons';
  import { faBookmark as fasBookmark } from '@fortawesome/free-solid-svg-icons';
  import { readerImageGalleryPictures$ } from '$lib/components/book-reader/book-reader-image-gallery/book-reader-image-gallery';
  import Popover from '$lib/components/popover/popover.svelte';
  import { baseHeaderClasses, baseIconClasses } from '$lib/css-classes';
  import { customReadingPointEnabled$, readerToolbar$, viewMode$ } from '$lib/data/store';
  import { ViewMode } from '$lib/data/view-mode';
  import { dummyFn, isMobile$, isOnOldUrl } from '$lib/functions/utils';
  import {
    DOMAIN_HINT,
    JUMP_BACK,
    JUMP_FORWARD,
    MENU_ICON,
    MENU_TITLE,
    READING_POINT_ICON,
    READING_POINT_TITLE,
    SAVE_PLACE_LABEL,
    SAVE_PLACE_TITLE,
    STATISTICS,
    TOOLBAR_ACTIONS,
    type HeaderEvent,
    type ToolbarAction
  } from '$lib/reader-toolbar/toolbar-entries';
  import { resolveTopBar, visibleTopBar, type TopId } from '$lib/reader-toolbar/toolbar-layout';
  import type { Placement } from '@popperjs/core';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';

  export let hasChapterData: boolean;
  export let hasText: boolean;
  export let autoScrollMultiplier: number;
  export let hasCustomReadingPoint: boolean;
  export let showFullscreenButton: boolean;
  export let isBookmarkScreen: boolean;
  export let hasBookmarkData: boolean;
  /** WP10b: the jump history has a place to go back / forward to. */
  export let canJumpBack = false;
  export let canJumpForward = false;
  /** WP10c: the book has text to search. */
  export let canSearch = false;
  /** WP8a: the book is in the library catalog, so it has a status. */
  export let hasBookState = false;
  /** WP11a: the book has text, so it can have highlights and notes. */
  export let canNote = false;
  /** WP11b: a return marker (where you were reading before jumping) is set. */
  export let canReturnToMarker = false;

  const dispatch = createEventDispatcher<Record<HeaderEvent, void>>();

  /** A labelled menu entry (one top-bar entry can give several, e.g. Back and Forward). */
  interface MenuItem {
    key: string;
    label: string;
    title: string;
    event: HeaderEvent;
  }

  $: isOldUrl = browser && isOnOldUrl(window);

  $: customReadingPointMenuItems = [
    ...(hasCustomReadingPoint
      ? [{ label: 'Show Point', menuLabel: 'Show reading point', event: 'showCustomReadingPoint' }]
      : []),
    { label: 'Set Point', menuLabel: 'Set reading point', event: 'setCustomReadingPoint' },
    ...(hasCustomReadingPoint
      ? [
          {
            label: 'Reset Point',
            menuLabel: 'Reset reading point',
            event: 'resetCustomReadingPoint'
          }
        ]
      : [])
  ] as { label: string; menuLabel: string; event: HeaderEvent }[];

  $: showCustomReadingPointMenu = $customReadingPointEnabled$ || $viewMode$ === ViewMode.Paginated;

  $: statistics = isOldUrl ? DOMAIN_HINT : STATISTICS;

  /**
   * Reader toolbars session 1: each entry shows only when the device's list puts it in the
   * bar or the menu AND its condition (unchanged from before) holds now.
   */
  let availability: Record<TopId, boolean>;
  $: availability = {
    toc: hasChapterData,
    appearance: true,
    search: canSearch,
    notes: canNote,
    jumpBackForward: canJumpBack || canJumpForward,
    returnMarker: canReturnToMarker,
    speed: $viewMode$ === ViewMode.Continuous && !$isMobile$,
    gap: true,
    images: $readerImageGalleryPictures$.length > 0,
    jump: hasText,
    addBookmark: hasText,
    pacer: hasText,
    readAloud: hasText,
    shortcuts: true,
    fullscreen: showFullscreenButton,
    settings: true,
    home: true,
    menu: true,
    savePlace: true,
    returnToSaved: hasBookmarkData,
    readingPoint: showCustomReadingPointMenu,
    completeBook: true,
    statistics: true,
    ankiEnrich: hasText,
    bookStatus: hasBookState,
    addToCollection: hasBookState,
    zen: true,
    library: true
  };

  $: visible = visibleTopBar(resolveTopBar($readerToolbar$), (id) => availability[id]);
  $: barIds = visible.bar;

  /** A plain button's control (only called for ids in TOOLBAR_ACTIONS). */
  const act = (id: TopId) => TOOLBAR_ACTIONS[id] as ToolbarAction;

  function buildMenuItems(
    ids: TopId[],
    back: boolean,
    forward: boolean,
    pointItems: typeof customReadingPointMenuItems,
    stats: ToolbarAction
  ): MenuItem[] {
    return ids.flatMap((id) => menuItemsFor(id, back, forward, pointItems, stats));
  }

  function menuItemsFor(
    id: TopId,
    back: boolean,
    forward: boolean,
    pointItems: typeof customReadingPointMenuItems,
    stats: ToolbarAction
  ): MenuItem[] {
    switch (id) {
      case 'jumpBackForward':
        return [
          ...(back ? [{ key: 'jumpBack', ...JUMP_BACK }] : []),
          ...(forward ? [{ key: 'jumpForward', ...JUMP_FORWARD }] : [])
        ];
      case 'readingPoint':
        return pointItems.map(({ label, menuLabel, event }) => ({
          key: event,
          label: menuLabel,
          title: label,
          event
        }));
      case 'savePlace':
        return [
          { key: id, label: SAVE_PLACE_LABEL, title: SAVE_PLACE_TITLE, event: 'bookmarkClick' }
        ];
      case 'statistics':
        return [{ key: id, ...stats }];
      default: {
        const action = TOOLBAR_ACTIONS[id];
        return action ? [{ key: id, ...action }] : [];
      }
    }
  }

  $: menuItems = buildMenuItems(
    visible.menu,
    canJumpBack,
    canJumpForward,
    customReadingPointMenuItems,
    statistics
  );

  // The menu opens towards the middle of the screen, so it stays inside it (the phone fix of
  // 2026-11-14: no fallback placements, so Popper's flip never picks the side).
  let menuPlacement: Placement = 'bottom-end';
  $: menuPlacement = barIds.indexOf('menu') >= barIds.length / 2 ? 'bottom-end' : 'bottom-start';

  /** Test ids the e2e checks already use. */
  const TEST_IDS: Partial<Record<TopId, string>> = {
    notes: 'reader-notes-button',
    returnMarker: 'reader-return-marker'
  };

  let buttons: Partial<Record<TopId, HTMLElement>> = {};
  let menuPopover: Popover | undefined;
  let readingPointPopover: Popover | undefined;

  function runMenuItem(event: HeaderEvent) {
    dispatch(event);
    menuPopover?.toggleOpen();
  }

  function runReadingPointAction(event: HeaderEvent) {
    dispatch(event);
    readingPointPopover?.toggleOpen();
  }
</script>

<div class="flex bg-gray-700 px-4 md:px-8 {baseHeaderClasses}">
  <!-- One row in the device's order; it scrolls sideways when the icons don't fit. The gap
       entry grows to push what follows it to the right edge (and shrinks to nothing when
       the row is full). The negative margins keep the first and last icons where they were. -->
  <div class="header-icons -mx-4 flex min-w-0 flex-1 overflow-x-auto xl:-mx-3">
    {#each barIds as id (id)}
      {#if id === 'gap'}
        <div class="header-gap" aria-hidden="true" data-toolbar-id="gap" />
      {:else if id === 'speed'}
        <div
          class="flex items-center px-4 text-xl xl:px-3 xl:text-lg"
          title="Current Autoscroll Speed"
          data-toolbar-id="speed"
        >
          {autoScrollMultiplier}x
        </div>
      {:else if id === 'jumpBackForward'}
        {#if canJumpBack}
          <div
            tabindex="0"
            role="button"
            title={JUMP_BACK.title}
            class={baseIconClasses}
            data-toolbar-id="jumpBack"
            on:click={() => dispatch('jumpBackClick')}
            on:keyup={dummyFn}
          >
            <Fa icon={JUMP_BACK.icon} />
          </div>
        {/if}
        {#if canJumpForward}
          <div
            tabindex="0"
            role="button"
            title={JUMP_FORWARD.title}
            class={baseIconClasses}
            data-toolbar-id="jumpForward"
            on:click={() => dispatch('jumpForwardClick')}
            on:keyup={dummyFn}
          >
            <Fa icon={JUMP_FORWARD.icon} />
          </div>
        {/if}
      {:else if id === 'savePlace'}
        <div
          tabindex="0"
          role="button"
          title={SAVE_PLACE_TITLE}
          class={baseIconClasses}
          data-toolbar-id="savePlace"
          on:click={() => dispatch('bookmarkClick')}
          on:keyup={dummyFn}
        >
          <Fa icon={isBookmarkScreen ? fasBookmark : farBookmark} />
        </div>
      {:else if id === 'readingPoint'}
        <div
          tabindex="0"
          role="button"
          title={READING_POINT_TITLE}
          class={baseIconClasses}
          data-popover
          data-toolbar-id="readingPoint"
          bind:this={buttons.readingPoint}
          on:click={() => readingPointPopover?.toggleOpen(buttons.readingPoint)}
          on:keyup={dummyFn}
        >
          <Fa icon={READING_POINT_ICON} />
        </div>
      {:else if id === 'menu'}
        <div
          tabindex="0"
          role="button"
          title={MENU_TITLE}
          aria-label="Menu"
          class={baseIconClasses}
          data-popover
          data-toolbar-id="menu"
          bind:this={buttons.menu}
          on:click={() => menuPopover?.toggleOpen(buttons.menu)}
          on:keyup={dummyFn}
        >
          <Fa icon={MENU_ICON} />
        </div>
      {:else if id === 'statistics'}
        <div
          tabindex="0"
          role="button"
          title={statistics.title}
          class={baseIconClasses}
          data-toolbar-id="statistics"
          on:click={() => dispatch(statistics.event)}
          on:keyup={dummyFn}
        >
          <Fa icon={statistics.icon} />
        </div>
      {:else if TOOLBAR_ACTIONS[id]}
        <div
          tabindex="0"
          role="button"
          title={act(id).title}
          class={baseIconClasses}
          data-toolbar-id={id}
          data-testid={TEST_IDS[id]}
          on:click={() => dispatch(act(id).event)}
          on:keyup={dummyFn}
        >
          <Fa icon={act(id).icon} />
        </div>
      {/if}
    {/each}
  </div>

  <!-- The two popovers live outside the scrolling row, which would clip them; the row's
       buttons open them at their own place. -->
  <div class="absolute left-0 top-0 h-0 w-0">
    {#if barIds.includes('readingPoint')}
      <Popover
        placement="bottom"
        fallbackPlacements={['bottom-end', 'bottom-start']}
        yOffset={0}
        bind:this={readingPointPopover}
      >
        <div class="w-40 bg-gray-700 md:w-32" slot="content">
          {#each customReadingPointMenuItems as actionItem (actionItem.label)}
            <div
              tabindex="0"
              role="button"
              class="px-4 py-2 text-sm hover:bg-white hover:text-gray-700"
              on:click={() => runReadingPointAction(actionItem.event)}
              on:keyup={dummyFn}
            >
              {actionItem.label}
            </div>
          {/each}
        </div>
      </Popover>
    {/if}
    {#if barIds.includes('menu')}
      {#key menuPlacement}
        <Popover
          placement={menuPlacement}
          fallbackPlacements={[]}
          yOffset={0}
          bind:this={menuPopover}
        >
          <div
            class="w-40 overflow-y-auto bg-gray-700 md:w-32"
            style="max-height: calc(100vh - 4rem); max-height: calc(100dvh - 4rem)"
            data-testid="reader-toolbar-menu"
            slot="content"
          >
            {#each menuItems as item (item.key)}
              <div
                tabindex="0"
                role="button"
                class="px-4 py-2 text-sm hover:bg-white hover:text-gray-700"
                title={item.title}
                data-toolbar-menu-item={item.key}
                on:click={() => runMenuItem(item.event)}
                on:keyup={dummyFn}
              >
                {item.label}
              </div>
            {/each}
          </div>
        </Popover>
      {/key}
    {/if}
  </div>
</div>

<style>
  /* Safety net for screens narrower than the icons: the row scrolls sideways (no visible
     scrollbar) instead of pushing icons off-screen. */
  .header-icons {
    scrollbar-width: none;
  }

  .header-icons::-webkit-scrollbar {
    display: none;
  }

  /* Icons keep their 48 px touch target rather than shrinking. */
  .header-icons > div {
    flex-shrink: 0;
  }

  /* The gap takes the free space, and none when the row is full. */
  .header-icons > .header-gap {
    flex: 1 1 0;
    min-width: 0;
  }
</style>
