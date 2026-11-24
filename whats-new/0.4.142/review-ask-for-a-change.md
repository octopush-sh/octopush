---
title: Comment on the diff and send it to the agent
kind: feature
area: app
highlight: true
steps:
  - open: mode/review
    target: review-hunk-comment
    caption: Ask for a change on a hunk, or click a line number to comment on lines.
    action: click
  - target: review-comment-composer
    caption: Say what should change. ⌘⏎ adds it to the comments.
    action: type
    text: Extract this into a helper.
  - target: review-comment-add
    caption: Add as many as you need.
    action: click
  - target: review-companion-comments
    caption: They collect here, marked outdated if the hunk changes.
  - target: review-companion-send-comments
    caption: Send them all as one message to Talk, or as a waiting review gate's Send-back.
---
In Review, leave a comment on a hunk (the speech-bubble icon or `m`) or on lines of it. The
comments collect in the Companion; **Send to the agent** sends them as one message, to the
mission's Talk thread or, when a crew waits at a review gate, as its Send-back feedback.
