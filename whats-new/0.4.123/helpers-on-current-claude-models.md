---
title: Drafting commits and PRs now uses current Claude models
kind: improvement
area: app
steps:
  - open: mode/review
    target: review-open-pr
    caption: Open a pull request; the draft is written by Sonnet 5.5 now.
    action: click
  - target: pr-composer-draft-note
    caption: The note names the model that drafted it and what it cost.
    action: none
---
Commit and PR drafts, AI review and new builder stages default to Sonnet 5.5, and the project
rename uses Haiku 5.5, so they cost less. Built-in crews on a fresh install use them too; crews
you already have keep their models.
