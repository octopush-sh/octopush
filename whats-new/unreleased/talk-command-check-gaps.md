---
title: More risky agent commands ask before they run
kind: fix
area: app
---
Talk's command check now reads commands inside `$(…)`, backticks and `bash -c "…"`, knows
`/bin/rm` is `rm`, and asks before a `+main` push, a remote branch delete, a downloaded script run
through `bash <(curl …)`, or a `curl` upload of a dotfile such as `.env`.
