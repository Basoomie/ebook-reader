#!/usr/bin/env python
# 1.7.0 (books without an EPUB): what a book's file is, read in the sidecar's own work folder.
#
# Run with calibre's own Python (it reads RAR with calibre's unrar):
#   calibre-debug -e formats-helper.py inspect <file>
#       the archive's entries (name and size) or, for a Kindle file, whether it is locked (DRM);
#   calibre-debug -e formats-helper.py extract <archive> <entry name> <out file>
#       one entry written to <out file>;
#   calibre-debug -e formats-helper.py extractall <archive> <out folder>
#       every entry written under <out folder> (names that would leave it are refused).
# Every path must be inside TTSU_WORK_DIR (the job's own folder); nothing else is read or written.
# One answer line on stdout: "@@ttsu " + JSON. Calibre's own output goes to stderr.
import json
import os
import shutil
import struct
import sys
import zipfile

PROTO = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr


def send(obj):
    PROTO.write('@@ttsu ' + json.dumps(obj, ensure_ascii=False) + '\n')
    PROTO.flush()


def inside_work(path):
    work = os.path.realpath(os.environ.get('TTSU_WORK_DIR') or '/nonexistent')
    real = os.path.realpath(path)
    return real == work or real.startswith(work + os.sep)


def is_rar(path):
    with open(path, 'rb') as f:
        return f.read(4) == b'Rar!'


def entries(path):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            return [{'name': i.filename, 'size': i.file_size} for i in z.infolist()]
    if is_rar(path):
        from calibre.utils.unrar import names
        return [{'name': n, 'size': None} for n in names(path)]
    return None


def mobi_drm(path):
    # PalmDB: the offset of record 0 at byte 78; its MOBI header's encryption type at 12.
    with open(path, 'rb') as f:
        h = f.read(86)
        if len(h) < 86:
            return None
        off = struct.unpack('>I', h[78:82])[0]
        f.seek(off)
        r0 = f.read(16)
        if len(r0) < 14:
            return None
        return struct.unpack('>H', r0[12:14])[0] != 0


def safe_target(root, name):
    target = os.path.realpath(os.path.join(root, name))
    if not (target == os.path.realpath(root) or target.startswith(os.path.realpath(root) + os.sep)):
        raise ValueError('An entry name leaves the folder: ' + name[:100])
    return target


def extract(path, entry, out):
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z, z.open(entry) as a, open(out, 'xb') as o:
            shutil.copyfileobj(a, o)
        return
    from calibre.utils.unrar import extract_member
    name, data = extract_member(path, name=entry)
    with open(out, 'xb') as o:
        o.write(data)


def extractall(path, outdir):
    os.makedirs(outdir, exist_ok=True)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            for i in z.infolist():
                target = safe_target(outdir, i.filename)
                if i.is_dir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with z.open(i) as a, open(target, 'xb') as o:
                    shutil.copyfileobj(a, o)
        return
    from calibre.utils.unrar import names, extract_member
    for n in names(path):
        target = safe_target(outdir, n)
        name, data = extract_member(path, name=n)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'xb') as o:
            o.write(data)


def main(argv):
    if len(argv) < 2:
        raise ValueError('No command')
    cmd = argv[0]
    paths = argv[1:]
    for p in paths:
        if not os.path.isabs(p) or not inside_work(p):
            raise ValueError('A path is not inside the work folder')
    if cmd == 'inspect' and len(paths) == 1:
        f = paths[0]
        ext = os.path.splitext(f)[1].lower()
        out = {'size': os.path.getsize(f)}
        if ext in ('.azw3', '.azw', '.mobi', '.prc'):
            out['drm'] = mobi_drm(f)
        else:
            out['entries'] = entries(f)
        return out
    if cmd == 'extractall' and len(paths) == 2:
        extractall(paths[0], paths[1])
        return {'ok': True}
    raise ValueError('Unknown command')


if __name__ == '__main__':
    args = sys.argv[1:]
    try:
        # extract's second argument is an entry name, not a path: its two paths are checked here.
        if args and args[0] == 'extract':
            if len(args) != 4:
                raise ValueError('extract takes an archive, an entry and an output file')
            for p in (args[1], args[3]):
                if not os.path.isabs(p) or not inside_work(p):
                    raise ValueError('A path is not inside the work folder')
            extract(args[1], args[2], args[3])
            send({'ok': True})
        else:
            send({'ok': True, 'result': main(args)})
    except Exception as e:  # noqa: BLE001
        send({'ok': False, 'error': (type(e).__name__ + ': ' + str(e))[:500]})
