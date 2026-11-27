---
title: Talk's error card says what failed and what to do next
kind: improvement
area: app
steps:
  - open: mode/talk
    target: talk-error-action
    caption: The card names the failure and what was kept. Try again continues the turn without asking twice.
    action: none
---
When a Talk turn ends on an error, the card now says what happened and how much of the turn was kept, with one action: **Try again** after an overload or outage, **Configure API key**, or **Copy error details**. A spend-limit 429 or an error the provider marks final now shows at once instead of after minutes of retries.
