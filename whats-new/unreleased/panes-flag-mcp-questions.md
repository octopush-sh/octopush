---
title: Panes now flag MCP questions too
kind: improvement
area: app
highlight: true
steps:
  - open: mode/run
    target: run-pane-waiting
    caption: When an MCP server asks you something, the pane says it's waiting on your input.
    action: none
---
When an MCP server asks for your input, through a form or a link, the Run pane now reads **waiting on your input**, as it does for a permission prompt. Worktrees that already have the hooks pick this up the next time Octopush starts.
