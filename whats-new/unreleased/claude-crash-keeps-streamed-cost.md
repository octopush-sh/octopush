---
title: A Claude stage that crashes keeps its estimated cost
kind: fix
area: app
---
When Claude Code exited without finishing a Direct stage, the stage was recorded as free. It now keeps the cost estimated from what it streamed, priced per model, so the run ledger and your budget count it.
