---
title: GPT-6 reasoning replay is more careful
kind: fix
area: app
---
GPT-6 reasoning is passed back only to the same provider and endpoint that produced it, so a run resumed under a different provider or endpoint rebuilds the turn instead of sending reasoning that may not decrypt. Long GPT-6 stages no longer compact older tool output early, and **Off** no longer sends effort `none` to a GPT-6 variant that may not accept it.
