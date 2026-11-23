---
title: The secret guard checks exactly what a push sends
kind: fix
area: app
---
Before a push, the secret guard now checks the commits that aren't on origin's copy of the branch yet, which is where the push goes. It used to start from the branch's upstream, which can be another remote.
