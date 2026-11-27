---
title: Talk stays within each model's output limit
kind: fix
area: app
---
Talk, Direct and sub-agents no longer ask a model for more output than it takes, so GPT-4o and DeepSeek Chat stop refusing Deep turns. An answer cut at the output limit now says so: say continue to get the rest. Two replies in a row cut mid tool call end the turn instead of retrying.
