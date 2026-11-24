---
title: Octopush names Claude Code 2.1.329 as a release to skip
kind: improvement
area: app
steps:
  - open: settings/general
    target: settings-readiness-card
    caption: Readiness warns when this Mac has Claude Code 2.1.329.
    action: none
  - open: mode/direct
    target: direct-launcher-known-bad
    caption: The launcher warns only when a crew stage runs a gateway model.
    action: none
---
Claude Code 2.1.329 dropped the retry that gateway models need when a `max_tokens` error names a
lower limit, and 2.1.330 put it back. Readiness and the Direct launcher now warn when this Mac
has that release. A gateway stage that fails this way names the release and asks you to update.
