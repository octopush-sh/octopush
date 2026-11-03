## Octopush 0.4.99

### Features

- **Find your way back after following a definition** — The editor now keeps a trail of your jumps: go to definition, ⌘P, go to line and search results. Press **⌃−** (Ctrl+Alt+− on Windows and Linux) to go back, with the selection and scroll restored, and **⌃⇧−** to go forward. **⌥F7** / **⇧⌥F7** step through the changes in a file, and typing in large files is lighter.

### Fixes

- **Back returns the caret to where you ⌘-clicked** — After a ⌘-click to a definition, **⌃−** now puts the caret on the word you clicked, not where it was before you scrolled. Declined large-file opens and reopening the current file no longer leave empty stops, and a symbol with very many matches now resolves to the same definition every time.
