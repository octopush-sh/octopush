---
title: A warning before a crew's model retires
kind: improvement
area: app
steps:
  - open: mode/direct
    target: direct-launcher-model-retirement
    caption: A crew on a model that retires within 30 days says so here, with the switch to its replacement.
    action: none
  - open: settings/general
    target: settings-readiness-models
    caption: Readiness lists every crew and Routine that will fail once that model retires.
    action: none
  - open: settings/routines
    target: routines-model-retirement
    caption: A Routine on a retiring model gets the same line, so an overnight run doesn't fail without warning.
    action: none
---
When a crew uses a model with a published retirement date (today Sonnet 4.5, on Nov 30), the Direct
launcher, Readiness and Settings › Routines warn you in its last 30 days and after it. **Switch to
Sonnet 5.5** moves only that crew, and only after you confirm.
