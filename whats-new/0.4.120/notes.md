## Octopush 0.4.120

### Fixes

- **Codex stage effort follows each model's levels** — A Codex CLI stage's effort now follows the levels each model offers in Codex: Max reaches GPT-5.6 models and codex-auto-review, and runs as XHi on GPT-5.5. On a model Codex doesn't list, such as gpt-5-codex or o3, the stage keeps Codex's default instead of failing on an unsupported level.
- **GPT-6.1 Terra cache writes are billed at $1.25** — GPT-6.1 Terra cache writes are now priced at $1.25 per million tokens, OpenAI's rate for the default 30-minute retention, and Terra can take images. Cache-write tokens reported by OpenAI and by Codex stages are now billed at the cache-write rate instead of as plain input, so run budgets match the bill.
- **Tools work on GPT-6 models in Talk and API stages** — GPT-6 models now go through OpenAI's Responses API, so their tool calls work in Talk and API stages. Before, those calls failed with tools sent. The XHi and Max effort levels now reach GPT-6 too, instead of falling back to High.
