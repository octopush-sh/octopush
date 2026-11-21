---
title: Re-runs no longer read "unpriced" in Usage by mistake
kind: fix
area: app
---
When a stage stopped before its usage was reported and then ran again, Settings › Usage could label the later attempt's spend "unpriced" even though that attempt reported its usage. Each attempt is now labelled by its own usage.
