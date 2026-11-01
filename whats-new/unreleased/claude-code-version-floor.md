---
title: Octopush tells you when Claude Code needs an update
kind: improvement
area: app
highlight: true
steps:
  - open: settings/integrations
    target: settings-claude-code-card
    caption: The Claude Code card shows the CLI version you have installed.
  - target: settings-claude-cli-version
    caption: Older than the version Octopush is tested with? An amber row says which version to update to, and why.
---
Octopush now reads your Claude Code CLI version. If it is older than the version Octopush is
tested with, Settings › Integrations and the Direct launcher show an amber **Update Claude Code**
note: older releases can record wrong token usage and skip sandbox rules. Runs still start.
