---
title: New missions can borrow node_modules and .env
kind: feature
area: app
steps:
  - target: mission-share
    caption: Link a dependency folder or copy an env file from the main checkout into every new mission. All off until you turn one on.
    action: none
  - target: mission-setup-script
    caption: They land before the setup script runs, and the setup line says what was shared.
    action: none
---
The new-mission setup step now lists what your main checkout has and git ignores: link `node_modules` or `.venv` instead of reinstalling, and copy `.env` files. It's saved per project, and a linked folder is shared by every mission. Sandboxed missions get the copies but no links, and turning the sandbox on later removes them.
