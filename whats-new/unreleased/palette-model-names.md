---
title: Model names stay whole in the command palette
kind: fix
area: app
steps:
  - open: palette
    target: palette-models
    caption: Each model shows its full name; a long provider name shortens first.
---
The command palette's Models rows now show just the model's name, without the extra
"Model:" prefix. When a row is tight, the provider name shortens before the model name does,
and you can hover it to see the whole thing.
