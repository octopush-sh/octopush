---
title: Go to definition jumps to names, not the types before them
kind: fix
area: app
---
⌘-click in Review no longer treats the type in front of a declaration as the thing declared:
`Integer` no longer jumps to a method that returns `Integer`. Keywords like `const` or `int`
skip the workspace search and say so, and Java fields, annotated methods, C# properties, C typedefs and
declarations split after their return type now resolve.
