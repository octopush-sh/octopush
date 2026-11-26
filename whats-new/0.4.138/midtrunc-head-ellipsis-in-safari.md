---
title: Shortened paths keep their ellipsis in Safari's engine
kind: fix
area: app
---
A long path or name shortened in the middle, such as a Review file header's `src-tauri/…/sync.rs`, now always shows its ellipsis. It is never cut off without one after Octopush measures the row.
