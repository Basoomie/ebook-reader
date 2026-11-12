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

export interface LinkedAudio {
  /** The book's linked audiobook as a signed URL, or null (no link, split, missing, offline). */
  playUrl(): Promise<string | null>;
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
