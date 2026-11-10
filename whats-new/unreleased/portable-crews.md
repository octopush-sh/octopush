---
title: Share a crew as a file, and import one after a review
kind: feature
area: app
highlight: true
steps:
  - open: mode/direct
    target: direct-launcher-import-crew
    caption: Import a .octocrew.json crew here, or drop the file on the launcher.
    action: none
  - open: palette
    target: palette-import-crew
    caption: The palette has it too. You review every stage before anything is saved.
    action: none
---
Export a pipeline and its custom roles as a `.octocrew.json` file from the builder, or right-click
its ticket. Importing one shows each stage's tools (or the full shell a CLI stage gets), loops,
escalation, instructions and models first, and never starts a run. Crews committed under `.octopush/crews/` appear in the launcher, ready to fork.
