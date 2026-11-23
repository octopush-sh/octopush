---
title: Sandboxed crews keep running Bash with your own sandbox on
kind: fix
area: app
---
If you turned on Claude Code's Bash sandbox, it can't start inside a sandboxed mission, and Claude Code then refused every Bash command. Octopush now turns it off in those stages, because its own sandbox already confines them, and the launch line says so. If a stage still meets that refusal, its card and halt name it.
