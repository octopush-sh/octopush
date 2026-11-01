---
title: 1-hour prompt-cache writes are priced correctly
kind: fix
area: app
---
Claude Code writes to the 1-hour prompt cache now cost 2× the model's input price, as Anthropic
bills them, instead of the 5-minute rate. Run spend from transcripts and stages is no longer
under-counted, and savings are no longer overstated.
