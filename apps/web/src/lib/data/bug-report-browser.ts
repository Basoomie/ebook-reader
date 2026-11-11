/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { buildBugReport } from '$lib/data/bug-report';
import { logger } from '$lib/data/logger';
import { StorageSourceDefault } from '$lib/data/storage/storage-types';
import {
  theme$,
  viewMode$,
  fontFamilyGroupOne$,
  fontFamilyGroupTwo$,
  fontSize$,
  lineHeight$,
  textIndentation$,
  textMarginMode$,
  textMarginValue$,
  firstDimensionMargin$,
  secondDimensionMaxValue$,
  swipeThreshold$,
  disableWheelNavigation$,
  writingMode$,
  enableVerticalFontKerning$,
  enableFontVPAL$,
  verticalTextOrientation$,
  prioritizeReaderStyles$,
  enableTextJustification$,
  enableTextWrapPretty$,
  confirmClose$,
  autoBookmark$,
  autoBookmarkTime$,
  hideSpoilerImage$,
  hideFurigana$,
  furiganaStyle$,
  avoidPageBreak$,
  pauseTrackerOnCustomPointChange$,
  customReadingPointEnabled$,
  selectionToBookmarkEnabled$,
  enableTapEdgeToFlip$,
  pageColumns$,
  autoPositionOnResize$,
  requestPersistentStorage$,
  importHTMLFixMode$,
  restrictImportFixToAnchor$,
  cacheStorageData$,
  autoReplication$,
  replicationSaveBehavior$,
  showExternalPlaceholder$,
  gDriveStorageSource$,
  oneDriveStorageSource$,
  fsStorageSource$,
  syncTarget$,
  keepLocalStatisticsOnDeletion$,
  overwriteBookCompletion$,
  startDayHoursForTracker$,
  statisticsMergeMode$,
  readingGoalsMergeMode$,
  statisticsEnabled$,
  trackerAutoPause$,
  openTrackerOnCompletion$,
  addCharactersOnCompletion$,
  trackerAutostartTime$,
  trackerIdleTime$,
  trackerLongPressTime$,
  trackerForwardSkipThreshold$,
  trackerBackwardSkipThreshold$,
  trackerSkipThresholdAction$,
  trackerPopupDetection$,
  adjustStatisticsAfterIdleTime$,
  readingGoal$,
  lastSyncedSettingsSource$,
  lastSyncedSettingsTarget$,
  lastReadingGoalsModified$,
  isOnline$,
  multiplier$,
  showCharacterCounter$,
  showPercentage$,
  showFooterChapterCharacterCounter$,
  showFooterChapterPercentage$,
  enableReaderWakeLock$
} from '$lib/data/store';
import { LibraryApi } from '$lib/library/api';
import { getLibraryStore } from '$lib/library/library-db';
import { libraryRequestTimeoutSeconds$ } from '$lib/library/settings';

/**
 * The browser side of the bug-report bundle (WP18): what this device knows, and the
 * server's recent lines read with this device's token. See bug-report.ts.
 */

/** Browser, screen and settings (the report as it was before WP18). */
export function deviceReport() {
  return {
    userAgent: navigator.userAgent,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffset: new Date().getTimezoneOffset(),
    languages: navigator.languages,
    viewport: {
      visualViewport: !!window.visualViewport,
      width: window.visualViewport?.width ?? window.innerWidth,
      height: window.visualViewport?.height ?? window.innerHeight
    },
    settings: {
      theme: theme$.getValue(),
      viewMode: viewMode$.getValue(),
      fontFamilyGroupOne: fontFamilyGroupOne$.getValue(),
      fontFamilyGroupTwo: fontFamilyGroupTwo$.getValue(),
      fontSize: fontSize$.getValue(),
      lineHeight: lineHeight$.getValue(),
      textIndentation: textIndentation$.getValue(),
      textMarginMode: textMarginMode$.getValue(),
      textMarginValue: textMarginValue$.getValue(),
      firstDimensionMargin: firstDimensionMargin$.getValue(),
      secondDimensionMaxValue: secondDimensionMaxValue$.getValue(),
      swipeThreshold: swipeThreshold$.getValue(),
      disableWheelNavigation: disableWheelNavigation$.getValue(),
      writingMode: writingMode$.getValue(),
      enableVerticalFontKerning: enableVerticalFontKerning$.getValue(),
      enableFontVPAL: enableFontVPAL$.getValue(),
      verticalTextOrientation: verticalTextOrientation$.getValue(),
      prioritizeReaderStyles: prioritizeReaderStyles$.getValue(),
      enableTextJustification: enableTextJustification$.getValue(),
      enableTextWrapPretty: enableTextWrapPretty$.getValue(),
      enableReaderWakeLock: enableReaderWakeLock$.getValue(),
      showCharacterCounter$: showCharacterCounter$.getValue(),
      showPercentage$: showPercentage$.getValue(),
      showFooterChapterCharacterCounter: showFooterChapterCharacterCounter$.getValue(),
      showFooterChapterPercentage: showFooterChapterPercentage$.getValue(),
      confirmClose: confirmClose$.getValue(),
      autoBookmark: autoBookmark$.getValue(),
      autoBookmarkTime: autoBookmarkTime$.getValue(),
      hideSpoilerImage: hideSpoilerImage$.getValue(),
      hideFurigana: hideFurigana$.getValue(),
      furiganaStyle: furiganaStyle$.getValue(),
      avoidPageBreak: avoidPageBreak$.getValue(),
      pauseTrackerOnCustomPointChange: pauseTrackerOnCustomPointChange$.getValue(),
      customReadingPointEnabled: customReadingPointEnabled$.getValue(),
      selectionToBookmarkEnabled: selectionToBookmarkEnabled$.getValue(),
      enableTapEdgeToFlip: enableTapEdgeToFlip$.getValue(),
      pageColumns: pageColumns$.getValue(),
      autoPositionOnResize: autoPositionOnResize$.getValue(),
      requestPersistentStorage: requestPersistentStorage$.getValue(),
      importHTMLFixMode: importHTMLFixMode$.getValue(),
      restrictImportFixToAnchor: restrictImportFixToAnchor$.getValue(),
      cacheStorageData: cacheStorageData$.getValue(),
      autoReplication: autoReplication$.getValue(),
      replicationSaveBehavior: replicationSaveBehavior$.getValue(),
      showExternalPlaceholder: showExternalPlaceholder$.getValue(),
      gDriveStorageSource: gDriveStorageSource$.getValue() === StorageSourceDefault.GDRIVE_DEFAULT,
      oneDriveStorageSource:
        oneDriveStorageSource$.getValue() === StorageSourceDefault.ONEDRIVE_DEFAULT,
      fsStorageSource: !!fsStorageSource$.getValue(),
      syncTarget: !!syncTarget$.getValue(),
      keepLocalStatisticsOnDeletion: keepLocalStatisticsOnDeletion$.getValue(),
      overwriteBookCompletion: overwriteBookCompletion$.getValue(),
      startDayHoursForTracker: startDayHoursForTracker$.getValue(),
      statisticsMergeMode: statisticsMergeMode$.getValue(),
      readingGoalsMergeMode: readingGoalsMergeMode$.getValue(),
      statisticsEnabled: statisticsEnabled$.getValue(),
      trackerAutoPause: trackerAutoPause$.getValue(),
      openTrackerOnCompletion: openTrackerOnCompletion$.getValue(),
      addCharactersOnCompletion: addCharactersOnCompletion$.getValue(),
      trackerAutostartTime: trackerAutostartTime$.getValue(),
      trackerIdleTime: trackerIdleTime$.getValue(),
      trackerLongPressTime: trackerLongPressTime$.getValue(),
      trackerForwardSkipThreshold: trackerForwardSkipThreshold$.getValue(),
      trackerBackwardSkipThreshold: trackerBackwardSkipThreshold$.getValue(),
      trackerSkipThresholdAction: trackerSkipThresholdAction$.getValue(),
      trackerPopupDetection: trackerPopupDetection$.getValue(),
      adjustStatisticsAfterIdleTime: adjustStatisticsAfterIdleTime$.getValue(),
      readingGoal: readingGoal$.getValue(),
      lastSyncedSettingsSource: lastSyncedSettingsSource$.getValue(),
      lastSyncedSettingsTarget: lastSyncedSettingsTarget$.getValue(),
      lastReadingGoalsModified: lastReadingGoalsModified$.getValue(),
      isOnline: isOnline$.getValue(),
      multiplier: multiplier$.getValue()
    }
  };
}

async function syncReport() {
  const { getSyncEngine } = await import('$lib/sync/sync-service');
  const engine = await getSyncEngine();
  const [status, rejected] = await Promise.all([engine.status(), engine.rejectedChanges(50)]);
  return { ...status, rejectedChanges: rejected };
}

async function connectedApi(): Promise<LibraryApi | null> {
  const connection = await getLibraryStore().getConnection();
  if (!connection) return null;
  return new LibraryApi(connection.serverUrl, connection.token, 0);
}

async function storedSecrets(): Promise<string[]> {
  const connection = await getLibraryStore().getConnection();
  return connection?.token ? [connection.token] : [];
}

/** The redacted bundle for the bug-report dialog. Never throws. */
export function collectBugReport(title: string, message: string) {
  return buildBugReport({
    title,
    message,
    device: deviceReport,
    log: () => logger.history,
    sync: syncReport,
    serverLogs: async (signal) => {
      const api = await connectedApi();
      return api ? api.recentServerLogs({ signal }) : null;
    },
    secrets: storedSecrets,
    // The device's library request timeout (Settings), as for every other server call.
    serverTimeoutSeconds: libraryRequestTimeoutSeconds$.getValue()
  });
}
