---
title: Language grammars load when you first need them
kind: improvement
area: app
highlight: false
---
Syntax grammars for the Review editor, Quick View and the Review diff are no longer part of the app's startup bundle. Each one loads the first time a file in that language opens, and is ready immediately after that.
