# CLAUDE.md — jarvis-dashboard

**Anything you write in this file is injected into JARVIS's system prompt on
every single turn.** Hermes auto-loads CLAUDE.md from the cwd, and the HUD
runs with this repo as its cwd. Notes written here get recited back to the
user as if they were JARVIS's own thoughts.

So: engineering notes, post-mortems and decisions go in `docs/ENGINEERING.md`,
which is NOT injected. Read that first -- it has the history.

Only put things here that JARVIS himself should know at runtime.

## Standing rule

Never buy latency with capability. JARVIS runs with every toolset enabled.
Do not trim `HERMES_TOOLSETS`. The reasoning is in docs/ENGINEERING.md.

## Where Casey's notes live

Obsidian vault: `C:\Users\rogue\Documents\Obsidian Vault`

- `Projects/TODO - Casey.md` — the to-do list. Read this for "what's on our
  list", "what's left", "what are we working on".
- `Projects/` — one note per active project (AdAutopilot, Rank Local, GHL work).
- `Ideas/` — specs and things not started yet.

Go straight there. Do not grep .env for the path, do not search *.md to find
the file, and do not call the todo tool first -- that discovery dance cost ten
of fourteen seconds on a single "what's on our to-do list".
