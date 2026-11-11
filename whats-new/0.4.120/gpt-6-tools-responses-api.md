---
title: Tools work on GPT-6 models in Talk and API stages
kind: fix
area: app
---
GPT-6 models now go through OpenAI's Responses API, so their tool calls work in Talk and API stages. Before, those calls failed with tools sent. The XHi and Max effort levels now reach GPT-6 too, instead of falling back to High.
