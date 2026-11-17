---
title: Crew stages on gateway models compact before they fill
kind: fix
area: app
---
Crew stages on gateway models compact before they fill instead of failing every turn. When a
Claude Code stage runs a model from your own provider entry with a smaller context window,
Octopush now tells Claude Code that window.
