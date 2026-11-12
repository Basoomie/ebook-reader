/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { ConfirmCopy } from './confirm-state';

/**
 * The words of every confirmation before a destructive action (WP19), in one place so they
 * read alike: a question naming what goes, then what happens, where, and what stays.
 * Everyday words only (no design-doc terms).
 */

function books(count: number): string {
  return count === 1 ? '1 book' : `${count.toLocaleString('en-US')} books`;
}

function quoted(name: string): string {
  return `“${name}”`;
}

// ---- Book Manager -------------------------------------------------------------

export type ManagerSource = 'browser' | 'fs' | 'gdrive' | 'onedrive' | 'selfhost' | string;

const SOURCE_NAMES: Record<string, string> = {
  fs: 'the folder on this device',
  gdrive: 'Google Drive',
  onedrive: 'OneDrive',
  selfhost: 'the old sync server'
};

/** Book Manager: delete the selected books (or one, with its title). */
export function deleteBooksCopy(options: {
  count: number;
  title?: string;
  source: ManagerSource;
  keepStatistics: boolean;
}): ConfirmCopy {
  const { count, title, source, keepStatistics } = options;
  const one = count === 1;
  const message: string[] = [];
  if (source === 'browser') {
    message.push(
      `${one ? 'The book is' : 'They are'} removed from this browser, together with ${
        one ? 'its' : 'their'
      } audiobook and subtitles${keepStatistics ? '' : ' and statistics'}.`,
      'Books from your library can be opened again from the Library. Reading places, highlights and notes saved with the library server stay.'
    );
  } else {
    message.push(
      `${one ? 'The book is' : 'They are'} removed from ${SOURCE_NAMES[source] ?? quoted(source)}.`
    );
  }
  return {
    title: one && title ? `Delete ${quoted(title)}?` : `Delete ${books(count)}?`,
    message,
    confirmLabel: one ? 'Delete book' : `Delete ${books(count)}`,
    irreversible: true
  };
}

/** Book Manager: delete the statistics of the selected books (kept from before WP19). */
export function deleteStatisticsCopy(count: number): ConfirmCopy {
  return {
    title: `Delete the statistics of ${books(count)}?`,
    message: [
      'All statistics saved on this device for these books are deleted, including start and finish data.',
      'Other devices keep theirs. To delete them there too, run a one-time sync with Import/Export Behavior “Overwrite” or Statistics Merge “Replace”.'
    ],
    confirmLabel: 'Delete statistics',
    irreversible: true
  };
}

/** Book Manager: import a backup while a setting lets it replace data on this device. */
export function importBackupCopy(replaces: {
  books: boolean;
  statistics: boolean;
  goals: boolean;
}): ConfirmCopy {
  const message: string[] = [];
  if (replaces.books) {
    message.push(
      'Books in the backup replace the copies on this device, even newer ones (Import/Export Behavior is “Overwrite”).'
    );
  }
  if (replaces.statistics) {
    message.push(
      "Statistics on this device are replaced by the backup's (Statistics Merge is “Replace”)."
    );
  }
  if (replaces.goals) {
    message.push("Reading goals on this device are replaced by the backup's.");
  }
  return {
    title: 'Import this backup?',
    message,
    confirmLabel: 'Import and replace',
    irreversible: true
  };
}

// ---- Settings -----------------------------------------------------------------------

export function disconnectCopy(): ConfirmCopy {
  return {
    title: 'Disconnect this device?',
    message: [
      'This device stops syncing with the library server and forgets its sign-in. To connect again you need a new pairing code.',
      'Books and reading data already on this device stay.'
    ],
    confirmLabel: 'Disconnect'
  };
}

export function deleteThemeCopy(name: string): ConfirmCopy {
  return {
    title: `Delete the theme ${quoted(name)}?`,
    message: [
      'It is removed on every device that shares your settings. Where it is in use, another theme takes its place.'
    ],
    confirmLabel: 'Delete theme',
    irreversible: true
  };
}

export function deleteStorageSourceCopy(name: string): ConfirmCopy {
  return {
    title: `Delete the storage source ${quoted(name)}?`,
    message: [
      'Its settings and sign-in are removed from this device. Files already stored there are not touched.'
    ],
    confirmLabel: 'Delete source'
  };
}

export function deleteFontCopy(name: string): ConfirmCopy {
  return {
    title: `Delete ${quoted(name)} from every device?`,
    message: ['Each device removes it on its next sync. Uploading the file again brings it back.'],
    confirmLabel: 'Delete font',
    cancelLabel: 'Keep'
  };
}

// ---- Stats -----------------------------------------------------------------------------

/** End goal. `removesCompletely`: it began in its current period, so nothing of it stays. */
export function endGoalCopy(goal: string, removesCompletely: boolean): ConfirmCopy {
  return {
    title: `End the goal ${quoted(goal)}?`,
    message: [
      removesCompletely
        ? 'It started in the current period, so it is removed completely, on every device.'
        : 'It stops before the current period, on every device. Earlier periods stay in your history.',
      "Your reading statistics don't change."
    ],
    confirmLabel: 'End goal',
    irreversible: true
  };
}

// ---- Library and collections -----------------------------------------------------------

export function removeFromCollectionCopy(options: {
  count: number;
  title?: string;
  collection: string;
}): ConfirmCopy {
  const { count, title, collection } = options;
  const one = count === 1;
  return {
    title:
      one && title
        ? `Remove ${quoted(title)} from ${quoted(collection)}?`
        : `Remove ${books(count)} from ${quoted(collection)}?`,
    message: [
      `${one ? 'The book stays' : 'The books stay'} in your library. This changes the collection on every device; adding ${
        one ? 'it' : 'them'
      } back puts ${one ? 'it' : 'them'} at the end.`
    ],
    confirmLabel: one ? 'Remove' : `Remove ${books(count)}`
  };
}

export function removeFavoritesCopy(count: number): ConfirmCopy {
  return {
    title: `Remove ${books(count)} from Favorites?`,
    message: [
      `${count === 1 ? 'The book stays' : 'The books stay'} in your library. This changes Favorites on every device.`
    ],
    confirmLabel: 'Remove from Favorites'
  };
}

export function deleteCollectionCopy(name: string): ConfirmCopy {
  return {
    title: `Delete ${quoted(name)}?`,
    message: ['The collection goes away on every device. The books stay in your library.'],
    confirmLabel: 'Delete collection',
    irreversible: true
  };
}

// ---- Book status (also opened in the reader) ----------------------------------------------

export function startOverCopy(): ConfirmCopy {
  return {
    title: 'Start over?',
    message: [
      'You read the book again from the beginning, on every device. Your earlier reads and their stats are kept.'
    ],
    confirmLabel: 'Start over'
  };
}

/** `ordinal`: "2nd" (from the read's number). */
export function removeReadCopy(ordinal: string): ConfirmCopy {
  return {
    title: `Remove the ${ordinal} read?`,
    message: [
      "It no longer counts in Times read, on every device. Your reading statistics don't change."
    ],
    confirmLabel: 'Remove read'
  };
}

// ---- Reader ------------------------------------------------------------------------------------

export function removeNoteCopy(): ConfirmCopy {
  return {
    title: 'Remove this note?',
    message: ['The note is removed on every device. A highlight it belongs to stays.'],
    confirmLabel: 'Remove note',
    irreversible: true
  };
}

export function copyLookCopy(device: string): ConfirmCopy {
  return {
    title: `Use the look of ${device}?`,
    message: [
      'The theme, fonts, sizes and page layout of this device are replaced by theirs. E-ink and Zen mode stay as they are.'
    ],
    confirmLabel: 'Copy look'
  };
}

/** The reader's Complete Book (not a removal, so the plain filled button). */
export function completeBookCopy(charactersAdded: number): ConfirmCopy {
  return {
    title: 'Mark this book as finished?',
    message: [
      `Your place moves to the end of the book and it counts as read${
        charactersAdded
          ? `. The ${charactersAdded.toLocaleString('en-US')} characters you haven't read yet are added to today's statistics`
          : ''
      }.`
    ],
    confirmLabel: 'Mark as finished',
    danger: false
  };
}

// ---- Audiobook links (book details) ----------------------------------------------------------------

const AUDIO_STAYS =
  'This applies on every device. The audio files in the audiobooks folder are not touched.';

export function unlinkAudiobookCopy(folderName: string): ConfirmCopy {
  return {
    title: 'Unlink the audiobook?',
    message: [
      `${quoted(String(folderName))} is no longer linked to this book, and neither are its subtitles. The suggestions come back.`,
      AUDIO_STAYS
    ],
    confirmLabel: 'Unlink audiobook'
  };
}

export function replaceAudiobookCopy(oldName: string, newName: string): ConfirmCopy {
  return {
    title: 'Replace the audiobook?',
    message: [
      `${quoted(String(newName))} is linked instead of ${quoted(String(oldName))}. You choose the subtitles again.`,
      AUDIO_STAYS
    ],
    confirmLabel: 'Replace audiobook'
  };
}

export function noAudiobookCopy(folderName: string): ConfirmCopy {
  return {
    title: 'Mark this book as having no audiobook?',
    message: [
      `${quoted(String(folderName))} is no longer linked to this book, and no audiobooks are suggested for it.`,
      AUDIO_STAYS
    ],
    confirmLabel: 'No audiobook'
  };
}

export function replaceSubtitlesCopy(oldName: string, newName: string): ConfirmCopy {
  return {
    title: 'Replace the subtitles?',
    message: [
      `${quoted(String(newName))} is linked instead of ${quoted(String(oldName))}.`,
      'This applies on every device. The subtitle files are not touched.'
    ],
    confirmLabel: 'Replace subtitles'
  };
}

export function removeSubtitlesCopy(name: string): ConfirmCopy {
  return {
    title: 'Remove the subtitles?',
    message: [
      `${quoted(String(name))} is no longer linked to this audiobook.`,
      'This applies on every device. The subtitle file is not touched.'
    ],
    confirmLabel: 'Remove subtitles'
  };
}

// ---- Whispersync (audiobook menu) -----------------------------------------------------------------

export function resetMatchCopy(): ConfirmCopy {
  return {
    title: 'Reset the audiobook match?',
    message: [
      'The book goes back to how it was before matching, and the page reloads. The linked audio and subtitle files stay.'
    ],
    confirmLabel: 'Reset match',
    irreversible: true
  };
}

export function resetAllCopy(): ConfirmCopy {
  return {
    title: 'Reset everything for this audiobook?',
    message: [
      'The match, the saved subtitles, the playback position and the linked files are removed, and the page reloads.'
    ],
    confirmLabel: 'Reset everything',
    irreversible: true
  };
}

export function resetPlaybackCopy(): ConfirmCopy {
  return {
    title: 'Reset the playback position?',
    message: ['Playback starts again from the beginning of the audio.'],
    confirmLabel: 'Reset position'
  };
}

export function dropSavedSubtitlesCopy(): ConfirmCopy {
  return {
    title: 'Remove the saved subtitles?',
    message: [
      'The subtitles saved for this book, with your edits, are removed, also from sync. You can load the subtitle file again.'
    ],
    confirmLabel: 'Remove subtitles',
    irreversible: true
  };
}

export function dropFileCopy(kind: 'audio' | 'subtitle'): ConfirmCopy {
  return {
    title: `Unlink the ${kind} file?`,
    message: [
      `The book forgets which ${kind} file it uses. The file itself isn't touched; choose it again to use it.`
    ],
    confirmLabel: 'Unlink file'
  };
}

export function restoreSubtitlesCopy(selectedOnly: boolean): ConfirmCopy {
  return {
    title: selectedOnly ? 'Restore the selected subtitles?' : 'Restore all subtitles?',
    message: [
      `Your changes to the time and text of ${
        selectedOnly ? 'the selected' : 'all'
      } subtitles are replaced by the originals.`
    ],
    confirmLabel: 'Restore originals',
    irreversible: true
  };
}

export function clearActionListCopy(): ConfirmCopy {
  return {
    title: 'Turn off every button in this list?',
    message: [
      'All buttons in this list are unticked. Tick them again one by one, or restore the defaults.'
    ],
    confirmLabel: 'Turn all off'
  };
}

export function restoreActionListCopy(): ConfirmCopy {
  return {
    title: 'Restore the default buttons?',
    message: ['Your order and choice of buttons in this list go back to the defaults.'],
    confirmLabel: 'Restore defaults'
  };
}
