"""Standalone check of the resident-agent path. Touches nothing in the HUD.

    python acp_smoke.py            # one warm-up + two timed questions

Prints how long the one-time handshake costs and how long each question takes
once the process is warm. The second question is the number that matters --
that is what every voice turn will feel like.
"""
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).parent))

for line in (pathlib.Path(__file__).parent / ".env").read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

# Fail fast and loud in the smoke test -- a 300s hang tells you nothing.
os.environ["JARVIS_ACP_TRACE"] = os.environ.get("JARVIS_ACP_TRACE", "1")
os.environ["JARVIS_ACP_TURN_TIMEOUT"] = os.environ.get("JARVIS_ACP_TURN_TIMEOUT", "75")

import runtime          # noqa: E402
import acp_client       # noqa: E402

print(f"hermes  : {' '.join(runtime._hermes_base())}")
print(f"workdir : {runtime.WORKDIR}\n")

agent = acp_client.get_agent(runtime._hermes_base(), runtime.WORKDIR)

# Ctrl-C used to leave a `hermes acp` process running forever. Reap it on
# ANY exit -- clean finish, exception, or interrupt.
import atexit
atexit.register(lambda: agent.stop())

t0 = time.monotonic()
try:
    ok = agent.start()
except Exception as e:                                    # noqa: BLE001
    print(f"FAILED during handshake: {e}")
    print("stderr tail:\n" + (agent.stderr_tail() or "(empty)"))
    raise SystemExit(1)
print(f"handshake      : {time.monotonic()-t0:5.2f}s   session={agent.session_id}")
if not ok:
    print("no session id -- stopping")
    raise SystemExit(1)

for n, q in enumerate(["Reply with the single word: ready",
                         "Run one shell command that prints the word pong, then tell me what it printed."], 1):
    t = time.monotonic()
    first = None
    out = []
    try:
        for ev in agent.prompt(q):
            if ev["t"] == "delta":
                if first is None:
                    first = time.monotonic() - t
                out.append(ev["text"])
            elif ev["t"] == "tool":
                if ev.get("phase") == "use":
                    print(f"                 tool: {ev.get('name')}")
    except Exception as e:                                # noqa: BLE001
        print(f"question {n} FAILED: {e}")
        print("stderr tail:\n" + (agent.stderr_tail() or "(empty)"))
        raise SystemExit(1)
    total = time.monotonic() - t
    fw = f"{first:.2f}s" if first else " n/a "
    print(f"question {n}     : first word {fw}   total {total:5.2f}s")
    print(f"                 {''.join(out).strip()[:160]}\n")

agent.stop()
print("done -- resident process stopped.")
