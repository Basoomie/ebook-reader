"""Kanji to kana for the TTS input (WP17).

The book's own furigana is applied before this (the server sends each sentence's
`reading` with ruby bases already replaced by their readings). This converts the
kanji that are left, word by word, with SudachiPy: only words that contain kanji
are replaced by their hiragana reading; kana, punctuation, Latin letters and digits
stay as they are.
"""
from __future__ import annotations

import re
from functools import lru_cache

_KANJI = re.compile(r"[㐀-䶿一-鿿豈-﫿々〆〻ヶ]")


def has_kanji(text: str) -> bool:
    return _KANJI.search(text) is not None


def katakana_to_hiragana(text: str) -> str:
    out = []
    for ch in text:
        code = ord(ch)
        # Katakana ァ..ヶ map to hiragana ぁ..ゖ; ー and others stay.
        if 0x30A1 <= code <= 0x30F6:
            out.append(chr(code - 0x60))
        else:
            out.append(ch)
    return "".join(out)


@lru_cache(maxsize=1)
def _tokenizer():
    from sudachipy import Dictionary, SplitMode

    return Dictionary(dict="core").create(), SplitMode.C


def to_kana(text: str) -> str:
    """Replace every word containing kanji by its reading in hiragana."""
    if not has_kanji(text):
        return text
    tok, mode = _tokenizer()
    out = []
    for m in tok.tokenize(text, mode):
        surface = m.surface()
        if has_kanji(surface):
            reading = m.reading_form()
            # Sudachi gives "キゴウ" for symbols it doesn't know and "" for unknown words:
            # keep the surface then rather than reading out nonsense.
            if reading and reading != "キゴウ":
                out.append(katakana_to_hiragana(reading))
                continue
        out.append(surface)
    return "".join(out)
