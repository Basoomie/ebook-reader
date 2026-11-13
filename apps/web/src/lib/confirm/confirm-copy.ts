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

// ---- This device (WP15e; replaces the old Book Manager's delete) ----------------------

/** "Remove from this device" (a book's ⋮ menu and its details page). */
export function removeFromDeviceCopy(title: string): ConfirmCopy {
  return {
    title: `Remove ${quoted(title)} from this device?`,
    message: [
      "The book's copy on this device is removed, together with its bookmark and the audiobook place and subtitles stored here.",
      'Reading places, statistics, highlights and notes saved with the library server stay, and so does the book in your library: open it again to download it.'
    ],
    confirmLabel: 'Remove from this device'
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

/** A change of files resets whispersync's saved match and subtitles (server, 2026-11-13). */
const MATCH_RESET =
  "The book's audiobook match and its saved subtitles are reset, because they were made with the old files. The listening position stays.";

export function unlinkAudiobookCopy(folderName: string): ConfirmCopy {
  return {
    title: 'Unlink the audiobook?',
    message: [
      `${quoted(String(folderName))} is no longer linked to this book, and neither are its subtitles. The suggestions come back.`,
      MATCH_RESET,
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
      MATCH_RESET,
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
      MATCH_RESET,
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
      MATCH_RESET,
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
      MATCH_RESET,
      'This applies on every device. The subtitle file is not touched.'
    ],
    confirmLabel: 'Remove subtitles'
  };
}

/** WP15f: "Merge into one file" writes a new file into the audiobooks folder. */
export function mergeAudiobookCopy(
  folderName: string,
  fileCount: number,
  approxSize: string
): ConfirmCopy {
  return {
    title: 'Merge into one file?',
    message: [
      `The ${fileCount} files of ${quoted(String(folderName))} are joined in the order shown into one new file of about ${approxSize}, saved next to them in the same folder. Each file becomes a chapter.`,
      "The original files are not changed. Audiobookshelf will show both the originals and the new file; delete the ones you don't need yourself.",
      'When it is done, this book uses the new file and you choose the subtitles. Its audiobook match and saved subtitles are reset then; the listening position stays.'
    ],
    confirmLabel: 'Merge files',
    danger: false
  };
}

export function stopMergeCopy(folderName: string): ConfirmCopy {
  return {
    title: 'Stop the merge?',
    message: [
      `The merge of ${quoted(String(folderName))} stops. Nothing is added to the audiobooks folder; you can start it again later.`
    ],
    confirmLabel: 'Stop merge'
  };
}

// ---- WP16: subtitles made on the PC (SubPlz) -------------------------------------------------------

export function stopSubtitleJobCopy(bookTitle: string): ConfirmCopy {
  return {
    title: 'Stop making subtitles?',
    message: [
      `Making subtitles for ${quoted(String(bookTitle))} stops. Nothing is added to the subtitle folder; you can start it again later.`
    ],
    confirmLabel: 'Stop making subtitles'
  };
}

export function replaceSubtitlesWithJobCopy(subtitleName: string): ConfirmCopy {
  return {
    title: 'Make new subtitles for this book?',
    message: [
      `Your PC makes new subtitles from the audiobook and the book's text. When they are ready, this book uses them instead of ${quoted(String(subtitleName))}, on every device, and its audiobook match and saved subtitles are reset (the listening position stays).`,
      `${quoted(String(subtitleName))} stays in the subtitle folder.`
    ],
    confirmLabel: 'Make new subtitles',
    danger: false
  };
}

// ---- Audiobooks made on the PC (WP17) -------------------------------------------------------------

export function replaceAudiobookWithMadeCopy(audiobookName: string): ConfirmCopy {
  return {
    title: 'Make an audiobook for this book?',
    message: [
      `Your PC reads the book aloud with the voice you chose. When it is ready, this book uses the new audiobook and its subtitles instead of ${quoted(String(audiobookName))}, on every device, and its audiobook match and saved subtitles are reset (the listening position stays).`,
      `${quoted(String(audiobookName))} stays in the audiobooks folder.`
    ],
    confirmLabel: 'Make the audiobook',
    danger: false
  };
}

export function stopAudiobookJobCopy(bookTitle: string, chaptersDone: number): ConfirmCopy {
  return {
    title: 'Stop making the audiobook?',
    message: [
      `Making the audiobook of ${quoted(String(bookTitle))} stops, and the ${
        chaptersDone === 1 ? 'chapter' : `${chaptersDone} chapters`
      } read so far ${chaptersDone === 1 ? 'is' : 'are'} thrown away. Nothing is added to the audiobooks folder.`,
      'To stop for a while and go on later instead, pause the PC in Settings > Audiobooks.'
    ],
    confirmLabel: 'Stop making the audiobook'
  };
}

export function deleteVoiceCopy(name: string): ConfirmCopy {
  return {
    title: 'Delete this voice?',
    message: [
      `${quoted(String(name))} is deleted from the server. Audiobooks already made with it stay as they are.`
    ],
    confirmLabel: 'Delete voice'
  };
}

export function removeTtsModelCopy(label: string): ConfirmCopy {
  return {
    title: 'Remove this model?',
    message: [
      `${quoted(String(label))} is no longer offered, and the PC deletes its files the next time it checks in. Audiobooks already made with it stay as they are.`,
      'You can add it again later; it is then downloaded again.'
    ],
    confirmLabel: 'Remove model'
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

// ---- Library cleanup (WP20a) ----------------------------------------------------------

/** Turning stage 1 on: from then on it removes identical copies from Calibre on its own. */
export function turnOnIdenticalFilesCopy(toRemove: number | null): ConfirmCopy {
  const what =
    typeof toRemove !== 'number' || toRemove <= 0
      ? 'identical copies'
      : toRemove === 1
        ? 'the 1 identical copy'
        : `the ${toRemove.toLocaleString('en-US')} identical copies`;
  return {
    title: `Remove ${what} from Calibre?`,
    message: [
      'From now on this runs on its own, in batches: each copy is first saved to the quarantine folder, then moved to Calibre’s trash. The copy with more of your tags (or the older one) stays, and gets the removed copy’s own tags too.',
      'Reading data of a removed copy stays: when only the removed copy has any, it shows on the kept copy. Each batch can be undone on this page.'
    ],
    confirmLabel: 'Turn on and remove copies'
  };
}

/** Undo of one batch: the removed copies come back into Calibre. */
export function undoCleanupBatchCopy(count: number): ConfirmCopy {
  return {
    title: `Bring back ${books(count)} removed in this batch?`,
    message: [
      'They are restored in Calibre, from Calibre’s trash when they are still there, otherwise added again from the quarantine folder (then with a new Calibre id). Reading data that moved to the kept copy moves back.',
      'The quarantine folder stays as it is.'
    ],
    confirmLabel: 'Undo this batch',
    danger: false
  };
}

/** Replacing a saved API key or the Calibre password (they can't be shown again). */
export function replaceCleanupSecretCopy(label: string): ConfirmCopy {
  return {
    title: `Replace the saved ${label}?`,
    message: ['The new one is saved instead, and the old one is gone from the server.'],
    confirmLabel: `Replace ${label}`,
    irreversible: true
  };
}

/** Removing a saved API key or the Calibre password. */
export function removeCleanupSecretCopy(label: string): ConfirmCopy {
  return {
    title: `Remove the saved ${label}?`,
    message: ['The library cleanup can’t use it until you enter it again.'],
    confirmLabel: `Remove ${label}`,
    irreversible: true
  };
}
