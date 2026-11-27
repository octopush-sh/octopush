---
title: See the skills and sub-agents Talk can use
kind: feature
area: app
scenario: talk-mcp
steps:
  - open: mode/talk
    target: companion-can-use-agents
    caption: The sub-agent types this conversation can hand work to, each with its tier or model and its tools.
  - target: companion-can-use-skills
    caption: Its skills. Pick one to add /name to your message.
---
The Companion's **can use** row now counts the conversation's skills and sub-agent types beside its MCP
servers. Open either to see each one's description and where it comes from; a skill adds `/name` to your
message, and an agent shows its tier or model and the tools it may use.
