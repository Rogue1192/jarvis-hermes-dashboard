"""dashflow.py — today's list, read from Casey's own task app.

DashFlow speaks MCP over HTTP. Hermes is already authorised against it
(`hermes mcp login dashflow`), so rather than making Casey approve a second
OAuth client for the HUD, this reads the tokens Hermes stores in
%LOCALAPPDATA%/hermes/mcp-tokens/dashflow.json.

That coupling is deliberate but worth naming: one login, one place tokens
live, one thing to revoke. The cost is that the HUD stops working if Hermes'
authorisation lapses -- which is the correct behaviour anyway, since the HUD
is a window onto what JARVIS can see.

Refreshing is done carefully. Hermes refreshes the same token file, so both
processes can want a new token at once; Supabase rotates refresh tokens, and
a lost race would leave one side holding a dead one. So the HUD only refreshes
when the token is genuinely close to expiry, writes back atomically, and on
any failure reports rather than retrying in a loop.
"""
import json
import os
import pathlib
import threading
import time
import urllib.error
import urllib.request

MCP_URL = "https://app.get-dashflow.com/mcp"
# The spec requires this on every request AFTER initialize. Servers are
# entitled to reject a request without it, and the rejection is a 4xx that
# looks exactly like an auth failure -- which is how it cost an hour once.
PROTOCOL_VERSION = "2025-06-18"

# urllib announces itself as "Python-urllib/3.x", which edge bot filters drop
# before the request ever reaches the application. DashFlow is hosted on
# Lovable, and that is exactly what happened: a 403 carrying a Lovable HTML
# error page rather than anything from the MCP server. Hermes gets through
# because its HTTP client sends an ordinary agent string.
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisHUD/1.0 (MCP client)"
_LOCK = threading.Lock()
_SESSION = {"id": None}


def _tokens_dir() -> pathlib.Path:
    env = os.environ.get("JARVIS_DASHFLOW_TOKENS")
    if env:
        return pathlib.Path(env)
    local = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/AppData/Local")
    return pathlib.Path(local) / "hermes" / "mcp-tokens"


def _read(name):
    p = _tokens_dir() / name
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def _post_json(url, payload, headers=None, form=False):
    if form:
        from urllib.parse import urlencode
        data = urlencode(payload).encode()
        ctype = "application/x-www-form-urlencoded"
    else:
        data = json.dumps(payload).encode()
        ctype = "application/json"
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", ctype)
    req.add_header("Accept", "application/json, text/event-stream")
    req.add_header("User-Agent", USER_AGENT)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=20) as r:
        body = r.read().decode("utf-8", "replace")
        return r.headers, body


def _refresh(tok):
    """Trade the refresh token for a new access token, and write it back."""
    meta = _read("dashflow.meta.json") or {}
    client = _read("dashflow.client.json") or {}
    endpoint = meta.get("token_endpoint")
    if not endpoint or not tok.get("refresh_token") or not client.get("client_id"):
        return None
    try:
        _, body = _post_json(endpoint, {
            "grant_type": "refresh_token",
            "refresh_token": tok["refresh_token"],
            "client_id": client["client_id"],
        }, form=True)
        fresh = json.loads(body)
    except (urllib.error.URLError, ValueError, OSError):
        return None
    if not fresh.get("access_token"):
        return None

    merged = dict(tok)
    merged.update(fresh)
    merged["expires_at"] = time.time() + float(fresh.get("expires_in") or 3600)

    # Atomic write: a half-written token file would lock Hermes out too.
    p = _tokens_dir() / "dashflow.json"
    tmp = p.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(merged), encoding="utf-8")
        os.replace(tmp, p)
    except OSError:
        pass
    return merged


def _token():
    tok = _read("dashflow.json")
    if not tok or not tok.get("access_token"):
        return None, "DashFlow is not connected. Run: hermes mcp login dashflow"
    # 90s of headroom: a token that expires mid-request is a failure that looks
    # like a network fault.
    if float(tok.get("expires_at") or 0) - time.time() < 90:
        fresh = _refresh(tok)
        if fresh:
            tok = fresh
        elif float(tok.get("expires_at") or 0) <= time.time():
            return None, "DashFlow authorisation expired. Run: hermes mcp login dashflow"
    return tok["access_token"], None


def _readable(body, limit=160):
    """Turn whatever came back into one line worth reading.

    A hosting layer answers with an HTML page; quoting its doctype at someone
    tells them nothing. Strip the tags and keep the sentence."""
    body = (body or "").strip()
    if body.lower().startswith("<!doctype") or body.lower().startswith("<html"):
        import re as _re
        text = _re.sub(r"(?is)<(script|style|head).*?</\1>", " ", body)
        text = _re.sub(r"(?s)<[^>]+>", " ", text)
        text = " ".join(text.split())
        return (text[:limit] or "an HTML error page, not an MCP response")
    return body[:limit]


def _parse(body):
    """MCP over HTTP answers with JSON or an SSE stream, depending on mood."""
    body = body.strip()
    if body.startswith("{"):
        return json.loads(body)
    for line in body.splitlines():
        if line.startswith("data:"):
            chunk = line[5:].strip()
            if chunk:
                try:
                    return json.loads(chunk)
                except ValueError:
                    continue
    raise ValueError("unrecognised MCP response")


def _rpc(method, params, access, want_session=True):
    headers = {"Authorization": "Bearer " + access}
    if want_session:
        headers["MCP-Protocol-Version"] = PROTOCOL_VERSION
        if _SESSION["id"]:
            headers["Mcp-Session-Id"] = _SESSION["id"]
    payload = {"jsonrpc": "2.0", "id": int(time.time() * 1000) % 100000,
               "method": method, "params": params}
    resp_headers, body = _post_json(MCP_URL, payload, headers)
    sid = resp_headers.get("Mcp-Session-Id") or resp_headers.get("mcp-session-id")
    if sid:
        _SESSION["id"] = sid
    return _parse(body)


def _notify(method, access):
    headers = {"Authorization": "Bearer " + access,
               "MCP-Protocol-Version": PROTOCOL_VERSION}
    if _SESSION["id"]:
        headers["Mcp-Session-Id"] = _SESSION["id"]
    try:
        _post_json(MCP_URL, {"jsonrpc": "2.0", "method": method}, headers)
    except (urllib.error.URLError, OSError):
        pass


def _handshake(access):
    out = _rpc("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "jarvis-hud", "version": "1.0"},
    }, access, want_session=False)
    if "error" in out:
        raise RuntimeError(out["error"].get("message", "initialize refused"))
    _notify("notifications/initialized", access)


def call_tool(name, arguments=None):
    """One DashFlow tool call. Returns (result, error_message)."""
    with _LOCK:
        access, err = _token()
        if err:
            return None, err
        try:
            if not _SESSION["id"]:
                _handshake(access)
            out = _rpc("tools/call", {"name": name, "arguments": arguments or {}}, access)
            if "error" in out:
                # A dead session id survives a restart of the far end; clear it
                # so the next call re-handshakes instead of failing forever.
                _SESSION["id"] = None
                return None, out["error"].get("message", "DashFlow refused the call")
        except urllib.error.HTTPError as e:
            _SESSION["id"] = None
            detail = ""
            try:
                detail = _readable(e.read().decode("utf-8", "replace"))
            except Exception:                                 # noqa: BLE001
                pass
            if e.code in (401, 403):
                # Say what the server said. "Rejected the token" sent Casey to
                # re-run a login that was not the problem.
                return None, ("DashFlow rejected the request (%s)%s. If this persists, "
                              "run: hermes mcp login dashflow"
                              % (e.code, " — " + detail if detail else ""))
            return None, "DashFlow returned HTTP %s%s" % (e.code, " — " + detail if detail else "")
        except (urllib.error.URLError, OSError):
            return None, "DashFlow unreachable"
        except (ValueError, RuntimeError) as e:
            _SESSION["id"] = None
            return None, str(e)[:160]

    result = out.get("result") or {}
    # MCP returns content blocks; the useful payload is either structured or
    # JSON inside a text block.
    if isinstance(result.get("structuredContent"), (dict, list)):
        return result["structuredContent"], None
    for block in result.get("content") or []:
        if block.get("type") == "text":
            try:
                return json.loads(block["text"]), None
            except (ValueError, KeyError):
                return {"text": block.get("text", "")}, None
    return result, None


def _as_list(payload, *keys):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in keys:
            v = payload.get(k)
            if isinstance(v, list):
                return v
    return []


def snapshot(list_id=None, status="today"):
    """What the Today panel renders: the lists to filter by, and the tasks."""
    lists, err = call_tool("list_lists")
    if err:
        return dict(ok=False, error=err, lists=[], tasks=[])

    args = {"status": status, "limit": 100}
    if list_id:
        args["list_id"] = list_id
    tasks, err = call_tool("list_tasks", args)
    if err:
        return dict(ok=False, error=err, lists=_as_list(lists, "lists", "data"), tasks=[])

    return dict(ok=True,
                lists=_as_list(lists, "lists", "data", "items"),
                tasks=_as_list(tasks, "tasks", "data", "items"),
                status=status,
                list_id=list_id)


def complete(task_id):
    _, err = call_tool("complete_task", {"task_id": task_id})
    return dict(ok=not err, error=err)


def add(title, list_id=None, status="today", estimate_minutes=None):
    args = {"title": title, "status": status}
    if list_id:
        args["list_id"] = list_id
    if estimate_minutes:
        args["estimate_minutes"] = int(estimate_minutes)
    out, err = call_tool("create_task", args)
    return dict(ok=not err, error=err, task=out)
