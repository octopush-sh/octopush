---
title: Sandbox write roots are harder to replace
kind: improvement
area: app
highlight: false
---
In a sandboxed mission, stages can still write inside the temp folders, `~/.claude` and `~/.cache`, but can no longer remove, rename or relink those folders themselves. Before each launch Octopush checks them and leaves out any that points somewhere it shouldn't, such as your home folder.
