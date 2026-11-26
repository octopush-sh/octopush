## Octopush 0.4.121

### Improvements

- **GPT-6 keeps its reasoning across tool calls** — API stages on GPT-6 now pass the model's reasoning back after each tool call, as OpenAI asks. **Off** now turns reasoning off on GPT-6 Sol, Luna and 6.1 Terra. A refusal from any OpenAI-compatible provider now shows its explanation instead of an empty reply.

### Fixes

- **Budget messages group dollars; stricter emoji in crews** — Budget notices and halts read "$1,234.50", like the rest of the app. A crew file's emoji joiner now only counts between two real pictographs, and the launcher's Claude Code model note says a stage may not run on an older CLI.
- **GPT-6 through a gateway uses Chat Completions** — A GPT-6 model reached through LiteLLM, OpenRouter or another OpenAI-compatible base URL goes back to Chat Completions, so a gateway that doesn't speak the Responses API no longer fails every request. GPT-6 on OpenAI itself keeps the Responses API. When GPT-6 refuses a request, Talk and API stages now show its explanation instead of an empty reply.
- **GPT-6 reasoning replay is more careful** — GPT-6 reasoning is passed back only to the same provider and endpoint that produced it, so a run resumed under a different provider or endpoint rebuilds the turn instead of sending reasoning that may not decrypt. Long GPT-6 stages compact older tool output closer to when they really need to, and **Off** no longer sends effort `none` to a GPT-6 variant that may not accept it.
