#!/usr/bin/env python
# WP20b: one long-lived calibredb for the cleanup sidecar.
#
# Run with calibre's own Python: `calibre-debug -e calibredb-helper.py`. It runs calibredb's
# own command code (calibre.db.cli.main: option_parser_for, DBCtx, run_cmd) exactly as the
# `calibredb` program does, for the same argument lists, but in one process, so each call
# doesn't pay calibre's start-up. It talks only to the content server given in each call's
# --with-library (an http URL); never to a library folder.
#
# Allowed: `list`, and `set_metadata <id> --field ...` for the fields the sidecar may set
# (the sidecar builds and checks the arguments; this checks them again).
#
# Protocol: one JSON object per line on stdin {"id", "args", "password"}; one line per answer
# on stdout, "@@ttsu " + {"id", "code", "stdout", "stderr"}. The first line says it is ready.
# Anything else calibre prints goes to stderr.
import io
import json
import os
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
}
GLOBAL = {'--with-library', '--library-path', '--username', '--password', '--timeout'}
CONTEXTS = {}


def send(obj):
    PROTO.write('@@ttsu ' + json.dumps(obj, ensure_ascii=False) + '\n')
    PROTO.flush()


def check(cmd, opts, rest):
    if not (opts.library_path or '').startswith(('http://', 'https://')):
        raise SystemExit('Only a content server (http URL) is allowed')
    if cmd == 'list':
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
    if not args or args[0] not in ('list', 'set_metadata'):
        raise SystemExit(f'{args[0] if args else "nothing"} is not allowed')
    cmd = args[0]
    argv = ['calibredb'] + list(args[1:])
    parser = option_parser_for(cmd, argv[1:])()
    opts, rest = parser.parse_args(argv)
    rest = rest[1:]
    opts.password = password
    check(cmd, opts, rest)
    return run_cmd(cmd, opts, rest, context(opts, parser))


def answer(req):
    out_bytes = io.BytesIO()
    out = io.TextIOWrapper(out_bytes, encoding='utf-8', errors='replace', write_through=True)
    err = io.StringIO()
    code = 0
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
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
        sys.stdout, sys.stderr = old_out, old_err
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
