---
title: Talk's shell finds Homebrew, nvm and other PATH tools
kind: fix
area: app
---
Commands in Talk, yours (`$`) and the agent's, sub-agents' included, now run with your login shell's PATH, as Direct's CLI stages do, so `gh`, `node` and tools from Homebrew, nvm or similar are found. When a program still isn't found, the result says so, so the agent doesn't take it as not installed.
