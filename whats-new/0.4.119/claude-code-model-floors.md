---
title: The launcher says when a model needs a newer Claude Code
kind: improvement
area: app
steps:
  - open: mode/direct
    target: direct-launcher-model-floor
    caption: A stage on Fable 5.2 needs Claude Code 2.1.321 or newer. Update before the run, or begin anyway.
---
The Direct launcher now warns when a Claude Code stage, or its escalation, uses a model this Mac's CLI is too old to start, such as Fable 5.2 before 2.1.321. The update note also recommends 2.1.321, which fixes a read-only Bash command running outside the sandbox without a prompt.
