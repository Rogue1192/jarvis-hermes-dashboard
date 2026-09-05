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
