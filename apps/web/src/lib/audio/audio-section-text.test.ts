/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { describe, expect, it } from 'vitest';
import {
  audioRowButton,
  rowToOpen,
  subtitleRowButton,
  ttsCountsText,
  ttsVoiceText
} from './audio-section-text';
import type { BookVoiceChoices, VoiceChoice } from './tts-types';

const choice: VoiceChoice = {
  voiceId: 'v1',
  dialogueVoiceId: null,
  modelId: 1,
  updatedAt: 0,
  voiceName: '落ち着いた女性',
  dialogueVoiceName: null,
  modelLabel: 'Irodori',
  problem: null
};

describe('rowToOpen', () => {
  it('opens the audiobook row while nothing is chosen', () => {
    expect(rowToOpen('choose', 'hidden')).toBe('audio');
  });
  it('opens the subtitles row when the audiobook is chosen and subtitles are not', () => {
    expect(rowToOpen('linked', 'choose')).toBe('subs');
  });
  it('opens nothing when both are decided or something needs a look', () => {
    expect(rowToOpen('linked', 'linked')).toBeNull();
    expect(rowToOpen('linked', 'none')).toBeNull();
    expect(rowToOpen('none', 'hidden')).toBeNull();
    expect(rowToOpen('split', 'choose')).toBeNull();
    expect(rowToOpen('missing', 'choose')).toBeNull();
  });
});

describe('row buttons', () => {
  it('says Choose until something is chosen, then Change', () => {
    expect(audioRowButton('choose')).toBe('Choose');
    expect(audioRowButton('linked')).toBe('Change');
    expect(audioRowButton('none')).toBe('Change');
    expect(subtitleRowButton('choose')).toBe('Choose');
    expect(subtitleRowButton('none')).toBe('Change');
  });
});

describe('ttsVoiceText', () => {
  it('says when no voice is chosen', () => {
    expect(ttsVoiceText(null)).toBe('TTS voice: none chosen');
    expect(ttsVoiceText({ book: null, global: null, effective: null })).toBe(
      'TTS voice: none chosen'
    );
  });
  it("names the book's own voice and its dialogue voice", () => {
    const c: BookVoiceChoices = {
      book: choice,
      global: null,
      effective: { ...choice, dialogueVoiceId: 'v2', dialogueVoiceName: '若い男性', from: 'book' }
    };
    expect(ttsVoiceText(c)).toBe('TTS voice: 落ち着いた女性, dialogue 若い男性');
  });
  it('says when the voice comes from Settings, or was deleted', () => {
    const c: BookVoiceChoices = {
      book: null,
      global: choice,
      effective: { ...choice, voiceName: null, from: 'global' }
    };
    expect(ttsVoiceText(c)).toBe('TTS voice: a deleted voice (from Settings > Anki)');
  });
});

describe('ttsCountsText', () => {
  it('counts characters and fixes, leaving out what is not known', () => {
    expect(ttsCountsText(12, 3)).toBe('12 characters · 3 pronunciation fixes');
    expect(ttsCountsText(1, 1)).toBe('1 character · 1 pronunciation fix');
    expect(ttsCountsText(null, 0)).toBe('0 pronunciation fixes');
    expect(ttsCountsText(null, null)).toBe('');
  });
});
