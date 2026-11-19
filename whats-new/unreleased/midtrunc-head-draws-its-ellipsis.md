---
title: Shortened names draw a real ellipsis on macOS
kind: fix
area: app
---
A long name shortened in the middle (the project name in the top bar, rail rows, branches, file paths) now ends its first half with the text's own ellipsis. Before, macOS clipped the text and drew the `…` separately. The `…` still sits right against the end of the name.
