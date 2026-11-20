---
title: Receded stage cards read unknown and tiny costs in full
kind: fix
area: app
---
In a Direct run, a receded stage card reads "unreported" instead of a cut-off "usage not report…", and a cost under a cent reads `<$0.01`, not `$0.00`. When the token pair steps aside, its tooltip reads millions as `1.24M`, and screen readers still hear the full figures.
