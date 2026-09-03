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
