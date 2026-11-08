---
title: Conductor repos bring their setup script along
kind: feature
area: app
steps:
  - target: mission-setup-script
    caption: A repo with a .conductor/settings.toml starts with its setup script here. Edit it before it runs.
    action: none
  - target: mission-setup-conductor
    caption: This line says where the script came from.
    action: none
---
A new mission in a repo set up for Conductor now prefills its setup script from `.conductor/settings.toml`. It runs only when you begin the mission. Setup scripts also get `CONDUCTOR_ROOT_PATH`, `CONDUCTOR_WORKSPACE_PATH` and `CONDUCTOR_WORKSPACE_NAME`, unless you already set them.
