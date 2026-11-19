---
title: Receded stage cards keep their figures on one line
kind: fix
area: app
---
In a Direct run, a receded stage card's position, cost and tokens no longer wrap onto a second line. Large token counts read compactly (`↑18k`), and when they still don't fit, the token pair steps aside and stays in the line's tooltip. An unknown cost reads "unpriced" or "usage not reported", never $0.00.
