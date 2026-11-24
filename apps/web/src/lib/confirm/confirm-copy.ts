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

/**
 * "Remove from this device" (a book's ⋮ menu and its details page). `audioSize`: the
 * book's downloaded audio, removed with it (Season 2 Phase 9), as "1.2 GB".
 */
export function removeFromDeviceCopy(title: string, audioSize?: string): ConfirmCopy {
  return {
    title: `Remove ${quoted(title)} from this device?`,
    message: [
      "The book's copy on this device is removed, together with its bookmark and the audiobook place and subtitles stored here.",
      ...(audioSize
        ? [
            `Its audio downloaded to this device (${audioSize}) is removed too; the audiobook stays linked and streams from the library server.`
          ]
        : []),
      'Reading places, statistics, highlights and notes saved with the library server stay, and so does the book in your library: open it again to download it.'
    ],
    confirmLabel: 'Remove from this device'
  };
}

/** Season 2 Phase 9: the book page's "Remove audio from this device". */
export function removeAudioCopy(size: string): ConfirmCopy {
  return {
    title: 'Remove the audio from this device?',
    message: [
      `The audio downloaded to this device (${size}) is removed. The audiobook stays linked: whispersync streams it from the library server again.`,
      'Your listening place and match stay. You can download the audio again.'
    ],
    confirmLabel: 'Remove audio'
  };
}

/** Season 2 Phase 9: "Download the current audio" over a copy of an earlier link. */
export function replaceAudioCopy(oldFile: string, size: string): ConfirmCopy {
  return {
    title: 'Replace the audio on this device?',
    message: [
      `The audio on this device (${quoted(oldFile)}, ${size}) is removed, and the audiobook linked now is downloaded instead.`,
      'Your listening place and match stay.'
    ],
    confirmLabel: 'Replace audio'
  };
}

// ---- Settings -----------------------------------------------------------------------

/** Settings > Anki: cancel sentence audio that waits to be added (Season 2 §3). */
export function cancelPendingClipCopy(word: string): ConfirmCopy {
  return {
    title: word
      ? `Stop waiting to add sentence audio to 「${word}」?`
      : 'Stop waiting to add this sentence audio?',
    message: [
      'The sentence audio is not added to the card, and what this device kept for it is removed.',
      'The card stays as it is. Enrich it again to add the audio.'
    ],
    confirmLabel: 'Stop waiting',
    cancelLabel: 'Keep waiting'
  };
}

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

/**
 * Delete a reading session (the reading log's ⋯ menu, 2026-11-22). `when`: its day and
 * clock times; `numbers`: its time and characters, as the log shows them.
 */
export function deleteSessionCopy(q: {
  title: string;
  when: string;
  numbers: string;
}): ConfirmCopy {
  return {
    title: 'Delete this reading session?',
    message: [
      `${quoted(q.title)}, ${q.when} (${q.numbers}).`,
      'It is removed from the reading log and from every total, chart and goal, on every device.',
      'To keep it listed without counting it, use Leave out of the totals instead.'
    ],
    confirmLabel: 'Delete session',
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

/** Unread on a book that is part-read: it also goes back to the start (planSetStatus). */
export function unreadResetCopy(): ConfirmCopy {
  return {
    title: 'Set to Unread?',
    message: [
      'The book goes back to the start on every device and leaves Continue Reading. Your stats and earlier reads are kept.'
    ],
    confirmLabel: 'Set to Unread'
  };
}

/** Unread for a library selection. */
/**
 * Select mode's Download menu, above Settings > Data > "Ask before downloads larger than".
 * Removes nothing: the plain filled button.
 */
export function largeDownloadCopy(opts: {
  /** "audiobooks", "books", "covers", "SRT files". */
  what: string;
  count: number;
  size: string;
  zip: boolean;
}): ConfirmCopy {
  return {
    title: `Download ${opts.size}?`,
    message: [
      `${opts.count.toLocaleString('en-US')} ${opts.what}, ${opts.size} in all. ${
        opts.zip ? 'They arrive as one ZIP file.' : 'Each file is saved on its own.'
      }`,
      'You can change the size that asks first in Settings > Library > Downloading books.'
    ],
    confirmLabel: `Download ${opts.size}`,
    danger: false
  };
}

export function unreadManyCopy(count: number): ConfirmCopy {
  return {
    title: `Set ${books(count)} to Unread?`,
    message: [
      'Part-read books go back to the start on every device and leave Continue Reading. Your stats and earlier reads are kept.'
    ],
    confirmLabel: 'Set to Unread'
  };
}

/** `ordinal`: "2nd" (the read's place among the finished reads). */
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

/** Leaving the reader when the current place isn't bookmarked ("Confirm close" on). */
export function leaveUnbookmarkedCopy(): ConfirmCopy {
  return {
    title: 'Leave without a bookmark?',
    message: ['Your current place is not bookmarked.'],
    confirmLabel: 'Leave',
    cancelLabel: 'Stay',
    danger: false
  };
}

/** Opening a library book that is already on this device under another count (WP6). */
export function openOwnCopyCopy(q: {
  title: string;
  localCharacters: number;
  calibreCharacters: number;
}): ConfirmCopy {
  return {
    title: 'Open your own copy?',
    message: [
      `You already have "${q.title}" on this device (${Number(q.localCharacters).toLocaleString()} characters). The library copy has ${Number(q.calibreCharacters).toLocaleString()} characters, so it may be a different edition.`,
      'Your copy opens and is remembered as this library book. Your copy and its progress are not changed.'
    ],
    confirmLabel: 'Open my copy',
    danger: false
  };
}

/** WP7b: a migrated placeholder becomes the library copy with another count. */
export function openLibraryCopyCopy(q: {
  title: string;
  localCharacters: number;
  calibreCharacters: number;
}): ConfirmCopy {
  return {
    title: 'Open the library copy?',
    message: [
      `Your old copy of "${q.title}" had ${Number(q.localCharacters).toLocaleString()} characters; the library copy has ${Number(q.calibreCharacters).toLocaleString()}, so your place may move a little.`,
      'The library copy opens from now on. Your reading place, bookmark and stats are kept.'
    ],
    confirmLabel: 'Open the library copy',
    danger: false
  };
}

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

/** Settings > Data, "Copy settings from another device": all of that device's own settings. */
export function copyAllSettingsCopy(device: string, savedWhen: string): ConfirmCopy {
  return {
    title: `Use all settings of ${device}?`,
    message: [
      `This device's own settings are replaced by ${device}'s, as saved there ${savedWhen}: the reader's look and behaviour, E-ink and Zen mode, the reading tracker, Library and Home, sync and Anki connection settings, and whispersync's settings.`,
      "Not copied: the AnkiConnect key. Enter it again in Settings > Anki, and in whispersync's Anki settings if you use them. Settings shared by all devices are already the same here."
    ],
    confirmLabel: 'Copy all settings'
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
      `The ${fileCount} files of ${quoted(String(folderName))} are joined in the order shown into one new file of about ${approxSize}, saved in the reader's own folder for merged files (Audiobookshelf doesn't show it). Each file's chapters are kept; a file without chapters becomes one chapter.`,
      'The original files are not changed.',
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

// ---- Per-character voices (Season 2 Phase 12 session 5) ---------------------------------

/** Stop working out who speaks (the answers so far are thrown away). */
export function stopSpeakersCopy(bookTitle: string): ConfirmCopy {
  return {
    title: 'Stop finding who speaks?',
    message: [
      `The PC stops working out who speaks in ${quoted(String(bookTitle))}. What it found in this run is thrown away; the characters and speakers from an earlier run, and your changes, stay.`,
      'To stop for a while and go on later instead, pause the PC in Settings > Audiobooks.'
    ],
    confirmLabel: 'Stop finding who speaks'
  };
}

/** Run again over a book that has speakers (corrections and voices are kept). */
export function runSpeakersAgainCopy(corrected: number): ConfirmCopy {
  return {
    title: 'Find who speaks again?',
    message: [
      'The PC reads the whole book again and gives every quote the speaker it finds now.',
      `${corrected ? `Your ${corrected === 1 ? 'correction' : `${corrected} corrections`}, ` : 'Your '}renamed characters and their voices stay as you set them.`
    ],
    confirmLabel: 'Find who speaks again',
    danger: false
  };
}

/** Merge one character into another. */
export function mergeCharacterCopy(from: string, into: string, quotes: number): ConfirmCopy {
  return {
    title: `Merge ${quoted(from)} into ${quoted(into)}?`,
    message: [
      `${quotes === 1 ? 'Its quote is' : `Its ${quotes} quotes are`} read by ${quoted(into)} from now on, and ${quoted(from)} becomes another name of ${quoted(into)} (later runs find it by that name too).`,
      `${quoted(from)} is removed from the list; to separate them again, add the character back and change the quotes.`
    ],
    confirmLabel: 'Merge'
  };
}

/** Start an audiobook while the book's speakers are not (yet) worked out (user, 2026-11-16). */
export function audiobookWithoutSpeakersCopy(running: boolean): ConfirmCopy {
  return {
    title: running
      ? 'Make the audiobook before the speakers are found?'
      : 'Make the audiobook without character voices?',
    message: [
      running
        ? 'The PC is still working out who speaks in this book. An audiobook started now uses what is known so far: quotes without a speaker are read with the dialogue voice.'
        : 'Who speaks each quote has not been worked out for this book, so every quote is read with the dialogue voice.',
      'Find who speaks under “Characters” to give characters their own voices; you can make a new version of the audiobook later.'
    ],
    confirmLabel: 'Make it anyway',
    danger: false
  };
}

/** Remove a speaker model from the list (Settings > Audiobooks). */
export function removeSpeakerModelCopy(label: string): ConfirmCopy {
  return {
    title: 'Remove this speaker model?',
    message: [
      `${quoted(String(label))} is no longer offered, and the PC deletes its file the next time it checks in. Speakers already found with it stay as they are.`,
      'You can add it again later; it is then downloaded again.'
    ],
    confirmLabel: 'Remove model'
  };
}

/** Season 2 Phase 12: remove a pronunciation fix (a book's or the global list). */
export function removePronunciationFixCopy(match: string, global: boolean): ConfirmCopy {
  return {
    title: `Remove the fix for ${quoted(match)}?`,
    message: [
      global
        ? 'Audio the PC makes from now on reads it as before, in every book.'
        : 'Audio the PC makes for this book from now on reads it as before.',
      'Audiobooks already made stay as they are.'
    ],
    confirmLabel: 'Remove fix'
  };
}

// ---- Whispersync (audiobook menu) -----------------------------------------------------------------

/**
 * Reset match: the reader's (the page reloads), and the book page's (Whispersync Match on the
 * book page, `reload: false`: the page stays, the reset applies on every device).
 */
export function resetMatchCopy(options: { reload?: boolean } = {}): ConfirmCopy {
  return {
    title: 'Reset the audiobook match?',
    message: [
      options.reload === false
        ? 'The book goes back to how it was before matching, on every device. The linked audio and subtitle files stay.'
        : 'The book goes back to how it was before matching, and the page reloads. The linked audio and subtitle files stay.'
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

/** Settings > Reader > Toolbars: "Reset to default" of one bar's list (this device only). */
export function resetToolbarCopy(bar: 'top' | 'bottom'): ConfirmCopy {
  const name = bar === 'top' ? 'top bar' : 'bottom bar';
  return {
    title: `Reset the ${name} to its default?`,
    message: [
      `The order of the ${name}’s buttons and where each one shows go back to the defaults on this device.`,
      'Other devices keep their own toolbars.'
    ],
    confirmLabel: 'Reset',
    // Nothing is deleted: the plain filled button.
    danger: false
  };
}

/** Settings > Library > Links: Reset to default. */
export function resetLinksCopy(): ConfirmCopy {
  return {
    title: 'Reset the links to their default?',
    message: [
      'Put the links back in their default order and places on this device.',
      'Other devices keep their own links.'
    ],
    confirmLabel: 'Reset',
    // Nothing is deleted: the plain filled button (as Reset of the toolbars).
    danger: false
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
      'With many books in Calibre’s trash, Calibre takes a few minutes before the first one is back.',
      'The quarantine folder stays as it is.'
    ],
    confirmLabel: 'Undo this batch',
    danger: false
  };
}

/**
 * Turning stage 2 on (WP20b): from then on it writes the books' own titles, authors, covers
 * and more into Calibre on its own.
 */
export function turnOnFileMetadataCopy(counts: {
  books: number | null;
  folderMoves: number | null;
}): ConfirmCopy {
  const what =
    typeof counts.books !== 'number' || counts.books <= 0 ? 'the books' : `${books(counts.books)}`;
  return {
    title: `Write the files’ metadata into Calibre for ${what}?`,
    message: [
      'From now on this runs on its own, in batches: titles, first authors, covers, Amazon ids, and an empty publisher, language or illustrator are taken from each book’s own file. Titles and authors are written only where Calibre’s are worse (author “Unknown” or the Google-era tag), or tidied where they already agree; the rest waits in Review.',
      typeof counts.folderMoves === 'number' && counts.folderMoves > 0
        ? `Calibre moves the folders of ${books(counts.folderMoves)} whose title or first author changes; the reader follows.`
        : 'Calibre moves a book’s folder when its title or first author changes; the reader follows.',
      'A field you change in Calibre afterwards is left alone. Each batch can be undone on this page; a cover added where Calibre had none stays.'
    ],
    confirmLabel: 'Turn on and write'
  };
}

/** Turning stage 3 on: the worse copy of books with the same text is removed (WP20c). */
export function turnOnContentDuplicatesCopy(counts: {
  toRemove: number | null;
  review: number | null;
}): ConfirmCopy {
  const what =
    typeof counts.toRemove !== 'number' || counts.toRemove <= 0
      ? 'the copies'
      : `${counts.toRemove.toLocaleString('en-US')} ${counts.toRemove === 1 ? 'copy' : 'copies'}`;
  return {
    title: `Remove ${what} whose text another copy has?`,
    message: [
      'From now on this runs on its own, in batches: of two books with the same text, the copy that is worse on every measure (pictures, furigana, contents, cover, text) is exported to the quarantine folder and moved to Calibre’s trash. Your own tags go to the copy that stays, and reading data moves with the book.',
      typeof counts.review === 'number' && counts.review > 0
        ? `${counts.review.toLocaleString('en-US')} pairs where each copy is better somewhere, or with extra text inside the chapters, wait in the review list; nothing is removed for them.`
        : 'Pairs where each copy is better somewhere wait in the review list; nothing is removed for them.',
      'Each batch can be undone on this page.'
    ],
    confirmLabel: 'Turn on and remove'
  };
}

/**
 * Turning stage 4 on (WP20e): from then on it writes what the online sources and the AI check
 * decided into Calibre on its own.
 */
export function turnOnOnlineSourcesCopy(counts: {
  changes: number | null;
  unconfirmed: number | null;
}): ConfirmCopy {
  const what =
    typeof counts.changes !== 'number' || counts.changes <= 0
      ? 'the changes'
      : `${counts.changes.toLocaleString('en-US')} ${counts.changes === 1 ? 'change' : 'changes'}`;
  return {
    title: `Write ${what} from the online sources into Calibre?`,
    message: [
      'From now on this runs on its own, in batches: titles, authors with their readings, illustrators, series and numbers, descriptions, store links and covers are written where the rules are sure or both AI models agree.',
      typeof counts.unconfirmed === 'number' && counts.unconfirmed > 0
        ? `${counts.unconfirmed.toLocaleString('en-US')} values are the best guess where the sources or the models don’t agree; they are not written: they wait in Review with the suggestion.`
        : 'Where the sources or the models don’t agree, the best guess is not written: it waits in Review with the suggestion.',
      'Calibre moves a book’s folder when its title or first author changes; the reader follows. A value you change in Calibre afterwards is left alone. Format and edition are not written (stage 5 makes them tags). Each batch can be undone on this page; a cover added where Calibre had none stays.'
    ],
    confirmLabel: 'Turn on and write'
  };
}

/** Stage 5 On (WP20f): the genres, tags and format added to each book's tags, old tags taken off. */
export function turnOnGenresTagsCopy(counts: {
  books: number | null;
  added: number | null;
  removed: number | null;
}): ConfirmCopy {
  const books =
    typeof counts.books !== 'number' || counts.books <= 0
      ? 'the books'
      : `${counts.books.toLocaleString('en-US')} ${counts.books === 1 ? 'book' : 'books'}`;
  return {
    title: `Write genres and tags into ${books} in Calibre?`,
    message: [
      'From now on this runs on its own, in batches: each book’s genres, tags and format are added to its own tags (in Japanese), and the Google Books categories and the old workflow tags (needs-metadata, metadata-processed, …) are taken off.',
      typeof counts.added === 'number' && typeof counts.removed === 'number'
        ? `${counts.added.toLocaleString('en-US')} tags are added and ${counts.removed.toLocaleString('en-US')} taken off.`
        : 'Tags are added and old ones taken off as listed.',
      'Your own tags (PeepoHappyBooks, alpindale, TMW-collection-…) and any tag you add in Calibre stay. A tag you take off a book later is never added again. Each batch can be undone on this page.'
    ],
    confirmLabel: 'Turn on and write'
  };
}

/** Undo of one stage-2 batch: the old values go back into Calibre. */
export function undoFileMetadataBatchCopy(count: number): ConfirmCopy {
  return {
    title: `Put back the old values of ${count.toLocaleString('en-US')} ${count === 1 ? 'change' : 'changes'} in this batch?`,
    message: [
      'Titles, authors, Amazon ids, publishers, languages and illustrators get their old values again, and replaced covers their old picture (kept in the quarantine folder).',
      'A cover added where Calibre had none stays: the content server can’t remove a cover. A value changed in Calibre since is left as it is.'
    ],
    confirmLabel: 'Undo this batch',
    danger: false
  };
}

/** Undo of a stage-4 batch (values from the online sources). */
export function undoOnlineSourcesBatchCopy(count: number): ConfirmCopy {
  return {
    title: `Put back the old values of ${count.toLocaleString('en-US')} ${count === 1 ? 'change' : 'changes'} in this batch?`,
    message: [
      'Titles, authors and their readings, illustrators, series and numbers, descriptions and store links get their old values again, and replaced covers their old picture (kept in the quarantine folder).',
      'A cover added where Calibre had none stays: the content server can’t remove a cover. A value changed in Calibre since is left as it is.'
    ],
    confirmLabel: 'Undo this batch',
    danger: false
  };
}

/** Undo of a stage-5 batch (genres and tags, WP20f). */
export function undoGenresTagsBatchCopy(count: number): ConfirmCopy {
  return {
    title: `Put back the old tags of ${count.toLocaleString('en-US')} ${count === 1 ? 'book' : 'books'} in this batch?`,
    message: [
      'The genres, tags and format this batch added are taken off again, and the old tags it took off are put back.',
      'Tags added or taken off in Calibre since stay as they are.'
    ],
    confirmLabel: 'Undo this batch',
    danger: false
  };
}

/** Removing a saved API key or the Calibre password. */
/** Settings > Notifications: removing the webhook address or the app password. */
export function removeNotificationSecretCopy(label: string): ConfirmCopy {
  return {
    title: `Remove the saved ${label}?`,
    message: ['Nothing is sent on this channel until you enter it again.'],
    confirmLabel: `Remove ${label}`,
    irreversible: true
  };
}

/** Settings > AI: remove a saved API key. */
export function removeAiKeyCopy(label: string): ConfirmCopy {
  return {
    title: `Remove the saved ${label}?`,
    message: ['No feature can ask this provider’s models until you enter it again.'],
    confirmLabel: `Remove ${label}`,
    irreversible: true
  };
}

/** Settings > AI: take a model off the list. */
export function removeAiModelCopy(model: string): ConfirmCopy {
  return {
    title: `Delete ${model}?`,
    message: [
      'It goes from the list with its batch setting; no feature can choose it until it is added again.'
    ],
    confirmLabel: `Delete ${model}`,
    irreversible: true
  };
}

/** Audiobook cleanup: a stage's "Run the analysis again" (starts the stage over). */
export function analyseAgainCopy(stageName: string, detail: string): ConfirmCopy {
  return {
    title: `Run “${stageName}” again?`,
    message: [detail, 'Nothing is written anywhere: this is a Preview.'],
    confirmLabel: 'Run it again',
    irreversible: false
  };
}

/** Audiobook stage 6 (WP21e-1): switching the build On. */
export function buildOnCopy(plan: string | null): ConfirmCopy {
  return {
    title: 'Build japanese-new now?',
    message: [
      ...(plan ? [plan] : []),
      'The linking sidecar makes new folders, hard links to the torrents’ files and each book’s metadata.json in media/audiobooks/japanese-new/ and japanese-generated-new/. The live library, the torrents, Audiobookshelf and the reader are not changed.',
      'It waits for the Calibre cleanup whenever that uses the disk. The check runs when it is done.'
    ],
    confirmLabel: 'Build it',
    irreversible: false
  };
}

/** Audiobook stage 7 (WP21f-1): switching the daily new arrivals On. */
export function arrivalsOnCopy(lastPlan: string | null): ConfirmCopy {
  return {
    title: 'Add new audiobooks to the library every day?',
    message: [
      ...(lastPlan ? [lastPlan] : []),
      'From the next run on (daily, or Run now), the linking sidecar adds each new book to media/audiobooks/japanese as new folders with hard links to the torrents’ files and its metadata.json. Audiobookshelf then shows them. Books already in the library change only when Settings > Audiobooks > Changes to books already in the library is On.'
    ],
    confirmLabel: 'Switch it On',
    irreversible: false
  };
}

/** WP21g: audiobook stage 8 (genres, tags and series from the Calibre ebooks) switched On. */
export function ebooksOnCopy(preview: string | null): ConfirmCopy {
  return {
    title: 'Give the paired audiobooks their ebooks’ genres, tags and series?',
    message: [
      ...(preview ? [preview] : []),
      'From the next daily run (or Run now), each audiobook paired with its Calibre volume gets that ebook’s genres and tags in Audiobookshelf, and the series where the audiobook has none from a store; a book that gains a series moves into its series folder (its reader links follow), but never while someone has listening progress or a bookmark on it. Your own Audiobookshelf edits stay yours. Calibre is only read. Takes effect only while Settings > Audiobooks > Changes to books already in the library is On.'
    ],
    confirmLabel: 'Switch it On',
    irreversible: false
  };
}

/** WP20g: the Calibre library's new arrivals switched On. */
export function booksArrivalsOnCopy(lastRun: string | null): ConfirmCopy {
  return {
    title: 'Add new books to Calibre and run them through stages 1-5?',
    message: [
      ...(lastRun ? [lastRun] : []),
      'From the next run on (daily, Run now, or a book you add in Calibre), new EPUBs from the source folders that are not copies of library books are added to Calibre with calibredb add (copies; nothing under /torrents changes but _extracted/), and every new book goes through stages 1-5 with their changes written. A folder adds only after its first run (a Preview of every file in it) has finished. Each batch can be undone.'
    ],
    confirmLabel: 'Switch it On',
    irreversible: false
  };
}

/** WP20g: Run now of the Calibre library's new arrivals. */
export function booksArrivalsRunNowCopy(mode: 'analyse' | 'on'): ConfirmCopy {
  return {
    title: 'Run the new arrivals now?',
    message: [
      mode === 'on'
        ? 'The source folders are checked, new books are added to Calibre (from folders whose first run has finished) and go through stages 1-5, their changes written.'
        : 'Preview: the source folders are checked and new books compared with the library; nothing is added or written.'
    ],
    confirmLabel: 'Run now',
    irreversible: false
  };
}

/** WP20g: Undo of an add batch. */
export function booksArrivalsUndoCopy(books: number): ConfirmCopy {
  return {
    title: `Take the ${books} added books out of Calibre again?`,
    message: [
      'Each is exported into the quarantine first, then moved to Calibre’s trash (14 days). Their files are not added again by themselves.'
    ],
    confirmLabel: 'Undo',
    irreversible: false
  };
}

/** Audiobook stage 7 (WP21f-1): Run now; with the changes to books in the library (WP21f-2). */
export function arrivalsRunNowCopy(
  mode: 'analyse' | 'on',
  libraryChanges: 'off' | 'analyse' | 'on' = 'off'
): ConfirmCopy {
  const changes =
    libraryChanges === 'off'
      ? []
      : mode === 'on' && libraryChanges === 'on'
        ? [
            'Changes to books already in the library are On: each book whose decisions changed gets its new metadata.json, moves to its new folder or gets numbered file names, as listed under Library changes; then Audiobookshelf scans the library. Your edits in Audiobookshelf are kept.'
          ]
        : [
            'Changes to books already in the library are only listed (Preview): nothing is changed.'
          ];
  return {
    title: 'Run the new arrivals now?',
    message: [
      'Stages 1-5 run again (hashes, checks and answers already there are kept), new archives are unpacked into torrents/…/_extracted/, and the new books are planned.',
      mode === 'on'
        ? 'Stage 7 is On: the new books are added to the library.'
        : 'Stage 7 is in Preview: nothing is added to the library.',
      ...changes
    ],
    confirmLabel: 'Run now',
    irreversible: false
  };
}

/** WP21e-2: the switch to the new audiobook library. */
export function switchCopy(): ConfirmCopy {
  return {
    title: 'Switch to the new audiobook library now?',
    message: [
      'japanese is renamed japanese-old and japanese-new becomes japanese (and japanese-generated-new japanese-generated). The five library-only files get their name under the torrents’ _from-library first; the reader’s links are rewritten to the new folders (a copy of ttsu.db is made first).',
      'While it runs the reader holds its audiobooks: no scans, merges, PC jobs or link changes. Downloaded copies on your devices will need downloading again.',
      'Audiobookshelf must have no library on these folders (delete the old one first). Undo renames everything back until japanese-old is deleted.'
    ],
    confirmLabel: 'Switch',
    irreversible: false
  };
}

export function undoSwitchCopy(): ConfirmCopy {
  return {
    title: 'Undo the switch?',
    message: [
      'japanese goes back to japanese-new and japanese-old back to japanese; the reader’s links get their old folders again. The library-only files keep their extra name under _from-library (harmless).',
      'Audiobookshelf must have no library on these folders (delete the new one first). Merging waits again until the next switch.'
    ],
    confirmLabel: 'Undo the switch',
    irreversible: false
  };
}

export function deleteOldCopy(size: string | null): ConfirmCopy {
  return {
    title: 'Delete japanese-old?',
    message: [
      `The old library is deleted${size ? ` (${size})` : ''}, after stage 6’s check runs again, its PDFs and archives are read again against their torrent twins and the old copy script’s files are kept in _inventory/old-copy-script. Anything not as the build listed it stops the deletion.`,
      'Afterwards the switch can’t be undone either. The new library and the torrents are not touched.'
    ],
    confirmLabel: 'Delete japanese-old',
    irreversible: true,
    danger: true
  };
}

export function setCoversCopy(): ConfirmCopy {
  return {
    title: 'Set the missing covers in Audiobookshelf?',
    message: [
      'For each book whose file has no cover and that Audiobookshelf shows without one: the store cover, else the old library’s cover file. Only covers are changed, one book at a time; books that have a cover are left alone.'
    ],
    confirmLabel: 'Set the covers',
    irreversible: false
  };
}

export function removeCleanupSecretCopy(label: string): ConfirmCopy {
  return {
    title: `Remove the saved ${label}?`,
    message: ['The library cleanup can’t use it until you enter it again.'],
    confirmLabel: `Remove ${label}`,
    irreversible: true
  };
}

// ---- Calibre metadata editing (tier 3 item 2) ----------------------------------------------

/** Undo of one entry in a book's history of changes: names the field and the value it goes back to. */
export function undoChangeCopy(field: string, value: string): ConfirmCopy {
  return {
    title: 'Undo this change?',
    message: [
      `${field} goes back to: ${value}`,
      'This writes to Calibre. The value then counts as yours, so the cleanup won’t change it again.'
    ],
    confirmLabel: 'Undo',
    // Nothing is deleted: the earlier value is written back (and can be undone in turn).
    danger: false
  };
}

/** Settings › Library › Tags you can pick: taking a tag off the list. */
export function removeTagFromListCopy(tag: string): ConfirmCopy {
  return {
    title: `Remove ${quoted(tag)} from the list?`,
    message: ['You won’t be able to pick it any more. Books that have it keep it.'],
    confirmLabel: 'Remove'
  };
}

/** Settings › Library › Tags you can pick: back to the default list. */
export function resetTagListCopy(): ConfirmCopy {
  return {
    title: 'Put the list back to the default?',
    message: ['Your books don’t change: they keep the tags they have.'],
    confirmLabel: 'Reset',
    danger: false
  };
}

/**
 * A save that changes only the case of a name other books share: Calibre renames it for every
 * book that has it (asked first; design follow-up decided 2026-11-23).
 */
export function sharedRenameCopy(
  renames: { from: string; to: string; books: number }[]
): ConfirmCopy {
  const list = Array.isArray(renames) ? renames : [];
  return {
    title: list.length === 1 ? 'Rename it for every book?' : 'Rename them for every book?',
    message: [
      ...list.map((r) => `${quoted(r.from)} becomes ${quoted(r.to)} on ${books(r.books)} more.`),
      'Calibre keeps one spelling of a name for all its books. On those books the name then counts as yours too.'
    ],
    confirmLabel: 'Save and rename',
    danger: false
  };
}

/** More Bookmeter coverage: On writes the new matches' store links to Calibre. */
export function bookmeterOnCopy(books: number): ConfirmCopy {
  return {
    title: 'Write the new Bookmeter store links to Calibre?',
    message: [
      `${books.toLocaleString()} books get their Bookmeter id and the store ids from its store list (ISBN, Rakuten, honto, ebookjapan, U-NEXT, BOOK☆WALKER, Natively) added to their identifiers. An id Calibre already has is never replaced, and store links you edited are never touched.`,
      'They are written in batches through stage 4; each batch can be undone from the batches list.'
    ],
    confirmLabel: 'Switch it On',
    irreversible: false
  };
}

/** Series under two names: switching it On. */
export function seriesPairsOnCopy(books: number, pairs: number): ConfirmCopy {
  return {
    title: 'Merge the series under two names in Calibre?',
    message: [
      `${books.toLocaleString()} ${books === 1 ? 'book' : 'books'} in ${pairs.toLocaleString()} ${pairs === 1 ? 'pair' : 'pairs'} move into the series' kept name and keep their numbers. No merge puts two books on one number, and a series you edited is never touched.`,
      'They are written in batches through stage 4; each batch can be undone from the batches list.'
    ],
    confirmLabel: 'Switch it On',
    irreversible: false
  };
}

// ---- Book summaries (session 4): the Summary section on the book page ------------------

/** Replace ▾ › Regenerate with AI, when the book has a summary. */
export function regenerateSummaryCopy(title: string): ConfirmCopy {
  return {
    title: `Make a new summary of ${quoted(title)}?`,
    message: [
      'The AI reads the book again and writes a new summary. It takes about 15–20 minutes and is charged to the AI spending of this month.',
      'The summary you have now is kept under Earlier versions, where you can bring it back.'
    ],
    confirmLabel: 'Regenerate',
    danger: false
  };
}

/** Replace ▾ › Write my own: saving it over the book's summary. */
export function replaceSummaryWithOwnCopy(title: string): ConfirmCopy {
  return {
    title: `Replace the summary of ${quoted(title)} with yours?`,
    message: [
      'What you wrote becomes the summary.',
      'The summary you have now is kept under Earlier versions, where you can bring it back.'
    ],
    confirmLabel: 'Replace',
    danger: false
  };
}

/** ⋯ › Delete summary. */
export function deleteSummaryCopy(title: string): ConfirmCopy {
  return {
    title: `Delete the summary of ${quoted(title)}?`,
    message: [
      'The book no longer shows a summary, on any device.',
      'It is kept under Earlier versions, where you can bring it back. A summary is not made again on its own: use Add summary.'
    ],
    confirmLabel: 'Delete summary'
  };
}

/** Earlier versions › Restore, over the current summary. */
export function restoreSummaryCopy(date: string): ConfirmCopy {
  return {
    title: `Bring back the summary of ${date}?`,
    message: [
      'It becomes the summary again.',
      'The summary you have now is kept under Earlier versions.'
    ],
    confirmLabel: 'Restore',
    danger: false
  };
}

/** Earlier versions › Delete, one earlier version for good. */
export function deleteSummaryVersionCopy(date: string): ConfirmCopy {
  return {
    title: `Delete the earlier summary of ${date}?`,
    message: ['Only this earlier version goes; the current summary stays.'],
    confirmLabel: 'Delete',
    irreversible: true
  };
}

/** Edit › Delete on one item. */
export function deleteSummaryItemCopy(): ConfirmCopy {
  return {
    title: 'Delete this item?',
    message: ['It goes from the summary on every device, and from its translations.'],
    confirmLabel: 'Delete',
    irreversible: true
  };
}
