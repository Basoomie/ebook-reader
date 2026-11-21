/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writable, type Readable } from 'svelte/store';
import {
  MAX_NOTE_BODY,
  type HighlightColor,
  type HighlightItem,
  type NoteItem
} from '$lib/notes/highlights';
import type { NoteTarget, Undo } from '$lib/notes/notes-service';

/**
 * What a list of highlight and note cards shares (the Notes page's Books and Highlights
 * views, the Library's series section): the note being edited, the Undo of the last
 * removal (until the next action), an error, and one action at a time. Moved out of
 * notes-list.svelte (WP19d) unchanged, so both views behave the same.
 */

export interface NotesListActions {
  setColor(id: string, color: HighlightColor): Promise<void>;
  saveNote(target: NoteTarget, body: string): Promise<string | null>;
  removeHighlight(id: string): Promise<Undo>;
  removeNote(id: string): Promise<Undo>;
}

export interface NotesListView {
  /** The card whose note is being edited (a highlight's or a book note's id). */
  editing: { key: string; target: NoteTarget; text: string } | undefined;
  undo: { message: string; run: Undo } | undefined;
  error: string;
  busy: boolean;
}

export interface NotesListState extends Readable<NotesListView> {
  startNote(key: string, target: NoteTarget, text: string): void;
  cancelEdit(): void;
  saveNote(text: string): void;
  setColor(item: HighlightItem, color: HighlightColor): void;
  removeHighlight(item: HighlightItem): void;
  removeNote(note: NoteItem): void;
  runUndo(): void;
}

export function createNotesListState(actions: () => NotesListActions): NotesListState {
  let view: NotesListView = { editing: undefined, undo: undefined, error: '', busy: false };
  const store = writable(view);
  const set = (patch: Partial<NotesListView>) => {
    view = { ...view, ...patch };
    store.set(view);
  };

  async function act(run: () => Promise<void>) {
    if (view.busy) return;
    set({ busy: true, error: '' });
    try {
      await run();
    } catch (e) {
      set({ error: (e as Error)?.message || 'Something went wrong.' });
    } finally {
      set({ busy: false });
    }
  }

  return {
    subscribe: store.subscribe,
    startNote(key, target, text) {
      set({ undo: undefined, error: '', editing: { key, target, text } });
    },
    cancelEdit() {
      set({ editing: undefined });
    },
    saveNote(text) {
      const current = view.editing;
      if (!current) return;
      if (Array.from(text).length > MAX_NOTE_BODY) {
        set({ error: `A note can be at most ${MAX_NOTE_BODY.toLocaleString()} characters.` });
        return;
      }
      void act(async () => {
        await actions().saveNote(current.target, text);
        set({ editing: undefined });
      });
    },
    setColor(item, color) {
      set({ undo: undefined });
      void act(() => actions().setColor(item.id, color));
    },
    removeHighlight(item) {
      void act(async () => {
        const run = await actions().removeHighlight(item.id);
        set({ undo: { message: 'Highlight removed.', run } });
      });
    },
    removeNote(note) {
      void act(async () => {
        const run = await actions().removeNote(note.id);
        set({ undo: { message: 'Note removed.', run } });
      });
    },
    runUndo() {
      const current = view.undo;
      set({ undo: undefined });
      if (current) void act(current.run);
    }
  };
}
