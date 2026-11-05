"""Build/read an exact MetaCore form proposal. Never switches ads or reports mapping."""
import argparse
import base64
import hashlib
import hmac
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit, urlunsplit

ROOT = pathlib.Path('C:/jarvis-dashboard')
FUNCTION = 'lead-form-build'
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')


def scrub(value):
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if k.lower() not in {'access_token', 'token', 'authorization', 'secret', 'signedurl'}}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    if isinstance(value, str) and value.startswith(('http://', 'https://')):
        parts = urlsplit(value)
        if parts.query and parts.query != 'lead_id={{lead_id}}':
            return urlunsplit((parts.scheme, parts.netloc, parts.path, '[redacted]', ''))
    return value


def held_approval(state, opt, seen_sig, now):
    """Only JARVIS's already-recorded held approval; never accept user-provided approval JSON."""
    matches = [h for h in (state.get('holds') or {}).values() if opt in h.get('need', [])]
    if len(matches) != 1:
        raise ValueError('Exactly one existing JARVIS held approval is required. Wait for the approved buildform card; nothing sent.')
    hold = matches[0]
    body = hold.get('body') or {}
    if hold.get('kind') == 'bundle':
        items = [i for i in body.get('items', []) if i.get('optimization_id') == opt]
        if len(items) != 1:
            raise ValueError('Held bundle does not contain exactly this optimization')
        decision = items[0]
    else:
        decision = body
    # board-decide bundle items carry seen_sig and an explicit verdict.
    verdict = decision.get('verdict', body.get('verdict'))
    if verdict != 'approve' or decision.get('seen_sig') != seen_sig or decision.get('include') is False or not decision.get('build_form'):
        raise ValueError('Held approval is absent, rejected, or for a different proposal version')
    if not re.fullmatch(r't_[0-9a-f]+', str(hold.get('task_id', ''))):
        raise ValueError('Held approval source card missing')
    return {'optimization_id': opt, 'seen_sig': seen_sig, 'task_id': hold['task_id'], 'verdict': 'approve', 'expires': now + 90}


def call(op, opt, approval_header=None, auth='valid', extra=None):
    sys.path.insert(0, str(ROOT))
    import metacore_board as mb
    key = mb._key()
    if not key:
        raise ValueError('Existing JARVIS connection key is missing')
    headers = {'Content-Type': 'application/json'}
    if auth != 'missing':
        headers['x-jarvis-key'] = key if auth == 'valid' else 'invalid-key-test'
    if approval_header:
        headers['x-form-approval'] = approval_header
    body = {'op': op, 'optimization_id': opt, **(extra or {})}
    request = urllib.request.Request(mb.BASE + FUNCTION, data=json.dumps(body).encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=170) as response:
            return response.status, scrub(json.load(response))
    except urllib.error.HTTPError as error:
        return error.code, scrub(json.loads(error.read()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('op', choices=['inspect', 'create', 'read'])
    parser.add_argument('optimization_id')
    parser.add_argument('--output', required=True, type=pathlib.Path, help='New evidence filename; never overwritten')
    args = parser.parse_args()
    if not UUID.fullmatch(args.optimization_id):
        parser.error('Copy the exact lowercase optimization UUID; no normalization is performed')
    if args.output.exists():
        parser.error('Evidence file exists: choose a new filename')
    attestation = None
    try:
        if args.op == 'create':
            status, inspected = call('inspect', args.optimization_id)
            if status != 200 or not inspected.get('ok'):
                raise ValueError('Read-only preflight failed; no creation sent')
            state = json.loads((ROOT / 'logs/metacore_board.json').read_text(encoding='utf-8'))
            witness = held_approval(state, args.optimization_id, inspected['seen_sig'], int(time.time()))
            sys.path.insert(0, str(ROOT))
            import metacore_board as mb
            encoded = base64.b64encode(json.dumps(witness, separators=(',', ':')).encode()).decode()
            attestation = encoded + '.' + hmac.new(mb._key().encode(), encoded.encode(), hashlib.sha256).hexdigest()
        status, result = call(args.op, args.optimization_id, attestation)
    except (ValueError, OSError, TimeoutError) as error:
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, ValueError) else 'Connection/state read failed; no blind retry'}))
        return 2
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as out:
        json.dump({'http_status': status, 'result': result}, out, indent=2)
    print(json.dumps({'http_status': status, 'ok': result.get('ok', False), 'op': args.op, 'form_id': result.get('form_id'), 'created': result.get('created', False), 'reused': result.get('reused', False), 'error': result.get('error'), 'evidence': str(args.output)}))
    return 0 if status == 200 and result.get('ok') else 2


if __name__ == '__main__':
    raise SystemExit(main())
