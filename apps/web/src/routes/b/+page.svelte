<script lang="ts">
  import {
    BehaviorSubject,
    combineLatest,
    debounceTime,
    distinctUntilChanged,
    defer,
    EMPTY,
    filter,
    fromEvent,
    map,
    merge,
    NEVER,
    of,
    share,
    shareReplay,
    skip,
    startWith,
    switchMap,
    take,
    takeWhile,
    tap,
    timer,
    type Observable
  } from 'rxjs';
  import { quintInOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import { browser } from '$app/environment';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { faNoteSticky, faPause, faPlay, faSpinner } from '@fortawesome/free-solid-svg-icons';
  import BookReader from '$lib/components/book-reader/book-reader.svelte';
  import { serverFonts } from '$lib/fonts/server-fonts-browser';
  import type {
    AutoScroller,
    BookmarkManager,
    PageManager
  } from '$lib/components/book-reader/types';
  import MessageDialog from '$lib/components/message-dialog.svelte';
  import StyleSheetRenderer from '$lib/components/style-sheet-renderer.svelte';
  import {
    autoBookmark$,
    autoBookmarkTime$,
    autoPositionOnResize$,
    avoidPageBreak$,
    bookReaderKeybindMap$,
    database,
    enableTapEdgeToFlip$,
    enableTextJustification$,
    enableTextWrapPretty$,
    firstDimensionMargin$,
    fontFamilyGroupOne$,
    fontFamilyGroupTwo$,
    fontSize$,
    furiganaStyle$,
    hideFurigana$,
    hideSpoilerImage$,
    multiplier$,
    pageColumns$,
    prioritizeReaderStyles$,
    secondDimensionMaxValue$,
    showFooterChapterCharacterCounter$,
    showFooterChapterPercentage$,
    textIndentation$,
    textMarginValue$,
    theme$,
    trackerAutostartTime$,
    trackerLongPressTime$,
    verticalMode$,
    writingMode$,
    viewMode$,
    selectionToBookmarkEnabled$,
    lineHeight$,
    skipKeyDownListener$,
    confirmClose$,
    verticalCustomReadingPosition$,
    horizontalCustomReadingPosition$,
    customReadingPointEnabled$,
    statisticsEnabled$,
    openTrackerOnCompletion$,
    addCharactersOnCompletion$,
    manualBookmark$,
    customThemes$,
    pauseTrackerOnCustomPointChange$,
    hideSpoilerImageMode$,
    showCharacterCounter$,
    bottomBarTimeLeft$,
    timeLeftMinMinutes$,
    timeLeftRecentMinutes$,
    showPercentage$,
    enableVerticalFontKerning$,
    enableFontVPAL$,
    verticalTextOrientation$,
    zenMode$,
    mouseDragPageTurn$,
    mouseDragThreshold$,
    swipeThreshold$,
    jumpHistoryLimit$,
    einkMode$,
    highlightLastColor$,
    highlightRefindChars$,
    highlightBarAnySelection$,
    showReturnMarker$
  } from '$lib/data/store';
  import HighlightBar from '$lib/components/book-reader/highlight-bar.svelte';
  import NotesPanel from '$lib/components/book-reader/notes-panel.svelte';
  import NoteEditorDialog from '$lib/components/book-reader/note-editor-dialog.svelte';
  import QuoteImageDialog from '$lib/components/notes/quote-image-dialog.svelte';
  import {
    ReaderHighlights,
    type BarState,
    type NotesPanelAnswer
  } from '$lib/components/book-reader/reader-highlights';
  import BookmarkNameDialog from '$lib/components/book-reader/bookmark-name-dialog.svelte';
  import { ReturnMarker } from '$lib/components/book-reader/return-marker';
  import { bookmarkPlaceAt, defaultBookmarkName } from '$lib/notes/bookmarks';
  import { takePendingJump } from '$lib/notes/pending-jump';
  import {
    isHighlightColor,
    quoteOf,
    type HighlightColor,
    type HighlightItem
  } from '$lib/notes/highlights';
  import { chapterLabelAt } from '$lib/sync/position-prompt';
  import { readable, type Readable } from 'svelte/store';
  import { JumpHistory } from '$lib/components/book-reader/jump-history';
  import AppearancePanel from '$lib/components/book-reader/appearance-panel.svelte';
  import BookSearchDialog from '$lib/components/book-reader/book-search-dialog.svelte';
  import {
    buildBookTextIndex,
    findMatches,
    matchRange,
    parseBookHtml,
    searchBook,
    type BookTextIndex,
    type SearchResult,
    type SearchState
  } from '$lib/components/book-reader/book-search';
  import ShortcutsDialog from '$lib/components/book-reader/shortcuts-dialog.svelte';
  import { readerShortcutGroups } from '$lib/components/book-reader/shortcuts';
  import { decideMouseDrag, isPointOverText } from '$lib/components/book-reader/mouse-drag';
  import {
    DEFAULT_TWO_FINGER_TAP_OPTIONS,
    TwoFingerTapDetector
  } from '$lib/functions/two-finger-tap';
  import BookCompletionConfetti from '$lib/components/book-reader/book-completion-confetti/book-completion-confetti.svelte';
  import BookReaderHeader from '$lib/components/book-reader/book-reader-header.svelte';
  import {
    readerImageGalleryPictures$,
    toggleImageGalleryPictureSpoiler$,
    updateImageGalleryPictureSpoilers$
  } from '$lib/components/book-reader/book-reader-image-gallery/book-reader-image-gallery';
  import BookReaderImageGallery from '$lib/components/book-reader/book-reader-image-gallery/book-reader-image-gallery.svelte';
  import {
    isTrackerMenuOpen$,
    isTrackerPaused$,
    isTrackerPausedByIdle$
  } from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker';
  import { AutoStartGate } from '$lib/components/book-reader/book-reading-tracker/tracker-auto';
  import BookReadingTracker from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker.svelte';
  import {
    getChapterData,
    nextChapter$,
    sectionList$,
    sectionProgress$,
    tocIsOpen$,
    type SectionWithProgress
  } from '$lib/components/book-reader/book-toc/book-toc';
  import BookToc from '$lib/components/book-reader/book-toc/book-toc.svelte';
  import ConfirmDialog from '$lib/components/confirm-dialog.svelte';
  import { confirmDestructive } from '$lib/confirm/confirm';
  import { completeBookCopy } from '$lib/confirm/confirm-copy';
  import NumberDialog from '$lib/components/number-dialog.svelte';
  import PositionPromptDialog from '$lib/components/book-reader/position-prompt-dialog.svelte';
  import BookStateDialog from '$lib/components/library/book-state-dialog.svelte';
  import AddToCollectionDialog from '$lib/components/collections/add-to-collection-dialog.svelte';
  import { readingStatusSettleSeconds$ } from '$lib/sync/settings';
  import type { PositionPrompt, PromptRow } from '$lib/sync/position-prompt-service';
  import type { ReaderPositionPrompt } from '$lib/sync/reader-position-prompt';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import {
    currentDbVersion,
    type BooksDbBookData,
    type BooksDbBookmarkData
  } from '$lib/data/database/books-db/versions/books-db';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { pagePath } from '$lib/data/env';
  import { DB_VERSION, PAGE_CHANGE, SKIPKEYLISTENER, SYNCED } from '$lib/data/events';
  import { fullscreenManager } from '$lib/data/fullscreen-manager';
  import { logger } from '$lib/data/logger';
  import { getBrowserStorageHandler } from '$lib/data/storage/storage-handler-factory';
  import type { BrowserStorageHandler } from '$lib/data/storage/handler/browser-handler';
  import { StorageDataType } from '$lib/data/storage/storage-types';
  import { availableThemes, EINK_THEME_OPTION, themeColors } from '$lib/data/theme-option';
  import { ViewMode } from '$lib/data/view-mode';
  import loadBookData from '$lib/functions/book-data-loader/load-book-data';
  import { formatPageTitle } from '$lib/functions/format-page-title';
  import { iffBrowser } from '$lib/functions/rxjs/iff-browser';
  import { readableToObservable } from '$lib/functions/rxjs/readable-to-observable';
  import { reduceToEmptyString } from '$lib/functions/rxjs/reduce-to-empty-string';
  import { takeWhenBrowser } from '$lib/functions/rxjs/take-when-browser';
  import { tapDom } from '$lib/functions/rxjs/tap-dom';
  import { longPressHandler } from '$lib/functions/long-press-handler';
  import { clickOutside } from '$lib/functions/use-click-outside';
  import {
    convertRemToPixels,
    dummyFn,
    isMobile$,
    limitToRange,
    getWeightedAverage
  } from '$lib/functions/utils';
  import { onKeydownReader } from './on-keydown-reader';
  import { onDestroy, onMount, tick } from 'svelte';
  import Fa from 'svelte-fa';
  import {
    clearRange,
    getParagraphToPoint,
    getRangeForUserSelection,
    getReferencePoints,
    pulseElement
  } from '$lib/functions/range-util';
  import AudioBookMenu from '$lib/whispersync/components/AudioBookMenu.svelte';
  import '$lib/whispersync/styles.css';
  import type { IDBPDatabase } from 'idb';
  import {
    createReaderWhispersync,
    withinRequestTime,
    type ReaderWhispersync
  } from '$lib/audio/whispersync-reader';
  import { leavingForgetsLastBook } from '$lib/home/open-target';
  import { formatTimeLeft, secondsLeft, speedEstimate } from '$lib/stats/time-left';
  import { ankiBottomBarButton$ } from '$lib/anki/settings';
  import type { LookupCapture, LookupSentence } from '$lib/anki/lookup-capture';

  let showSpinner = true;
  let showHeader = false;
  let isBookmarkScreen = false;
  let showFooter = true;
  let whisperContainerEl: HTMLDivElement;
  let bookContentEl: HTMLDivElement | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let readerDb: IDBPDatabase<any> | undefined;
  database.db.then((db) => {
    readerDb = db;
  });

  // WP14: "Enrich last Anki card". The last dictionary lookup's sentence is remembered
  // while reading (lib/anki/lookup-capture.ts); the action itself loads on first use.
  // Isolated like the stats code: failures end up in the banner or the log, never in reading.
  let lookupCapture: LookupCapture | undefined;
  let ankiNotice = '';
  let ankiNoticeSetup = false;
  let ankiBusy = false;

  // WP15c: whispersync's audio comes from the book's linked audiobook, and its position,
  // saved subtitles and saved match sync through the library server (not the old sync).
  // AudioBookMenu mounts once the open book's first sync is done (at most the library
  // request time); reading never waits for it.
  let whispersync: ReaderWhispersync | undefined;
  let whispersyncReady = false;
  let whispersyncNotice = false;
  let stopWhispersyncWatch: (() => void) | undefined;

  $: if ($rawBookData$ && readerDb && whispersync?.localId !== $rawBookData$.id) {
    setUpWhispersync($rawBookData$.id, $rawBookData$.title, readerDb);
  }

  function setUpWhispersync(
    localId: number,
    title: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: IDBPDatabase<any>
  ) {
    stopWhispersyncWatch?.();
    whispersyncReady = false;
    whispersyncNotice = false;
    const ws = createReaderWhispersync({
      localId,
      title,
      db,
      leave: (route) => void leaveReader(route, false)
    });
    whispersync = ws;
    let mounted = false;
    void withinRequestTime(ws.ready, null).then(() => {
      if (whispersync !== ws) return;
      whispersyncReady = true;
      mounted = true;
    });
    void ws.ready.then((changed) => {
      if (whispersync !== ws || !changed) return;
      // The page already shows the book's old text, so a newer match always needs a
      // reload; position and subtitles only when they came after whispersync loaded.
      if (changed.match || (mounted && (changed.position || changed.subtitles))) {
        whispersyncNotice = true;
      }
    });
    stopWhispersyncWatch = ws.watch(() => {
      if (whispersync === ws) whispersyncNotice = true;
    });
  }
  let exploredCharCount = 0;
  let bookCharCount = 0;
  let autoScroller: AutoScroller | undefined;
  let bookmarkManager: BookmarkManager | undefined;
  let pageManager: PageManager | undefined;
  let bookmarkData: Promise<BooksDbBookmarkData | undefined> = Promise.resolve(undefined);
  let customReadingPointTop = -2;
  let customReadingPointLeft = -2;
  let customReadingPoint = $verticalMode$
    ? $verticalCustomReadingPosition$
    : $horizontalCustomReadingPosition$;
  let customReadingPointScrollOffset = 0;
  let customReadingPointRange: Range | undefined;
  let lastSelectedRange: Range | undefined;
  let lastSelectedRangeWasEmpty = true;
  let isSelectingCustomReadingPoint = false;
  let showCustomReadingPoint = false;
  let localStorageHandler: BrowserStorageHandler;
  let storedExploredCharacter = 0;
  let hasBookmarkData = false;
  let blockDataUpdates = false;
  let trackerElm: BookReadingTracker;
  let showTrackerIcon = false;
  let autoStartGate: AutoStartGate | undefined;
  /** WP8a: detects the first real page turn for the book's status (independent of the tracker). */
  let statusGate: AutoStartGate | undefined;
  /** WP8a: the open book's catalog id (only catalog books have a status), once known. */
  let stateBookId: string | null = null;
  let startOverNotice = '';
  /** WP11c: one line after opening at a highlight that couldn't be placed (tap to close). */
  let openNotice = '';
  let stopStartOverWatch: (() => void) | undefined;
  let wasTrackerPaused = true;
  let frozenPosition = -1;
  let skipFirstFreezeChange = false;
  let bookCompleted = false;
  let confettiWidthModifier = 36;
  let confettiMaxRuns = 0;
  let showReaderImageGallery = false;
  let dismissDialogs = true;
  let syncedResolver: () => void;

  const syncedPromise = new Promise<void>((resolver) => {
    syncedResolver = resolver;
  });
  const queuedReaderImageGalleryPictures = new Map<string, boolean>();
  /**
   * WP10e: the layout settings the reader is mounted with. They change only together with a
   * remount (remountReader), after the current place has been taken, so the reader never
   * re-lays itself out at a different place first.
   */
  interface ReaderLayout {
    viewMode: ViewMode;
    writingMode: string;
    firstDimensionMargin: number;
    secondDimensionMaxValue: number;
    pageColumns: number;
    hideFurigana: boolean;
    furiganaStyle: ReturnType<typeof furiganaStyle$.getValue>;
    verticalTextOrientation: string;
    kerning: boolean;
    vpal: boolean;
  }

  function currentLayout(): ReaderLayout {
    return {
      viewMode: viewMode$.getValue(),
      writingMode: writingMode$.getValue(),
      firstDimensionMargin: firstDimensionMargin$.getValue(),
      secondDimensionMaxValue: secondDimensionMaxValue$.getValue(),
      pageColumns: pageColumns$.getValue(),
      hideFurigana: hideFurigana$.getValue(),
      furiganaStyle: furiganaStyle$.getValue(),
      verticalTextOrientation: verticalTextOrientation$.getValue(),
      kerning: enableVerticalFontKerning$.getValue(),
      vpal: enableFontVPAL$.getValue()
    };
  }

  let readerLayout = currentLayout();

  /** The writing mode of the mounted reader (also set on the root element). */
  const readerWritingMode$ = new BehaviorSubject(readerLayout.writingMode);

  $: readerVertical = readerLayout.writingMode === 'vertical-rl';

  $: fontFeatureSettings = [readerLayout.kerning && '"vkrn"', readerLayout.vpal && '"vpal"']
    .filter((f) => !!f && readerVertical)
    .join(', ');

  $: verticalTextOrientation = readerVertical ? readerLayout.verticalTextOrientation : '';

  const bookId$ = iffBrowser(() => readableToObservable(page)).pipe(
    map((pageObj) => Number(pageObj.url.searchParams.get('id'))),
    shareReplay({ refCount: true, bufferSize: 1 })
  );

  const rawBookData$ = bookId$.pipe(
    switchMap(async (id) => {
      let bookData: BooksDbBookData | undefined;

      try {
        localStorageHandler = getBrowserStorageHandler(window);

        localStorageHandler.startContext({ id, title: '' });
        bookData = await localStorageHandler.getBook();

        if (!bookData) {
          return bookData;
        }

        const currentContext = {
          id: bookData.id,
          title: bookData.title,
          imagePath: bookData.coverImage
        };

        localStorageHandler.startContext(currentContext);

        // WP15e: books are read from this device's copy only (the old sync, which could
        // fetch a placeholder's text from elsewhere, is gone). A placeholder opens from
        // the Library, which fills it with the library copy.
        if (!bookData.elementHtml) {
          throw new Error("This book's text is not on this device. Open it from the Library.");
        }

        bookData.lastBookOpen = new Date().getTime();

        await localStorageHandler.updateLastRead(bookData);
        // WP7b: remember the book for "Opening the app: Last book", whatever page opened it.
        database.putLastItem(bookData.id).catch(() => {});

        if (bookData.language) {
          document.documentElement.lang = bookData.language;
        }
      } catch (error: any) {
        const message = `Error loading book: ${error.message}`;

        logger.warn(message);

        dialogManager.dialogs$.next([
          {
            component: MessageDialog,
            props: {
              title: 'Load Error',
              message
            }
          }
        ]);
        return undefined;
      } finally {
        syncedResolver();

        showSpinner = false;
      }

      return bookData;
    }),
    share()
  );

  const leaveIfBookMissing$ = rawBookData$.pipe(
    tap((data) => {
      if (!data) {
        goto(`${pagePath}${mergeEntries.LIBRARY.routeId}`);
      }
    }),
    reduceToEmptyString()
  );

  const initBookmarkData$ = rawBookData$.pipe(
    tap((rawBookData) => {
      if (!rawBookData) return;
      bookmarkData = database.getBookmark(rawBookData.id);
    }),
    reduceToEmptyString()
  );

  /** WP10e: the view mode the book is formatted for (paginated and continuous differ). */
  const formatViewMode$ = new BehaviorSubject<ViewMode>(readerLayout.viewMode);

  const bookData$ = combineLatest([rawBookData$, formatViewMode$]).pipe(
    switchMap(([rawBookData, formatViewMode]) => {
      if (!rawBookData) return EMPTY;

      sectionList$.next(rawBookData.sections || []);

      return loadBookData(
        rawBookData,
        '.book-content',
        document,
        formatViewMode === ViewMode.Paginated,
        $hideSpoilerImageMode$
      );
    }),
    shareReplay({ refCount: true, bufferSize: 1 })
  );

  const resize$ = iffBrowser(() =>
    visualViewport ? fromEvent(visualViewport, 'resize') : of()
  ).pipe(share());

  const containerViewportWidth$ = resize$.pipe(
    startWith(0),
    map(() => visualViewport?.width || 0),
    takeWhenBrowser()
  );

  const containerViewportHeight$ = resize$.pipe(
    startWith(0),
    map(() => visualViewport?.height || 0),
    takeWhenBrowser()
  );

  // WP10d: E-ink mode shows the book in pure black on white, whatever the theme.
  const themeOption$ = combineLatest([theme$, einkMode$]).pipe(
    map(([theme, eink]) => {
      if (eink) {
        return EINK_THEME_OPTION;
      }

      const custom = $customThemes$[theme];

      return (
        availableThemes.get(theme) ||
        (custom ? themeColors(custom) : undefined) ||
        availableThemes.get('light-theme')
      );
    }),
    filter((o): o is NonNullable<typeof o> => !!o),
    takeWhenBrowser()
  );

  const backgroundColor$ = themeOption$.pipe(map((o) => o.backgroundColor));

  const collectReaderImageGallerySpoilerToggles$ = toggleImageGalleryPictureSpoiler$.pipe(
    tap((readerImageGalleryPicture) => {
      queuedReaderImageGalleryPictures.set(
        readerImageGalleryPicture.url,
        readerImageGalleryPicture.unspoilered
      );

      updateImageGalleryPictureSpoilers$.next();
    }),
    reduceToEmptyString()
  );

  const handleUpdateImageGalleryPictureSpoilers$ = updateImageGalleryPictureSpoilers$.pipe(
    debounceTime(250),
    tap(() => {
      $readerImageGalleryPictures$ = $readerImageGalleryPictures$.map((galleryPicture) => {
        const picture = galleryPicture;

        if (queuedReaderImageGalleryPictures.has(picture.url)) {
          picture.unspoilered = queuedReaderImageGalleryPictures.get(picture.url)!;
        }

        return picture;
      });

      queuedReaderImageGalleryPictures.clear();
    }),
    reduceToEmptyString()
  );

  const backgroundStyleName = 'background-color';
  const setBackgroundColor$ = backgroundColor$.pipe(
    tapDom(
      () => document.body,
      (backgroundColor, body) => body.style.setProperty(backgroundStyleName, backgroundColor),
      (body) => body.style.removeProperty(backgroundStyleName)
    ),
    reduceToEmptyString(),
    takeWhenBrowser()
  );

  const writingModeStyleName = 'writing-mode';
  const setWritingMode$ = readerWritingMode$.pipe(
    tapDom(
      () => document.documentElement,
      (writingMode, documentElement) =>
        documentElement.style.setProperty(writingModeStyleName, writingMode),
      (documentElement) => documentElement.style.removeProperty(writingModeStyleName)
    ),
    reduceToEmptyString(),
    takeWhenBrowser()
  );

  const sectionData$ = iffBrowser(() => sectionProgress$).pipe(
    map((sectionProgress) => [...sectionProgress.values()])
  );

  const textSelector$ = iffBrowser(() => fromEvent(document, 'selectionchange')).pipe(
    debounceTime(200),
    tap(() => {
      const currentSelected = window.getSelection()?.toString() || '';

      if (!currentSelected && lastSelectedRangeWasEmpty) {
        lastSelectedRange = undefined;
      } else if (currentSelected) {
        lastSelectedRange = window.getSelection()?.getRangeAt(0);
        lastSelectedRangeWasEmpty = false;
      } else {
        lastSelectedRangeWasEmpty = true;
      }
    }),
    reduceToEmptyString()
  );

  // Auto-start on the first page turn. The first position report and page changes
  // while the book settles (position restore, layout) only extend the settle period
  // of trackerAutostartTime seconds (see AutoStartGate).
  const autoStartTracker$ = iffBrowser(() =>
    $statisticsEnabled$ && $trackerAutostartTime$ > 0
      ? defer(() => {
          autoStartGate = new AutoStartGate($trackerAutostartTime$ * 1000);

          return fromEvent<CustomEvent>(document, PAGE_CHANGE);
        })
      : NEVER
  ).pipe(
    filter(isAutoStartPageTurn),
    take(1),
    tap(() => {
      wasTrackerPaused = false;
      isTrackerPaused$.next(wasTrackerPaused);
    }),
    reduceToEmptyString()
  );

  // WP8a: Unread becomes Reading on the first real page turn. Same settling rule
  // as the tracker's auto-start (position restore and layout are not page
  // turns), with its own per-device settle time; works with statistics off.
  const firstPageTurnStatus$ = iffBrowser(() =>
    defer(() => {
      statusGate = new AutoStartGate(
        Math.max(1, (Number($readingStatusSettleSeconds$) || 0) * 1000)
      );

      return fromEvent<CustomEvent>(document, PAGE_CHANGE);
    })
  ).pipe(
    filter(isFirstStatusPageTurn),
    take(1),
    tap(() => {
      if (!$rawBookData$) return;
      const { id, title } = $rawBookData$;
      import('$lib/sync/sync-service')
        .then(({ noteReaderFirstPageTurn }) => noteReaderFirstPageTurn(id, title))
        .catch(() => {});
    }),
    reduceToEmptyString()
  );

  $: if ($tocIsOpen$) {
    autoScroller?.off();
  }

  $: if (browser && bookCharCount) {
    document.dispatchEvent(new CustomEvent(PAGE_CHANGE, { detail: { exploredCharCount } }));
  }

  $: if (browser) {
    document.dispatchEvent(new CustomEvent(PAGE_CHANGE, { detail: { bookCharCount } }));
  }

  $: if (showCustomReadingPoint) {
    pauseTracker();

    pulseElement(customReadingPointRange?.endContainer?.parentElement, 'add', 1);

    fromEvent(document, 'click')
      .pipe(skip(1), take(1))
      .subscribe(() => {
        showCustomReadingPoint = false;
        pulseElement(customReadingPointRange?.endContainer?.parentElement, 'remove', 1);
        restartTrackerAfterCharacterChangeOrTime(1);
      });
  }

  $: if (frozenPosition !== -1 && exploredCharCount >= frozenPosition) {
    if (skipFirstFreezeChange) {
      skipFirstFreezeChange = false;
    } else {
      frozenPosition = -1;
    }
  }

  $: isPaginated = readerLayout.viewMode === ViewMode.Paginated;

  $: firstDimensionMargin =
    browser && $enableTapEdgeToFlip$ && isPaginated && readerVertical
      ? limitToRange(
          convertRemToPixels(window, 0.5),
          window.innerWidth,
          readerLayout.firstDimensionMargin
        )
      : (readerLayout.firstDimensionMargin ?? 0);

  $: tapButtonHeight = `calc(100% - ${showHeader ? 5 : 4}rem)`;

  $: tapButtonTop = `${showHeader ? 3 : 2}rem`;

  $: footerChapterProgress = getCurrentChapterProgress($sectionData$);

  // WP12c: time left in the bottom bar (opt-in per device), redone after page changes only.
  let timeLeftText = '';
  let timeLeftTimer: ReturnType<typeof setTimeout> | undefined;

  $: scheduleTimeLeft($bottomBarTimeLeft$, exploredCharCount, bookCharCount);

  $: if ($bookData$) {
    tick().then(() => {
      bookContentEl = document.querySelector<HTMLDivElement>('.book-content');
    });
  }

  $: bookmarkData.then((data) => {
    hasBookmarkData = !!data;
    storedExploredCharacter = data?.exploredCharCount || 0;
  });

  /** Experimental Code - May be removed any time without warning */

  $: if (browser) {
    document.dispatchEvent(new CustomEvent(SKIPKEYLISTENER, { detail: $skipKeyDownListener$ }));
  }

  onMount(() => document.addEventListener('ttu-action', handleAction, false));

  onMount(() => {
    // WP10b: a TOC visit is one jump, from the place where the TOC was opened.
    let isTocOpen = false;
    const tocOpen = tocIsOpen$.subscribe((open) => {
      isTocOpen = open;
      tocOrigin = open ? exploredCharCount : undefined;
    });
    const tocJump = nextChapter$.subscribe(() => {
      // N/M chapter keys also use nextChapter$, but only while the TOC is closed.
      if (isTocOpen && tocOrigin !== undefined) {
        recordJump(tocOrigin);
        tocOrigin = undefined;
      }
    });
    const bookChange = bookId$.subscribe(() => {
      jumpHistory.clear();
      refreshJumpHistory();
      searchState = { query: '', results: [], more: false, searched: false };
      searchIndex = undefined;
      clearSearchMark?.();
      stopHighlights();
      returnMarker.clear();
      refreshReturnMarker();
    });

    return () => {
      tocOpen.unsubscribe();
      tocJump.unsubscribe();
      bookChange.unsubscribe();
      clearSearchMark?.();
      stopHighlights();
    };
  });

  onMount(() => {
    if (!browser) return;
    let stopped = false;
    import('$lib/anki/lookup-capture')
      .then(({ LookupCapture }) => {
        if (stopped) return;
        lookupCapture = new LookupCapture(
          document,
          {
            root: () => document.querySelector('.book-content'),
            base: () => bookmarkManager?.sectionStartCount?.() ?? 0
          },
          (message) => logger.warn(message)
        );
        lookupCapture.start();
      })
      .catch((error) => logger.warn(`Anki: lookups not recorded: ${error?.message ?? error}`));
    // bookId$ repeats on every page-store update; only another book forgets the lookup.
    let lookupBook: number | undefined;
    const bookChange = bookId$.subscribe((id) => {
      if (lookupBook !== undefined && id !== lookupBook) lookupCapture?.reset();
      lookupBook = id;
    });

    return () => {
      stopped = true;
      bookChange.unsubscribe();
      lookupCapture?.stop();
    };
  });

  /** The sentence for the card: the last lookup, else the selected text (or none). */
  function ankiSentence(): LookupSentence | null {
    const lookup = lookupCapture?.lastLookup ?? null;

    if (lookup || !lookupCapture) {
      return lookup;
    }

    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount && !selection.isCollapsed
        ? selection.getRangeAt(0)
        : lastSelectedRange?.startContainer.isConnected && !lastSelectedRange.collapsed
          ? lastSelectedRange
          : undefined;

    return range ? lookupCapture.selectionSentence(range) : null;
  }

  async function enrichAnkiCard() {
    showHeader = false;

    if (ankiBusy || !$rawBookData$) {
      return;
    }

    ankiBusy = true;
    ankiNoticeSetup = false;
    ankiNotice = 'Sending to Anki…';

    try {
      const { enrichFromReader } = await import('$lib/anki/reader-enrich');
      const outcome = await enrichFromReader({
        localId: $rawBookData$.id,
        localTitle: $rawBookData$.title,
        coverImage: $rawBookData$.coverImage,
        sentence: ankiSentence(),
        readingPosition: exploredCharCount,
        bookCharacters: bookCharCount
      });
      ankiNotice = outcome.message;
      ankiNoticeSetup = !!outcome.unmapped;
    } catch (error) {
      ankiNotice = `Could not enrich the card: ${(error as Error)?.message ?? error}`;
      logger.warn(`Anki: ${ankiNotice}`);
    } finally {
      ankiBusy = false;
    }
  }

  onMount(() => {
    // WP10a: two-finger tap (Zen mode) and mouse-drag page turns. Document level, so both
    // reader modes get them; capture phase and passive, so nothing else is held up.
    const options = { capture: true, passive: true };
    document.addEventListener('pointerdown', onReaderPointerDown, options);
    document.addEventListener('pointermove', onReaderPointerMove, options);
    document.addEventListener('pointerup', onReaderPointerUp, options);
    document.addEventListener('pointercancel', onReaderPointerCancel, options);
    window.addEventListener('click', swallowGestureClick, true);
    document.addEventListener('selectstart', blockOffTextSelection, true);

    return () => {
      document.removeEventListener('selectstart', blockOffTextSelection, true);
      document.removeEventListener('pointerdown', onReaderPointerDown, options);
      document.removeEventListener('pointermove', onReaderPointerMove, options);
      document.removeEventListener('pointerup', onReaderPointerUp, options);
      document.removeEventListener('pointercancel', onReaderPointerCancel, options);
      window.removeEventListener('click', swallowGestureClick, true);
    };
  });

  function handleAction({ detail }: any) {
    if (!detail.type) {
      return;
    }

    if (detail.type === 'dbVersion') {
      document.dispatchEvent(new CustomEvent(DB_VERSION, { detail: currentDbVersion }));
    } else if (detail.type === 'waitForSync') {
      syncedPromise.finally(() => document.dispatchEvent(new CustomEvent(SYNCED)));
    } else if (detail.type === 'skipKeyDownListener') {
      skipKeyDownListener$.next(detail.params.value);
    } else if (detail.type === 'sync' && detail.syncType === StorageDataType.AUDIOBOOK) {
      // WP15c: whispersync's position goes to the library server (not the old sync).
      whispersync?.onPositionSaved();
    } else if (detail.type === 'sync' && detail.syncType === StorageDataType.SUBTITLE) {
      whispersync?.onSubtitlesSaved();
    } else if (detail.type === 'syncAndReload') {
      // Dispatched by onSaveMatch after writing matched HTML to local IDB. Upload the
      // match before reloading so other devices get it without re-matching (WP15c).
      const upload = whispersync ? whispersync.onMatchSaved() : Promise.resolve();
      upload.finally(() => window.location.reload());
    }
  }
  /** Experimental Code - May be removed any time without warning */

  onDestroy(() => {
    if (browser) {
      document.removeEventListener('ttu-action', handleAction, false);
      document.documentElement.lang = 'ja';
    }

    readerImageGalleryPictures$.next([]);

    if (quoteCoverUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(quoteCoverUrl);
    }

    stopPositionPrompt();
    stopStartOverWatch?.();

    if (dismissDialogs) {
      dialogManager.dialogs$.next([]);
    }
  });

  function handleUnload(event: BeforeUnloadEvent) {
    if ($confirmClose$ && storedExploredCharacter !== exploredCharCount) {
      event.preventDefault();
      // eslint-disable-next-line no-param-reassign
      return (event.returnValue = 'Are you sure you want to exit?');
    }

    return event;
  }

  function isFirstStatusPageTurn(event: CustomEvent) {
    try {
      return (
        typeof event.detail?.exploredCharCount === 'number' &&
        !!statusGate?.onPageChange(Date.now(), true)
      );
    } catch (error) {
      logger.warn(`Book state: ${(error as Error)?.message ?? error}`);
      return false;
    }
  }

  function isAutoStartPageTurn(event: CustomEvent) {
    try {
      if (typeof event.detail?.exploredCharCount !== 'number' || !autoStartGate) {
        return false;
      }

      return autoStartGate.onPageChange(Date.now(), $isTrackerPaused$);
    } catch ({ message }: any) {
      logger.error(`Error in tracker autostart: ${message}`);

      return false;
    }
  }

  function openTrackerMenu() {
    if (!$statisticsEnabled$) {
      return;
    }

    wasTrackerPaused = $isTrackerPaused$;
    isTrackerPaused$.next(true);
    isTrackerMenuOpen$.next(true);
  }

  /** Manual pause/resume (bottom-bar tap, keyboard). A manual pause never auto-resumes. */
  function toggleTrackerManually() {
    if (!$statisticsEnabled$) {
      return;
    }

    autoStartGate?.cancel();
    isTrackerPausedByIdle$.next(false);
    dialogManager.dialogs$.next([]);
    wasTrackerPaused = !$isTrackerPaused$;
    isTrackerPaused$.next(wasTrackerPaused);
  }

  // -------------------------------------------------------------------------
  // WP10b: jump history. Search, TOC, bookmark, Jump to Position and "Continue there"
  // record where they leave from; back/forward return there (in memory, per open book).

  const jumpHistory = new JumpHistory(() => jumpHistoryLimit$.getValue());

  let canJumpBack = false;

  let canJumpForward = false;

  /** Where the TOC was opened, until its first chapter jump is recorded. */
  let tocOrigin: number | undefined;

  function refreshJumpHistory() {
    canJumpBack = jumpHistory.canGoBack;
    canJumpForward = jumpHistory.canGoForward;
  }

  function recordJump(from = exploredCharCount) {
    try {
      jumpHistory.push(from);
      refreshJumpHistory();
      // WP11b: the first jump of an excursion keeps where you were reading.
      returnMarker.noteJump(from);
      refreshReturnMarker();
    } catch (error) {
      logger.warn(`Jump history: ${(error as Error)?.message ?? error}`);
    }
  }

  // -------------------------------------------------------------------------
  // WP11b: the return marker, "where you were reading" before the first jump. In memory for
  // the open book; cleared by returning there (the marker, or Back/Forward landing on it)
  // or by closing it. Shown in the notes panel and the reader menu, and in the bottom bar
  // when "Show Return Marker" is on (per device) while that place is not on screen.

  const returnMarker = new ReturnMarker();

  let returnMarkerPos: number | undefined;

  let returnMarkerOnScreen = false;

  function refreshReturnMarker() {
    returnMarkerPos = returnMarker.position;
    returnMarkerOnScreen =
      returnMarkerPos !== undefined &&
      readerHighlights?.isPositionOnScreen(returnMarkerPos) === true;
  }

  function returnToMarker() {
    showHeader = false;
    const target = returnMarker.position;

    if (target === undefined || !bookmarkManager || !getBookIdSync()) {
      return;
    }

    // Like Back after "Continue there": a jump that saves the place (unless Manual Save Place).
    jumpToPosition(target, { save: !$manualBookmark$, record: true });
    returnMarker.clear();
    refreshReturnMarker();
  }

  function clearReturnMarker() {
    returnMarker.clear();
    refreshReturnMarker();
  }

  onMount(() => {
    const pageChanges = fromEvent(document, PAGE_CHANGE)
      .pipe(debounceTime(300))
      .subscribe(() => {
        if (returnMarker.position !== undefined) refreshReturnMarker();
      });

    return () => pageChanges.unsubscribe();
  });

  // -------------------------------------------------------------------------
  // WP11b: named bookmarks. A bookmark keeps the page you are on under a name; making one
  // never saves the place or writes a position record.

  async function addBookmarkHere() {
    showHeader = false;
    const controller = readerHighlights;

    if (dialogManager.dialogs$.getValue().length || !controller || !$bookData$) {
      return;
    }

    if (!controller.bookId) {
      void openNotes('bookmarks');
      return;
    }

    const bookId = controller.bookId;
    const position = exploredCharCount;
    let place: ReturnType<typeof bookmarkPlaceAt>;
    let name = '';

    try {
      const index = getSearchIndex();
      place = bookmarkPlaceAt(index, position);
      name = defaultBookmarkName(index, position);
    } catch (error) {
      logger.warn(`Bookmarks: ${(error as Error)?.message ?? error}`);
      place = { pos: position, text: '', before: '', after: '' };
    }

    const chapter = chapterLabelAt(sectionList$.getValue(), position) ?? null;
    const placeLabel = [
      chapter ? `「${chapter}」` : '',
      bookCharCount ? `${((position / bookCharCount) * 100).toFixed(1)}%` : ''
    ]
      .filter(Boolean)
      .join(' · ');
    const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
    pauseTracker();
    const keysWereSkipped = $skipKeyDownListener$;
    skipKeyDownListener$.next(true);

    const answer = await new Promise<string | null>((resolver) => {
      dialogManager.dialogs$.next([
        {
          component: BookmarkNameDialog,
          disableCloseOnClick: true,
          props: { place: placeLabel, name: name || chapter || 'Bookmark', resolver }
        }
      ]);
    });

    skipKeyDownListener$.next(keysWereSkipped);

    if (answer) {
      try {
        const { notesApi } = await import('$lib/sync/sync-service');
        await notesApi().addBookmark(bookId, place, answer, chapter);
      } catch (error) {
        logger.warn(`Bookmarks: ${(error as Error)?.message ?? error}`);
      }
    }

    if ($statisticsEnabled$ && !wasPaused) {
      restartTrackerAfterCharacterChangeOrTime(1);
    }
  }

  /** Back or forward: the same jump as "Continue there" (saves the place, tracker untouched). */
  function goJumpHistory(direction: 'back' | 'forward') {
    showHeader = false;

    if (!bookmarkManager || !getBookIdSync()) {
      return;
    }

    const target =
      direction === 'back'
        ? jumpHistory.back(exploredCharCount)
        : jumpHistory.forward(exploredCharCount);
    refreshJumpHistory();

    if (target !== undefined) {
      jumpToPosition(target, { save: !$manualBookmark$, record: false });
      returnMarker.noteArrived(target);
      refreshReturnMarker();
    }
  }

  // -------------------------------------------------------------------------
  // WP10e: the appearance panel and live changes. Style changes (font, size, line height,
  // indentation, paragraph spacing, font features) re-measure the page in place; changes of
  // layout (view mode, writing, page margins, columns, furigana) reopen the reader in place
  // at the same character. Neither saves the place, prompts, or counts as reading.

  let showAppearance = false;

  let bookReaderRef: { relayout(): Promise<void> } | undefined;

  /** Changes to remount the reader for; the view mode also formats the book again. */
  let readerKey = 0;

  let remountTarget: number | undefined;

  let remountTrackerWasRunning = false;

  /** The old reader's bookmark manager, to know when the new one has arrived. */
  let remountStaleManager: BookmarkManager | undefined;

  /** A view mode change waits for the book formatted for the new mode before reopening. */
  let awaitingBookHtml = false;

  let restoreAppearanceKeys: (() => void) | undefined;

  function openAppearance() {
    showHeader = false;

    if (showAppearance || dialogManager.dialogs$.getValue().length) {
      return;
    }

    const keysWereSkipped = $skipKeyDownListener$;
    skipKeyDownListener$.next(true);
    restoreAppearanceKeys = () => {
      restoreAppearanceKeys = undefined;
      skipKeyDownListener$.next(keysWereSkipped);
    };
    showAppearance = true;
  }

  function closeAppearance() {
    showAppearance = false;
    restoreAppearanceKeys?.();
  }

  function noteLayoutSettling() {
    const now = Date.now();
    autoStartGate?.noteSettling(now);
    statusGate?.noteSettling(now);
  }

  async function relayoutInPlace() {
    if (!bookReaderRef || remountTarget !== undefined) {
      return;
    }

    const wasRunning = $statisticsEnabled$ && !$isTrackerPaused$;

    try {
      if (wasRunning) {
        pauseTracker();
      }

      noteLayoutSettling();
      clearSearchMark?.();
      await bookReaderRef.relayout();
      noteLayoutSettling();
    } catch (error) {
      logger.warn(`Appearance: ${(error as Error)?.message ?? error}`);
    } finally {
      if (wasRunning) {
        restartTrackerAfterCharacterChangeOrTime(500);
      }
    }
  }

  function remountReader() {
    const next = currentLayout();

    if (
      !$bookData$ ||
      !bookmarkManager ||
      remountTarget !== undefined ||
      JSON.stringify(next) === JSON.stringify(readerLayout)
    ) {
      return;
    }

    remountTarget = exploredCharCount;
    remountStaleManager = bookmarkManager;
    remountTrackerWasRunning = $statisticsEnabled$ && !$isTrackerPaused$;

    if (remountTrackerWasRunning) {
      pauseTracker();
    }

    noteLayoutSettling();
    clearSearchMark?.();
    // Whispersync holds the page element and its writing mode: it starts again with the new
    // page (as after coming back from Settings).
    bookContentEl = null;

    const applyLayout = () => {
      readerLayout = next;
      readerWritingMode$.next(next.writingMode);
      readerKey += 1;
    };

    if (next.viewMode !== readerLayout.viewMode) {
      awaitingBookHtml = true;
      bookData$.pipe(skip(1), take(1)).subscribe({
        next: () => {
          awaitingBookHtml = false;
          applyLayout();
        },
        error: (error) => {
          awaitingBookHtml = false;
          remountTarget = undefined;
          logger.warn(`Appearance: ${(error as Error)?.message ?? error}`);

          if (remountTrackerWasRunning) {
            restartTrackerAfterCharacterChangeOrTime(1);
          }
        }
      });
      formatViewMode$.next(next.viewMode);
      return;
    }

    applyLayout();
  }

  async function finishRemount() {
    const target = remountTarget ?? 0;

    try {
      // The new reader's bookmark manager reaches this page through a binding, sometimes a
      // few frames after the reader reports its restore: wait for it (at most ~1 s).
      await tick();
      for (let i = 0; i < 60 && bookmarkManager === remountStaleManager; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      remountTarget = undefined;
      remountStaleManager = undefined;
      bookContentEl = document.querySelector<HTMLDivElement>('.book-content');
      jumpToPosition(target, { save: false, record: false });

      // Safety net: if something moved the reader away again (a late restore), go back once.
      await pageSettled();
      if (Math.abs(exploredCharCount - target) > 3000) {
        jumpToPosition(target, { save: false, record: false });
      }
    } catch (error) {
      remountTarget = undefined;
      logger.warn(`Appearance: ${(error as Error)?.message ?? error}`);
    }

    if (remountTrackerWasRunning) {
      restartTrackerAfterCharacterChangeOrTime(1000);
    }

    // Changed again while reopening: reopen once more for the latest settings.
    if (JSON.stringify(currentLayout()) !== JSON.stringify(readerLayout)) {
      setTimeout(remountReader, 500);
    }
  }

  onMount(() => {
    const changes = (...subjects: Observable<unknown>[]) =>
      merge(...subjects.map((s) => s.pipe(distinctUntilChanged(), skip(1)))).pipe(
        debounceTime(350)
      );

    const inPlace = changes(
      fontSize$,
      lineHeight$,
      fontFamilyGroupOne$,
      fontFamilyGroupTwo$,
      textIndentation$,
      textMarginValue$
    ).subscribe(() => relayoutInPlace());

    // WP13: a server font this book uses arrived after the page was laid out (its first
    // download on this device): lay out again in place, like a font change.
    const fontArrived = serverFonts.arrived$
      .pipe(
        filter(
          (name) =>
            firstPositionRestored &&
            (name === fontFamilyGroupOne$.getValue() || name === fontFamilyGroupTwo$.getValue())
        ),
        debounceTime(350)
      )
      .subscribe(() => relayoutInPlace());

    const reopen = changes(
      viewMode$,
      writingMode$,
      firstDimensionMargin$,
      secondDimensionMaxValue$,
      pageColumns$,
      hideFurigana$,
      furiganaStyle$,
      verticalTextOrientation$,
      enableVerticalFontKerning$,
      enableFontVPAL$
    ).subscribe(() => remountReader());

    return () => {
      inPlace.unsubscribe();
      fontArrived.unsubscribe();
      reopen.unsubscribe();
      restoreAppearanceKeys?.();
    };
  });

  // -------------------------------------------------------------------------
  // WP10c: in-book search. The index is built from the reader's own HTML with the reader's
  // own character positions, so a result jumps to exactly the place the reader counts.

  const SEARCH_LIMIT = 500;

  let searchState: SearchState = { query: '', results: [], more: false, searched: false };

  let searchIndex: { html: string; index: BookTextIndex } | undefined;

  let clearSearchMark: (() => void) | undefined;

  function getSearchIndex() {
    const html = $bookData$?.htmlContent ?? '';

    if (searchIndex?.html !== html) {
      const index = buildBookTextIndex(parseBookHtml(html));
      searchIndex = { html, index };

      if (bookCharCount && index.total !== bookCharCount) {
        logger.warn(`Search: counted ${index.total} characters, the reader ${bookCharCount}`);
      }
    }

    return searchIndex.index;
  }

  async function openSearch() {
    showHeader = false;

    if (dialogManager.dialogs$.getValue().length || !$bookData$) {
      return;
    }

    const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
    pauseTracker();
    const keysWereSkipped = $skipKeyDownListener$;
    skipKeyDownListener$.next(true);

    const answer = await new Promise<{ state: SearchState; result: SearchResult | null }>(
      (resolver) => {
        dialogManager.dialogs$.next([
          {
            component: BookSearchDialog,
            disableCloseOnClick: true,
            props: {
              state: searchState,
              total: bookCharCount,
              sections: sectionList$.getValue(),
              limit: SEARCH_LIMIT,
              search: (query: string) => searchBook(getSearchIndex(), query, SEARCH_LIMIT),
              resolver
            }
          }
        ]);
      }
    );

    skipKeyDownListener$.next(keysWereSkipped);
    searchState = answer.state;

    if (answer.result) {
      // Like Jump to Position: recorded in the jump history, saved by the next page turn.
      jumpToPosition(answer.result.position, { save: false, record: true });

      try {
        await revealSearchMatch(searchState.query, answer.result.position);
      } catch (error) {
        logger.warn(`Search: ${(error as Error)?.message ?? error}`);
      }
    }

    // The tracker stays paused through the jump and any page turn that reveals the match.
    if ($statisticsEnabled$ && !wasPaused) {
      restartTrackerAfterCharacterChangeOrTime(1);
    }
  }

  function isOnScreen(range: Range) {
    return Array.from(range.getClientRects()).some(
      (r) =>
        r.width > 0 &&
        r.right > 0 &&
        r.bottom > 0 &&
        r.left < window.innerWidth &&
        r.top < window.innerHeight
    );
  }

  /** Resolves once the page has stopped changing (or right away if it doesn't change). */
  function pageSettled() {
    return new Promise<void>((resolve) => {
      merge(fromEvent(document, PAGE_CHANGE), timer(300))
        .pipe(debounceTime(450), take(1))
        .subscribe(() => resolve());
    });
  }

  function liveMatches(query: string) {
    const root = document.querySelector('.book-content');

    if (!root) {
      return [];
    }

    const index = buildBookTextIndex(root, true);

    return findMatches(index, query, 5000)
      .matches.map((match) => ({ match, range: matchRange(index, match, document) }))
      .filter((m): m is { match: typeof m.match; range: Range } => !!m.range);
  }

  /**
   * After a search jump, makes sure the match is on screen and marks it until the next page
   * change. The reader places a position by text node, so a match inside a long paragraph can
   * land one page off: paginated mode then turns at most one page each way (noted as
   * settling, so it never starts the tracker or sets Reading); continuous mode scrolls the
   * exact occurrence (the whole book is on the page there) into view.
   */
  async function revealSearchMatch(query: string, position: number) {
    clearSearchMark?.();
    await pageSettled();

    const visible = await bringOnScreen(
      () => liveMatches(query).map((m) => m.range),
      () => liveMatches(query).find((m) => m.match.position === position)?.range
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const highlights = (globalThis as any).CSS?.highlights as Map<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const HighlightCtor = (globalThis as any).Highlight as
      | (new (...r: Range[]) => unknown)
      | undefined;

    if (!highlights || !HighlightCtor || !visible.length) {
      return;
    }

    highlights.set('ttu-search', new HighlightCtor(...visible));
    const nextTurn = fromEvent(document, PAGE_CHANGE)
      .pipe(take(1))
      .subscribe(() => clearSearchMark?.());
    clearSearchMark = () => {
      nextTurn.unsubscribe();
      highlights.delete('ttu-search');
      clearSearchMark = undefined;
    };
  }

  /**
   * After a jump to a place found in the text (search, highlight), makes sure it is on
   * screen. The reader places a position by text node, so a place inside a long paragraph
   * can land one page off: paginated mode then turns at most one page each way (noted as
   * settling, so it never starts the tracker or sets Reading); continuous mode scrolls the
   * exact range (the whole book is on the page there) into view. Returns the ranges of
   * `find` that are on screen.
   */
  async function bringOnScreen(find: () => Range[], exact: () => Range | undefined) {
    let visible = find().filter(isOnScreen);

    if (!visible.length && isPaginated && pageManager) {
      const manager = pageManager;
      const turn = async (step: 'prev' | 'next') => {
        autoStartGate?.noteSettling(Date.now());
        statusGate?.noteSettling(Date.now());

        if (step === 'prev') {
          manager.prevPage();
        } else {
          manager.nextPage();
        }

        await pageSettled();
        return find().filter(isOnScreen);
      };

      // Most often the place starts on the page before the one the position lands on.
      visible = await turn('prev');

      if (!visible.length) {
        await turn('next');
        visible = await turn('next');

        if (!visible.length) {
          await turn('prev');
        }
      }
    } else if (!visible.length && !isPaginated) {
      const target = exact()?.startContainer.parentElement;

      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'center' });
        await pageSettled();
        visible = find().filter(isOnScreen);
      }
    }

    return visible;
  }

  // -------------------------------------------------------------------------
  // WP11a: highlights and notes. Isolated in ReaderHighlights: painted with the CSS Custom
  // Highlight API (no DOM changes), shown only for selections the user made (long-press,
  // mouse drag), and never in the way of taps, Yomitan or page turns. Failures are logged.

  let readerHighlights: ReaderHighlights | undefined;

  let highlightBarState: Readable<BarState> = readable<BarState>({
    mode: 'hidden',
    colors: [],
    message: ''
  });

  $: readerHighlights?.attach(bookContentEl);

  function highlightLastColor(): HighlightColor {
    const color = Number($highlightLastColor$);
    return isHighlightColor(color) ? color : 1;
  }

  function startHighlights(localId: number, title: string) {
    if (readerHighlights || !browser) {
      return;
    }

    try {
      const controller = new ReaderHighlights({
        root: () => document.querySelector('.book-content'),
        base: () => bookmarkManager?.sectionStartCount?.() ?? 0,
        wholeIndex: getSearchIndex,
        chapterAt: (position) => chapterLabelAt(sectionList$.getValue(), position) ?? null,
        resolveBookId: async () =>
          (await import('$lib/sync/sync-service')).bookIdForLocalBook(localId, title),
        api: async () => (await import('$lib/sync/sync-service')).notesApi(),
        refindChars: () => $highlightRefindChars$,
        anySelection: () => $highlightBarAnySelection$,
        lastColor: highlightLastColor,
        setLastColor: (color) => highlightLastColor$.next(color),
        editNote: (item) => void openNoteEditor(item),
        warn: (message) => logger.warn(message)
      });
      readerHighlights = controller;
      highlightBarState = controller.bar;
      controller.attach(bookContentEl);
      void controller.start();
      void consumePendingJump(controller);
    } catch (error) {
      logger.warn(`Highlights: ${(error as Error)?.message ?? error}`);
    }
  }

  /**
   * WP11c: "Open in book" on the Notes page or in the Library left a jump to a highlight.
   * Like a jump from the panel: recorded (the return marker leads back), not saved. A
   * highlight this device can't place opens at its stored position, with a notice.
   */
  async function consumePendingJump(controller: ReaderHighlights) {
    try {
      await controller.loaded;

      if (readerHighlights !== controller) {
        return;
      }

      const jump = takePendingJump(controller.bookId);

      if (!jump) {
        return;
      }

      const id = jump.highlightId;
      const place = id ? controller.placeOf(id) : undefined;

      if (id && place === null) {
        openNotice = "Couldn't place this highlight in the current file; opened at its old place.";
      } else if (id && place === undefined) {
        openNotice = 'This highlight was removed; opened at its old place.';
      }

      jumpToPosition(place ?? jump.position, { save: false, record: true });

      if (id && typeof place === 'number') {
        await pageSettled();
        await bringOnScreen(
          () => {
            const range = readerHighlights?.rangeOf(id);
            return range ? [range] : [];
          },
          () => readerHighlights?.rangeOf(id)
        );
      }
    } catch (error) {
      logger.warn(`Highlights: ${(error as Error)?.message ?? error}`);
    }
  }

  function stopHighlights() {
    readerHighlights?.destroy();
    readerHighlights = undefined;
    highlightBarState = readable<BarState>({ mode: 'hidden', colors: [], message: '' });
  }

  async function openNoteEditor(item: HighlightItem) {
    if (dialogManager.dialogs$.getValue().length) {
      return;
    }

    const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
    pauseTracker();
    const keysWereSkipped = $skipKeyDownListener$;
    skipKeyDownListener$.next(true);

    const answer = await new Promise<
      { action: 'save'; body: string } | { action: 'remove' } | null
    >((resolver) => {
      dialogManager.dialogs$.next([
        {
          component: NoteEditorDialog,
          disableCloseOnClick: true,
          props: {
            heading: item.note ? 'Edit note' : 'Note',
            quote: quoteOf(item.text),
            body: item.note?.body ?? '',
            canRemove: !!item.note,
            resolver
          }
        }
      ]);
    });

    skipKeyDownListener$.next(keysWereSkipped);

    if (answer) {
      try {
        const { notesApi } = await import('$lib/sync/sync-service');
        await notesApi().saveNote(
          { bookId: item.bookId, highlight: item, noteId: item.note?.id },
          answer.action === 'save' ? answer.body : ''
        );
      } catch (error) {
        logger.warn(`Highlights: ${(error as Error)?.message ?? error}`);
      }
    }

    if ($statisticsEnabled$ && !wasPaused) {
      restartTrackerAfterCharacterChangeOrTime(1);
    }
  }

  /** WP19d: the book's cover for quote images (an object URL, revoked when the reader closes). */
  let quoteCoverUrl: string | null | undefined;

  function quoteCover(): string | null {
    if (quoteCoverUrl !== undefined) {
      return quoteCoverUrl;
    }

    const cover = $rawBookData$?.coverImage;
    quoteCoverUrl =
      cover instanceof Blob ? URL.createObjectURL(cover) : typeof cover === 'string' ? cover : null;
    return quoteCoverUrl;
  }

  /**
   * WP19d: "Quote image" in the highlight bar. Like the note editor: the tracker pauses and
   * keys don't turn pages while the dialog is open. Any failure is logged, never thrown, so
   * it can't get in the way of reading. The author is the one this device remembers for
   * the book (from the library); the dialog asks the server for a newer one.
   */
  async function openQuoteImage() {
    try {
      if (dialogManager.dialogs$.getValue().length) {
        return;
      }

      const quote = readerHighlights?.chooseQuote();

      if (!quote) {
        return;
      }

      const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
      pauseTracker();
      const keysWereSkipped = $skipKeyDownListener$;
      skipKeyDownListener$.next(true);

      let author = '';
      let refreshAuthor: (() => Promise<string | null>) | null = null;
      const localId = $rawBookData$?.id;

      if (typeof localId === 'number') {
        try {
          const { readerQuoteAuthor } = await import('$lib/library/reader-quote-author');
          const found = await readerQuoteAuthor(localId);
          author = found.author;
          refreshAuthor = found.refresh;
        } catch (error) {
          logger.warn(`Quote image author: ${(error as Error)?.message ?? error}`);
        }
      }

      dialogManager.dialogs$.next([
        {
          component: QuoteImageDialog,
          props: {
            content: {
              text: quote.text,
              note: quote.note,
              title: $rawBookData$?.title ?? '',
              author,
              color: quote.color,
              coverUrl: quoteCover()
            },
            refreshAuthor
          }
        }
      ]);
      const subscription = dialogManager.dialogs$.subscribe((dialogs) => {
        if (dialogs.length) {
          return;
        }

        queueMicrotask(() => subscription.unsubscribe());
        skipKeyDownListener$.next(keysWereSkipped);

        if ($statisticsEnabled$ && !wasPaused) {
          restartTrackerAfterCharacterChangeOrTime(1);
        }
      });
    } catch (error) {
      logger.warn(`Quote image: ${(error as Error)?.message ?? error}`);
    }
  }

  async function openNotes(initialTab: 'notes' | 'bookmarks' = 'notes') {
    showHeader = false;
    const controller = readerHighlights;

    if (dialogManager.dialogs$.getValue().length || !controller || !$bookData$) {
      return;
    }

    const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
    pauseTracker();
    const keysWereSkipped = $skipKeyDownListener$;
    skipKeyDownListener$.next(true);

    try {
      const { notesApi } = await import('$lib/sync/sync-service');
      const api = notesApi();
      const answer = await new Promise<NotesPanelAnswer>((resolver) => {
        dialogManager.dialogs$.next([
          {
            component: NotesPanel,
            disableCloseOnClick: true,
            props: {
              view: controller.view,
              bookId: controller.bookId,
              total: bookCharCount,
              sections: sectionList$.getValue(),
              canPaint: controller.supported,
              eink: $einkMode$,
              returnMarker: returnMarker.position ?? null,
              initialTab,
              actions: {
                setColor: api.setColor,
                saveNote: api.saveNote,
                removeHighlight: api.removeHighlight,
                removeNote: api.removeNote,
                renameBookmark: api.renameBookmark,
                removeBookmark: api.removeBookmark,
                clearReturnMarker
              },
              resolver
            }
          }
        ]);
      });

      skipKeyDownListener$.next(keysWereSkipped);

      if (answer?.kind === 'return') {
        returnToMarker();
      } else if (answer?.kind === 'add-bookmark') {
        if ($statisticsEnabled$ && !wasPaused) {
          restartTrackerAfterCharacterChangeOrTime(1);
        }

        void addBookmarkHere();
        return;
      } else if (answer?.kind === 'jump') {
        // Like search: recorded in the jump history, saved by the next page turn.
        jumpToPosition(answer.position, { save: false, record: true });

        if (answer.highlightId) {
          const id = answer.highlightId;
          await pageSettled();
          await bringOnScreen(
            () => {
              const range = readerHighlights?.rangeOf(id);
              return range ? [range] : [];
            },
            () => readerHighlights?.rangeOf(id)
          );
        }
      }
    } catch (error) {
      skipKeyDownListener$.next(keysWereSkipped);
      logger.warn(`Highlights: ${(error as Error)?.message ?? error}`);
    }

    if ($statisticsEnabled$ && !wasPaused) {
      restartTrackerAfterCharacterChangeOrTime(1);
    }
  }

  /** Keys for highlights; true when the key was used. */
  function onHighlightKey(ev: KeyboardEvent) {
    const controller = readerHighlights;

    if (!controller || isTypingTarget(ev.target)) {
      return false;
    }

    if (controller.barOpen) {
      if (ev.key === 'Escape') {
        controller.close();
        return true;
      }

      const digit = Number(ev.key);

      if (isHighlightColor(digit)) {
        void controller.chooseColor(digit);
        return true;
      }
    }

    const map = bookReaderKeybindMap$.getValue();
    const key = ev.key.toLowerCase();

    if (key === 'h' && !map.KeyH && !map.h) {
      void controller.highlightSelection();
      return true;
    }

    if (key === 'l' && !map.KeyL && !map.l) {
      void openNotes();
      return true;
    }

    // WP11b: K adds a bookmark at the page you are on.
    if (key === 'k' && !map.KeyK && !map.k) {
      void addBookmarkHere();
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // WP10a: Zen mode, the `?` cheat sheet, two-finger tap and mouse-drag page turns.

  /** Zen mode hides the bottom bar only; the tracker, audio and every key keep working. */
  function toggleZen() {
    showHeader = false;
    zenMode$.next(!zenMode$.getValue());
  }

  async function openShortcuts() {
    showHeader = false;

    if (dialogManager.dialogs$.getValue().length) {
      return;
    }

    const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
    pauseTracker();
    const keysWereSkipped = $skipKeyDownListener$;
    skipKeyDownListener$.next(true);

    await new Promise<void>((resolver) => {
      dialogManager.dialogs$.next([
        {
          component: ShortcutsDialog,
          disableCloseOnClick: true,
          props: {
            groups: readerShortcutGroups({
              keybindMap: bookReaderKeybindMap$.getValue(),
              paginated: isPaginated,
              verticalMode: $verticalMode$,
              tapEdgeToFlip: $enableTapEdgeToFlip$,
              mouseDragPageTurn: $mouseDragPageTurn$,
              statisticsEnabled: $statisticsEnabled$
            }),
            resolver
          }
        }
      ]);
    });

    skipKeyDownListener$.next(keysWereSkipped);

    if ($statisticsEnabled$ && !wasPaused) {
      restartTrackerAfterCharacterChangeOrTime(1);
    }
  }

  const twoFingerTap = new TwoFingerTapDetector({
    ...DEFAULT_TWO_FINGER_TAP_OPTIONS,
    // No more movement than a swipe needs, so a two-finger tap never turns the page.
    getMaxMove: () => swipeThreshold$.getValue()
  });

  /** Clicks that end a two-finger tap or a mouse-drag page turn are swallowed until then. */
  let swallowClicksUntil = 0;

  /** `offText`: the drag started on blank space, so it must not start a text selection. */
  let mouseDrag: { x: number; y: number; at: number; offText: boolean } | undefined;

  /** The page itself (text or blank space around it), not a bar, menu or dialog. */
  function isReaderSurface(target: EventTarget | null) {
    if (!(target instanceof Element)) {
      return false;
    }

    if (target === document.body || target === document.documentElement) {
      return true;
    }

    return !!target.closest('.book-content');
  }

  function onReaderPointerDown(ev: PointerEvent) {
    if (ev.pointerType === 'touch') {
      twoFingerTap.down(ev.pointerId, ev.clientX, ev.clientY, performance.now());
      return;
    }

    mouseDrag = undefined;

    if (
      ev.pointerType !== 'mouse' ||
      ev.button !== 0 ||
      ev.altKey ||
      ev.ctrlKey ||
      ev.metaKey ||
      ev.shiftKey ||
      !$mouseDragPageTurn$ ||
      $skipKeyDownListener$ ||
      isSelectingCustomReadingPoint ||
      !isReaderSurface(ev.target)
    ) {
      return;
    }

    mouseDrag = {
      x: ev.clientX,
      y: ev.clientY,
      at: performance.now(),
      offText: !isPointOverText(document, ev.clientX, ev.clientY)
    };
  }

  /** A drag that started on blank space turns pages instead of selecting text. */
  function blockOffTextSelection(ev: Event) {
    if (mouseDrag?.offText) {
      ev.preventDefault();
    }
  }

  function onReaderPointerMove(ev: PointerEvent) {
    if (ev.pointerType === 'touch') {
      twoFingerTap.move(ev.pointerId, ev.clientX, ev.clientY, performance.now());
    }
  }

  function onReaderPointerUp(ev: PointerEvent) {
    const now = performance.now();

    if (ev.pointerType === 'touch') {
      if (twoFingerTap.up(ev.pointerId, ev.clientX, ev.clientY, now)) {
        swallowClicksUntil = now + 500;

        // Not while a dialog, the tracker menu or another overlay has the keys.
        if (!$skipKeyDownListener$) {
          toggleZen();
        }
      }

      return;
    }

    const drag = mouseDrag;
    mouseDrag = undefined;

    if (!drag || ev.pointerType !== 'mouse' || $skipKeyDownListener$ || !pageManager) {
      return;
    }

    const selection = window.getSelection();
    const decision = decideMouseDrag({
      dx: ev.clientX - drag.x,
      dy: ev.clientY - drag.y,
      durationMs: now - drag.at,
      selectionCollapsed: !selection || selection.isCollapsed,
      threshold: $mouseDragThreshold$,
      paginated: isPaginated,
      swipeThreshold: $swipeThreshold$,
      verticalMode: $verticalMode$
    });

    if (!decision) {
      return;
    }

    swallowClicksUntil = now + 400;

    if (decision === 'next') {
      pageManager.nextPage();
    } else {
      pageManager.prevPage();
    }
  }

  function onReaderPointerCancel(ev: PointerEvent) {
    if (ev.pointerType === 'touch') {
      twoFingerTap.cancel(ev.pointerId, performance.now());
    } else {
      mouseDrag = undefined;
    }
  }

  function swallowGestureClick(ev: MouseEvent) {
    const now = performance.now();

    if (now < swallowClicksUntil || now - twoFingerTap.lastMultiTouchAt < 500) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }

  async function handleJump() {
    const dataId = getBookIdSync();

    if (!bookmarkManager || !dataId) {
      return;
    }

    pauseTracker();
    skipKeyDownListener$.next(true);

    const target = await new Promise<number | undefined>((resolver) => {
      dialogManager.dialogs$.next([
        {
          component: NumberDialog,
          props: {
            dialogHeader: 'Jump to Position',
            minValue: 1,
            maxValue: bookCharCount || 1,
            resolver
          }
        }
      ]);
    });

    skipKeyDownListener$.next(false);

    if (typeof target !== 'number') {
      restartTrackerAfterCharacterChangeOrTime(1);
      return;
    }

    restartTrackerAfterCharacterChangeOrTime(1000);

    recordJump();
    bookmarkManager.scrollToBookmark(
      {
        dataId: dataId,
        exploredCharCount: target,
        lastBookmarkModified: new Date().getTime(),
        progress: 0
      },
      customReadingPointScrollOffset
    );
  }

  async function completeBook() {
    if (!$rawBookData$) {
      return;
    }

    const wasAutoscrollerEnabled = autoScroller?.wasAutoScrollerEnabled$.getValue();
    const wasTrackerPausedBefore = $statisticsEnabled$ ? $isTrackerPaused$ : true;

    showHeader = false;
    autoScroller?.off();

    if ($statisticsEnabled$) {
      wasTrackerPaused = true;
      isTrackerPaused$.next(true);
    }

    const diffToComplete =
      $statisticsEnabled$ && $addCharactersOnCompletion$
        ? Math.max(0, bookCharCount - exploredCharCount)
        : 0;
    // WP19: closing the dialog any other way (backdrop, Esc) is Cancel too, so the tracker
    // and auto scroll always come back.
    const confirmed = await confirmDestructive(completeBookCopy(diffToComplete));

    if (!confirmed) {
      if ($statisticsEnabled$ && !wasTrackerPausedBefore) {
        wasTrackerPaused = false;
        $isTrackerPaused$ = false;
      }

      if (wasAutoscrollerEnabled) {
        autoScroller?.toggle();
      }

      return;
    }

    dialogManager.dialogs$.next([
      {
        component: '<div/>',
        disableCloseOnClick: true
      }
    ]);

    try {
      // WP12: the read-through (below) is the only completion record; no stat row is
      // marked. The characters left count as read today, never as time or speed.
      if (diffToComplete && trackerElm && !(await trackerElm.recordCompletion(diffToComplete))) {
        logger.warn('Stats: the completion characters will be saved on the next try');
      }

      if (bookmarkManager) {
        const data = {
          ...bookmarkManager.formatBookmarkData($rawBookData$.id, customReadingPointScrollOffset),
          exploredCharCount: Math.max(0, bookCharCount - 1),
          progress: 1
        };

        await database.putBookmark(data);

        recordShadowPosition($rawBookData$.id, $rawBookData$.title, data);

        bookmarkData = Promise.resolve(data);
      }

      // WP8a: also Completed, finishing the read-through as a tracked one. Fire
      // and forget; the tracker then shows the new completion (WP12).
      noteBookCompletedForStatus($rawBookData$.id, $rawBookData$.title).then(() =>
        trackerElm?.refreshCompletion()
      );

      if ($statisticsEnabled$ && $openTrackerOnCompletion$) {
        confettiWidthModifier = 36;
        confettiMaxRuns = 0;
        bookCompleted = window.matchMedia('(min-width: 900px)').matches;
        isTrackerMenuOpen$.next(true);
      } else {
        dialogManager.dialogs$.next([]);
        confettiWidthModifier = 0;
        confettiMaxRuns = 3;
        bookCompleted = true;

        merge(fromEvent(document, 'pointerup'), timer(10000))
          .pipe(take(1))
          .subscribe(() => {
            bookCompleted = false;
          });
      }
    } catch ({ message }: any) {
      dialogManager.dialogs$.next([
        {
          component: MessageDialog,
          props: {
            title: 'Error',
            message: `Error completing Book: ${message}`
          }
        }
      ]);
    }
  }

  function scheduleTimeLeft(mode: string, _position: number, _total: number) {
    clearTimeout(timeLeftTimer);

    if (!browser || mode === 'off') {
      timeLeftText = '';
      return;
    }

    timeLeftTimer = setTimeout(() => updateTimeLeft(mode), 600);
  }

  /** Recent speed in this book (every device), else overall; never blocks reading. */
  async function updateTimeLeft(mode: string) {
    try {
      if (!$rawBookData$ || !bookCharCount) return;

      const sync = await import('$lib/sync/sync-service');
      const bookId =
        stateBookId ?? (await sync.bookIdForLocalBook($rawBookData$.id, $rawBookData$.title));
      const entries = await sync.statsApi().allEntries();
      const estimate = speedEstimate(
        bookId ?? '',
        entries,
        Math.max(1, Number($timeLeftRecentMinutes$) || 60) * 60,
        Math.max(0, Number($timeLeftMinMinutes$) || 0) * 60
      );
      const book = formatTimeLeft(secondsLeft(bookCharCount - exploredCharCount, estimate));
      let chapter = '–';

      if ($sectionData$?.length) {
        const [mainChapters, chapterIndex] = getChapterData($sectionData$);
        const current = mainChapters[chapterIndex];

        if (current) {
          chapter = formatTimeLeft(
            secondsLeft(
              (current.startCharacter ?? 0) + (current.characters ?? 0) - exploredCharCount,
              estimate
            )
          );
        }
      }

      if ($bottomBarTimeLeft$ !== mode) return;

      timeLeftText =
        mode === 'chapter'
          ? `Chapter ${chapter}`
          : mode === 'book'
            ? `Book ${book}`
            : `Chapter ${chapter} · Book ${book}`;
    } catch (error: any) {
      logger.warn(`Stats: time left: ${error?.message ?? error}`);
    }
  }

  function getCurrentChapterProgress(sectionData: SectionWithProgress[]) {
    if (
      (!$showFooterChapterCharacterCounter$ && !$showFooterChapterPercentage$) ||
      !sectionData?.length
    ) {
      return '';
    }

    let chapterProgress = '';
    let chapterCharacters = '';

    const [mainChapters, chapterIndex, referenceId] = getChapterData($sectionData$);

    if ($showFooterChapterPercentage$) {
      const relevantSections = sectionData.filter(
        (section) => section.reference === referenceId || section.parentChapter === referenceId
      );

      chapterProgress = `${getWeightedAverage(
        relevantSections.map((section) => section.progress),
        relevantSections.map((section) => section.charactersWeight)
      ).toFixed(2)}%`;
    }

    if ($showFooterChapterCharacterCounter$) {
      const currentChapter = mainChapters[chapterIndex];

      if (currentChapter) {
        const endCharacter = currentChapter.characters as number;

        chapterCharacters = `${Math.min(
          Math.max(exploredCharCount - (currentChapter.startCharacter as number), 0),
          endCharacter
        )} / ${endCharacter}`;
      }
    }

    return [chapterCharacters, chapterProgress, 'C'].filter(Boolean).join(' ');
  }

  function copyCurrentProgress(currentProgress: string) {
    try {
      navigator.clipboard.writeText(currentProgress);
    } catch (error: any) {
      logger.error(`Error writing Progress to Clipboard: ${error.message}`);
    }
  }

  function freezeTrackerPosition() {
    if (!$statisticsEnabled$) {
      return;
    }

    if (frozenPosition > -1) {
      frozenPosition = -1;
    } else {
      skipFirstFreezeChange = true;
      frozenPosition = exploredCharCount;
    }
  }

  function onKeydown(ev: KeyboardEvent) {
    // WP10a: `?` is Shift+/ on most layouts, so it is checked before the modifier guard.
    if (
      ev.key === '?' &&
      !$skipKeyDownListener$ &&
      !ev.altKey &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.repeat &&
      !isTypingTarget(ev.target)
    ) {
      ev.preventDefault();
      openShortcuts();
      return;
    }

    if (
      $skipKeyDownListener$ ||
      ev.altKey ||
      ev.ctrlKey ||
      ev.shiftKey ||
      ev.metaKey ||
      ev.repeat
    ) {
      return;
    }

    // WP10b: matched by the typed character, so `[` and `]` work on any keyboard layout.
    if ((ev.key === '[' || ev.key === ']') && !isTypingTarget(ev.target)) {
      ev.preventDefault();
      goJumpHistory(ev.key === '[' ? 'back' : 'forward');
      return;
    }

    // WP10c: `/` opens the search (by the typed character, like `[` and `]`).
    if (ev.key === '/' && !isTypingTarget(ev.target)) {
      ev.preventDefault();
      openSearch();
      return;
    }

    // WP11a: H highlights the selection, L opens the notes, 1-5 / Esc while the bar is open.
    if (onHighlightKey(ev)) {
      ev.preventDefault();
      return;
    }

    const result = onKeydownReader(
      ev,
      bookReaderKeybindMap$.getValue(),
      bookmarkPage,
      scrollToBookmark,
      (x) => multiplier$.next(multiplier$.getValue() + x),
      autoScroller,
      pageManager,
      $verticalMode$,
      changeChapter,
      handleSetCustomReadingPoint,
      toggleTrackerManually,
      freezeTrackerPosition,
      toggleZen,
      () => void enrichAnkiCard()
    );

    if (!result) return;

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    ev.preventDefault();
  }

  function isTypingTarget(target: EventTarget | null) {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
  }

  function getBookIdSync() {
    let bookId: number | undefined;
    bookId$.subscribe((x) => (bookId = x)).unsubscribe();
    return bookId;
  }

  async function bookmarkPage() {
    const bookId = getBookIdSync();
    if (!bookId || !bookmarkManager) return;

    let data: BooksDbBookmarkData;

    showHeader = false;

    if (isPaginated) {
      const userSelectedRange = $selectionToBookmarkEnabled$
        ? getRangeForUserSelection(window, lastSelectedRange)
        : undefined;
      const bookmarkRange = userSelectedRange || customReadingPointRange;

      pulseElement(bookmarkRange?.endContainer?.parentElement, 'add', 0.5, 500);

      data = bookmarkManager.formatBookmarkDataByRange(bookId, bookmarkRange);

      if (userSelectedRange) {
        clearRange(window);
      }
    } else {
      data = bookmarkManager.formatBookmarkData(bookId, customReadingPointScrollOffset);
    }

    await database.putBookmark(data);

    if ($rawBookData$) recordShadowPosition(bookId, $rawBookData$.title, data);

    bookmarkData = Promise.resolve(data);
  }

  /**
   * Record sync (WP4): also note this device's position for Calibre books.
   * Fire and forget; loaded on demand so the reader never depends on it.
   * The bookmark above stays the source of truth.
   */
  function recordShadowPosition(localId: number, title: string, data: BooksDbBookmarkData) {
    import('$lib/sync/sync-service')
      .then(({ recordReaderPosition }) => recordReaderPosition(localId, title, data))
      .catch(() => {});
  }

  /**
   * "Continue from...?" (WP9): once the saved place is restored, offer another
   * device's place when it is further along (Calibre books only). Loaded on
   * demand and isolated: any failure is logged and reading goes on unchanged.
   */
  let positionPrompt: ReaderPositionPrompt | undefined;
  let positionPromptStarted = false;
  let positionPromptStopped = false;
  let restorePromptKeys: (() => void) | undefined;

  /** WP13: the book has been placed on the page once (a late font then lays out again). */
  let firstPositionRestored = false;

  async function onPositionRestored() {
    firstPositionRestored = true;

    // WP10e: the reader was reopened in place for a layout change; return to where it was.
    if (remountTarget !== undefined) {
      // A view mode change shows the new mode before the book is formatted for it; only the
      // restore after the reformatted book counts.
      if (!awaitingBookHtml) {
        finishRemount();
      }

      return;
    }

    // WP11a: highlights start once the book is on the page.
    if (browser && $rawBookData$ && !readerHighlights) {
      startHighlights($rawBookData$.id, $rawBookData$.title);
    }

    if (!browser || positionPromptStarted || !$rawBookData$) return;
    positionPromptStarted = true;
    try {
      const { id: localId, title } = $rawBookData$;
      let restoredPos = (await bookmarkData)?.exploredCharCount ?? 0;
      const [{ positionPromptApi }, { ReaderPositionPrompt }] = await Promise.all([
        import('$lib/sync/sync-service'),
        import('$lib/sync/reader-position-prompt')
      ]);
      if (positionPromptStopped) return;

      // WP8a: a Start over not applied on this device yet opens the book at the
      // start, before "Continue from...?" looks at other devices' places.
      if (await startOverOnOpen(localId, title, restoredPos)) restoredPos = 0;
      if (positionPromptStopped) return;

      positionPrompt = new ReaderPositionPrompt(positionPromptApi(), {
        livePos: () => exploredCharCount,
        total: () => bookCharCount,
        otherDialogOpen: () => dialogManager.dialogs$.getValue().length > 0,
        onDialogsClosed: (callback) => {
          const sub = dialogManager.dialogs$
            .pipe(filter((dialogs) => !dialogs.length))
            .subscribe(() => callback());
          return () => sub.unsubscribe();
        },
        onVisible: (callback) => {
          const listener = () => {
            if (document.visibilityState === 'visible') callback();
          };
          document.addEventListener('visibilitychange', listener);
          return () => document.removeEventListener('visibilitychange', listener);
        },
        ask: askPositionPrompt,
        jump: jumpToPromptedPosition,
        warn: (message) => logger.warn(message)
      });
      void positionPrompt.start(localId, title, restoredPos);
    } catch (error) {
      logger.warn(`Position prompt not started: ${(error as Error)?.message ?? error}`);
    }
  }

  function stopPositionPrompt() {
    positionPromptStopped = true;
    try {
      positionPrompt?.destroy();
      restorePromptKeys?.();
      const dialogs = dialogManager.dialogs$.getValue();
      if (dialogs.some((d) => d.component === PositionPromptDialog)) {
        dialogManager.dialogs$.next(dialogs.filter((d) => d.component !== PositionPromptDialog));
      }
    } catch {
      // never disturb leaving the reader
    }
  }

  function askPositionPrompt(prompt: PositionPrompt) {
    return new Promise<PromptRow | null>((resolve) => {
      const keysWereSkipped = $skipKeyDownListener$;
      skipKeyDownListener$.next(true);
      restorePromptKeys = () => {
        restorePromptKeys = undefined;
        skipKeyDownListener$.next(keysWereSkipped);
      };
      dialogManager.dialogs$.next([
        {
          component: PositionPromptDialog,
          props: {
            prompt,
            livePos: exploredCharCount,
            total: bookCharCount,
            sections: sectionList$.getValue(),
            resolver: (row: PromptRow | null) => {
              restorePromptKeys?.();
              resolve(row);
            }
          },
          disableCloseOnClick: true
        }
      ]);
    });
  }

  // -------------------------------------------------------------------------
  // WP8a: book state (status, read-throughs, Start over). Isolated like the
  // prompt: every failure is logged and reading goes on unchanged.
  // -------------------------------------------------------------------------

  function noteBookCompletedForStatus(localId: number, title: string): Promise<void> {
    return import('$lib/sync/sync-service')
      .then(({ noteReaderBookCompleted }) => noteReaderBookCompleted(localId, title))
      .catch(() => {});
  }

  /** Resolves the catalog id, applies a pending Start over, and watches for new ones. */
  async function startOverOnOpen(localId: number, title: string, restoredPos: number) {
    try {
      const sync = await import('$lib/sync/sync-service');
      stateBookId = await sync.bookIdForLocalBook(localId, title);
      if (!stateBookId || positionPromptStopped) return false;
      const bookId = stateBookId;

      const off = await sync.bookStateApi().onChanged(
        (ids) => {
          if (ids.has(bookId)) void applyStartOverNow(bookId);
        },
        { remoteOnly: true }
      );
      if (positionPromptStopped) off();
      else stopStartOverWatch = off;

      return await applyPendingStartOver(bookId, restoredPos);
    } catch (error) {
      logger.warn(`Book state: ${(error as Error)?.message ?? error}`);
      return false;
    }
  }

  /** A sync brought a Start over for the open book (made on another device). */
  async function applyStartOverNow(bookId: string) {
    if (await applyPendingStartOver(bookId, exploredCharCount)) {
      void positionPrompt?.check(false);
    }
  }

  async function applyPendingStartOver(bookId: string, place: number) {
    try {
      const { readerPendingStartOver } = await import('$lib/sync/sync-service');
      const readThrough = await readerPendingStartOver(bookId, place);
      if (!readThrough || positionPromptStopped) return false;
      jumpToStart();
      startOverNotice = `Started over${
        readThrough.startedOn ? ` on ${readThrough.startedOn}` : ''
      }: reading again from the beginning.`;
      return true;
    } catch (error) {
      logger.warn(`Book state: ${(error as Error)?.message ?? error}`);
      return false;
    }
  }

  /**
   * Start over: to the first character, saved as the bookmark with the same
   * steps as the prompt's jump (local bookmark, position record carrying the
   * new read-through, old-sync upload), so old and new data agree. Saved also
   * with Manual Bookmark on: Start over is an explicit action.
   */
  function jumpToStart() {
    const dataId = getBookIdSync();
    if (!bookmarkManager || !dataId) return;

    const now = Date.now();
    autoStartGate?.noteSettling(now);
    statusGate?.noteSettling(now);
    if ($statisticsEnabled$ && !$isTrackerPaused$) {
      pauseTracker();
      restartTrackerAfterCharacterChangeOrTime(0);
    }

    // Character 1 is the first page in both modes (0 means "no bookmark" to the managers).
    bookmarkManager.scrollToBookmark(
      { dataId, exploredCharCount: 1, lastBookmarkModified: now, progress: 0 },
      customReadingPointScrollOffset
    );
    void saveJumpBookmark({ dataId, exploredCharCount: 0, lastBookmarkModified: now, progress: 0 });
  }

  /** WP8b: the lists this catalog book is in, like Book status (tracker paused, keys off). */
  async function openAddToCollection() {
    const bookId = stateBookId;
    if (!bookId || !$rawBookData$) return;
    showHeader = false;
    try {
      const { collectionsApi } = await import('$lib/sync/sync-service');
      const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
      pauseTracker();
      const keysWereSkipped = $skipKeyDownListener$;
      skipKeyDownListener$.next(true);
      await new Promise<void>((resolver) => {
        dialogManager.dialogs$.next([
          {
            component: AddToCollectionDialog,
            disableCloseOnClick: true,
            props: {
              bookId,
              title: $rawBookData$?.title ?? '',
              api: collectionsApi(),
              resolver
            }
          }
        ]);
      });
      skipKeyDownListener$.next(keysWereSkipped);
      if ($statisticsEnabled$ && !wasPaused) restartTrackerAfterCharacterChangeOrTime(1);
    } catch (error) {
      logger.warn(`Collections: ${(error as Error)?.message ?? error}`);
    }
  }

  async function openBookState() {
    const bookId = stateBookId;
    if (!bookId || !$rawBookData$) return;
    showHeader = false;
    try {
      const { bookStateApi } = await import('$lib/sync/sync-service');
      const wasPaused = $statisticsEnabled$ ? $isTrackerPaused$ : true;
      pauseTracker();
      const keysWereSkipped = $skipKeyDownListener$;
      skipKeyDownListener$.next(true);
      const result = await new Promise<'start-over' | null>((resolver) => {
        dialogManager.dialogs$.next([
          {
            component: BookStateDialog,
            disableCloseOnClick: true,
            props: {
              bookId,
              title: $rawBookData$?.title ?? '',
              charCount: bookCharCount || null,
              api: bookStateApi(),
              inReader: true,
              resolver
            }
          }
        ]);
      });
      skipKeyDownListener$.next(keysWereSkipped);
      if (result === 'start-over') {
        jumpToStart();
      } else if ($statisticsEnabled$ && !wasPaused) {
        restartTrackerAfterCharacterChangeOrTime(1);
      }
    } catch (error) {
      logger.warn(`Book state: ${(error as Error)?.message ?? error}`);
    }
  }

  /** The prompt's one jump ("Back" in the jump history undoes it). */
  function jumpToPromptedPosition(row: PromptRow) {
    jumpToPosition(row.target, { save: !$manualBookmark$, record: true });
  }

  /**
   * WP9's jump, shared by "Continue there", jump-history back/forward and (WP10c) search.
   * `save` keeps the target as the bookmark at once; `record` adds the place it leaves from
   * to the jump history.
   */
  function jumpToPosition(target: number, { save, record }: { save: boolean; record: boolean }) {
    const dataId = getBookIdSync();
    if (!bookmarkManager || !dataId) return;

    if (record) {
      recordJump();
    }

    // The jump is not reading: before auto-start it only settles the book; a
    // running tracker pauses and resumes from the new place (nothing counted).
    autoStartGate?.noteSettling(Date.now());
    statusGate?.noteSettling(Date.now());
    if ($statisticsEnabled$ && !$isTrackerPaused$) {
      pauseTracker();
      restartTrackerAfterCharacterChangeOrTime(0);
    }

    const data: BooksDbBookmarkData = {
      dataId,
      exploredCharCount: target,
      lastBookmarkModified: Date.now(),
      progress: bookCharCount ? target / bookCharCount : 0
    };
    // Character 0 means "no bookmark" to the managers; 1 is the first page (as jumpToStart).
    bookmarkManager.scrollToBookmark(
      target < 1 ? { ...data, exploredCharCount: 1 } : data,
      customReadingPointScrollOffset
    );

    // Keep the new place as the bookmark right away (the same steps as
    // bookmarkPage, with the exact target, so a slow section load can't save
    // a place on the way). Manual bookmarking leaves that to the user, as
    // when leaving the reader.
    if (save) {
      void saveJumpBookmark(data);
    }
  }

  async function saveJumpBookmark(data: BooksDbBookmarkData) {
    try {
      await database.putBookmark(data);
      if ($rawBookData$) recordShadowPosition(data.dataId, $rawBookData$.title, data);
      bookmarkData = Promise.resolve(data);
    } catch (error) {
      logger.warn(`Could not save the bookmark: ${(error as Error)?.message ?? error}`);
    }
  }

  async function scrollToBookmark() {
    const data = await bookmarkData;
    if (!data || !bookmarkManager) return;

    if (data.exploredCharCount !== exploredCharCount) {
      pauseTracker(true);
      recordJump();
    }

    bookmarkManager.scrollToBookmark(data, customReadingPointScrollOffset);
  }

  function onFullscreenClick() {
    showHeader = false;

    if (!fullscreenManager.fullscreenElement) {
      fullscreenManager.requestFullscreen(document.documentElement);
      return;
    }
    fullscreenManager.exitFullscreen();
  }

  function onDomainHintClick() {
    dialogManager.dialogs$.next([
      {
        component: MessageDialog,
        props: {
          title: 'Old Domain',
          message:
            'You are currently using the old domain of ッツ Reader - consider switching to https://reader.ttsu.app to prevent issues and to ensure full features'
        },
        disableCloseOnClick: true
      }
    ]);
  }

  function changeChapter(offset: number) {
    if (!$sectionData$?.length) {
      return;
    }

    const [mainChapters, currentChapterIndex] = getChapterData($sectionData$);

    if (
      (!currentChapterIndex && offset === -1) ||
      (offset === 1 && currentChapterIndex === mainChapters.length - 1)
    ) {
      return;
    }

    const nextChapter = mainChapters[currentChapterIndex + offset];

    if (!nextChapter) {
      return;
    }

    if (nextChapter.startCharacter !== exploredCharCount) {
      pauseTracker(true);
    }

    nextChapter$.next(nextChapter.reference);
  }

  function openActionBackdrop() {
    dialogManager.dialogs$.next([
      {
        component: '<div/>',
        disableCloseOnClick: true
      }
    ]);
  }

  // Leaving for Home, Library or Collections forgets the last book; Settings and
  // Statistics keep it (WP7b, opening the app).
  async function leaveReader(routeId: string, deleteLastItem = leavingForgetsLastBook(routeId)) {
    let message;

    try {
      blockDataUpdates = true;

      await tick();

      autoScroller?.off();
      wasTrackerPaused = true;
      isTrackerPaused$.next(true);

      if ($confirmClose$ && storedExploredCharacter !== exploredCharCount) {
        const wasCanceled = await new Promise((resolver) => {
          dialogManager.dialogs$.next([
            {
              component: ConfirmDialog,
              props: {
                dialogHeader: 'Confirm Exit',
                dialogMessage: 'Your current location was not bookmarked. Continue leaving?',
                resolver
              },

              disableCloseOnClick: true
            }
          ]);
        });

        if (wasCanceled) {
          blockDataUpdates = false;
          return;
        }

        await tick();
      }

      openActionBackdrop();

      if (deleteLastItem) {
        await database.deleteLastItem();
      }

      if (!$manualBookmark$) {
        await bookmarkPage();
      }

      if ($statisticsEnabled$ && trackerElm) {
        const [hadError] = await trackerElm.flushUpdates(true);
        const sealed = await trackerElm.sealSession();

        // WP12: stats never block reading or leaving; the session is retried later.
        if (hadError || !sealed) {
          logger.warn('Stats: the reading session will be saved on the next try');
        }
      }

      dialogManager.dialogs$.next([]);
    } catch (error: any) {
      message = error.message;
    }

    if (message) {
      logger.error(message);

      dismissDialogs = false;
      dialogManager.dialogs$.next([
        {
          component: MessageDialog,
          props: {
            title: 'Error',
            message
          },
          disableCloseOnClick: true
        }
      ]);
    }

    goto(`${pagePath}${routeId}`);
  }

  function handleSetCustomReadingPoint() {
    if (!$customReadingPointEnabled$ && !isPaginated) {
      return;
    }

    const contentEl = document.querySelector('.book-content');

    if (!contentEl) {
      return;
    }

    autoScroller?.off();

    if ($pauseTrackerOnCustomPointChange$) {
      pauseTracker();
    }

    if (isPaginated) {
      customReadingPointTop = window.innerHeight / 2 - 2;
      customReadingPointLeft = window.innerWidth / 2 - 2;
    }

    showHeader = false;
    isSelectingCustomReadingPoint = true;
    document.body.classList.add('cursor-crosshair');

    const {
      elLeftReferencePoint,
      elTopReferencePoint,
      elRightReferencePoint,
      elBottomReferencePoint,
      pointGap
    } = getReferencePoints(window, contentEl, $verticalMode$, firstDimensionMargin);

    merge(fromEvent(document, 'pointerup'), fromEvent(document, 'pointermove'))
      // eslint-disable-next-line rxjs/no-ignored-takewhile-value
      .pipe(takeWhile(() => isSelectingCustomReadingPoint))
      .subscribe((event: Event) => {
        if (!(event instanceof PointerEvent)) {
          return;
        }

        if (event.type === 'pointerup') {
          document.body.classList.remove('cursor-crosshair');
          isSelectingCustomReadingPoint = false;

          tick().then(() => {
            customReadingPointLeft = $verticalMode$ ? event.x : customReadingPointLeft;
            customReadingPointTop = $verticalMode$ ? customReadingPointTop : event.y;

            const result = getParagraphToPoint(customReadingPointLeft, customReadingPointTop);

            if (result) {
              pulseElement(result.parent, 'add', 0.5, 500);
            }

            if (isPaginated) {
              customReadingPointRange = result?.range;
            } else {
              let newPercentage = 0;

              if ($verticalMode$) {
                newPercentage = Math.ceil(
                  (Math.max(0, customReadingPointLeft - elLeftReferencePoint) /
                    (elRightReferencePoint - elLeftReferencePoint)) *
                    100
                );

                verticalCustomReadingPosition$.next(newPercentage);
              } else {
                newPercentage = Math.ceil(
                  (Math.max(0, customReadingPointTop - elTopReferencePoint) /
                    (elBottomReferencePoint - elTopReferencePoint)) *
                    100
                );

                horizontalCustomReadingPosition$.next(newPercentage);
              }

              customReadingPoint = newPercentage;
            }

            if ($pauseTrackerOnCustomPointChange$) {
              restartTrackerAfterCharacterChangeOrTime(1000);
            }
          });
        } else {
          const insideXBound =
            event.x >= elLeftReferencePoint + pointGap && event.x <= elRightReferencePoint;
          const insideYBound =
            event.y >= elTopReferencePoint && event.y <= elBottomReferencePoint - pointGap;

          if (isPaginated) {
            customReadingPointTop = insideYBound ? event.y : customReadingPointTop;
            customReadingPointLeft = insideXBound ? event.x : customReadingPointLeft;
          } else if ($verticalMode$ && insideXBound) {
            customReadingPointLeft = event.x;
          } else if (!$verticalMode$ && insideYBound) {
            customReadingPointTop = event.y;
          }
        }
      });
  }

  function pauseTracker(restartAfterCharacterChange = false) {
    if ($statisticsEnabled$ && !$isTrackerPaused$) {
      wasTrackerPaused = false;
      $isTrackerPaused$ = true;

      if (restartAfterCharacterChange) {
        restartTrackerAfterCharacterChangeOrTime();
      }
    }
  }

  function restartTrackerAfterCharacterChangeOrTime(timerAmount = 0) {
    if (!$statisticsEnabled$ || wasTrackerPaused) {
      return;
    }

    merge(fromEvent(document, PAGE_CHANGE), timerAmount ? timer(timerAmount) : NEVER)
      .pipe(debounceTime(200), take(1))
      .subscribe(() => {
        wasTrackerPaused = false;
        $isTrackerPaused$ = false;
      });
  }
</script>

<svelte:head>
  <title>{formatPageTitle($rawBookData$?.title ?? '')}</title>
</svelte:head>

{$collectReaderImageGallerySpoilerToggles$ ?? ''}
{$handleUpdateImageGalleryPictureSpoilers$ ?? ''}
<button class="fixed inset-x-0 top-0 z-10 h-8 w-full" on:click={() => (showHeader = true)} />
{#if showHeader}
  <div
    class="elevation-4 writing-horizontal-tb fixed inset-x-0 top-0 z-10 w-full"
    transition:fly|local={{ y: -300, easing: quintInOut, duration: $einkMode$ ? 0 : 400 }}
    use:clickOutside={() => (showHeader = false)}
  >
    <BookReaderHeader
      hasChapterData={!!$sectionData$?.length}
      hasText={!!bookCharCount}
      hasCustomReadingPoint={!!(
        ($customReadingPointEnabled$ || isPaginated) &&
        ((isPaginated && customReadingPointRange) ||
          (!isPaginated && customReadingPointLeft > -1 && customReadingPointTop > -1))
      )}
      showFullscreenButton={fullscreenManager.fullscreenEnabled}
      autoScrollMultiplier={$multiplier$}
      {hasBookmarkData}
      {canJumpBack}
      {canJumpForward}
      canReturnToMarker={returnMarkerPos !== undefined}
      hasBookState={!!stateBookId}
      canSearch={!!bookCharCount}
      canNote={!!bookCharCount}
      bind:isBookmarkScreen
      on:tocClick={() => {
        pauseTracker();

        showHeader = false;
        tocIsOpen$.next(true);
      }}
      on:jumpClick={handleJump}
      on:bookStateClick={openBookState}
      on:addToCollectionClick={openAddToCollection}
      on:completeBook={completeBook}
      on:setCustomReadingPoint={handleSetCustomReadingPoint}
      on:showCustomReadingPoint={() => {
        showHeader = false;
        showCustomReadingPoint = true;
      }}
      on:resetCustomReadingPoint={() => {
        showHeader = false;

        if ($pauseTrackerOnCustomPointChange$) {
          pauseTracker();
        }

        if (isPaginated) {
          customReadingPointRange = undefined;
        } else if ($verticalMode$) {
          verticalCustomReadingPosition$.next(100);
          customReadingPoint = 100;
        } else {
          horizontalCustomReadingPosition$.next(0);
          customReadingPoint = 0;
        }

        if ($pauseTrackerOnCustomPointChange$) {
          restartTrackerAfterCharacterChangeOrTime(1000);
        }
      }}
      on:fullscreenClick={onFullscreenClick}
      on:bookmarkClick={bookmarkPage}
      on:scrollToBookmarkClick={() => {
        showHeader = false;
        scrollToBookmark();
      }}
      on:statisticsClick={() => {
        // WP12b: the Stats page opens on this book when it has a library id.
        const query = stateBookId ? `?book=${encodeURIComponent(stateBookId)}` : '';

        leaveReader(`${mergeEntries.STATISTICS.routeId}${query}`, false);
      }}
      on:readerImageGalleryClick={() => {
        showHeader = false;
        showReaderImageGallery = true;
      }}
      on:settingsClick={() => leaveReader(mergeEntries.SETTINGS.routeId, false)}
      on:domainHintClick={onDomainHintClick}
      on:homeClick={() => leaveReader(mergeEntries.HOME.routeId)}
      on:libraryClick={() => leaveReader(mergeEntries.LIBRARY.routeId)}
      on:zenClick={toggleZen}
      on:searchClick={openSearch}
      on:notesClick={() => openNotes()}
      on:appearanceClick={openAppearance}
      on:jumpBackClick={() => goJumpHistory('back')}
      on:jumpForwardClick={() => goJumpHistory('forward')}
      on:returnMarkerClick={returnToMarker}
      on:addBookmarkClick={addBookmarkHere}
      on:ankiEnrichClick={() => void enrichAnkiCard()}
      on:shortcutsClick={openShortcuts}
    />
  </div>
{/if}

{#if $bookData$ && $rawBookData$}
  {#if $statisticsEnabled$}
    <BookReadingTracker
      fontColor={$themeOption$.fontColor}
      backgroundColor={$backgroundColor$}
      bookTitle={$rawBookData$.title}
      bookLocalId={$rawBookData$.id}
      sectionData={$sectionData$}
      {frozenPosition}
      {exploredCharCount}
      {bookCharCount}
      {autoScroller}
      {blockDataUpdates}
      bind:wasTrackerPaused
      bind:this={trackerElm}
      on:freezeCurrentLocation={freezeTrackerPosition}
      on:trackerAvailable={() => (showTrackerIcon = true)}
      on:trackerMenuClosed={() => {
        if (!wasTrackerPaused) {
          isTrackerPaused$.next(false);
        }

        isTrackerMenuOpen$.next(false);

        bookCompleted = false;
      }}
    />
  {/if}
  <StyleSheetRenderer styleSheet={$bookData$.styleSheet} />
  {#key readerKey}
    <BookReader
      bind:this={bookReaderRef}
      htmlContent={$bookData$.htmlContent}
      width={$containerViewportWidth$ ?? 0}
      height={$containerViewportHeight$ ?? 0}
      {fontFeatureSettings}
      {verticalTextOrientation}
      prioritizeReaderStyles={$prioritizeReaderStyles$}
      enableTextJustification={$enableTextJustification$}
      enableTextWrapPretty={$enableTextWrapPretty$}
      verticalMode={readerVertical}
      fontColor={$themeOption$?.fontColor}
      backgroundColor={$backgroundColor$}
      hintFuriganaFontColor={$themeOption$?.hintFuriganaFontColor}
      hintFuriganaShadowColor={$themeOption$?.hintFuriganaShadowColor}
      fontFamilyGroupOne={$fontFamilyGroupOne$}
      fontFamilyGroupTwo={$fontFamilyGroupTwo$}
      fontSize={$fontSize$}
      lineHeight={$lineHeight$}
      textIndentation={$textIndentation$}
      textMarginValue={$textMarginValue$}
      hideSpoilerImage={$hideSpoilerImage$}
      hideFurigana={readerLayout.hideFurigana}
      furiganaStyle={readerLayout.furiganaStyle}
      viewMode={readerLayout.viewMode}
      secondDimensionMaxValue={readerLayout.secondDimensionMaxValue}
      {firstDimensionMargin}
      autoPositionOnResize={$autoPositionOnResize$}
      avoidPageBreak={$avoidPageBreak$}
      pageColumns={readerLayout.pageColumns}
      autoBookmark={$autoBookmark$}
      autoBookmarkTime={$autoBookmarkTime$}
      multiplier={$multiplier$}
      bind:exploredCharCount
      bind:bookCharCount
      bind:isBookmarkScreen
      bind:bookmarkData
      bind:autoScroller
      bind:bookmarkManager
      bind:pageManager
      bind:customReadingPoint
      bind:customReadingPointTop
      bind:customReadingPointLeft
      bind:customReadingPointScrollOffset
      bind:customReadingPointRange
      bind:showCustomReadingPoint
      on:bookmark={bookmarkPage}
      on:trackerPause={() => pauseTracker(true)}
      on:positionRestored={onPositionRestored}
    />
  {/key}
  {$initBookmarkData$ ?? ''}
  {$setBackgroundColor$ ?? ''}
  {$setWritingMode$ ?? ''}
  {$textSelector$ ?? ''}
  {$autoStartTracker$ ?? ''}
  {$firstPageTurnStatus$ ?? ''}
{:else}
  {$leaveIfBookMissing$ ?? ''}
{/if}

{#if showAppearance}
  <AppearancePanel on:close={closeAppearance} />
{/if}

{#if readerHighlights}
  <HighlightBar
    state={$highlightBarState}
    lastColor={highlightLastColor()}
    eink={$einkMode$}
    on:color={({ detail }) => readerHighlights?.chooseColor(detail)}
    on:note={() => readerHighlights?.chooseNote()}
    on:quote={openQuoteImage}
    on:remove={() => readerHighlights?.chooseRemove()}
    on:undo={() => readerHighlights?.chooseUndo()}
    on:close={() => readerHighlights?.close()}
  />
{/if}

{#if startOverNotice}
  <!-- WP8a: one line after a Start over moved the book to the start (tap to close). -->
  <button
    class="writing-horizontal-tb fixed inset-x-4 top-4 z-20 mx-auto max-w-md rounded border-2 border-gray-700 bg-white p-3 text-left text-black"
    role="status"
    data-testid="start-over-notice"
    on:click={() => (startOverNotice = '')}
  >
    {startOverNotice} <span class="underline">OK</span>
  </button>
{/if}

{#if whispersyncNotice}
  <!-- WP15c: newer audiobook data (position, subtitles or match) came from another device. -->
  <div
    class="writing-horizontal-tb fixed inset-x-4 top-4 z-20 mx-auto flex max-w-md items-center gap-2 rounded border-2 border-gray-700 bg-white p-2 text-black"
    role="status"
    data-testid="whispersync-reload-notice"
  >
    <span class="grow px-1">Newer audiobook data from another device.</span>
    <button
      class="min-h-[2.75rem] rounded border-2 border-gray-700 px-3 font-medium"
      data-testid="whispersync-reload"
      on:click={() => window.location.reload()}
    >
      Reload
    </button>
    <button
      class="min-h-[2.75rem] px-3"
      aria-label="Close"
      data-testid="whispersync-reload-close"
      on:click={() => (whispersyncNotice = false)}
    >
      ✕
    </button>
  </div>
{/if}

{#if ankiNotice}
  <!-- WP14: what "Enrich last Anki card" did, or why it couldn't. -->
  <div
    class="writing-horizontal-tb fixed inset-x-4 top-4 z-20 mx-auto flex max-w-md items-center gap-2 rounded border-2 border-gray-700 bg-white p-2 text-black"
    role="status"
    data-testid="anki-notice"
  >
    <span class="grow px-1" data-testid="anki-notice-text">{ankiNotice}</span>
    {#if ankiNoticeSetup}
      <button
        class="min-h-[2.75rem] shrink-0 rounded border-2 border-gray-700 px-3 font-medium"
        data-testid="anki-notice-setup"
        on:click={() => leaveReader(`${mergeEntries.SETTINGS.routeId}?tab=anki`, false)}
      >
        Set up fields
      </button>
    {/if}
    {#if !ankiBusy}
      <button
        class="min-h-[2.75rem] shrink-0 px-3"
        aria-label="Close"
        data-testid="anki-notice-close"
        on:click={() => (ankiNotice = '')}
      >
        ✕
      </button>
    {/if}
  </div>
{/if}

{#if openNotice}
  <div
    class="writing-horizontal-tb fixed inset-x-4 top-4 z-20 mx-auto max-w-md rounded border-2 border-gray-700 bg-white text-black"
    role="status"
    data-testid="open-notice"
  >
    <button class="w-full p-3 text-left" on:click={() => (openNotice = '')}>
      {openNotice} <span class="underline">OK</span>
    </button>
  </div>
{/if}

{#if $tocIsOpen$ && $sectionData$}
  <div
    class="writing-horizontal-tb fixed top-0 left-0 z-[60] flex h-full w-full max-w-xl flex-col justify-between"
    style:color={$themeOption$?.fontColor}
    style:background-color={$backgroundColor$}
    in:fly|local={{ x: -100, duration: $einkMode$ ? 0 : 100, easing: quintInOut }}
    use:clickOutside={() => {
      if ($statisticsEnabled$ && !wasTrackerPaused) {
        isTrackerPaused$.next(false);
      }
      tocIsOpen$.next(false);
    }}
  >
    <BookToc
      sectionData={$sectionData$}
      verticalMode={$verticalMode$}
      {exploredCharCount}
      {wasTrackerPaused}
    />
  </div>
{/if}

{#if showReaderImageGallery}
  <BookReaderImageGallery
    fontColor={$themeOption$.fontColor}
    backgroundColor={$backgroundColor$}
    on:close={() => (showReaderImageGallery = false)}
  />
{/if}

{#if (isSelectingCustomReadingPoint && !$isMobile$) || (!isPaginated && showCustomReadingPoint)}
  <div
    class="fixed left-0 z-20 h-[1px] w-full border border-red-500"
    style:top={`${customReadingPointTop}px`}
  />
  <div
    class="fixed top-0 z-20 h-full w-[1px] border border-red-500"
    style:left={`${customReadingPointLeft}px`}
  />
{/if}

{#if $enableTapEdgeToFlip$ && isPaginated && !$skipKeyDownListener$}
  <button
    class="fixed left-0 z-10 w-5"
    on:click={$verticalMode$ ? () => pageManager?.nextPage() : () => pageManager?.prevPage()}
    style:height={tapButtonHeight}
    style:top={tapButtonTop}
  />
  <button
    class="fixed right-0 z-10 w-5"
    on:click={$verticalMode$ ? () => pageManager?.prevPage() : () => pageManager?.nextPage()}
    style:height={tapButtonHeight}
    style:top={tapButtonTop}
  />
{/if}

{#if showSpinner}
  <div class="fixed inset-0 flex h-full w-full items-center justify-center text-7xl">
    <Fa icon={faSpinner} spin />
  </div>
{/if}

<div
  id="ttu-page-footer"
  tabindex="0"
  role="button"
  class="writing-horizontal-tb fixed bottom-0 left-0 z-10 flex h-8 w-full items-center justify-between text-xs leading-none"
  class:ttu-zen={$zenMode$}
  data-testid="reader-footer"
  style:color={$themeOption$?.tooltipTextFontColor}
  on:click={() => (showFooter = !showFooter)}
  on:keyup={dummyFn}
>
  <div class="flex h-full">
    {#if showTrackerIcon}
      <div
        role="button"
        title="Tap to pause or resume the Tracker, long-press to open the Tracker Menu"
        class="flex h-full w-8 items-center justify-center text-sm sm:text-lg"
        class:text-red-500={$isTrackerPaused$}
        class:animate-pulse={frozenPosition > -1}
        use:longPressHandler={{
          onTap: toggleTrackerManually,
          onLongPress: openTrackerMenu,
          getDuration: () => $trackerLongPressTime$
        }}
      >
        <Fa icon={$isTrackerPaused$ ? faPlay : faPause} />
      </div>
    {/if}
    {#if $ankiBottomBarButton$}
      <!-- WP14: one tap to enrich the last Anki card (opt-in per device). -->
      <div
        tabindex="0"
        role="button"
        title="Enrich the last Anki card (E)"
        aria-label="Enrich the last Anki card"
        class="flex h-full min-w-[2.5rem] items-center justify-center text-sm sm:text-lg"
        class:animate-pulse={ankiBusy}
        data-testid="footer-anki"
        on:click|stopPropagation={() => void enrichAnkiCard()}
        on:keyup={dummyFn}
      >
        <Fa icon={faNoteSticky} />
      </div>
    {/if}
    {#if $showReturnMarker$ && returnMarkerPos !== undefined && !returnMarkerOnScreen && bookCharCount}
      <!-- WP11b: where you were reading before jumping (opt-in per device). -->
      <div
        tabindex="0"
        role="button"
        title="Back to where you were reading"
        class="flex h-full items-center px-2 text-xs sm:text-sm"
        data-testid="footer-return-marker"
        on:click|stopPropagation={returnToMarker}
        on:keyup={dummyFn}
      >
        ↩ {((returnMarkerPos / bookCharCount) * 100).toFixed(1)}%
      </div>
    {/if}
    <div
      bind:this={whisperContainerEl}
      class="h-full"
      on:click|stopPropagation
      on:keyup={dummyFn}
      role="none"
    >
      {#if $rawBookData$ && bookContentEl && readerDb && whispersync && whispersyncReady}
        <AudioBookMenu
          componentContainerElement={whisperContainerEl}
          bookContentElement={bookContentEl}
          currentBookId={$rawBookData$.id}
          readerDatabase={readerDb}
          externalElementHtml={$rawBookData$.elementHtml}
          externalBlobs={$rawBookData$.blobs}
          externalBookData={$rawBookData$}
          linkedAudio={whispersync.linkedAudio}
        />
      {/if}
    </div>
  </div>
  {#if showFooter && bookCharCount}
    <!-- prettier-ignore -->
    {@const currentProgress = [
      $showCharacterCounter$ ? `${exploredCharCount} / ${bookCharCount}` : '',
      $showPercentage$ ? `${((exploredCharCount / bookCharCount) * 100).toFixed(2)}%` : '',
      $showFooterChapterCharacterCounter$ || $showFooterChapterPercentage$ ? 'T' : ''
    ]
      .filter(Boolean)
      .join(' ')}
    <div
      tabindex="0"
      role="button"
      title="Click to copy Progress"
      class="writing-horizontal-tb fixed bottom-2 right-2 z-10 text-xs leading-none select-none whitespace-pre"
      class:invisible={!$showCharacterCounter$ &&
        !$showPercentage$ &&
        !$showFooterChapterCharacterCounter$ &&
        !$showFooterChapterPercentage$ &&
        !timeLeftText}
      style:color={$themeOption$?.tooltipTextFontColor}
      on:click|stopPropagation={({ target }) => {
        if (!$showCharacterCounter$ && !$showPercentage$) {
          return;
        }

        copyCurrentProgress(currentProgress.replace(/ T$/, ''));

        if (target instanceof HTMLElement) {
          pulseElement(target.parentElement || target, 'add', 0.5, 500);
        }
      }}
      on:keyup={dummyFn}
    >
      {#if timeLeftText}
        <span class="mr-4" data-testid="footer-time-left">{timeLeftText}</span>
      {/if}
      <span class="mr-4" class:invisible={!footerChapterProgress}>{footerChapterProgress}</span>
      <span class:invisible={!$showCharacterCounter$ && !$showPercentage$}>{currentProgress}</span>
    </div>
  {/if}
</div>

{#if bookCompleted && !$einkMode$}
  <BookCompletionConfetti {confettiWidthModifier} {confettiMaxRuns} {window} />
{/if}

<svelte:window
  on:keydown={onKeydown}
  on:beforeunload={handleUnload}
  on:resize={() => {
    if ($statisticsEnabled$ && !$isTrackerPaused$) {
      pauseTracker();

      merge(fromEvent(document, PAGE_CHANGE), timer(1000))
        .pipe(debounceTime(1000), take(1))
        .subscribe(() => {
          restartTrackerAfterCharacterChangeOrTime(1000);
        });
    }
  }}
/>

<style>
  /*
   * WP10a Zen mode: the bottom bar is hidden but keeps its space, so the page layout (and
   * the reading position) does not change. Whispersync renders its side menu, dialogs and
   * line menu inside the bar, so those stay visible.
   */
  :global(#ttu-page-footer.ttu-zen) {
    visibility: hidden;
  }

  :global(#ttu-page-footer.ttu-zen .ttu-whispersync-container),
  :global(#ttu-page-footer.ttu-zen .ttu-whispersync-dialog) {
    visibility: visible;
  }
</style>
