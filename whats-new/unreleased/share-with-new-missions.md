---
title: New missions can borrow node_modules and .env
kind: feature
area: app
steps:
  - target: mission-share
    caption: Link a dependency folder or copy an env file from the main checkout into new missions. All off until you turn one on.
    action: none
  - target: mission-setup-script
    caption: They land before the setup script runs, and the setup line says what was shared.
    action: none
---
The new-mission setup step lists what your main checkout has and git ignores: link `node_modules` or `.venv`, copy `.env` files. A linked folder is the main checkout's own folder, so an install in a mission changes it everywhere. Agents in the mission can read a copied env file. Sandboxed missions get neither, and Routines and MCP workspaces don't share.
