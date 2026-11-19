---
title: No false "ran on" note for Bedrock or Foundry ids
kind: fix
area: app
---
A Direct stage whose Claude Code session reported a Bedrock inference-profile ARN or a Microsoft Foundry deployment name was flagged as running on another model, and its cost went unpriced. It now shows no note and keeps its cost on the model it asked for.
