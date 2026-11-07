---
title: The welcome screen leads with one action
kind: improvement
area: app
scenario: empty
steps:
  - target: genesis-key-save
    caption: Paste your Anthropic key here — no separate button to press.
    action: none
  - target: genesis-begin
    caption: One action leads. It lights up once there is a brief and a key.
    action: none
  - target: welcome-new-study
    caption: The other routes share one quiet line underneath.
    action: none
---
The welcome screen now has one primary action, **Set a crew on it**. It saves your API key as
well, and fills in brass once a brief and a key are there. Thinking it through first, starting a
new study and opening a folder from disk now share one quiet line under it.
