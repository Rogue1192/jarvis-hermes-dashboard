"""
Hermes runtime for the JARVIS HUD.

This dashboard is a face on Hermes Agent, not Claude Code. It launches the
Hermes CLI with the selected profile/source so Hermes keeps access to the same
configured toolsets, MCP servers, browser automation, Google integrations,
third-party tools, skills, memory, and gateway features that are available to the
normal Hermes agent.

Set HERMES_CMD when your shell exposes Hermes under a custom command/path, e.g.
  HERMES_CMD="/path/to/hermes"
or
  HERMES_CMD="python3 -m hermes_cli.main"
"""
import collections
import json
import os
import random
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time

_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$")
_ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_CLI_NOISE = re.compile(
    r"^(?:Query:|Initializing agent|Resume this session with:|hermes --resume\b|"
    r"Session:|Duration:|Messages:|─+|=+|[-─ ]*⚕\s*Hermes\b)", re.I)

MODEL = os.environ.get("JARVIS_MODEL", "").strip()
PROFILE = os.environ.get("HERMES_PROFILE", os.environ.get("JARVIS_PROFILE", "default")).strip() or "default"
SOURCE = os.environ.get("HERMES_SOURCE", "jarvis-dashboard").strip() or "jarvis-dashboard"
WORKDIR = os.path.expanduser(os.environ.get("JARVIS_WORKDIR", os.getcwd()))
PERMISSION = os.environ.get("JARVIS_PERMISSION", os.environ.get("HERMES_PERMISSION", "normal")).strip().lower()
RUNTIME = os.environ.get("JARVIS_RUNTIME", "auto").strip().lower()  # auto|hermes|mock
IDLE_TIMEOUT = int(os.environ.get("JARVIS_TIMEOUT", "120"))
# Raw transcripts can contain private prompts. Logging is off by default.
RAW_LOG = os.environ.get("JARVIS_RAW_LOG", "").strip()
TOOLSETS = os.environ.get("HERMES_TOOLSETS", "").strip()
# Reasoning depth for voice turns only. Unset means Hermes uses
# agent.reasoning_effort from config.yaml (medium), which is more
# deliberation than "what is on my calendar" needs and costs seconds
# of latency on every question. Levels: none, minimal, low, medium, high.
REASONING = os.environ.get("JARVIS_REASONING", "").strip()
# Resident Hermes over ACP instead of a fresh subprocess per question.
# Off unless asked for; any failure falls back to the subprocess path.
ACP_ENABLED = os.environ.get("JARVIS_ACP", "").strip().lower() in {"1","true","yes","on"}
# -Q is "quiet mode for programmatic use ... only output the final response".
# That is why voice never streamed: first token and last token arrive in the
# same instant, so sentence-by-sentence speech has nothing to start on.
# Dropping it lets tokens arrive as they are generated. -q alone still
# answers-and-exits on a non-TTY, which a pipe is.
STREAM_CLI = os.environ.get("JARVIS_STREAM", "").strip().lower() in {"1","true","yes","on"}

# One Hermes subprocess at a time. Hermes session state and profile resources are
# shared, so foreground runs and /background missions must not overlap. The active
# process handle lets the browser Escape key stop the backend work, not just the
# frontend fetch.
EXECUTION_LOCK = threading.RLock()
_ACTIVE_PROC = None
_ACTIVE_LOCK = threading.Lock()


def cancel_active():
    """Terminate the currently running Hermes child process, if any."""
    with _ACTIVE_LOCK:
        proc = _ACTIVE_PROC
    if proc is None or proc.poll() is not None:
        return False
    try:
        proc.terminate()
        return True
    except Exception:
        return False


def valid_session(sid):
    # Hermes emits timestamp-based IDs such as 20260808_031038_0ecb14.
    return bool(sid) and bool(_SESSION_ID.match(str(sid)))


def _mono_ms():
    return int(time.monotonic() * 1000)


def _windows_hermes():
    """Known-good locations for hermes.exe on a native Windows install."""
    local = os.environ.get("LOCALAPPDATA", "")
    if not local:
        return None
    for candidate in (
        os.path.join(local, "hermes", "hermes-agent", "venv", "Scripts", "hermes.exe"),
        os.path.join(local, "hermes", "bin", "hermes.exe"),
    ):
        if os.path.isfile(candidate):
            return candidate
    return None


def _hermes_base():
    configured = os.environ.get("HERMES_CMD", "").strip()
    if configured:
        # A bare Windows path must not go through shlex, which eats backslashes.
        if os.path.isfile(configured):
            return [configured]
        return shlex.split(configured, posix=(os.name != "nt"))
    exe = shutil.which("hermes")
    if exe:
        return [exe]
    if os.name == "nt":
        found = _windows_hermes()
        if found:
            return [found]
    # Last-resort module invocation. "python3" does not exist on Windows, where
    # it is usually a Store alias stub that exits without running anything.
    return [sys.executable or "python3", "-m", "hermes_cli.main"]


def _can_launch_hermes():
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["--version"], cwd=WORKDIR, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=12, encoding="utf-8", errors="replace")
        return proc.returncode == 0, (proc.stdout or proc.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def runtime_kind():
    if RUNTIME == "mock":
        return "mock"
    if RUNTIME == "hermes":
        return "hermes"
    ok, _ = _can_launch_hermes()
    return "hermes" if ok else "mock"


def compose_prompt(message, system):
    """The one turn of text JARVIS sends, identical on both runtimes."""
    if not system:
        return message
    return (f"{system}\n\n## Current user request\n{message}\n\n"
            "Answer the request now. Return only the words JARVIS should say aloud; "
            "never include session IDs, runtime metadata, headings, or process narration.")


def build_command(message, session_id=None, system=None):
    # Hermes chat has no separate --system flag. Put the voice persona and the
    # current request into one explicit turn so the model answers as JARVIS
    # instead of narrating its CLI/runtime. Quiet mode removes the Hermes banner.
    prompt = compose_prompt(message, system)
    cmd = _hermes_base() + ["chat"]
    if not STREAM_CLI:
        cmd.append("-Q")
    cmd += ["-q", prompt, "--source", SOURCE]
    if valid_session(session_id):
        cmd += ["--resume", str(session_id)]
    if PROFILE and PROFILE != "default":
        cmd += ["--profile", PROFILE]
    if MODEL:
        cmd += ["--model", MODEL]
    if TOOLSETS:
        cmd += ["--toolsets", TOOLSETS]
    if REASONING:
        cmd += ["--reasoning", REASONING]
    # Hermes one-shot output is currently plain text; slash commands that need a
    # live TUI are handled in commands.py before we get here. Prompts go to the
    # real agent with normal tool access.
    return cmd


def hermes_tools_snapshot(limit=36):
    """Return a compact list of enabled/visible Hermes toolsets/tools for UI status."""
    try:
        base = _hermes_base()
        proc = subprocess.run(base + ["tools", "list"], cwd=WORKDIR, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=20, encoding="utf-8", errors="replace")
        out = (proc.stdout or proc.stderr or "").strip()
        tools = []
        for line in out.splitlines():
            clean = re.sub(r"\x1b\[[0-9;]*m", "", line).strip()
            if not clean or clean.startswith(("Usage", "─", "=")):
                continue
            if any(tok in clean.lower() for tok in ("enabled", "available", "tool", "browser", "terminal", "file", "google", "github", "web", "voice")):
                tools.append(clean[:80])
            if len(tools) >= limit:
                break
        return tools or [out[:120]] if out else []
    except Exception:
        return []


def run_hermes(message, session_id=None, system=None):
    with EXECUTION_LOCK:
        yield from _run_hermes_locked(message, session_id, system)


def _run_hermes_locked(message, session_id=None, system=None):
    global _ACTIVE_PROC
    started = _mono_ms()
    cmd = build_command(message, session_id, system)
    yield dict(t="status", model=MODEL or "Hermes default", tools=len(hermes_tools_snapshot()),
               mcp=[], permission=PERMISSION, profile=PROFILE, runtime="hermes",
               session_id=session_id)

    child_env = dict(os.environ)
    # Ensure GUI-started shells can still find common user installs.
    #
    # Windows separates PATH with ";" and keeps tools elsewhere. Joining with ":"
    # here handed the Hermes subprocess a corrupted PATH, so everything Hermes
    # shelled out to afterwards (git, node, ffmpeg, ripgrep) failed to resolve
    # while Hermes itself still launched -- a confusing half-working state.
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
        extra = [
            "/opt/homebrew/bin", "/usr/local/bin",
            os.path.join(home, ".local", "bin"),
            os.path.join(home, ".npm-global", "bin"),
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]
    child_env["PATH"] = os.pathsep.join(
        dict.fromkeys([child_env.get("PATH", ""), *extra]))
    # Windows Python defaults to the cp1252 code page, which cannot represent the
    # check marks and emoji Hermes prints. Decoding then raises, the exception is
    # swallowed, and the UI reports an empty tool list. Pin both ends to UTF-8.
    child_env.setdefault("PYTHONIOENCODING", "utf-8")

    try:
        proc = subprocess.Popen(cmd, cwd=WORKDIR, text=True, bufsize=1,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=child_env, encoding="utf-8", errors="replace")
        with _ACTIVE_LOCK:
            _ACTIVE_PROC = proc
    except FileNotFoundError:
        raise RuntimeError("Hermes CLI not found. Set HERMES_CMD to your Hermes executable.")

    q = collections.deque()
    lock = threading.Lock()
    done = threading.Event()
    errbuf = collections.deque(maxlen=120)
    raw = None
    if RAW_LOG:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(os.path.expanduser(RAW_LOG), flags, 0o600)
        os.fchmod(fd, 0o600)
        raw = os.fdopen(fd, "w", encoding="utf-8", errors="replace")
        raw.write("$ " + " ".join(shlex.quote(x) for x in cmd) + "\n\n")
        raw.flush()

    def pump_stdout():
        try:
            for ln in proc.stdout:
                if raw:
                    raw.write("OUT " + ln); raw.flush()
                with lock:
                    q.append(ln)
        finally:
            done.set()

    def pump_stderr():
        try:
            for ln in proc.stderr:
                if raw:
                    raw.write("ERR " + ln); raw.flush()
                errbuf.append(ln.rstrip())
        except Exception:
            pass

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()

    first = True
    last = time.monotonic()
    text_seen = False
    emitted_session = None
    try:
        while not done.is_set() or q:
            line = None
            with lock:
                if q:
                    line = q.popleft()
            if line is None:
                if proc.poll() is not None and done.is_set():
                    break
                if time.monotonic() - last > IDLE_TIMEOUT:
                    proc.kill()
                    err = " | ".join(list(errbuf)[-3:])
                    yield dict(t="error", message=(f"Hermes went quiet for {IDLE_TIMEOUT}s and was stopped. " + err)[:400])
                    return
                time.sleep(0.05)
                continue
            last = time.monotonic()
            clean = _ANSI.sub("", line).strip()
            if not clean:
                continue
            session_match = re.match(r"^session_id:\s*(\S+)\s*$", clean, re.I)
            if session_match:
                candidate = session_match.group(1)
                if valid_session(candidate):
                    emitted_session = candidate
                continue
            # Be defensive when an older Hermes build ignores quiet mode.
            if _CLI_NOISE.match(clean):
                continue
            if first:
                first = False
                yield dict(t="latency", ms=_mono_ms() - started)
            text_seen = True
            yield dict(t="delta", text=clean + "\n")

        rc = proc.wait(timeout=5)
        # Hermes writes its programmatic session_id marker to stderr in quiet
        # mode, so capture it there without exposing it as response text.
        for errline in errbuf:
            session_match = re.match(r"^session_id:\s*(\S+)\s*$", errline.strip(), re.I)
            if session_match and valid_session(session_match.group(1)):
                emitted_session = session_match.group(1)
        if rc != 0:
            err = " | ".join(list(errbuf)[-6:])
            yield dict(t="error", message=(err or f"Hermes exited with code {rc}")[:500])
            return
        if not text_seen:
            yield dict(t="delta", text="Hermes completed without textual output.")
        yield dict(t="complete", session_id=emitted_session or session_id,
                   ms=_mono_ms() - started)
    finally:
        try:
            if raw:
                raw.close()
        except Exception:
            pass
        if proc.poll() is None:
            proc.terminate()
        with _ACTIVE_LOCK:
            if _ACTIVE_PROC is proc:
                _ACTIVE_PROC = None


def run_mock(message, session_id=None, system=None):
    ok, detail = _can_launch_hermes()
    yield dict(t="error", message=("Hermes is not reachable from this dashboard process. "
                                  "Set HERMES_CMD or start from a shell where `hermes` works. "
                                  f"Diagnostic: {detail[:240]}"))


# ── retrieval guard ──────────────────────────────────────────────────────
# The failure this exists for: asked tomorrow's weather, JARVIS answered "99,
# mostly cloudy, no rain" without looking. The real forecast was 96, sunny, 20%
# storms. A retrieved answer and an invented one sound identical, so the user
# cannot tell which he got -- and a rule per topic (weather, then time, then
# prices...) is whack-a-mole.
#
# The guard does not ask the model whether it looked. Tool calls arrive as
# protocol events emitted by the runtime, so they cannot be fabricated. We watch
# those instead.
#
# Questions about the current state of the world -- anything whose answer can
# change without the model knowing.
NEEDS_LIVE_DATA = re.compile(r"""
    \b(?:weather|forecast|temperature|rain|snow|humidity|wind|heat\s+index)\b
  | \b(?:what\s+time|what.s\s+the\s+time|time\s+is\s+it|today.s\s+date|what.s\s+today)\b
  | \b(?:price|cost|quote|stock|ticker|exchange\s+rate)\b
  | \b(?:news|headline|latest|announced|released)\b
  | \b(?:to.?do|task|calendar|schedule|appointment|meeting|inbox|unread)\b
  | \b(?:how\s+many|how\s+much|when\s+is|when.s|who\s+is\s+on|status\s+of)\b
  | \b(?:my|our|casey.s)\s+(?:list|notes?|files?|clients?|accounts?|numbers?|leads?)\b
""", re.I | re.X)

# Tools that constitute actually going and looking. A tool call that is not one
# of these (a scratch calculation, say) does not count as retrieval.
_RETRIEVAL_HINT = re.compile(
    r"web|search|extract|fetch|browse|read|file|terminal|shell|bash|python|"
    r"grep|obsidian|note|todo|kanban|memory|calendar|mail|sql|query", re.I)

# Spoken the instant a lookup is needed, before the model produces anything.
# The tool round trip costs 3-5s; silence for that long reads as a hang, while
# eight words of acknowledgement makes the same wait feel like someone checking.
_LOOKUP_FILLER = ("One second, checking on it, sir. ",)
# Spoken when the first pass answered from memory and we are making it go back.
_RETRY_FILLER = (
    "Still on it, sir. ",
    "One more moment - verifying that properly. ",
    "Bear with me, sir, let me check that properly. ",
)

_FORCE_RETRIEVAL = (
    "\n\nYou answered that from memory without retrieving anything. The answer may "
    "be wrong and must not be given as-is. Use your tools NOW to look up the actual "
    "current facts, then answer from what you retrieved. If a lookup fails, say "
    "plainly that you could not retrieve it -- do not estimate."
)


def needs_live_data(message):
    return bool(NEEDS_LIVE_DATA.search(message or ""))


def _is_retrieval(tool_name):
    return bool(_RETRIEVAL_HINT.search(str(tool_name or "")))


def _acp_agent():
    import acp_client
    return acp_client.get_agent(_hermes_base(), WORKDIR)


def warm():
    """Boot the resident agent ahead of the first question. Best effort."""
    if not (ACP_ENABLED and runtime_kind() == "hermes"):
        return False
    try:
        return _acp_agent().start()
    except Exception:  # noqa: BLE001
        return False


def run_acp(message, session_id=None, system=None):
    """Stream one turn through the resident process.

    The handshake happens BEFORE anything is yielded, so a failure here can
    still fall back to spawning the CLI with the caller none the wiser. Once
    the first event is out we are committed -- a mid-stream failure surfaces
    as an error, exactly as a crashed subprocess would.
    """
    agent = _acp_agent()
    if not agent.start():                     # raises or returns False; no events yet
        raise RuntimeError("ACP session unavailable")
    # The HUD clears SESSION["id"] for /new. With a resident process that has to
    # mean "open a fresh session", or the conversation grows all day and /new
    # quietly does nothing.
    if agent.session_id and not session_id:
        agent.new_session()
    yield dict(t="status", model=MODEL or "Hermes default", tools=0, mcp=[],
               permission=PERMISSION, profile=PROFILE, runtime="hermes-acp",
               session_id=agent.session_id)

    prompt = compose_prompt(message, system)
    if not needs_live_data(message):
        yield from agent.prompt(prompt)
        return

    # Live-data question. Say so immediately -- this is spoken while the tool
    # round trip happens, so the pause is filled rather than silent.
    # "say", not "delta": the speech queue buffers short fragments until they
    # reach a sentence worth synthesising, which is right for an answer and
    # exactly wrong here -- it held "One second, checking." until the lookup
    # finished and then said it in the same breath as the result.
    yield dict(t="say", text=random.choice(_LOOKUP_FILLER))

    # Hold the rest until we have seen a real retrieval; text arriving with no
    # tool call means it answered from memory.
    # A lookup only counts once it COMPLETES. Naming a tool proves nothing -- a
    # `python` call that imports a module and fetches nothing would otherwise
    # score as "he looked it up". Started-but-unfinished is not evidence.
    held, retrieved, released = [], False, False
    pending = False
    for ev in agent.prompt(prompt):
        if ev.get("t") == "tool":
            if ev.get("phase") == "use":
                pending = _is_retrieval(ev.get("name"))
            elif ev.get("phase") == "result" and pending and ev.get("ok"):
                retrieved = True
                pending = False
        if not retrieved and ev.get("t") in ("delta", "complete"):
            held.append(ev)            # might be an invented answer -- do not speak yet
            continue
        if held and retrieved and not released:
            released = True
            for h in held:             # it did look; release what we were holding
                yield h
            held = []
        yield ev

    if retrieved:
        for h in held:
            yield h
        return

    # Nothing was retrieved. Discard the unspoken answer and make it go look.
    yield dict(t="note", message="answered from memory - forcing a lookup")
    yield dict(t="say", text=random.choice(_RETRY_FILLER))
    pending = False
    for ev in agent.prompt(prompt + _FORCE_RETRIEVAL):
        if ev.get("t") == "tool":
            if ev.get("phase") == "use":
                pending = _is_retrieval(ev.get("name"))
            elif ev.get("phase") == "result" and pending and ev.get("ok"):
                retrieved = True
                pending = False
        yield ev
    if not retrieved:
        yield dict(t="note", message="RETRY ALSO DID NOT RETRIEVE - answer is unverified")


def run(message, session_id=None, system=None):
    if runtime_kind() != "hermes":
        yield from run_mock(message, session_id, system)
        return
    if ACP_ENABLED:
        emitted = False
        try:
            for ev in run_acp(message, session_id, system):
                emitted = True
                yield ev
            return
        except Exception as e:  # noqa: BLE001
            if emitted:
                # Already streamed part of an answer -- and on voice, already
                # SPOKE part of it. Re-running through the subprocess would say
                # the whole thing a second time. Fail this turn instead.
                yield dict(t="error", message=f"resident agent dropped mid-answer: {e}")
                return
            yield dict(t="note", message=f"resident agent unavailable ({e}); using subprocess")
    try:
        yield from run_hermes(message, session_id, system)
    except Exception as e:  # noqa: BLE001
        yield dict(t="error", message=f"could not start Hermes core: {e}")
