#!/usr/bin/env python
# WP20b: one long-lived calibredb for the cleanup sidecar.
#
# Run with calibre's own Python: `calibre-debug -e calibredb-helper.py`. It runs calibredb's
# own command code (calibre.db.cli.main: option_parser_for, DBCtx, run_cmd) exactly as the
# `calibredb` program does, for the same argument lists, but in one process, so each call
# doesn't pay calibre's start-up. It talks only to the content server given in each call's
# --with-library (an http URL); never to a library folder.
#
# Allowed: `list`; `set_metadata <id> --field ...` for the fields the sidecar may set;
# `remove <id>` (one book, to Calibre's trash, never --permanent); `export <id>` into a folder
# under TTSU_EXPORT_DIRS (the quarantine) only; `add` (1.6.1) in exactly the sidecar's three forms:
# a quarantined export folder (`--duplicates --one-book-per-directory <folder>` under
# TTSU_EXPORT_DIRS: the move and Undo's re-add) and one arrival EPUB from its own temporary
# folder (`--duplicates [--title <title>] <…/ttsu-arrival-<n>/<name>.epub>`). The sidecar builds
# and checks the arguments; this checks them again.
#
# Protocol: one JSON object per line on stdin {"id", "args", "password"}; one line per answer
# on stdout, "@@ttsu " + {"id", "code", "stdout", "stderr"}. The first line says it is ready.
# Anything else calibre prints goes to stderr.
import io
import json
import os
import re
import sys
import traceback

PROTO = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
os.dup2(2, 1)  # stray output from calibre can't break the protocol
sys.stdout = sys.stderr

from calibre.constants import __version__  # noqa: E402
from calibre.db.cli.main import DBCtx, option_parser_for, run_cmd  # noqa: E402

ALLOWED_FIELDS = {
    'title', 'sort', 'authors', 'author_sort', 'identifiers', 'publisher', 'languages',
    '#illustrator', 'cover', 'tags',
    # stage 4 (WP20e)
    'series', 'series_index', 'comments',
    # the user's edits from the reader (1.5.0)
    'pubdate', 'rating',
    # manga part A (1.6.0): a moved book's own columns and date added, written again only when
    # the add from its export did not carry them
    '#characters', 'timestamp',
}
GLOBAL = {'--with-library', '--library-path', '--username', '--password', '--timeout'}
CONTEXTS = {}


def send(obj):
    PROTO.write('@@ttsu ' + json.dumps(obj, ensure_ascii=False) + '\n')
    PROTO.flush()


ARRIVAL_FILE = re.compile(r'^/.*/ttsu-arrival-\d+/[^/]+\.epub$', re.IGNORECASE)


def inside_export_dirs(path):
    dirs = [d for d in os.environ.get('TTSU_EXPORT_DIRS', '').split(':') if d]
    to = os.path.realpath(path or '')
    return any(to.startswith(os.path.realpath(d) + os.sep) for d in dirs)


def add_args(raw):
    # The add's own arguments: the raw list without calibredb's global options and their values.
    out, skip = [], False
    for a in raw:
        if skip:
            skip = False
        elif a in GLOBAL:
            skip = True
        else:
            out.append(a)
    return out


def check_add(raw):
    a = add_args(raw)
    if len(a) == 3 and a[:2] == ['--duplicates', '--one-book-per-directory'] and inside_export_dirs(a[2]):
        return
    if len(a) == 2 and a[0] == '--duplicates' and ARRIVAL_FILE.match(a[1]):
        return
    if (len(a) == 4 and a[0] == '--duplicates' and a[1] == '--title' and a[2].strip()
            and chr(10) not in a[2] and chr(13) not in a[2] and ARRIVAL_FILE.match(a[3])):
        return
    raise SystemExit('add takes a quarantined folder or one arrival EPUB')


def check(cmd, opts, rest, raw=()):
    if not (opts.library_path or '').startswith(('http://', 'https://')):
        raise SystemExit('Only a content server (http URL) is allowed')
    if cmd == 'list':
        return
    if cmd == 'add':
        # Exactly the sidecar's forms: no other option (never -m/--automerge, never a folder of
        # files) can pass, whatever calibre's defaults are.
        return check_add(list(raw))
    if cmd == 'remove':
        if getattr(opts, 'permanent', True) or len(rest) != 1 or not rest[0].isdigit():
            raise SystemExit('remove takes exactly one book id, never --permanent')
        return
    if cmd == 'export':
        dirs = [d for d in os.environ.get('TTSU_EXPORT_DIRS', '').split(':') if d]
        to = os.path.realpath(opts.to_dir or '')
        inside = any(to == os.path.realpath(d) or to.startswith(os.path.realpath(d) + os.sep) for d in dirs)
        if getattr(opts, 'all', True) or len(rest) != 1 or not rest[0].isdigit() or not inside:
            raise SystemExit('export takes one book id and a folder in the quarantine')
        return
    if cmd != 'set_metadata':
        raise SystemExit(f'{cmd} is not allowed')
    if getattr(opts, 'list_fields', False) or len(rest) != 1 or not rest[0].isdigit():
        raise SystemExit('set_metadata takes exactly one book id and --field values')
    if not opts.field:
        raise SystemExit('set_metadata needs --field values')
    for f in opts.field:
        name = f.partition(':')[0]
        if name not in ALLOWED_FIELDS:
            raise SystemExit(f'set_metadata may not set {name}')


def context(opts, parser):
    key = (opts.library_path, opts.username, opts.password, opts.timeout)
    ctx = CONTEXTS.get(key)
    if ctx is None:
        ctx = CONTEXTS[key] = DBCtx(opts, parser)
    ctx.option_parser = parser
    return ctx


def run(args, password):
    # As calibredb's main(): the command is taken out, the rest parsed by its parser.
    if not args or args[0] not in ('list', 'set_metadata', 'remove', 'export', 'add'):
        raise SystemExit(f'{args[0] if args else "nothing"} is not allowed')
    cmd = args[0]
    argv = ['calibredb'] + list(args[1:])
    parser = option_parser_for(cmd, argv[1:])()
    opts, rest = parser.parse_args(argv)
    rest = rest[1:]
    opts.password = password
    check(cmd, opts, rest, args[1:])
    return run_cmd(cmd, opts, rest, context(opts, parser))


def answer(req):
    out_bytes = io.BytesIO()
    out = io.TextIOWrapper(out_bytes, encoding='utf-8', errors='replace', write_through=True)
    err = io.StringIO()
    code = 0
    # calibredb add prints "Added book ids: N" to sys.__stdout__ (calibre 9.18, db/cli/cmd_add.py),
    # not sys.stdout: both are this call's output, or the sidecar never sees the new book's id.
    old_out, old_err, old_real = sys.stdout, sys.stderr, sys.__stdout__
    sys.stdout, sys.stderr, sys.__stdout__ = out, err, out
    try:
        ret = run(req.get('args') or [], req.get('password') or '')
        code = ret if isinstance(ret, int) else 0
    except SystemExit as e:
        if isinstance(e.code, int):
            code = e.code
        else:
            code = 1
            if e.code is not None:
                err.write(str(e.code) + '\n')
    except BaseException:
        code = 1
        err.write(traceback.format_exc())
    finally:
        out.flush()
        sys.stdout, sys.stderr, sys.__stdout__ = old_out, old_err, old_real
    return {
        'id': req.get('id'),
        'code': code,
        'stdout': out_bytes.getvalue().decode('utf-8', 'replace'),
        'stderr': err.getvalue(),
    }


def main():
    send({'ready': True, 'version': __version__})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            send({'id': None, 'code': 2, 'stdout': '', 'stderr': 'bad request line'})
            continue
        send(answer(req))


main()
