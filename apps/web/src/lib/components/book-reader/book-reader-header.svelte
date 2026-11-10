<script lang="ts">
  import { browser } from '$app/environment';
  import { faBookmark as farBookmark } from '@fortawesome/free-regular-svg-icons';
  import {
    faBookmark as fasBookmark,
    faArrowLeft,
    faArrowRight,
    faCrosshairs,
    faExpand,
    faFlag,
    faFont,
    faReply,
    faHighlighter,
    faList,
    faMagnifyingGlass,
    faRotateLeft,
    type IconDefinition
  } from '@fortawesome/free-solid-svg-icons';
  import { readerImageGalleryPictures$ } from '$lib/components/book-reader/book-reader-image-gallery/book-reader-image-gallery';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import MergedHeaderIcon from '$lib/components/merged-header-icon/merged-header-icon.svelte';
  import Popover from '$lib/components/popover/popover.svelte';
  import {
    baseHeaderClasses,
    baseIconClasses,
    nTranslateXHeaderFa,
    translateXHeaderFa
  } from '$lib/css-classes';
  import { customReadingPointEnabled$, viewMode$ } from '$lib/data/store';
  import { ViewMode } from '$lib/data/view-mode';
  import { dummyFn, isMobile$, isOnOldUrl } from '$lib/functions/utils';
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

  const dispatch = createEventDispatcher<{
    tocClick: void;
    bookmarkClick: void;
    scrollToBookmarkClick: void;
    jumpClick: void;
    completeBook: void;
    bookStateClick: void;
    addToCollectionClick: void;
    fullscreenClick: void;
    showCustomReadingPoint: void;
    setCustomReadingPoint: void;
    resetCustomReadingPoint: void;
    statisticsClick: void;
    readerImageGalleryClick: void;
    settingsClick: void;
    domainHintClick: void;
    homeClick: void;
    libraryClick: void;
    zenClick: void;
    shortcutsClick: void;
    searchClick: void;
    appearanceClick: void;
    notesClick: void;
    returnMarkerClick: void;
    addBookmarkClick: void;
    jumpBackClick: void;
    jumpForwardClick: void;
  }>();

  const customReadingPointMenuItems: {
    label: string;
    action: any;
  }[] = [
    ...(hasCustomReadingPoint ? [{ label: 'Show Point', action: 'showCustomReadingPoint' }] : []),
    { label: 'Set Point', action: 'setCustomReadingPoint' },
    ...(hasCustomReadingPoint ? [{ label: 'Reset Point', action: 'resetCustomReadingPoint' }] : [])
  ];

  let customReadingPointMenuElm: Popover;

  let menuItems: {
    routeId: string;
    label: string;
    icon: IconDefinition;
    title: string;
  }[] = [];

  $: isOldUrl = browser && isOnOldUrl(window);

  $: {
    const items = [];

    if (isOldUrl) {
      items.push(mergeEntries.DOMAIN_HINT);
    } else {
      items.push(mergeEntries.STATISTICS);
    }

    if (hasText) {
      items.push(mergeEntries.JUMP_TO_POSITION);
      // WP11b
      items.push(mergeEntries.ADD_BOOKMARK);
    }

    if (hasBookState) {
      items.push(mergeEntries.BOOK_STATUS);
      items.push(mergeEntries.ADD_TO_COLLECTION);
    }

    if ($readerImageGalleryPictures$.length) {
      items.push(mergeEntries.READER_IMAGE_GALLERY);
    }

    // WP10a: the touch fallback for Zen mode, and the cheat sheet.
    items.push(mergeEntries.ZEN_MODE, mergeEntries.SHORTCUTS);

    // WP7b: back to Home or the Library (the Manager is reached from Settings).
    items.push(mergeEntries.SETTINGS, mergeEntries.HOME, mergeEntries.LIBRARY);

    menuItems = items;
  }

  function dispatchCustomReadingPointAction(action: any) {
    dispatch(action);
    customReadingPointMenuElm.toggleOpen();
  }
</script>

<div class="flex justify-between bg-gray-700 px-4 md:px-8 {baseHeaderClasses}">
  <div class="flex transform-gpu {nTranslateXHeaderFa}">
    {#if hasChapterData}
      <div
        tabindex="0"
        role="button"
        title="Open Table of Contents"
        class={baseIconClasses}
        on:click={() => dispatch('tocClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faList} />
      </div>
    {/if}
    <div
      tabindex="0"
      role="button"
      title="Appearance: theme, font, size, page"
      class={baseIconClasses}
      on:click={() => dispatch('appearanceClick')}
      on:keyup={dummyFn}
    >
      <Fa icon={faFont} />
    </div>
    {#if canSearch}
      <div
        tabindex="0"
        role="button"
        title="Search in this book (/)"
        class={baseIconClasses}
        on:click={() => dispatch('searchClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faMagnifyingGlass} />
      </div>
    {/if}
    {#if canNote}
      <div
        tabindex="0"
        role="button"
        title="Highlights and notes in this book (L)"
        class={baseIconClasses}
        data-testid="reader-notes-button"
        on:click={() => dispatch('notesClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faHighlighter} />
      </div>
    {/if}
    <div
      tabindex="0"
      role="button"
      title="Save my place (B)"
      class={baseIconClasses}
      on:click={() => dispatch('bookmarkClick')}
      on:keyup={dummyFn}
    >
      <Fa icon={isBookmarkScreen ? fasBookmark : farBookmark} />
    </div>
    {#if hasBookmarkData}
      <div
        tabindex="0"
        role="button"
        title="Return to saved place (R)"
        class={baseIconClasses}
        on:click={() => dispatch('scrollToBookmarkClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faRotateLeft} />
      </div>
    {/if}
    {#if canJumpBack}
      <div
        tabindex="0"
        role="button"
        title="Back to where you were before the jump ([)"
        class={baseIconClasses}
        on:click={() => dispatch('jumpBackClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faArrowLeft} />
      </div>
    {/if}
    {#if canJumpForward}
      <div
        tabindex="0"
        role="button"
        title="Forward again (])"
        class={baseIconClasses}
        on:click={() => dispatch('jumpForwardClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faArrowRight} />
      </div>
    {/if}
    {#if canReturnToMarker}
      <div
        tabindex="0"
        role="button"
        title="Back to where you were reading"
        class={baseIconClasses}
        data-testid="reader-return-marker"
        on:click={() => dispatch('returnMarkerClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faReply} />
      </div>
    {/if}
    {#if $viewMode$ === ViewMode.Continuous && !$isMobile$}
      <div
        class="flex items-center px-4 text-xl xl:px-3 xl:text-lg"
        title="Current Autoscroll Speed"
      >
        {autoScrollMultiplier}x
      </div>
    {/if}
  </div>

  <div class="flex transform-gpu {translateXHeaderFa}">
    <div
      tabindex="0"
      role="button"
      title="Complete Book"
      class={baseIconClasses}
      on:click={() => dispatch('completeBook')}
      on:keyup={dummyFn}
    >
      <Fa icon={faFlag} />
    </div>
    {#if $customReadingPointEnabled$ || $viewMode$ === ViewMode.Paginated}
      <div class="flex">
        <Popover
          placement="bottom"
          fallbackPlacements={['bottom-end', 'bottom-start']}
          yOffset={0}
          bind:this={customReadingPointMenuElm}
        >
          <div slot="icon" title="Open Custom Point Actions" class={baseIconClasses}>
            <Fa icon={faCrosshairs} />
          </div>
          <div class="w-40 bg-gray-700 md:w-32" slot="content">
            {#each customReadingPointMenuItems as actionItem (actionItem.label)}
              <div
                tabindex="0"
                role="button"
                class="px-4 py-2 text-sm hover:bg-white hover:text-gray-700"
                on:click={() => dispatchCustomReadingPointAction(actionItem.action)}
                on:keyup={dummyFn}
              >
                {actionItem.label}
              </div>
            {/each}
          </div>
        </Popover>
      </div>
    {/if}
    {#if showFullscreenButton}
      <div
        tabindex="0"
        role="button"
        title="Toggle Fullscreen"
        class={baseIconClasses}
        on:click={() => dispatch('fullscreenClick')}
        on:keyup={dummyFn}
      >
        <Fa icon={faExpand} />
      </div>
    {/if}
    <MergedHeaderIcon
      disableRouteNavigation
      items={menuItems}
      on:action={({ detail }) => {
        if (detail === mergeEntries.STATISTICS.label) {
          dispatch('statisticsClick');
        } else if (detail === mergeEntries.JUMP_TO_POSITION.label) {
          dispatch('jumpClick');
        } else if (detail === mergeEntries.BOOK_STATUS.label) {
          dispatch('bookStateClick');
        } else if (detail === mergeEntries.ADD_TO_COLLECTION.label) {
          dispatch('addToCollectionClick');
        } else if (detail === mergeEntries.READER_IMAGE_GALLERY.label) {
          dispatch('readerImageGalleryClick');
        } else if (detail === mergeEntries.SETTINGS.label) {
          dispatch('settingsClick');
        } else if (detail === mergeEntries.DOMAIN_HINT.label) {
          dispatch('domainHintClick');
        } else if (detail === mergeEntries.HOME.label) {
          dispatch('homeClick');
        } else if (detail === mergeEntries.LIBRARY.label) {
          dispatch('libraryClick');
        } else if (detail === mergeEntries.ZEN_MODE.label) {
          dispatch('zenClick');
        } else if (detail === mergeEntries.SHORTCUTS.label) {
          dispatch('shortcutsClick');
        } else if (detail === mergeEntries.ADD_BOOKMARK.label) {
          dispatch('addBookmarkClick');
        }
      }}
    />
  </div>
</div>
