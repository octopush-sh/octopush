---
title: ⌘P globs take braces and escapes
kind: improvement
area: app
highlight: true
steps:
  - open: file-finder
    target: file-finder-input
    caption: Braces pick between alternatives, so *.{ts,tsx} finds both kinds of file.
    action: type
    text: "*.{ts,tsx}"
  - target: file-finder-results
    caption: Every .ts and .tsx file in the workspace. A backslash makes the next character literal.
---
⌘P globs now expand braces (`*.{ts,tsx}`) and take `\` escapes (`\*.ts`), and `?` matches a
whole emoji. A glob longer than 256 characters is matched as plain fuzzy text, so a pasted
pattern can't stall the finder.
