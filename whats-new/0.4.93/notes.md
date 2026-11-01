## Octopush 0.4.93

### Features

- **Accept a crew's recommended answers from Mission Control** — When a crew stops to ask you something, its Mission Control card now lists the questions and the crew's recommended answers. **Accept recommended** answers them in one click and notes it in the run journal; **Answer…** opens the full form. Gates still open the run.

### Fixes

- **A terminal that fails to start says why and retries** — When a Run session can't start (no shell, a sandbox denial, the terminal service down), the canvas now says so in plain words, keeps the technical detail one click away and offers **Try the shell again**. The Companion reads *failed* instead of *shell idle*.

### Maintenance

jobs: area:app wins over a secondary area:web/api label (#370) · ideas/answers: the web lane is optional — don't fail without the App (#361)
