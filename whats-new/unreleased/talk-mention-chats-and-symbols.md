---
title: "@ can name an earlier conversation or a definition"
kind: feature
area: app
scenario: talk-mention-chats
steps:
  - open: mode/talk
    target: talk-composer-input
    caption: "Type @chat: to bring in another conversation of this workspace."
    action: type
    text: "@chat:"
  - target: talk-mention-chats
    caption: It arrives as its summary when it has one, else its asks and last answer, checked for secrets.
  - target: talk-composer-input
    caption: Type @ and a name to find where the workspace defines it.
    action: type
    text: "@parseToken"
  - target: talk-mention-symbols
    caption: Choose a definition to attach its lines as a range.
---
In Talk, `@chat:` attaches another conversation of the same workspace: its summary when it has one, otherwise its asks and last answer, capped at 64k and checked for secrets. `@` followed by a name also lists where the workspace defines it, and choosing one attaches those lines.
