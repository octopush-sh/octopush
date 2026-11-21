---
title: Secret guard reads a private key whole
kind: fix
area: app
---
The secret guard now reads a private key in full, including lines of it your change didn't touch. Two different keys at the same place that differ only in such a line each ask on their own, instead of the second passing on the first one's confirm.
