/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

// WP15c: what the reader gives whispersync instead of the old NAS upload/fetch helpers
// (nas.ts, removed). MIT-compatible addition to vendored ttu-whispersync code.
//
// Only the audio source and the transport change: whispersync still plays one audio
// URL, loads subtitles through updateSubtitles, and matches, re-matches and resets as
// before. The reader implements this (lib/audio/whispersync-sync.ts).

export interface LinkedAudioSource {
  /** What the <audio> element plays: the signed stream URL, or a downloaded copy's blob: URL. */
  url: string;
  /**
   * Season 2 Phase 9: the downloaded copy as a File, only to read its cover and chapters
   * (a blob: URL can't answer the HEAD request the URL reader sends). Not handed to
   * whispersync as its audio file, so Anki media names and FFmpeg stay as when streaming.
   */
  file: File | null;
}

export interface LinkedAudio {
  /**
   * The book's linked audiobook: the copy downloaded to this device when it is the linked
   * file (or the server can't be reached), else the signed stream URL; null when there is
   * nothing to play (no link, split, missing, offline without a copy).
   */
  playSource(): Promise<LinkedAudioSource | null>;
  /** The book's confirmed subtitle file, or null. */
  subtitleFile(): Promise<File | null>;
  /** Whether this book is in the library (only then can an audiobook be linked). */
  canLink(): Promise<boolean>;
  /** Opens the confirmation picker (the book's details page). */
  linkAudiobook(): void;
  /** Reset match: the saved match is removed on every device. Never throws. */
  resetMatch(): Promise<void>;
  /** Reset all: the saved match, saved subtitles and position are removed on every device. */
  resetAll(): Promise<void>;
}
