# JARVIS engineering notes

Moved out of CLAUDE.md on 2026-09-04. Hermes auto-injects CLAUDE.md from the
cwd into the system prompt (agent_init.py, skip_context_files docstring), and
the HUD's cwd IS this repo -- so every note written here was being fed to
JARVIS on every voice turn. He started answering latency questions by
reciting these notes back, which is both wrong and a direct violation of the
persona rule against narrating his own machinery.

Keep engineering history in THIS file. Keep CLAUDE.md short.

---

# JARVIS dashboard — orientation for a fresh session

Read this before touching anything. It exists because a session that guesses at
what this project is wastes an hour and gives confidently wrong answers.

## What this is

A local voice HUD for **Hermes Agent**. It is a face on Hermes, not a second
agent: `runtime.py` shells out to the Hermes CLI (`HERMES_CMD` in `.env`) with a
configured profile, so it inherits that profile's tools, skills, memory, MCP
servers and browser automation. It is not Claude Code and must never describe
itself as Claude, Hermes, or a CLI tool to the user — see `persona.md`.

Runs local-only on `127.0.0.1:8730`, launched by `Start JARVIS.bat` /
`JARVIS (background).vbs` on Windows, or `start.sh` elsewhere.

## Not to be confused with

`C:\Users\rogue\AppData\Local\hermes` — the Hermes install this dashboard drives.
That tree has its own `config.yaml`, its own `tools/wake_word.py`, and its own
"hey hermes" wake word, none of which this project uses. Answering a question
about **this** dashboard from files in that tree produces nonsense. The wake word
that actually runs on this machine is the one in `wake.py` here.

## Layout

| File | What it owns |
|---|---|
| `server.py` | HTTP server, static UI, `/api/*` endpoints, `.env` loading |
| `runtime.py` | Hermes subprocess, session continuity across voice turns |
| `commands.py` | Local command matrix; unknown slash commands go to Hermes |
| `voice.py` | ElevenLabs STT/TTS, with browser Web Speech as fallback |
| `wake.py` | Offline wake word (openWakeWord), `/api/wake` flag the UI polls |
| `persona.md` | The assistant's identity and speaking rules — the name lives here |
| `ui/` | `index.html`, `app.js`, `styles.css` — the HUD itself |

## The wake word

`wake.py` runs **openWakeWord** with the pretrained **`hey_jarvis`** model. The
phrase is the model, not a string: there is no "set the phrase" setting, and
changing a label changes nothing about what it hears.

- Bundled/pretrained phrases available: `alexa`, `hey_mycroft`, `hey_jarvis`,
  `hey_rhasspy` (plus `timer`/`weather`, which are not wake words). Switching
  between these is a two-line change in `_load_model()`.
- Any other phrase needs a trained `.onnx` (openWakeWord's training notebook) or
  a different engine (Picovoice `.ppn`, sherpa-onnx open-vocabulary).
- `_load_model()` deliberately has **no** "load every bundled model" fallback:
  that would score `alexa`, `timer` and `weather` too, and any of them firing
  looks exactly like a broken wake word. Do not add one back.
- Env knobs only: `JARVIS_WAKE` (0 disables), `JARVIS_WAKE_THRESHOLD`,
  `JARVIS_WAKE_DEVICE`.

Flow: `wake.py` detects → raises a one-shot flag → browser polls `GET /api/wake`
→ during a conversation the browser `POST`s to mute the detector so JARVIS never
wakes himself on his own voice.

## Renaming the assistant

The name is in ~130 places across ~20 files, but they are not equal:

1. `persona.md` — the identity. This is the one that changes what it *is*.
2. `ui/index.html`, `ui/app.js` — what the user sees.
3. Launchers, `README.md`, `install.sh` — cosmetic.
4. `JARVIS_*` env var names — touching these means editing the private `.env`
   too, and breaks a running setup for no user-visible gain. Leave them.

The wake word is a separate decision from the name: the assistant can be called
anything while still answering to "hey jarvis" until a model for the new phrase
exists.

## Conventions

- Comments explain **why**, not what. Several in `wake.py` and `server.py` record
  a real failure (Windows cp1252 killing startup; VAD gating so keyboard clatter
  cannot score). Keep that style; do not strip those.
- `.env` holds live ElevenLabs keys and is gitignored. Never print, echo or
  commit its values.
- Windows is the deployment target. Watch encoding and path assumptions.

## Never buy latency with capability

Sept 4 2026. Chasing a 17s voice response, I set `HERMES_TOOLSETS` to a trimmed
list — dropping browser, terminal, code execution, vision, image/video gen,
computer use, cronjob, delegation. It saved roughly a second. Within the hour
Casey asked JARVIS the time and got a confident guess, because reading a clock
runs through the terminal toolset. I listed the dropped toolsets when I made the
change, which is not the same as saying "it will now tell you it can't do
things." He was right to be furious.

The rule, in his words: he wants it to do every goddamn thing it's supposed to
do — talk, pull whatever he asks for, drive the browser, spin up stealth/incognito
sessions. Hamstringing it is never the answer. A fast assistant that answers
"I can't do that" is worthless; a slower one that does the job is not.

So: **JARVIS runs with every toolset config.yaml enables. Do not trim it.**
`HERMES_TOOLSETS` stays commented out in `.env`.

Latency work that is allowed — none of it removes an ability:
  - streaming sentence-by-sentence TTS (done; 11s -> 6.5s, the real win)
  - prompt_caching cache_ttl 1h (done)
  - model / reasoning depth (a quality dial, not a capability one — his call)
  - killing the per-question cold start: every voice turn spawns a brand-new
    `hermes.exe`. A warm resident process is the remaining big lever and costs
    no capability. This is where to go next, NOT another trim.

## ACP resident agent — built, benched, NOT enabled

Sept 4 2026. To kill the per-question cold start, `acp_client.py` drives a
resident `hermes acp` process (JSON-RPC over stdio) instead of spawning
`hermes.exe` per turn. It works and it is fast:

    handshake   1.92s   (once, at HUD launch)
    question    1.62s to first word, 2.00s total
    prompt cache 19511/19513 tokens read from cache

But the terminal toolset hangs under ACP on this machine. Same request, same
box, hermes 0.20.6:

    hermes chat -Q -q "run a shell command that prints pong"   -> "It printed: pong"
    ACP session/prompt, same question                          -> hangs forever

Both hang at the identical line and never emit another frame:

    tools.terminal_tool: Creating new local environment for task session:...

It is not the command (`echo pong` hangs exactly like the PowerShell Get-Date
one) and not the permission handshake (no session/request_permission is ever
sent). It hangs constructing LocalEnvironment. Ruled out: the parent-directory
walk in tools/environments/local.py has a correct
`next_parent == parent: break`. Best remaining theory, unproven: under ACP the
process's stdin IS the JSON-RPC pipe, and the environment's shell inherits it.

So `JARVIS_ACP` stays unset. The code is committed and inert -- if a later
Hermes release fixes terminal-under-ACP, set `JARVIS_ACP=1` and re-run
`acp_smoke.py`; if question 2 prints "pong", it is ready.

Do NOT enable it to get the 4 seconds. That is the trade this file already
forbids.

## RESOLVED: the ACP terminal hang was one missing `stdin=`

2026-09-04, late. Root cause found with a py-spy dump of the hung process:

    _wait_for_tstate_lock -> join -> _communicate -> communicate -> run
      _bash_starts        (tools/environments/local.py:1057)
      _find_bash          (tools/environments/local.py:924)
      init_session        (tools/environments/base.py:841)
      _create_environment (tools/terminal_tool.py:1982)

It was never running the user's command. It hung *probing for bash* at startup.
That `subprocess.run(...)` uses capture_output=True but sets no `stdin`, so the
probe inherits the parent's stdin. Under `hermes acp` the parent's stdin IS the
JSON-RPC pipe, held open by the client forever, and communicate() never returns
-- not even the timeout=15 rescues it, the signature of a descendant keeping the
pipes open after the child is killed.

Fix, applied locally to hermes-agent/tools/environments/local.py:

    stdin=subprocess.DEVNULL,

Result: terminal works under ACP, and ACP streams tokens
("\n\nIt", " printed `", "pong`.") which the CLI with -Q never could.

    handshake  2.44s (once, at HUD launch)
    question 1 1.62s to first word
    question 2 3.02s to first word, INCLUDING a shell command round trip

This affects any ACP client, since ACP always uses stdin as its transport.
Worth reporting upstream to Nous.

WARNING: `hermes update` overwrites local.py and reverts this. If the terminal
tool starts hanging under ACP again, re-apply the one-liner. Backup of the
original is beside it as local.py.bak.*
