---
title: The header branch keeps its tail
kind: fix
area: app
---
Long branch names in the workspace header no longer get cut off at the end. The branch uses the
free room in the header, and when it really is too long the middle is shortened so the start and
the end both stay visible.
