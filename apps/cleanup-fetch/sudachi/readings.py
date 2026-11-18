"""Generated author readings (WP20d) for names Web NDL Authorities doesn't know.

stdin: {"names": [...]} (or {"version": true} to report the versions); stdout: {"readings":
{name: reading}, "version": "..."}. Uses the same SudachiPy and dictionary as the PC's TTS
(sudachipy 0.6.10, sudachidict-core 20260428), split mode C. The reading is katakana; a name of
two person-name words gets NDL's "Family, Given" form. A name with a word Sudachi can't read, and
a name with anything but kana and kanji, gets no reading. Generated readings are always listed for spot checks."""
import json
import sys
import unicodedata


def katakana(text):
    out = []
    for ch in text:
        code = ord(ch)
        out.append(chr(code + 0x60) if 0x3041 <= code <= 0x3096 else ch)
    return ''.join(out)


def japanese(c):
    o = ord(c)
    return 0x3040 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0x3400 <= o <= 0x4DBF or 0xF900 <= o <= 0xFAFF


def is_kana(text):
    return all(0x3040 <= ord(c) <= 0x30FF or c in 'ー・' for c in text)


def main():
    req = json.loads(sys.stdin.read() or '{}')
    import sudachipy
    from sudachipy import Dictionary, SplitMode
    version = f'sudachipy {sudachipy.__version__}'
    try:
        from importlib.metadata import version as pkg_version
        version += f', sudachidict-core {pkg_version("sudachidict-core")}'
    except Exception:
        pass
    out = {'version': version, 'readings': {}}
    names = req.get('names') or []
    if names:
        tok = Dictionary(dict='core').create()
        for name in names:
            n = unicodedata.normalize('NFKC', name).strip()
            if not n:
                continue
            # Only names written in kana and kanji get a reading: Latin letters and digits are read
            # badly (竹井10日 as タケイイチレイニチ, 著者M with メートル), and a Latin name's own sort is right.
            if not all(japanese(c) or c in ' ・ー々〆' for c in n):
                continue
            if is_kana(n.replace(' ', '')):
                out['readings'][name] = katakana(n.replace(' ', ''))
                continue
            words = [m for m in tok.tokenize(n.replace(' ', ''), SplitMode.C)]
            readings = [m.reading_form() for m in words]
            if not words or any(not r or r == 'キゴウ' for r in readings):
                continue
            pos = [m.part_of_speech() for m in words]
            person = len(words) == 2 and all(p[2] == '人名' for p in pos)
            out['readings'][name] = ', '.join(readings) if person else ''.join(readings)
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == '__main__':
    main()
