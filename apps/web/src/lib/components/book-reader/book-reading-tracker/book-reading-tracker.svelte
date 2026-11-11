<script lang="ts">
  import {
    getDefaultStatistic,
    isTrackerPaused$,
    isTrackerPausedByIdle$,
    type TrackingHistory,
    isTrackerMenuOpen$,
    TrackerSkipThresholdAction,
    TrackerAutoPause
  } from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker';
  import { shouldAutoResume } from '$lib/components/book-reader/book-reading-tracker/tracker-auto';
  import BookTimerMenu from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker-menu.svelte';
  import type { SectionWithProgress } from '$lib/components/book-reader/book-toc/book-toc';
  import type { AutoScroller } from '$lib/components/book-reader/types';
  import type {
    BooksDbReadingGoal,
    BooksDbStatistic
  } from '$lib/data/database/books-db/versions/books-db';
  import { dialogManager } from '$lib/data/dialog-manager';
  import { PAGE_CHANGE } from '$lib/data/events';
  import { logger } from '$lib/data/logger';
  import { getReadingGoalWindow, type ReadingGoal } from '$lib/data/reading-goal';
  import { lastCompletion, readingSpeed, totalsByDay, type StatTotals } from '$lib/stats/aggregate';
  import { DICTIONARY_POPUP_SELECTOR, LookupCounter } from '$lib/stats/lookup-counter';
  import { lazyRecorderDeps, SessionRecorder } from '$lib/stats/session-recorder';
  import { randomId } from '$lib/functions/secure-context';
  import { parseStatSessionId } from '$lib/stats/stat-records';
  import type { StatsApi } from '$lib/sync/sync-service';
  import {
    adjustStatisticsAfterIdleTime$,
    database,
    readingGoal$,
    startDayHoursForTracker$,
    trackerAutoPause$,
    trackerBackwardSkipThreshold$,
    trackerForwardSkipThreshold$,
    trackerIdleTime$,
    trackerPopupDetection$,
    trackerSkipThresholdAction$,
    einkMode$
  } from '$lib/data/store';
  import { reduceToEmptyString } from '$lib/functions/rxjs/reduce-to-empty-string';
  import {
    getDate,
    getDateKey,
    getDateTimeString,
    getPreviousDayKey,
    getSecondsToDate,
    toTimeString
  } from '$lib/functions/statistic-util';
  import { clickOutside } from '$lib/functions/use-click-outside';
  import {
    fromEvent,
    interval,
    merge,
    NEVER,
    Observable,
    startWith,
    switchMap,
    tap,
    throttleTime
  } from 'rxjs';
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { quintInOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';

  export let fontColor: string;
  export let backgroundColor: string;
  export let bookTitle: string;
  /** The local book id (WP12: finds the catalog book its sessions belong to). */
  export let bookLocalId: number;
  export let wasTrackerPaused: boolean;
  export let exploredCharCount: number;
  export let bookCharCount: number;
  export let sectionData: SectionWithProgress[];
  export let frozenPosition: number;
  export let autoScroller: AutoScroller | undefined;
  export let blockDataUpdates: boolean;

  export function processStatistics(
    characterDiff: number,
    timeDiff = 1,
    referenceTick = Date.now(),
    flushData = true
  ) {
    const todayDate = new Date();
    const absoluteTimeDiff = Math.abs(timeDiff);
    const isNegativeTimeDiff = timeDiff < 0;
    const referenceDate = new Date(referenceTick);
    const referenceDateKey = getDateKey($startDayHoursForTracker$, referenceDate);
    const lastStatisticModified = referenceDate.getTime();
    const secondsOnDay = getSecondsToDate($startDayHoursForTracker$, referenceDate) || 1;
    const overlappedDay = absoluteTimeDiff > secondsOnDay;
    const timeDiffForToday = overlappedDay ? secondsOnDay : absoluteTimeDiff;
    const dateTimeKey = getDateTimeString(lastStatisticModified);
    const trackerHistory: TrackingHistory[] = [
      {
        id: lastStatisticModified * Math.random(),
        dateKey: referenceDateKey,
        dateTimeKey,
        timeDiff: isNegativeTimeDiff ? -timeDiffForToday : timeDiffForToday,
        characterDiff,
        saved: false
      }
    ];

    todayKey = getDateKey($startDayHoursForTracker$, todayDate);

    // WP12: the session recorder gets the same split (the earlier day's part first).
    if (recorder) {
      if (overlappedDay) {
        recorder.add(
          getPreviousDayKey($startDayHoursForTracker$, referenceDate),
          isNegativeTimeDiff ? -(absoluteTimeDiff - secondsOnDay) : absoluteTimeDiff - secondsOnDay,
          0,
          referenceTick
        );
      }

      recorder.add(
        referenceDateKey,
        isNegativeTimeDiff ? -timeDiffForToday : timeDiffForToday,
        characterDiff,
        referenceTick
      );
    }

    if (overlappedDay || referenceDateKey !== todayKey) {
      let otherDayTimeDiff = 0;

      if (overlappedDay) {
        otherDayTimeDiff = isNegativeTimeDiff
          ? -(absoluteTimeDiff - secondsOnDay)
          : absoluteTimeDiff - secondsOnDay;
      } else {
        otherDayTimeDiff = isNegativeTimeDiff ? -timeDiffForToday : timeDiffForToday;
      }

      const otherDayKey = overlappedDay
        ? getPreviousDayKey($startDayHoursForTracker$, referenceDate)
        : referenceDateKey;
      const otherDayStatistics =
        statistics.get(otherDayKey) || getDefaultStatistic(bookTitle, otherDayKey);

      updateStatistic(otherDayStatistics, otherDayTimeDiff, characterDiff, lastStatisticModified);

      statistics.set(otherDayKey, otherDayStatistics);
      statisticsToStore.add(otherDayKey);

      if (overlappedDay) {
        trackerHistory.unshift({
          id: lastStatisticModified * Math.random(),
          dateKey: otherDayStatistics.dateKey,
          dateTimeKey,
          timeDiff: otherDayTimeDiff,
          characterDiff,
          saved: false
        });
      }
    }

    todaysStatistics =
      todaysStatistics.dateKey === todayKey
        ? todaysStatistics
        : statistics.get(todayKey) || getDefaultStatistic(bookTitle, todayKey);

    if (todayKey === referenceDateKey) {
      updateStatistic(
        todaysStatistics,
        isNegativeTimeDiff ? -timeDiffForToday : timeDiffForToday,
        characterDiff,
        lastStatisticModified
      );
    } else {
      updateStatistic(todaysStatistics, 0, 0, lastStatisticModified);
    }

    statistics.set(todayKey, todaysStatistics);
    statisticsToStore.add(todayKey);

    updateStatistic(sessionStatistics, timeDiff, characterDiff, lastStatisticModified);
    updateStatistic(allTimeStatistics, timeDiff, characterDiff, lastStatisticModified);

    for (let index = 0, { length } = trackerHistory; index < length; index += 1) {
      if (historyIndex > 59) {
        historyIndex = 0;
      }

      if (trackingHistory.length < 60) {
        trackingHistory.unshift(trackerHistory[index]);
      } else {
        trackingHistory[historyIndex] = trackerHistory[index];
        trackingHistory.sort((t1, t2) => (t2.dateTimeKey > t1.dateTimeKey ? 1 : -1));
        historyIndex += 1;
      }
    }

    updateTimeToFinishBook();

    return flushData ? flushUpdates() : Promise.resolve([false, 0]);
  }

  export async function flushUpdates(force = false) {
    if (!statisticsToStore.size || (blockDataUpdates && !force)) {
      return [false, 0];
    }

    actionInProgress = true;
    hadError = false;

    const toUpdate: string[] = JSON.parse(JSON.stringify([...statisticsToStore]));

    statisticsToStore.clear();

    try {
      // WP12: the open session is the record; local statistic rows are no longer written.
      if (recorder && !(await recorder.flush())) {
        throw new Error('the session could not be saved (retried with the next save)');
      }

      trackingHistory = trackingHistory.map((item) => {
        const oldItem = item;

        oldItem.saved = toUpdate.some((dateKey) => dateKey === item.dateKey);

        return oldItem;
      });

      dispatch('statisticsSaved');
    } catch (error: any) {
      hadError = true;
      logger.warn(`Stats: ${error.message}`);
    } finally {
      actionInProgress = false;
      lastTrackerFlushTime = Date.now();

      if ($isTrackerMenuOpen$) {
        updateReadingGoalWindow();
      }
    }

    return [hadError, toUpdate.length];
  }

  let yomiPopover: HTMLElement | null;
  let jpdbPopover: HTMLElement | null;
  let actionInProgress = false;
  let hadError = false;
  let pausedByAutoPause = false;
  let visibilityState: DocumentVisibilityState;
  let currentReadingGoalStart = '';
  let currentReadingGoalEnd = '';
  let remainingTimeInReadingGoalWindow = '';
  let currentReadingGoal: ReadingGoal | undefined;
  let currentTimeGoal = 0;
  let currentCharacterGoal = 0;
  let statistics = new Map<string, BooksDbStatistic>();
  let todayKey = getDateKey($startDayHoursForTracker$);
  let sessionStatistics = getDefaultStatistic(bookTitle, todayKey);
  let todaysStatistics = getDefaultStatistic(bookTitle, todayKey);
  let allTimeStatistics = getDefaultStatistic(bookTitle, todayKey);
  let bookCompletionStatistics:
    | Omit<BooksDbStatistic, 'title' | 'lastStatisticModified'>
    | undefined;
  let bookStartDate = todayKey;
  let timeToFinishBook = 'N/A';
  let lastExploredCharCount = exploredCharCount;
  let previousLastExploredCharCount = 0;
  let trackingHistory: TrackingHistory[] = [];
  let historyIndex = 0;
  let autoScrollerStatistics: BooksDbStatistic | undefined;
  let autoScrollerTimer$: Observable<''> | undefined;
  let lastExploredCharCountScroller = exploredCharCount;
  let statisticsToStore = new Set<string>();
  let lastTrackerTick = 0;
  let lastTrackerFlushTime = 0;
  let trackerIdleTime = 0;
  let charCountAtIdlePause = 0;
  let lastResizeAt = 0;
  let wasTrackerPausedAtMenuOpen: boolean | undefined;
  /** WP12: sessions are the only record of reading. Exists at once; loads sync on first write. */
  let recorder: SessionRecorder | null = createRecorder();
  let statsApi: StatsApi | null = null;
  let statsUnavailable = false;
  let lookupCounter: LookupCounter | null = null;

  const dispatch = createEventDispatcher<{
    trackerAvailable: void;
    statisticsSaved: void;
    trackerMenuClosed: void;
  }>();
  const yomiObserver = new MutationObserver(handleYomiMutation);
  const dictionaryObserver = new MutationObserver(handleMutation);

  const readingTracker$ = isTrackerPaused$.pipe(
    switchMap((isPaused) => {
      if (isPaused) {
        trackerIdleTime = 0;

        flushUpdates();

        return NEVER;
      }

      const now = Date.now();

      lastTrackerFlushTime = now;
      lastTrackerTick = now;

      if (isTrackerPausedByIdle$.getValue()) {
        isTrackerPausedByIdle$.next(false);
      }

      return interval(1000);
    }),
    tap(processTicks),
    reduceToEmptyString()
  );

  const updateTrackerIdleTime$ = isTrackerPaused$.pipe(
    switchMap((isPaused) =>
      isPaused || $trackerIdleTime$ <= 0
        ? NEVER
        : merge(
            fromEvent(document, PAGE_CHANGE),
            fromEvent<PointerEvent>(window, 'pointermove'),
            fromEvent<Event>(document, 'selectionchange')
          ).pipe(
            startWith(true),
            throttleTime(1000),
            tap(() => (trackerIdleTime = Date.now() + $trackerIdleTime$ * 1000))
          )
    ),
    reduceToEmptyString()
  );

  const autoResumeAfterIdle$ = isTrackerPausedByIdle$.pipe(
    switchMap((pausedByIdle) =>
      pausedByIdle ? fromEvent<CustomEvent>(document, PAGE_CHANGE) : NEVER
    ),
    tap(handlePageChangeWhileIdle),
    reduceToEmptyString()
  );

  $: clearIdlePauseOnMenuToggle($isTrackerMenuOpen$, wasTrackerPaused);

  $: hasReadingGoal = !!($readingGoal$.goalStartDate && todayKey >= $readingGoal$.goalStartDate);

  $: handleVisibilityChange(visibilityState);

  $: sealSessionWhenHidden(visibilityState);

  $: updateReadingGoalWindowForPausedState($isTrackerMenuOpen$);

  $: if (!$isTrackerPaused$) {
    updateLastExploredCharCount();
  }

  $: if (autoScroller && !autoScrollerTimer$) {
    autoScrollerTimer$ = autoScroller.wasAutoScrollerEnabled$.pipe(
      tap((isEnabled) => {
        if (isEnabled) {
          todayKey = getDateKey($startDayHoursForTracker$);
          autoScrollerStatistics = getDefaultStatistic(bookTitle, todayKey);
          lastExploredCharCountScroller = exploredCharCount;
        } else {
          autoScrollerStatistics = undefined;
        }
      }),
      switchMap((isEnabled) => (isEnabled ? interval(1000) : NEVER)),
      tap(() => {
        if (!autoScrollerStatistics) {
          return;
        }

        const diff = exploredCharCount - lastExploredCharCountScroller;

        lastExploredCharCountScroller = exploredCharCount;
        autoScrollerStatistics = {
          ...updateStatistic(autoScrollerStatistics, 1, diff, Date.now())
        };
      }),
      reduceToEmptyString()
    );
  }

  $: if ($trackerAutoPause$ !== TrackerAutoPause.OFF && !yomiPopover) {
    yomiPopover = document.querySelector(DICTIONARY_POPUP_SELECTOR);

    if (!yomiPopover) {
      yomiObserver.observe(document.body, { childList: true, subtree: false });
    }
  } else {
    yomiObserver.disconnect();
  }

  $: if ($trackerAutoPause$ !== TrackerAutoPause.OFF && !$trackerPopupDetection$) {
    if (yomiPopover) {
      dictionaryObserver.observe(yomiPopover, { attributes: true });
    }

    if (jpdbPopover) {
      dictionaryObserver.observe(jpdbPopover, { attributes: true });
    }
  } else {
    dictionaryObserver.disconnect();
  }

  onMount(init);

  onDestroy(() => {
    yomiObserver.disconnect();
    dictionaryObserver.disconnect();
    isTrackerPausedByIdle$.next(false);
    lookupCounter?.stop();
    void sealSession();
  });

  function createRecorder(): SessionRecorder | null {
    try {
      const localId = bookLocalId;
      const title = bookTitle;

      return new SessionRecorder(
        lazyRecorderDeps(
          async () => (await import('$lib/sync/sync-service')).statsRecorderDeps(localId, title),
          randomId,
          (message) => logger.warn(message)
        )
      );
    } catch ({ message }: any) {
      logger.warn(`Stats: the session recorder could not start: ${message}`);
      return null;
    }
  }

  /**
   * WP12: ends the open session (leaving the book, page hidden or closed, idle).
   * Never throws; resolves false when the write failed (it is retried later).
   */
  export async function sealSession(): Promise<boolean> {
    try {
      return recorder ? await recorder.seal() : true;
    } catch ({ message }: any) {
      logger.warn(`Stats: could not end the session: ${message}`);
      return false;
    }
  }

  function sealSessionWhenHidden(state: DocumentVisibilityState) {
    if (state === 'hidden') void sealSession();
  }

  /**
   * WP12: "Complete Book" adding the characters left. They count as characters
   * read today, never as time or speed (a completion session).
   */
  export async function recordCompletion(characters: number): Promise<boolean> {
    try {
      const day = getDateKey($startDayHoursForTracker$);
      const at = Date.now();
      const row = statistics.get(day) || getDefaultStatistic(bookTitle, day);

      updateStatistic(row, 0, characters, at);
      statistics.set(day, row);
      if (day === todaysStatistics.dateKey) todaysStatistics = row;
      updateStatistic(allTimeStatistics, 0, characters, at);
      allTimeStatistics = { ...allTimeStatistics };

      return recorder ? await recorder.addCompletion(day, characters, at) : true;
    } catch ({ message }: any) {
      logger.warn(`Stats: could not record the completion: ${message}`);
      return false;
    }
  }

  /** WP12: reads the book's newest completion again (after Complete Book). */
  export async function refreshCompletion() {
    try {
      const bookId = await recorderBookId();
      if (!statsApi || !bookId) return;
      const { entries, readThroughs } = await statsApi.bookStats(bookId);
      const done = lastCompletion(readThroughs, entries);
      bookCompletionStatistics = done
        ? completionRow(done.readThrough.finishedOn, done.totals)
        : undefined;
    } catch ({ message }: any) {
      logger.warn(`Stats: could not read the completion: ${message}`);
    }
  }

  async function recorderBookId(): Promise<string | null> {
    if (!statsApi) return null;
    const sync = await import('$lib/sync/sync-service');
    return sync.bookIdForLocalBook(bookLocalId, bookTitle);
  }

  function completionRow(
    finishedOn: string | null,
    totals: StatTotals
  ): Omit<BooksDbStatistic, 'title' | 'lastStatisticModified'> {
    const speed = readingSpeed(totals);
    return {
      dateKey: finishedOn ?? '',
      charactersRead: totals.chars,
      readingTime: totals.seconds,
      minReadingSpeed: speed,
      altMinReadingSpeed: speed,
      lastReadingSpeed: speed,
      maxReadingSpeed: speed
    };
  }

  /** A pause/resume toggled inside the tracker menu is manual, so it ends the idle state. */
  function clearIdlePauseOnMenuToggle(isMenuOpen: boolean, paused: boolean) {
    try {
      if (!isMenuOpen) {
        wasTrackerPausedAtMenuOpen = undefined;
        return;
      }

      if (wasTrackerPausedAtMenuOpen === undefined) {
        wasTrackerPausedAtMenuOpen = paused;
        return;
      }

      if (paused !== wasTrackerPausedAtMenuOpen && isTrackerPausedByIdle$.getValue()) {
        isTrackerPausedByIdle$.next(false);
      }
    } catch ({ message }: any) {
      logger.error(`Error updating tracker idle state: ${message}`);
    }
  }

  function handlePageChangeWhileIdle(event: CustomEvent) {
    try {
      const currentCharCount = event.detail?.exploredCharCount;

      if (typeof currentCharCount !== 'number' || currentCharCount === charCountAtIdlePause) {
        return;
      }

      const resume = shouldAutoResume({
        pausedByIdle: isTrackerPausedByIdle$.getValue(),
        isTrackerPaused: $isTrackerPaused$,
        charCountAtPause: charCountAtIdlePause,
        currentCharCount,
        now: Date.now(),
        lastResizeAt
      });

      if (!resume) {
        // Layout shift right after a resize: follow it so it doesn't count as a page turn later.
        charCountAtIdlePause = currentCharCount;
        return;
      }

      isTrackerPausedByIdle$.next(false);
      wasTrackerPaused = false;
      isTrackerPaused$.next(false);
    } catch ({ message }: any) {
      logger.error(`Error resuming tracker after idle: ${message}`);
    }
  }

  function handleYomiMutation() {
    yomiPopover = document.querySelector(DICTIONARY_POPUP_SELECTOR);

    if (yomiPopover) {
      yomiObserver.disconnect();
    }
  }

  function handleMutation() {
    if (!jpdbPopover && !yomiPopover) {
      return;
    }

    const isDisplayed = isDictionaryDisplayed();

    if (isDisplayed && !$isTrackerPaused$) {
      pausedByAutoPause = true;
      isTrackerPaused$.next(true);
    } else if (!isDisplayed && $isTrackerPaused$ && !wasTrackerPaused && pausedByAutoPause) {
      pausedByAutoPause = false;
      isTrackerPaused$.next(false);
    }
  }

  function isDictionaryDisplayed() {
    return (
      (yomiPopover && yomiPopover.style.visibility !== 'hidden') ||
      (jpdbPopover && jpdbPopover.style.opacity !== '0')
    );
  }

  function handleBlur() {
    if (
      $isTrackerPaused$ ||
      $trackerAutoPause$ !== TrackerAutoPause.STRICT ||
      ($trackerPopupDetection$ && isDictionaryDisplayed())
    ) {
      return;
    }

    pausedByAutoPause = true;
    isTrackerPaused$.next(true);
  }

  function handleFocus() {
    if (
      !$isTrackerPaused$ ||
      !pausedByAutoPause ||
      wasTrackerPaused ||
      $trackerAutoPause$ !== TrackerAutoPause.STRICT ||
      (!$trackerPopupDetection$ && isDictionaryDisplayed())
    ) {
      return;
    }

    pausedByAutoPause = false;
    isTrackerPaused$.next(false);
  }

  function updateLastExploredCharCount() {
    const referenceCharCount = frozenPosition !== -1 ? frozenPosition : exploredCharCount;

    if (lastExploredCharCount !== referenceCharCount) {
      previousLastExploredCharCount = lastExploredCharCount;
      lastExploredCharCount = referenceCharCount;
    }
  }

  function revertTrackerHistory({ detail: historyItem }: CustomEvent<TrackingHistory>) {
    const entry = statistics.get(historyItem.dateKey);

    if (!entry) {
      trackingHistory = trackingHistory.filter((item) => item.id !== historyItem.id);
      return;
    }

    actionInProgress = true;

    const lastStatisticModified = Date.now();

    updateStatistic(
      entry,
      -historyItem.timeDiff,
      -historyItem.characterDiff,
      lastStatisticModified
    );
    updateStatistic(
      sessionStatistics,
      -historyItem.timeDiff,
      -historyItem.characterDiff,
      lastStatisticModified
    );
    updateStatistic(
      allTimeStatistics,
      -historyItem.timeDiff,
      -historyItem.characterDiff,
      lastStatisticModified
    );

    statistics.set(entry.dateKey, entry);
    statisticsToStore.add(entry.dateKey);
    recorder?.revert(
      historyItem.dateKey,
      -historyItem.timeDiff,
      -historyItem.characterDiff,
      lastStatisticModified
    );

    trackingHistory = trackingHistory.map((item) =>
      item.id === historyItem.id
        ? {
            id: historyItem.id,
            dateKey: historyItem.dateKey,
            dateTimeKey: getDateTimeString(lastStatisticModified),
            timeDiff: -historyItem.timeDiff,
            characterDiff: -historyItem.characterDiff,
            saved: false
          }
        : item
    );
    trackingHistory.sort((t1, t2) => (t2.dateTimeKey > t1.dateTimeKey ? 1 : -1));
    sessionStatistics = { ...sessionStatistics };

    updateTimeToFinishBook();
    flushUpdates();
  }

  function handleVisibilityChange(state: DocumentVisibilityState) {
    if ($trackerAutoPause$ !== TrackerAutoPause.MODERATE) {
      return;
    }

    if (
      state === 'hidden' &&
      !$isTrackerPaused$ &&
      (!$trackerPopupDetection$ || !isDictionaryDisplayed())
    ) {
      pausedByAutoPause = true;
      isTrackerPaused$.next(true);
    } else if (
      state === 'visible' &&
      $isTrackerPaused$ &&
      pausedByAutoPause &&
      !wasTrackerPaused &&
      ($trackerPopupDetection$ || !isDictionaryDisplayed())
    ) {
      pausedByAutoPause = false;
      isTrackerPaused$.next(false);
    }
  }

  function updateReadingGoalWindowForPausedState(isTrackerMenuOpen: boolean) {
    if (isTrackerMenuOpen && wasTrackerPaused) {
      updateReadingGoalWindow();
    }
  }

  async function init() {
    try {
      todayKey = getDateKey($startDayHoursForTracker$);
      jpdbPopover = document.getElementById('jpdb-popup');

      // WP12: reading is recorded as sessions; the book's earlier reading comes from
      // the synced records (every device), never from this browser's old rows.
      statsApi = (await import('$lib/sync/sync-service')).statsApi();
      lookupCounter = new LookupCounter(
        document,
        () => recorder?.addLookup(),
        (message) => logger.warn(message)
      );
      lookupCounter.start();
      statsUnavailable = !recorder || !(await recorder.available());

      if (!statsUnavailable) {
        await loadRecordedStatistics();
      }
    } catch ({ message }: any) {
      logger.error(`Error initializing timer: ${message}`);
    } finally {
      dispatch('trackerAvailable');
    }
  }

  /** Today, all time, the start date and the newest completion of this book, from records. */
  async function loadRecordedStatistics() {
    const bookId = await recorderBookId();

    if (!statsApi || !bookId) return;

    const { entries, readThroughs } = await statsApi.bookStats(bookId);
    // Sessions this visit already wrote are counted in memory.
    const own = (id: string) => {
      const sessionId = parseStatSessionId(id)?.sessionId;
      return !!sessionId && !!recorder?.ownsSession(sessionId);
    };
    const days = totalsByDay(entries, (entry) => !own(entry.id));

    for (const [dateKey, totals] of days) {
      const loaded = getDefaultStatistic(bookTitle, dateKey);

      loaded.readingTime = totals.seconds;
      loaded.charactersRead = totals.chars;
      loaded.lastReadingSpeed = readingSpeed(totals);
      loaded.minReadingSpeed = loaded.lastReadingSpeed;
      loaded.altMinReadingSpeed = loaded.lastReadingSpeed;
      loaded.maxReadingSpeed = loaded.lastReadingSpeed;
      loaded.lastStatisticModified = 0;

      const current = statistics.get(dateKey);

      if (current) {
        addToStatistic(current, loaded);
      } else {
        statistics.set(dateKey, loaded);
      }

      addToStatistic(allTimeStatistics, loaded);

      if (dateKey === todayKey) {
        todaysStatistics = statistics.get(dateKey) || todaysStatistics;
      }
    }

    const firstDay = [...days.keys()].sort()[0];

    bookStartDate = firstDay && firstDay < todayKey ? firstDay : todayKey;
    allTimeStatistics = { ...allTimeStatistics };

    const done = lastCompletion(readThroughs, entries);

    bookCompletionStatistics = done
      ? completionRow(done.readThrough.finishedOn, done.totals)
      : undefined;
  }

  async function updateReadingGoalWindow() {
    todayKey = getDateKey($startDayHoursForTracker$);
    todaysStatistics = statistics.get(todayKey) || getDefaultStatistic(bookTitle, todayKey);

    try {
      await tick();

      let currentClosedReadingGoal: BooksDbReadingGoal | undefined;

      if (!hasReadingGoal) {
        currentClosedReadingGoal = await database.getCurrentClosedReadingGoal(todayKey);

        if (!currentClosedReadingGoal) {
          return;
        }
      }

      currentReadingGoal = currentClosedReadingGoal || $readingGoal$;
      [currentReadingGoalStart, currentReadingGoalEnd, remainingTimeInReadingGoalWindow] =
        getReadingGoalWindow(todayKey, $startDayHoursForTracker$, currentReadingGoal);

      if (
        currentClosedReadingGoal?.goalEndDate &&
        currentClosedReadingGoal.goalEndDate < currentReadingGoalEnd
      ) {
        currentReadingGoalEnd = currentClosedReadingGoal.goalEndDate;

        const adjustedEndDate = getDate(currentReadingGoalEnd, $startDayHoursForTracker$);

        remainingTimeInReadingGoalWindow = toTimeString(
          (adjustedEndDate.getTime() + 8.64e7 - Date.now()) / 1000
        );
      }

      // WP12: every device's sessions (and frozen days) in the window.
      const totals = statsApi
        ? await statsApi.totalsBetween(currentReadingGoalStart, currentReadingGoalEnd)
        : null;

      currentTimeGoal = totals?.seconds ?? 0;
      currentCharacterGoal = totals?.chars ?? 0;
    } catch ({ message }: any) {
      logger.error(`Error updating Goal Data: ${message}`);
    }
  }

  function processTicks() {
    const now = Date.now();
    const nowTick = trackerIdleTime ? Math.min(trackerIdleTime, now) : now;
    const trackerIdleTimeReached = trackerIdleTime && nowTick >= trackerIdleTime;
    const elapsed = Math.round((nowTick - lastTrackerTick) / 1000);

    lastTrackerTick = nowTick;

    if (trackerIdleTimeReached) {
      // Automatic pause: the next page turn or scroll resumes (see handlePageChangeWhileIdle).
      // wasTrackerPaused stays true so closing the menu or TOC does not resume it.
      charCountAtIdlePause = exploredCharCount;
      wasTrackerPaused = true;
      isTrackerPausedByIdle$.next(true);
      isTrackerPaused$.next(true);

      if (frozenPosition === -1) {
        if ($adjustStatisticsAfterIdleTime$) {
          processStatistics(0, elapsed - $trackerIdleTime$, lastTrackerTick, true);
        } else if (elapsed) {
          processStatistics(0, elapsed, lastTrackerTick, true);
        }
      }

      void sealSession();

      return;
    }

    if (frozenPosition === -1) {
      const characterDiff = exploredCharCount - lastExploredCharCount;
      let finalCharacterDiff =
        characterDiff < 0 && Math.abs(characterDiff) > sessionStatistics.charactersRead
          ? -sessionStatistics.charactersRead
          : characterDiff;

      if (
        (finalCharacterDiff > 0 &&
          $trackerForwardSkipThreshold$ &&
          finalCharacterDiff >= $trackerForwardSkipThreshold$) ||
        (finalCharacterDiff < 0 &&
          $trackerBackwardSkipThreshold$ &&
          finalCharacterDiff <= -Math.abs($trackerBackwardSkipThreshold$))
      ) {
        if ($trackerSkipThresholdAction$ === TrackerSkipThresholdAction.PAUSE) {
          wasTrackerPaused = true;
          isTrackerPaused$.next(true);
          return;
        }
        finalCharacterDiff = 0;
      }

      previousLastExploredCharCount = lastExploredCharCount;
      lastExploredCharCount = exploredCharCount;

      processStatistics(
        finalCharacterDiff,
        elapsed,
        lastTrackerTick,
        now - lastTrackerFlushTime > 10000
      );
    }
  }

  function addToStatistic(statisticObject: BooksDbStatistic, entry: BooksDbStatistic) {
    const statistic = statisticObject;

    statistic.title = entry.title;
    statistic.readingTime += entry.readingTime;
    statistic.charactersRead += entry.charactersRead;
    statistic.lastReadingSpeed = statistic.readingTime
      ? Math.ceil((3600 * statistic.charactersRead) / statistic.readingTime)
      : 0;
    statistic.minReadingSpeed = statistic.minReadingSpeed
      ? Math.min(statistic.minReadingSpeed, statistic.lastReadingSpeed)
      : statistic.lastReadingSpeed;
    statistic.altMinReadingSpeed = statistic.altMinReadingSpeed
      ? Math.min(statistic.altMinReadingSpeed, statistic.lastReadingSpeed)
      : statistic.lastReadingSpeed;
    statistic.maxReadingSpeed = Math.max(statistic.maxReadingSpeed, statistic.lastReadingSpeed);
    statistic.lastStatisticModified = Math.max(
      statistic.lastStatisticModified,
      entry.lastStatisticModified
    );
  }

  function updateStatistic(
    statisticObject: BooksDbStatistic,
    timeDiff: number,
    characterDiff: number,
    lastStatisticModified: number
  ) {
    const statistic = statisticObject;

    statistic.readingTime = Math.max(0, statistic.readingTime + timeDiff);
    statistic.charactersRead = Math.max(0, statistic.charactersRead + characterDiff);
    statistic.lastReadingSpeed = statistic.readingTime
      ? Math.ceil((3600 * statistic.charactersRead) / statistic.readingTime)
      : 0;
    statistic.minReadingSpeed = statistic.minReadingSpeed
      ? Math.min(statistic.minReadingSpeed, statistic.lastReadingSpeed)
      : statistic.lastReadingSpeed;
    statistic.maxReadingSpeed = Math.max(statistic.maxReadingSpeed, statistic.lastReadingSpeed);
    statistic.lastStatisticModified = lastStatisticModified;

    if (characterDiff) {
      statistic.altMinReadingSpeed = statistic.altMinReadingSpeed
        ? Math.min(statistic.altMinReadingSpeed, statistic.lastReadingSpeed)
        : statistic.lastReadingSpeed;
    }

    return statistic;
  }

  function updateTimeToFinishBook() {
    timeToFinishBook = sessionStatistics.lastReadingSpeed
      ? toTimeString(
          Math.max(
            0,
            Math.floor(
              (bookCharCount - exploredCharCount) / (sessionStatistics.lastReadingSpeed / 3600)
            )
          )
        )
      : 'N/A';
  }
</script>

{$readingTracker$ ?? ''}
{$updateTrackerIdleTime$ ?? ''}
{$autoResumeAfterIdle$ ?? ''}
{$autoScrollerTimer$ ?? ''}

<svelte:window
  on:blur={handleBlur}
  on:focus={handleFocus}
  on:pagehide={() => void sealSession()}
  on:resize={() => (lastResizeAt = Date.now())}
/>
<svelte:document bind:visibilityState />

{#if $isTrackerMenuOpen$}
  <div
    class="writing-horizontal-tb fixed top-0 left-0 z-[60] flex h-full w-full max-w-xl flex-col justify-between"
    style:color={fontColor}
    style:background-color={backgroundColor}
    in:fly|local={{ x: -100, duration: $einkMode$ ? 0 : 100, easing: quintInOut }}
    use:clickOutside={() => {
      if (!actionInProgress) {
        dialogManager.dialogs$.next([]);
        dispatch('trackerMenuClosed');
      }
    }}
  >
    <BookTimerMenu
      {fontColor}
      {backgroundColor}
      {actionInProgress}
      {hadError}
      {currentReadingGoal}
      {currentTimeGoal}
      {currentCharacterGoal}
      {currentReadingGoalStart}
      {currentReadingGoalEnd}
      {remainingTimeInReadingGoalWindow}
      {timeToFinishBook}
      {exploredCharCount}
      {lastExploredCharCount}
      {previousLastExploredCharCount}
      {frozenPosition}
      {trackingHistory}
      {sessionStatistics}
      {todaysStatistics}
      {allTimeStatistics}
      {bookCompletionStatistics}
      {autoScrollerStatistics}
      {bookStartDate}
      {sectionData}
      {statsUnavailable}
      canSaveStatistics={statisticsToStore.size > 0}
      bind:wasTrackerPaused
      on:trackerMenuClosed
      on:freezeCurrentLocation
      on:updateCurrentLocation={updateLastExploredCharCount}
      on:saveStatistics={() => flushUpdates()}
      on:revertStatistic={revertTrackerHistory}
    />
  </div>
{/if}
