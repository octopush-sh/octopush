## Octopush 0.4.118

### Features

- **Effort and effort escalation now reach Codex CLI stages** — CLI stages that run Codex now honour the stage's **Reasoning** and **Escalate on failure** effort, and the pre-run estimate counts it. Octopush passes it as a one-off `model_reasoning_effort` override, which wins over your Codex config file. Codex stages that ran before this update ran at Codex's default, so their run history now shows no effort for them.

### Improvements

- **GPT-6.1 Terra is priced and in the model list** — GPT-6.1 Terra is priced and can be picked for Talk and Codex stages. Its spend ($1 input, $0.05 cached input and $5 output per million tokens) now counts toward run budgets, and earlier unpriced usage is priced on the next launch.

### Fixes

- **Effort now reaches GPT-6 models** — Effort now reaches GPT-6 models in Talk and API stages. Before, the effort you picked for a model such as GPT-6.1 Terra was dropped without notice.
- **Every cost figure groups thousands** — Costs over $999 read the same everywhere, with thousands separated ("$12,843.27"): on run stage cards, the halt bar, run history, the Logbook and its export, the Companion's Logbook line, Talk's conversation and message costs, the PR draft cost, Settings › Usage (totals too, as "$12,843"), budget toasts and "Crew finished". Costs under a cent keep their extra decimals.
- **Halted stages offer Re-run with feedback** — When a halted stage's main action is **Re-run**, the run bar now also offers **Re-run with feedback**. A stage paused by a hook on a tool no longer shows "awaiting retry" because the tool's name or the error output mentions DNS or a timeout.
