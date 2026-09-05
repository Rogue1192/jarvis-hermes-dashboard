"""Resident Hermes process, driven over ACP (Agent Client Protocol).

WHY THIS EXISTS
---------------
The original runtime spawns a brand-new ``hermes.exe`` for every question:
Python boots, the agent package imports, every enabled toolset loads, MCP
servers handshake -- and only then does your sentence reach a model. You pay
that on each turn, out loud, while standing there.

``hermes acp`` is the same agent as a long-lived JSON-RPC server on stdio
(newline-delimited JSON; see acp/connection.py). We start one at HUD launch,
call ``initialize`` + ``session/new`` once, and from then on each question is a
single ``session/prompt`` into an already-warm process. Nothing is trimmed to
get there -- full toolsets, full capability. The startup cost moves from
"every turn" to "once".

Hermes' ACP adapter accepts ``client_capabilities`` and ignores it
(acp_adapter/server.py:1298): it runs its own file and terminal tools
internally rather than delegating them back to us. So this client implements
exactly one inbound request -- ``session/request_permission`` -- and does not
have to reimplement any tool.

FAILURE POLICY
--------------
Never leave JARVIS worse than the subprocess path. Every entry point returns
False / raises rather than hanging, ``runtime.run`` falls back to spawning the
CLI, and a dead process is respawned on next use.
"""
import json
import os
import queue
import subprocess
import threading
import time

PROTOCOL_VERSION = 1
START_TIMEOUT = float(os.environ.get("JARVIS_ACP_START_TIMEOUT", "90"))
TURN_TIMEOUT = float(os.environ.get("JARVIS_ACP_TURN_TIMEOUT", "120"))
# JARVIS_ACP_TRACE=1 dumps every JSON-RPC frame to stderr. A stalled turn is
# unreadable without it -- you cannot tell "agent never answered" from
# "agent asked us something we ignored".
TRACE = os.environ.get("JARVIS_ACP_TRACE", "").strip().lower() in {"1","true","yes","on"}


def _trace(direction, payload):
    if not TRACE:
        return
    import sys as _sys
    text = json.dumps(payload, ensure_ascii=False)
    if len(text) > 400:
        text = text[:400] + "..."
    _sys.stderr.write(f"  {direction} {text}\n")
    _sys.stderr.flush()


def _child_env():
    """Same PATH/encoding hardening the subprocess path does.

    A GUI-launched HUD inherits a thin PATH; Hermes then fails to find git,
    node, ffmpeg. And Windows Python defaults to cp1252, which cannot encode
    what Hermes prints. Both bugs were already fixed once in runtime.py --
    keep them fixed here.
    """
    env = dict(os.environ)
    home = os.path.expanduser("~")
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        extra = [
            os.path.join(local, "hermes", "bin"),
            os.path.join(local, "hermes", "hermes-agent", "venv", "Scripts"),
            os.path.join(local, "hermes", "git", "cmd"),
            os.path.join(local, "Microsoft", "WindowsApps"),
        ]
    else:
        extra = ["/opt/homebrew/bin", "/usr/local/bin",
                 os.path.join(home, ".local", "bin"),
                 os.path.join(home, ".npm-global", "bin"),
                 "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    env["PATH"] = os.pathsep.join(dict.fromkeys([env.get("PATH", ""), *extra]))
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


class AcpAgent:
    """One resident `hermes acp` process. Thread-safe; one turn at a time."""

    def __init__(self, base_cmd, workdir):
        self.base_cmd = list(base_cmd)          # e.g. ["C:\\...\\hermes.exe"]
        self.workdir = workdir
        self.proc = None
        self.session_id = None
        self._next_id = 1
        self._pending = {}                      # id -> queue for the response
        self._updates = queue.Queue()           # session/update notifications
        self._lock = threading.Lock()           # serialises writes
        self._turn = threading.Lock()           # one prompt at a time
        self._stderr_tail = []

    # ── process lifecycle ────────────────────────────────────────────
    def alive(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self):
        """Spawn + handshake + open a session. True when ready to prompt."""
        if self.alive() and self.session_id:
            return True
        self.stop()
        cmd = self.base_cmd + ["acp"]
        self.proc = subprocess.Popen(
            cmd, cwd=self.workdir, env=_child_env(),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1, encoding="utf-8", errors="replace",
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

        self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {},           # adapter ignores this; be honest anyway
            "clientInfo": {"name": "jarvis-dashboard", "version": "1"},
        }, timeout=START_TIMEOUT)

        res = self.request("session/new", {
            "cwd": os.path.abspath(self.workdir),
            "mcpServers": [],
        }, timeout=START_TIMEOUT)
        self.session_id = res.get("sessionId") or res.get("session_id")
        return bool(self.session_id)

    def new_session(self):
        """Drop the current conversation and open a clean one. Keeps the
        process warm -- only the context is discarded."""
        old = self.session_id
        if old:
            try:
                self._send({"jsonrpc": "2.0", "method": "session/close",
                            "params": {"sessionId": old}})
            except Exception:
                pass
        res = self.request("session/new", {
            "cwd": os.path.abspath(self.workdir),
            "mcpServers": [],
        }, timeout=START_TIMEOUT)
        self.session_id = res.get("sessionId") or res.get("session_id")
        return self.session_id

    def stop(self):
        p, self.proc, self.session_id = self.proc, None, None
        if not p:
            return
        try:
            p.stdin.close()
        except Exception:
            pass
        try:
            p.terminate()
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    def stderr_tail(self):
        return "".join(self._stderr_tail[-40:]).strip()

    # ── transport ────────────────────────────────────────────────────
    def _send(self, payload):
        line = json.dumps(payload, ensure_ascii=False) + "\n"
        _trace("-->", payload)
        with self._lock:
            if not self.alive():
                raise RuntimeError("ACP process is not running")
            self.proc.stdin.write(line)
            self.proc.stdin.flush()

    def request(self, method, params=None, timeout=TURN_TIMEOUT):
        with self._lock:
            rid = self._next_id
            self._next_id += 1
        box = queue.Queue(maxsize=1)
        self._pending[rid] = box
        try:
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
            try:
                msg = box.get(timeout=timeout)
            except queue.Empty:
                raise RuntimeError(f"ACP timed out after {timeout}s on {method}")
        finally:
            self._pending.pop(rid, None)
        if "error" in msg:
            err = msg["error"] or {}
            raise RuntimeError(f"ACP {method} failed: {err.get('message', err)}")
        return msg.get("result") or {}

    def _read_stdout(self):
        proc = self.proc
        try:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue                     # adapter chatter, not protocol
                _trace("<--", msg)
                if "method" in msg and "id" in msg:
                    self._handle_incoming_request(msg)
                elif "method" in msg:
                    self._updates.put(msg)
                elif "id" in msg:
                    box = self._pending.get(msg["id"])
                    if box:
                        try:
                            box.put_nowait(msg)
                        except queue.Full:
                            pass
        except Exception:
            pass
        finally:
            # Unblock anyone waiting on a process that just died.
            for box in list(self._pending.values()):
                try:
                    box.put_nowait({"error": {"message": "ACP process exited"}})
                except Exception:
                    pass
            self._updates.put({"method": "_closed"})

    def _read_stderr(self):
        proc = self.proc
        try:
            for line in proc.stderr:
                self._stderr_tail.append(line)
                del self._stderr_tail[:-60]
        except Exception:
            pass

    def _handle_incoming_request(self, msg):
        """The agent asking US something. Only permission is expected."""
        method, rid = msg.get("method"), msg.get("id")
        if method == "session/request_permission":
            # Match `hermes chat -Q`: the HUD runs unattended by voice, so a
            # prompt nobody can answer is a hang. Pick the allow-ish option the
            # agent offered rather than inventing an option id.
            opts = ((msg.get("params") or {}).get("options")) or []
            pick = next((o for o in opts if "allow" in str(o.get("kind", "")).lower()
                         or "allow" in str(o.get("optionId", "")).lower()), None)
            pick = pick or (opts[0] if opts else None)
            result = ({"outcome": {"outcome": "selected", "optionId": pick.get("optionId")}}
                      if pick else {"outcome": {"outcome": "cancelled"}})
            self._reply(rid, result)
            return
        self._reply(rid, None, error={"code": -32601, "message": f"unhandled: {method}"})

    def _reply(self, rid, result, error=None):
        payload = {"jsonrpc": "2.0", "id": rid}
        if error:
            payload["error"] = error
        else:
            payload["result"] = result if result is not None else {}
        try:
            self._send(payload)
        except Exception:
            pass

    # ── one turn ─────────────────────────────────────────────────────
    def prompt(self, text):
        """Yield HUD events for one question. Same shapes as runtime.run."""
        with self._turn:
            if not self.start():
                raise RuntimeError("ACP session unavailable")
            while not self._updates.empty():     # drop anything stale
                self._updates.get_nowait()

            started = time.monotonic()
            done, box = threading.Event(), {}

            def call():
                try:
                    box["result"] = self.request(
                        "session/prompt",
                        {"sessionId": self.session_id,
                         "prompt": [{"type": "text", "text": text}]},
                        timeout=TURN_TIMEOUT)
                except Exception as e:           # noqa: BLE001
                    box["error"] = e
                finally:
                    done.set()

            threading.Thread(target=call, daemon=True).start()

            first_token_ms = None
            deadline = time.monotonic() + TURN_TIMEOUT
            timed_out = False
            while True:
                if done.is_set() and self._updates.empty():
                    break
                if time.monotonic() > deadline:
                    # A tool that never returns must not hold the turn open
                    # forever. Cancel it, keep the resident process, fail this
                    # one answer -- a wedged JARVIS is worse than a wrong one.
                    timed_out = True
                    self.cancel()
                    break
                try:
                    msg = self._updates.get(timeout=0.1)
                except queue.Empty:
                    continue
                if msg.get("method") == "_closed":
                    break
                if msg.get("method") != "session/update":
                    continue
                upd = ((msg.get("params") or {}).get("update")) or {}
                kind = upd.get("sessionUpdate")

                if kind == "agent_message_chunk":
                    piece = (upd.get("content") or {}).get("text") or ""
                    if piece:
                        if first_token_ms is None:
                            first_token_ms = int((time.monotonic() - started) * 1000)
                            yield dict(t="latency", ms=first_token_ms)
                        yield dict(t="delta", text=piece)
                elif kind == "tool_call":
                    yield dict(t="tool", phase="use",
                               name=upd.get("title") or upd.get("kind") or "tool",
                               input="")
                elif kind == "tool_call_update":
                    status = upd.get("status")
                    if status in ("completed", "failed"):
                        yield dict(t="tool", phase="result", ok=(status == "completed"))

            if timed_out:
                raise RuntimeError(
                    f"turn exceeded {TURN_TIMEOUT:.0f}s (a tool call never returned); "
                    "cancelled it and kept the agent warm")
            if "error" in box:
                raise box["error"]
            stop = (box.get("result") or {}).get("stopReason")
            if stop == "refusal":
                yield dict(t="note", message="the model declined that one")
            yield dict(t="complete",
                       ms=int((time.monotonic() - started) * 1000),
                       session_id=self.session_id,
                       stop_reason=stop)

    def cancel(self):
        if self.alive() and self.session_id:
            try:
                self._send({"jsonrpc": "2.0", "method": "session/cancel",
                            "params": {"sessionId": self.session_id}})
                return True
            except Exception:
                pass
        return False


_AGENT = None
_AGENT_LOCK = threading.Lock()


def get_agent(base_cmd, workdir):
    global _AGENT
    with _AGENT_LOCK:
        if _AGENT is None:
            _AGENT = AcpAgent(base_cmd, workdir)
        return _AGENT
