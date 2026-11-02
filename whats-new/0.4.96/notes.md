## Octopush 0.4.96

### Improvements

- **Logbook and Routines offer Pro more quietly** — The Logbook room and Settings › Routines no longer show a loud **Upgrade to Pro** button on the free plan. Each offers Pro as a calm serif phrase, and the Logbook lock is drawn in mute, so solid brass stays reserved for the one decision that needs you.
- **Review keeps brass for Accept all** — The Review toolbar and file headers are calmer. **Accept all** is the one brass button, AI and a hunk's Accept stay in quiet ink until you open or hover them, and MODIFIED reads in mute like the hunk count.

### Fixes

- **Gateway model ids like claude-opus-4.8 are now priced** — Claude model ids that a gateway spells with dots, such as `anthropic/claude-opus-4.8` or `claude-sonnet-5.5`, now price as their base model, including your catalog overrides, instead of showing as unpriced and dropping out of a run's cost and savings.
- **Long branch names keep both ends in the header** — Long branch names in the workspace header are shortened in the middle, so both ends stay visible.

### Maintenance

build(deps-dev): bump jsdom from 29.0.2 to 30.1.3 (#409) · build(deps-dev): bump @testing-library/jest-dom from 6.9.1 to 7.0.1 (#406) · build(deps): bump dirs from 6.0.0 to 7.0.0 in /src-tauri (#411) · deps: rustls-platform-verifier 0.7.1 with the macOS SecTrust mirror re-diffed (supersedes #412) (#420) · build(deps): bump rustls from 0.23.37 to 0.23.46 in /src-tauri in the cargo-minor-patch group (#408) · build(deps): bump lucide-react from 1.63.0 to 1.65.0 in the npm-minor-patch group (#403) · build(deps): bump the actions group with 2 updates (#404) · promote: open the octopush-web version PR after a promotion (#397)
