---
title: See what each Talk turn changed, and review it alone
kind: feature
area: app
highlight: true
scenario: default
steps:
  - open: mode/talk
    target: talk-turn-changes
    caption: A turn that changed files ends with what it changed, shell and sub-agent edits included.
  - target: talk-turn-changes-review
    caption: Review these changes opens just this turn's diff in Review, apart from earlier turns.
  - open: mode/review
    target: review-diff-turn
    caption: This turn sits beside Working tree. Press x on a hunk to revert it in your files.
---
A Talk turn that changed files now ends with a row: how many files, the lines added and removed,
and their names. **Review these changes** opens Review on that turn's diff alone; `x` reverts a
hunk in the working tree when it still applies cleanly. **Rewind files to here** is one click away.
