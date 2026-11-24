---
title: Talk checks attached context for secrets before sending
kind: improvement
area: app
steps:
  - open: mode/talk
    target: talk-composer-input
    caption: Files, ranges, @session output and @diff are checked before a message goes; a diff file by file, so an untracked .env counts.
  - target: talk-context-chip
    caption: A block with a possible secret, or one that couldn't be checked, asks first. Leave it out sends the rest; Escape keeps the draft.
---
Before a Talk message is sent, the secret guard now reads every `@` block it attaches, a diff file by file, and asks first when one holds what looks like a credential or can't be checked. A message attaches up to 10 mentions, a line range reads only its lines, and paths with spaces or non-ASCII names work.
