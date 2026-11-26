---
title: MCP results in Talk stay small
kind: fix
area: app
---
An MCP tool that returns an image or a file no longer pours its base64 into the conversation: the
tool card and the model see a short note such as "[image omitted: image/png, 48 KB]". Very long MCP
results are trimmed for the model, which can still read them in full, and MCP tools keep one order,
so Talk reuses its prompt cache instead of paying for it again each message.
