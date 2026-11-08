## Octopush 0.4.113

### Improvements

- **The welcome screen leads with one action** — The welcome screen now has one primary action, **Set a crew on it**. It saves your API key as well, and fills in brass once a brief and a key are there. Thinking it through first, starting a new study and opening a folder from disk now share one quiet line under it.

### Fixes

- **Readiness and Connect checks stay small and clean up** — A CLI that prints without end during a Readiness or Connect check no longer grows Octopush's memory, and anything a checked command leaves running in its process group is stopped when it exits.
- **An old Claude sign-in end clears once stages use a key** — When Claude Code stages run on an API key (for example `ANTHROPIC_API_KEY` in your login shell), the next stage now clears the stored Claude sign-in end, so Readiness, Mission Control and Routines no longer show "Sign-in ended" for a sign-in your stages don't use.
- **The Claude sign-in warning shows even with an API key** — An Anthropic key in Settings › Models doesn't sign Claude Code in, so Readiness, Mission Control and Routines now show when your Claude sign-in ends even when that key is set.
- **Quitting during Connect gives the add a moment to finish** — Quitting while **Connect to Claude Code** is under way now gives it up to 2 seconds to add the server back, including just after the previous registration was removed, so an add that completes in that time isn't cut off.
- **A starting stage says it's waiting in one place** — In Direct, a stage that just started no longer shows two waiting lines in the focus pane. The Thinking… octopus stays there on its own, and the stage's card in the run track reads "waiting for first tool call" until the first tool call arrives.
