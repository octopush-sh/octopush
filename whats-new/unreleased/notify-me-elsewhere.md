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
    caption: Paste a Slack or Discord incoming webhook URL, or any https endpoint that accepts JSON.
    action: none
  - target: settings-notify-elsewhere-test
    caption: Send a test to check it arrives.
    action: none
  - target: settings-notify-elsewhere-payload
    caption: See the message's fields. A fixed label, the project's name and the mission's title, nothing more.
    action: click
---
Turn on **Notify me elsewhere** in Settings › General to get a webhook message when a crew needs your
decision, a crew run fails, or a Routine finishes, also from crews that keep working after you quit. It
carries a fixed label, the project's name and the mission's title (the start of its task), never code,
diffs, questions or agent output.
