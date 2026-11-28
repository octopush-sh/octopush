---
title: Read Epiku stories as a project's issue tracker
kind: feature
area: app
steps:
  - open: settings/integrations
    target: settings-integrations-epiku
    caption: Connect Epiku with its URL, a project and a token. The token stays in the Keychain.
    action: click
  - target: settings-epiku-status
    caption: Connected shows once Epiku answered for the project.
---
Each project can now read Jira, Epiku or no tracker, from its menu under **Issue tracking**. Epiku
stories fill the backlog, the ticket chip and the Blocking, Blocked by and Epic pills, and a dotted id
like `ST-2.3` in a branch is detected. Octopush only reads Epiku, sending the token and the ids it asks for.
