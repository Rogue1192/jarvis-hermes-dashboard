"""
JARVIS Live — a HUD that drives Hermes Agent.

    python3 server.py

The brain is your own Hermes Agent CLI/profile. Hermes keeps access to the same
configured tools, browser/Chrome automation, MCP servers, skills, memory, and
third-party integrations that your normal Hermes sessions have. Voice can use the
browser Web Speech API, with optional server-side ElevenLabs STT/TTS if present.
"""
import datetime
import json
import mimetypes
import os
import pathlib
import secrets
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

# Windows defaults stdout to the cp1252 code page. Redirect that to a file and
# any non-ASCII character in our own output kills the process on startup. Ask for
# UTF-8 explicitly rather than keeping every future print() ASCII-only.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                          # noqa: BLE001
        pass

ROOT = pathlib.Path(__file__).resolve().parent
UI = ROOT / "ui"

# load .env before importing anything that reads os.environ
_env = ROOT / ".env"
if _env.exists():
    for line in _env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

import commands
import board         # noqa: E402
import runtime          # noqa: E402
import voice            # noqa: E402
import wake             # noqa: E402

PORT = int(os.environ.get("JARVIS_PORT", "8730"))
API_TOKEN = secrets.token_urlsafe(32)
RUN_LOCK = threading.Lock()
MAX_JSON_BODY = 1024 * 1024
MAX_AUDIO_BODY = 12 * 1024 * 1024

# The Jarvis persona, appended to every run. Without it, the model answers as a
# coding agent and narrates its own tooling — which is not what you want spoken
# out loud. Edit persona.md to change how it talks.
_PERSONA_FILE = ROOT / "persona.md"


def _now_line():
    """The wall clock, stated plainly.

    Hermes' system prompt carries the DATE but deliberately no time of day --
    it is kept byte-stable so the prompt cache survives the whole day, and the
    prompt itself tells the model to "query tools for exact time". Over voice
    that is the wrong trade: either the model burns a whole extra round trip
    shelling out to `date`, or -- with no terminal toolset loaded -- it simply
    guesses, which is how JARVIS confidently reported 2pm at 5:39pm. This rides
    in the per-turn user text, not the cached system prefix, so it costs one
    line and invalidates nothing.
    """
    now = datetime.datetime.now().astimezone()
    return ("Right now it is "
            f"{now.strftime('%-I:%M %p').lower() if os.name != 'nt' else now.strftime('%I:%M %p').lstrip('0').lower()}"
            f" on {now.strftime('%A, %B %-d, %Y') if os.name != 'nt' else now.strftime('%A, %B %d, %Y')}"
            f" ({now.strftime('%Z')}). Use this for anything time-related; do not "
            "estimate the time and do not run a command to look it up.")


def persona():
    try:
        base = _PERSONA_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        base = ""
    extra = commands.context_block()      # profile / goal / personality / queue
    return "\n\n".join(x for x in (base, extra, _now_line()) if x)
# One continuing Hermes conversation until the user hits /new.
SESSION = {"id": None}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("JARVIS_VERBOSE"):
            sys.stderr.write("  " + (fmt % args) + "\n")

    # ── helpers ──────────────────────────────────────────────
    def _json(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, data, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read(self, limit):
        n = int(self.headers.get("Content-Length", 0))
        if n < 0 or n > limit:
            raise ValueError(f"request body exceeds {limit} bytes")
        return self.rfile.read(n) if n else b""

    def _host_ok(self):
        host = self.headers.get("Host", "")
        return host in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin in {
            f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"
        }

    def _token_ok(self):
        supplied = self.headers.get("X-Jarvis-Token", "")
        return bool(supplied) and secrets.compare_digest(supplied, API_TOKEN)

    # ── GET ──────────────────────────────────────────────────
    def do_GET(self):
        if not self._host_ok():
            return self._json({"error": "invalid host"}, 403)
        p = urlparse(self.path).path
        if p == "/api/status":
            return self._json(dict(
                runtime=runtime.runtime_kind(),
                permission=runtime.PERMISSION,
                profile=runtime.PROFILE,
                source=runtime.SOURCE,
                workdir=runtime.WORKDIR,
                model=runtime.MODEL or "Hermes default",
                tools=runtime.hermes_tools_snapshot(),
                browser_stt=True,
                browser_tts=True,
                voice_mode=os.environ.get("JARVIS_VOICE_MODE", "elevenlabs" if voice.available() else "browser"),
                voice_id=voice.voice_id() if voice.available() else "browser",
                stt="elevenlabs" if voice.available() else "browser",
                tts="elevenlabs" if voice.available() else "browser",
                silence_ms=int(os.environ.get("JARVIS_SILENCE_MS", "1400") or 1400),
                wake=wake.status(),
                session=SESSION["id"]))
        if p == "/api/wake":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            # Consuming the flag here is deliberate: exactly one poller can win
            # a given detection, so two open tabs cannot both start a turn.
            return self._json(dict(triggered=wake.take_trigger(), **wake.status()))
        if p == "/api/board":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            return self._json(board.snapshot())
        if p.startswith("/api/board/attachment/"):
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            got = board.attachment(p.rsplit("/", 1)[-1])
            if got is None:
                return self._bytes(b"not found", "text/plain", 404)
            data, ctype, _name = got
            return self._bytes(data, ctype)
        if p == "/api/jobs":
            if not self._token_ok():
                return self._json({"error": "unauthorized"}, 401)
            # finished background missions, reported once each
            return self._json(dict(done=commands.take_finished(),
                                   running=[j for j in commands.jobs_snapshot()
                                            if j["status"] == "running"]))

        rel = "index.html" if p == "/" else p.lstrip("/")
        f = (UI / rel).resolve()
        if not str(f).startswith(str(UI.resolve())) or not f.is_file():
            return self._bytes(b"not found", "text/plain", 404)
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        data = f.read_bytes()
        if rel == "index.html":
            data = data.replace(b"__JARVIS_TOKEN__", API_TOKEN.encode())
        return self._bytes(data, ctype)

    # ── POST ─────────────────────────────────────────────────
    def do_POST(self):
        p = urlparse(self.path).path
        if not self._host_ok() or not self._origin_ok():
            return self._json({"error": "request origin rejected"}, 403)
        if not self._token_ok():
            return self._json({"error": "unauthorized"}, 401)
        ctype = self.headers.get("Content-Type", "").split(";", 1)[0].lower()
        if p in {"/api/run", "/api/speak", "/api/new", "/api/cancel", "/api/wake"} and ctype != "application/json":
            return self._json({"error": "application/json required"}, 415)
        if p == "/api/board/decide" and ctype != "application/json":
            return self._json({"error": "application/json required"}, 415)
        if p == "/api/listen" and not ctype.startswith("audio/"):
            return self._json({"error": "audio content type required"}, 415)
        try:
            raw = self._read(MAX_AUDIO_BODY if p == "/api/listen" else MAX_JSON_BODY)
        except (TypeError, ValueError):
            return self._json({"error": "request body too large"}, 413)

        if p == "/api/speak":
            try:
                body = json.loads(raw or b"{}")
                text = (body.get("text") or "").strip()
                prev = (body.get("previous") or "").strip() or None
                return self._bytes(voice.speak(text, prev), "audio/mpeg")
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:200]}, 503)

        if p == "/api/listen":
            try:
                mime = self.headers.get("Content-Type", "audio/webm")
                return self._json({"text": voice.transcribe(raw, mime)})
            except Exception as e:                        # noqa: BLE001
                return self._json({"error": str(e)[:300], "text": ""}, 503)

        if p == "/api/wake":
            try:
                wake.mute(bool(json.loads(raw or b"{}").get("mute")))
            except json.JSONDecodeError:
                return self._json({"error": "bad json"}, 400)
            return self._json(dict(ok=True, **wake.status()))

        if p == "/api/board/decide":
            try:
                body = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                return self._json({"error": "bad json"}, 400)
            res = board.decide(task_id=str(body.get("task_id") or ""),
                               verdict=str(body.get("verdict") or ""),
                               note=body.get("note"))
            return self._json(res, 200 if res.get("ok") else 400)

        if p == "/api/new":
            runtime.cancel_active()
            SESSION["id"] = None
            return self._json({"ok": True})

        if p == "/api/cancel":
            stopped = runtime.cancel_active()
            SESSION["id"] = None
            return self._json({"ok": True, "stopped": stopped})

        if p == "/api/run":
            if not RUN_LOCK.acquire(blocking=False):
                return self._json({"error": "JARVIS is already processing a request"}, 409)
            try:
                return self._stream_run(raw)
            finally:
                RUN_LOCK.release()

        return self._json({"error": "no such endpoint"}, 404)

    # ── the run: NDJSON stream of events ─────────────────────
    def _stream_run(self, raw):
        # Timing instrumentation. On 2026-09-04 a run showed RUN at :39 and the
        # first spoken word at :42 -- three seconds unaccounted for, and the same
        # question was instant the next morning. Intermittent, so it gets
        # measured rather than theorised about.
        _t_enter = time.monotonic()
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            return self._json({"error": "bad json"}, 400)
        message = (payload.get("message") or "").strip()
        extra = (payload.get("system") or "").strip()
        system = "\n\n".join(x for x in (persona(), extra) if x) or None
        _t_persona = time.monotonic()
        fresh = bool(payload.get("fresh"))
        if not message:
            return self._json({"error": "empty message"}, 400)
        if fresh:
            SESSION["id"] = None

        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(ev):
            self.wfile.write((json.dumps(ev) + "\n").encode())
            self.wfile.flush()

        # ── the command matrix: /new /profile /goal /personality /kanban /mission /background /tools /status /browser
        _t_headers = time.monotonic()
        cmd = commands.handle(
            message,
            runner=lambda m: runtime.run(m, None, persona()))
        _t_cmd = time.monotonic()
        if cmd:
            if cmd.get("note"):
                emit(dict(t="note", message=cmd["note"]))
            if cmd.get("fresh"):
                SESSION["id"] = None
            if cmd.get("message") is None:
                # answered locally — no model call needed
                emit(dict(t="delta", text=cmd.get("reply", "Done.")))
                emit(dict(t="complete", ms=0))
                return
            message = cmd["message"]
            system = "\n\n".join(x for x in (persona(), extra) if x) or None

        _prep = dict(
            persona=int((_t_persona - _t_enter) * 1000),
            headers=int((_t_headers - _t_persona) * 1000),
            commands=int((_t_cmd - _t_headers) * 1000),
        )
        if sum(_prep.values()) >= 250 or os.environ.get("JARVIS_TIMING"):
            emit(dict(t="note", message="prep " + " ".join(
                f"{k}={v}ms" for k, v in _prep.items())))

        try:
            for ev in runtime.run(message, SESSION["id"], system):
                # Only remember a real Hermes session, never demo/mock identifiers.
                sid = ev.get("session_id")
                # Only remember a session that actually COMPLETED. Storing it from
                # `status` (which fires at init) means one broken run poisons every
                # run after it with --resume <half-born session>.
                if ev.get("t") == "complete" and runtime.valid_session(sid):
                    SESSION["id"] = sid
                if ev.get("t") == "error":
                    SESSION["id"] = None       # drop a bad/stale session so the next run is fresh
                emit(ev)
        except (BrokenPipeError, ConnectionResetError):
            pass                                          # client navigated away
        except Exception as e:                            # noqa: BLE001
            try:
                emit(dict(t="error", message=str(e)[:300]))
            except OSError:
                pass


def _chrome():
    """First Chrome or Edge we can find, or None."""
    import shutil
    for var, rel in (
        ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
        ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles", r"Microsoft\Edge\Application\msedge.exe"),
        ("ProgramFiles(x86)", r"Microsoft\Edge\Application\msedge.exe"),
    ):
        base = os.environ.get(var)
        if base:
            path = os.path.join(base, rel)
            if os.path.isfile(path):
                return path
    return shutil.which("chrome") or shutil.which("msedge")


def _place_window(x, y, w, h, timeout=20):
    """Move the app window onto the monitor we actually asked for.

    Chrome's --window-position is only honoured when Chrome is not already
    running. When it is, the existing process creates the window and restores
    the app's last remembered bounds instead, silently ignoring the flag -- so
    the window lands wherever it was last time, no matter what we pass.

    Rather than fight that with a separate browser profile (which would lose the
    microphone permission granted to this address), find the window by title and
    move it with the Windows API.
    """
    if os.name != "nt":
        return False
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def scan(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value.startswith("JARVIS"):
                found.append(hwnd)
                return False
        return True

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        found.clear()
        user32.EnumWindows(scan, 0)
        if found:
            user32.SetWindowPos(found[0], 0, int(x), int(y), int(w), int(h),
                                SWP_NOZORDER | SWP_NOACTIVATE)
            return True
        time.sleep(0.4)
    return False


def _open_window():
    """Open the HUD in a chrome-less app window once the port is answering.

    App mode rather than a native wrapper on purpose: it reuses the browser
    profile that already holds your microphone permission for this address. A
    wrapper would have to broker that permission itself, and one that quietly
    denied it would break voice while looking perfectly fine.
    """
    import socket
    import subprocess
    url = f"http://127.0.0.1:{PORT}"
    for _ in range(60):
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                break
        except OSError:
            time.sleep(0.5)
    exe = _chrome()
    if not exe or os.environ.get("JARVIS_APP_WINDOW", "1") == "0":
        webbrowser.open(url)
        return
    # Which monitor to land on. Windows gives every screen a coordinate in one big
    # virtual desktop, so a screen above the primary one has a negative Y. Get the
    # numbers from PowerShell:
    #   Add-Type -AssemblyName System.Windows.Forms
    #   [System.Windows.Forms.Screen]::AllScreens | Select DeviceName, Bounds
    size = os.environ.get("JARVIS_WINDOW_SIZE", "1600,950").strip()
    pos = os.environ.get("JARVIS_WINDOW_POS", "").strip()
    args = [exe, f"--app={url}", f"--window-size={size}"]
    if pos:
        args.append(f"--window-position={pos}")
    try:
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:                                          # noqa: BLE001
        webbrowser.open(url)
        return
    if pos:
        try:
            x, y = (int(v) for v in pos.split(","))
            w, h = (int(v) for v in size.split(","))
            threading.Thread(target=_place_window, args=(x, y, w, h),
                             daemon=True).start()
        except ValueError:
            pass


def main():
    kind = runtime.runtime_kind()
    brain = ("Hermes Agent (profile tools, skills, memory, MCP, browser integrations live)"
             if kind == "hermes" else "MOCK — Hermes CLI not reachable")
    vo = (f"ElevenLabs · {voice.voice_id()[:8]}…" if voice.available()
          else "none (add ELEVENLABS_API_KEY for voice)")
    perm = runtime.PERMISSION
    perm_note = ("  can run tools without asking — set JARVIS_PERMISSION=default to require approval"
                 if perm == "bypass" else "")

    print(f"""
  JARVIS · Hermes Live HUD
  ----------------------------------------------
  brain        {brain}
  profile      {runtime.PROFILE}
  workdir      {runtime.WORKDIR}
  permission   {perm}{perm_note}
  voice        {vo} + browser Web Speech fallback
  open         http://localhost:{PORT}
""", flush=True)

    if wake.ENABLED:
        print("  starting wake word (first run downloads the model)...", flush=True)
        ok = wake.start()
        st = wake.status()
        print("  wake word    " + ("listening for 'Hey JARVIS'" if ok
                                   else f"unavailable - {st.get('error') or 'unknown'}"),
              flush=True)

    # Boot the resident Hermes in the background while the HUD finishes coming
    # up, so the FIRST question is warm too rather than paying for the handshake.
    threading.Thread(target=runtime.warm, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    if os.environ.get("JARVIS_OPEN", "1") != "0":
        threading.Thread(target=_open_window, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  down.")
        srv.shutdown()


if __name__ == "__main__":
    main()
