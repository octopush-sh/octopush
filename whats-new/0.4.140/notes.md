## Octopush 0.4.140

### Fixes

- **AI review says when it read only part of a change** — On a very large change, the AI review now cuts the diff at a file boundary to fit the model, instead of failing with a provider error. When it reads only part of the change, the drawer says so under the summary, for example "Read the first 2 of 14 files; the rest wasn't reviewed.", or "Read the first part of package-lock.json; the rest wasn't reviewed." when one file is too big for the model.
