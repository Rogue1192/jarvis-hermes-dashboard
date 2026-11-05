"""Vector's approved MetaCore form tool; delegates to the reviewed single creator.

Usage: metacore_form_create.py <optimization_id> [inspect|create|read] --output NEW.json
Also accepts operation first. Default is inspect. create --prepare-only only inspects;
it does NOT prove creation, reserve a receipt, upload a photo, or release approval.
"""
import argparse
import importlib.util
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
OPS = ('inspect', 'create', 'read')


def load_backend():
    path = ROOT / 'crew' / 'lead_form_build.py'
    spec = importlib.util.spec_from_file_location('metacore_reviewed_form_backend', path)
    backend = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend)
    return backend


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('first', help='Exact optimization UUID (or operation)')
    parser.add_argument('second', nargs='?', help='Operation, default inspect (or UUID)')
    parser.add_argument('--prepare-only', action='store_true', help='create preview only; no creation')
    parser.add_argument('--output', required=True, type=Path, help='New evidence path; never overwritten')
    args = parser.parse_args(argv)
    if args.first in OPS:
        op, opt = args.first, args.second
    else:
        opt, op = args.first, args.second or 'inspect'
    if op not in OPS or not opt or not UUID.fullmatch(opt):
        parser.error('Use the exact lowercase optimization UUID and inspect, create or read')
    if args.prepare_only and op != 'create':
        parser.error('--prepare-only is only valid with create')
    if args.output.exists():
        parser.error('Evidence file exists: choose a new filename')
    effective_op = 'inspect' if args.prepare_only else op
    if args.prepare_only:
        print('PREPARE ONLY: read-only inspect; no form created.', file=sys.stderr)
    backend = load_backend()
    original = sys.argv
    try:
        sys.argv = [str(ROOT / 'crew' / 'lead_form_build.py'), effective_op, opt, '--output', str(args.output)]
        return backend.main()
    finally:
        sys.argv = original


if __name__ == '__main__':
    raise SystemExit(main())
