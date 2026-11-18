---
title: Crews wait out your Claude plan limit and resume
kind: feature
area: app
highlight: true
steps:
  - target: direct-plan-wait
    caption: A stage that hits your Claude plan's limit is paused, not failed. It keeps its work and resumes on its own when the window resets.
    action: none
  - target: direct-plan-wait-cancel
    caption: Resume now, or keep it parked until you resume it yourself.
    action: none
---
When a Claude Code stage hits your Claude plan's 5-hour or weekly limit, the run now pauses at the stage boundary and resumes the same session after the window resets, even with Octopush closed for detached runs. Mission Control shows it in flight as `plan limit · resumes 19:40`. Routines skip a window while the plan is at its limit.
