---
title: Fewer MCP approval cards in Talk
kind: improvement
area: app
scenario: talk-mcp
steps:
  - open: mode/talk
    target: companion-can-use
    caption: A shield on a server means you told Talk to stop asking about it. Its tooltip says what runs without asking.
    action: none
  - open: settings/integrations
    target: settings-mcp-servers
    caption: Every tool and server you trusted is listed on its server's row. Revoke any of them here.
    action: none
---
In Edit freely, an MCP tool whose server marks it read-only or not destructive, or whose name starts with a read verb such as `get_` or `list_`, now runs without a card. The card can also allow a tool, or trust its server, in every conversation, until you revoke it in Settings › Integrations. Plan only is unchanged.
