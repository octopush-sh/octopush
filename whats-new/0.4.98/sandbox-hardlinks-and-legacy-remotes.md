---
title: The sandbox also guards git hardlinks and remotes
kind: fix
area: app
highlight: false
---
A sandboxed stage can no longer hardlink the repo's git config or a hook to write through the link, plant a legacy remote in `.git/remotes` or `.git/branches`, or swap the parent of a hooks dir that `core.hooksPath` puts in the temp dir or `~/.cache`.
