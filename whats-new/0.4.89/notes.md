## Octopush 0.4.89

### Features

- **Update alert with release notes, and a Beta channel** — When a new version is out, Octopush now shows its release notes as soon as you open it — install, decide later, or skip that version. Pick **Beta** in Settings › About to get nightly builds first.
- **See what each update brought, with a tour** — After an update, a **What's new** dialog walks through the changes one tip at a time. Tips with a demo have a short clip, and **Show me** points at the real controls.

### Improvements

- **Agents' file edits stay inside their workspace** — With Claude Code 2.1.314 or later, Claude Code's file-editing tools refuse writes outside the stage's workspace, even with permissions bypassed. Shell commands aren't covered unless the mission runs sandboxed. A refused edit shows as a failed tool call in the stage journal.

### Maintenance

Design rules: upright serif; reviewer design checklist; pin ubuntu-24.04 (#303) · chore(deps): Bump the actions group across 1 directory with 2 updates (#252) · Nightly cycle: schedules off the hour; ignore non-verdict CI runs (#302) · publish-build: shorten long titles instead of rejecting the work (#297) · publish-build: fix variable init; end-to-end test (#296) · octo-check: work inside the agent's rebuilt environment (#285) · builder: skip website/API ideas; digest instructions match Actions (#284) · ideas: keep a night's research when one entry is bad (#275) · agents: write permissions as Edit rules; print denied tool calls (#274) · ideas: skip sibling repos the workflow token can't read (#273) · Routines: errors as annotations; tolerate cross-repo CI reads (#272) · Nightly cycle on GitHub Actions: agents without credentials (#271) · What's new: automatic demo clip recorder (real frontend, mocked IPC) (#268) · Release: beta-first channel, promotion workflow, real notes, nightly beta routine (#267) · Routines: nightly builders, independent review + guarded auto-merge, ideas digest, answers (#265) · Adopt VISION.md: direction and rules for autonomous agents (#246) · Routines: Claude Code release watch, backlog → PR, dependency triage, weekly report (#249) · Privacy: cloud sync is opt-in (off by default); exact outbound-traffic copy (#248) · Pricing: current models, corrected prices, unknown models are unpriced (not $0) (#250) · Tests: Claude Code contract fixtures for every fragile surface (#251) · CI: PR checks, Dependabot, AGENTS.md mirror (#245)
