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
      `The ${fileCount} files of ${quoted(String(folderName))} are joined in the order shown into one new file of about ${approxSize}, saved in the reader's own folder for merged files (Audiobookshelf doesn't show it). Each file becomes a chapter.`,
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

export function removeCleanupSecretCopy(label: string): ConfirmCopy {
  return {
    title: `Remove the saved ${label}?`,
    message: ['The library cleanup can’t use it until you enter it again.'],
    confirmLabel: `Remove ${label}`,
    irreversible: true
  };
}
