"""Generated author readings (WP20d) for names Web NDL Authorities doesn't know.

stdin: {"names": [...]} (or {"version": true} to report the versions); stdout: {"readings":
{name: reading}, "version": "..."}. Uses the same SudachiPy and dictionary as the PC's TTS
(sudachipy 0.6.10, sudachidict-core 20260428), split mode C. The reading is katakana; a name of
two person-name words gets NDL's "Family, Given" form. A name with a word Sudachi can't read gets
no reading. Generated readings are always listed for spot checks."""
import json
import sys
import unicodedata


def katakana(text):
    out = []
    for ch in text:
        code = ord(ch)
        out.append(chr(code + 0x60) if 0x3041 <= code <= 0x3096 else ch)
    return ''.join(out)


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
