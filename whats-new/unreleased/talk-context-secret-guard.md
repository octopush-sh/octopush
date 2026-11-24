---
title: Talk checks attached context for secrets before sending
kind: improvement
area: app
steps:
  - open: mode/talk
    target: talk-composer-input
    caption: Files, ranges, @session output and @diff are checked for credentials before a message goes.
  - target: talk-context-chip
    caption: A block that holds a possible secret asks first; Leave it out sends the message without it.
---
Before a Talk message is sent, the secret guard now reads every `@` block it attaches and asks first when one holds what looks like a credential. A message attaches up to 10 mentions, a line range reads only its lines, and paths with spaces or non-ASCII names work.
