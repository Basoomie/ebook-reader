/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { charsRange, type PacerChar } from '$lib/components/book-reader/pacer/pacer-text';
import {
  pacerHighlightApi,
  PacerPage,
  type PacerPageHost,
  type PacerSnapshot
} from '$lib/components/book-reader/pacer/pacer-page';

/**
 * Season 2 Phase 12 session 3: read-aloud's highlight and following (decided with the user,
 * 2026-11-14/16). The sentence being read is painted with the CSS Custom Highlight API (no
 * change to the book's DOM, like the pacer, highlights and the search mark), and the reader
 * follows it: the next page with the reader's own page turn (paginated) or the pacer's line
 * scroll (continuous); anything further (the start, a skip, "Back to the voice") jumps.
 *
 * A page turn or scroll of yours stops the following while the sentence is off the screen
 * (the voice goes on); it follows again when the sentence is on the screen, or on "Back to
 * the voice". Yours: the page moved (its scroll, page or text changed since read-aloud last
 * saw it) after an input of yours (key, touch, wheel, click) that came after read-aloud's
 * own last move, or while read-aloud hasn't moved it for a while. Read-aloud's own moves are
 * done in one step (no smooth scrolling), so it sees the page they leave at once.
 */

export const READ_ALOUD_HIGHLIGHT = 'ttu-read-aloud';
/** Above the reader's highlights and the search mark; the pacer doesn't run meanwhile. */
export const READ_ALOUD_PRIORITY = 110;
/**
 * After read-aloud's own move, a page change within this long without an input of yours
 * counts as part of it (a new section loading after a page turn or a jump) (ms).
 */
const OWN_MOVE_MS = 1500;

export interface FollowLine {
  /** Reader positions [position, end) of the sentence. */
  position: number;
  end: number;
}

export type FollowAction = 'none' | 'next' | 'jump';

/**
 * What to do so the reading point (the character being read) is on the screen: nothing (it
 * is), the next page / line (it is on the next screen), or a jump (anywhere else).
 */
export function followAction(
  snapshot: Pick<PacerSnapshot, 'chars' | 'firstVisible' | 'lastVisible'>,
  target: number
): FollowAction {
  const { chars, firstVisible, lastVisible } = snapshot;
  const at = indexOfPosition(chars, target);

  if (at < 0) return 'jump';
  if (firstVisible >= 0 && at >= firstVisible && at <= lastVisible) return 'none';
  if (lastVisible >= 0 && at > lastVisible) return 'next';
  return 'jump';
}

/** Index of the counted character at reader position `position` in a snapshot, or -1. */
export function indexOfPosition(chars: PacerChar[], position: number): number {
  // Starts never go down; several characters can share one (uncounted ones take the time of
  // the counted one before them, or of the next at a paragraph start).
  let lo = 0;
  let hi = chars.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (chars[mid].start < position) lo = mid + 1;
    else hi = mid;
  }

  for (let i = lo; i < chars.length && chars[i].start === position; i++) {
    if (chars[i].counted) return i;
  }

  return -1;
}

/** The character range [from, to) of a sentence in a snapshot (empty when it isn't there). */
export function sentenceSpan(chars: PacerChar[], line: FollowLine): [number, number] {
  let from = -1;
  let to = -1;

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];

    if (c.start >= line.position && c.start < line.end && (c.counted || from >= 0)) {
      if (from < 0) from = i;
      to = i + 1;
    } else if (from >= 0 && c.start >= line.end) {
      break;
    }
  }

  return from < 0 ? [0, 0] : [from, to];
}

/** The reading point: the counted character `progress` (0..1) of the way into the sentence. */
export function readingPoint(line: FollowLine, progress: number): number {
  const length = Math.max(1, line.end - line.position);
  return line.position + Math.min(length - 1, Math.max(0, Math.floor(progress * length)));
}

export interface FollowHost {
  page: PacerPageHost;
  /** The reader's next page (paginated), its own page turn. */
  nextPage(): void;
  /** Brings a reader position on the screen (the reader's jump; not saved, not recorded). */
  jump(position: number): void;
  eink(): boolean;
  /** The highlight look changed (the reader's colours). */
  onFollowChange(following: boolean): void;
}

export class ReadAloudFollow {
  following = true;
  private readonly page: PacerPage;
  private line: FollowLine | null = null;
  private progress = 0;
  private ownMoveAt = 0;
  /** The last input of yours on the page (key, touch, wheel, click). */
  private lastInputAt = 0;
  /** The page as read-aloud last saw it (scroll, page, text). */
  private lastKey = '';
  private style: HTMLStyleElement | undefined;
  private styleText = '';
  private painted = false;
  /** The reader is laying the page out again: no page moves meanwhile (painting goes on). */
  private held = false;
  /** What is painted now (no repaint while it stays the same: E-ink redraws). */
  private paintedKey = '';

  constructor(
    private readonly host: FollowHost,
    private readonly win: Window = window
  ) {
    this.page = new PacerPage(host.page, () => this.update(), win);
  }

  get supported(): boolean {
    return this.page.supported;
  }

  private setFollowing(on: boolean) {
    if (this.following === on) return;
    this.following = on;
    this.host.onFollowChange(on);
  }

  /** The sentence being read now, and how far into it (null: nothing is read). */
  show(line: FollowLine | null, progress = 0) {
    this.line = line;
    this.progress = progress;
    this.update();
  }

  /** A page change or scroll happened (whose it is, update works out). */
  moved() {
    this.update();
  }

  /** An input of yours on the page (key, touch, wheel, click). */
  noteInput() {
    this.lastInputAt = Date.now();
  }

  /** Read-aloud's own move is still settling (and you haven't touched the page since). */
  private settling() {
    return Date.now() - this.ownMoveAt < OWN_MOVE_MS && this.lastInputAt <= this.ownMoveAt;
  }

  /** Holds page moves while the reader lays the page out again (a relayout, a reopen). */
  hold(on: boolean) {
    this.held = on;
    if (!on) {
      this.ownMoveAt = Date.now();
      this.update();
    }
  }

  /** The first counted character on the screen (where Play starts), or null without text. */
  screenPosition(): number | null {
    const snapshot = this.measure();

    if (!snapshot || snapshot.firstVisible < 0) return null;

    for (let i = snapshot.firstVisible; i <= snapshot.lastVisible; i++) {
      if (snapshot.chars[i].counted) return snapshot.chars[i].start;
    }

    return null;
  }

  /** "Back to the voice": follows again and brings the sentence on the screen. */
  back() {
    this.setFollowing(true);
    this.update(true);
  }

  private target() {
    return this.line ? readingPoint(this.line, this.progress) : 0;
  }

  private lastJump = { target: -1, at: 0 };

  /**
   * One jump per place: a place the page doesn't show after the jump (text the reader lays
   * out differently, an image page) isn't jumped to again and again.
   */
  private mayJump(target: number) {
    const now = Date.now();
    const line = this.line;
    const sameLine =
      !!line && this.lastJump.target >= line.position && this.lastJump.target < line.end;

    if (sameLine && now - this.lastJump.at < 3000) return false;
    this.lastJump = { target, at: now };
    return true;
  }

  private measure(): PacerSnapshot | null {
    try {
      return this.page.measure();
    } catch {
      return null;
    }
  }

  /** Paints the sentence and follows it. */
  update(force = false) {
    if (this.win.document.visibilityState === 'hidden') return;

    const line = this.line;

    if (!line) {
      this.clear();
      return;
    }

    let snapshot = this.measure();

    if (!snapshot) return;

    const target = this.target();
    const at = indexOfPosition(snapshot.chars, target);
    const visible = at >= 0 && at >= snapshot.firstVisible && at <= snapshot.lastVisible;

    if (snapshot.key !== this.lastKey) {
      // The page moved since read-aloud last saw it: yours, unless its own move settles.
      const yours = this.lastKey !== '' && !this.held && !this.settling();
      this.lastKey = snapshot.key;

      if (yours && !visible && !force) {
        this.setFollowing(false);
      }
    }

    if (!this.following && visible) {
      this.setFollowing(true);
    }

    if ((this.following || force) && !this.held) {
      const action = followAction(snapshot, target);

      if (action === 'next') {
        this.ownMoveAt = Date.now();

        if (this.host.page.paginated()) {
          this.host.nextPage();
        } else {
          // In one step: read-aloud sees at once where its scroll left the page.
          this.page.scrollToChar(snapshot, at, false);
        }
      } else if (action === 'jump' && this.mayJump(target)) {
        this.ownMoveAt = Date.now();
        this.host.jump(target);
      }

      if (action !== 'none') {
        snapshot = this.measure() ?? snapshot;
        this.lastKey = snapshot.key;
      }
    }

    this.paint(snapshot, line);
  }

  private css(): string {
    // The whispersync look (yellow, black text); E-ink: black with white text, no gray.
    const rule = this.host.eink()
      ? 'background-color: #000; color: #fff;'
      : 'background-color: #fffa82; color: #000;';
    return `::highlight(${READ_ALOUD_HIGHLIGHT}) { ${rule} }`;
  }

  private paint(snapshot: PacerSnapshot, line: FollowLine) {
    const api = pacerHighlightApi(this.win);

    if (!api) return;

    const css = this.css();

    if (css !== this.styleText || !this.style?.isConnected) {
      if (!this.style || !this.style.isConnected) {
        this.style = this.win.document.createElement('style');
        this.style.id = 'ttu-read-aloud-style';
        this.win.document.head.appendChild(this.style);
      }

      this.style.textContent = css;
      this.styleText = css;
    }

    const key = `${snapshot.key}|${line.position}|${line.end}|${css}`;

    if (this.painted && key === this.paintedKey && api.registry.has(READ_ALOUD_HIGHLIGHT)) return;
    this.paintedKey = key;

    const [from, to] = sentenceSpan(snapshot.chars, line);
    const range = charsRange(snapshot.chars, from, to, this.win.document);

    if (range) {
      const highlight = new api.Ctor(range);
      highlight.priority = READ_ALOUD_PRIORITY;
      api.registry.set(READ_ALOUD_HIGHLIGHT, highlight);
      this.painted = true;
    } else if (this.painted) {
      api.registry.delete(READ_ALOUD_HIGHLIGHT);
      this.painted = false;
    }
  }

  clear() {
    const api = pacerHighlightApi(this.win);

    if (api && this.painted) api.registry.delete(READ_ALOUD_HIGHLIGHT);
    this.painted = false;
    this.paintedKey = '';
  }

  destroy() {
    this.clear();
    this.page.destroy();
    this.style?.remove();
    this.style = undefined;
    this.styleText = '';
  }
}
