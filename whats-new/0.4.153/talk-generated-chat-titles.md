---
title: Talk chats get short titles after the first answer
kind: improvement
area: app
steps:
  - open: mode/talk
    target: companion-chats-list
    caption: After its first answer, a chat gets a short title from your provider's fast tier, led by its ticket key when it names one.
  - target: companion-chat-regenerate-title
    caption: Regenerate title asks again. A title you set is never replaced on its own.
---
After its first answer, a Talk chat is titled in a few words by the fast tier of the provider it already uses, led by its
ticket key when it names one, and billed to the chat. Until then, and whenever no title comes back, the title reads the
message without skills, mentions or long URLs.
