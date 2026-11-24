---
title: Hear from your crews when you're away from the Mac
kind: feature
area: app
steps:
  - open: settings/general
    target: settings-notify-elsewhere
    caption: Notify me elsewhere is off until you turn it on.
    action: none
  - target: settings-notify-elsewhere-url
    caption: Paste an ntfy, Slack or Discord webhook URL, or any https URL.
    action: none
  - target: settings-notify-elsewhere-test
    caption: Send a test to check it arrives.
    action: none
  - target: settings-notify-elsewhere-payload
    caption: See the exact message. It carries a fixed label, the mission and the project, nothing else.
    action: click
---
Turn on **Notify me elsewhere** in Settings › General to get a webhook message when a crew waits at a
gate or on a question, a crew run fails, or a Routine finishes, also from crews that keep working after
you quit. It sends the mission and project names only, never code, diffs, prompts or questions.
