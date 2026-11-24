---
title: A hook-paused stage names the call it paused
kind: improvement
area: app
steps:
  - open: mode/direct
    target: direct-halt-cause
    caption: The halt names the paused call and its command, with any secret redacted.
    action: none
  - open: mode/direct
    target: direct-halt-drop-call
    caption: If the tool is gone, drop the call and let Claude carry on without it.
    action: none
---
When a hook pauses a tool call, the halt and the journal now show which call it was, such as
`Bash · npm publish --tag beta`. If a resumed session is waiting on a tool that's no longer
available, **Drop the call and continue** resumes it without that call.
