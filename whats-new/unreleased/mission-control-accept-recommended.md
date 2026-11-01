---
title: Accept a crew's recommended answers from Mission Control
kind: feature
area: app
scenario: default
steps:
  - open: mission-control
    target: mission-control-ask-toggle
    caption: When a crew asks you something, open its questions right on the card.
    action: click
  - target: mission-control-ask-accept
    caption: Accept the crew's recommended answers here, or choose Answer… for the full form.
    action: none
---
When a crew stops to ask you something, its Mission Control card now lists the questions and the crew's recommended answers. **Accept recommended** answers them in one click and notes it in the run journal; **Answer…** opens the full form. Gates still open the run.
