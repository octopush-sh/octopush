---
title: See a possible secret before you press Commit
kind: improvement
area: app
highlight: true
steps:
  - open: mode/review
    target: review-companion-verdict
    caption: With something staged, the verdict says when the secret guard will ask before Commit.
    action: none
  - target: review-companion-secret
    caption: This line names what it found and where. Show it jumps to that line in the diff.
    action: none
---
The Review Companion now says when your staged change holds a possible secret, before you commit. The guard also checks credentials in the `env` block of `.mcp.json` and `.cursor/mcp.json`, newly added `.pem` and `.claude/settings.local.json` files, and long hex keys assigned to names like `secret` or `api_key`.
