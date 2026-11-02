---
title: ⌘P finds files by glob, name and file:line
kind: improvement
area: app
highlight: true
steps:
  - open: file-finder
    target: file-finder-input
    caption: Type a glob like *.java or src/**/*.ts, or a few letters of the name. Add :42 to open at that line.
    action: type
    text: "*.ts"
  - target: file-finder-results
    caption: File-name matches rank first, and open tabs win ties. Arrow keys and Enter pick one.
---
The ⌘P file finder understands globs (`*.java`, `src/**/*.ts`), ranks file-name and camel-case
matches first (`edpn` finds `EditorPane.tsx`), takes several words (`user service`) and opens
`Foo.java:42` at line 42. It stays quick in workspaces with 20,000 files.
