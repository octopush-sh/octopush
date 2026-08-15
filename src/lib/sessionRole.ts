// What a terminal session is *doing* — the one thing its label can't say.
//
// The daemon reports the foreground process's argv summary on every busy
// transition (`pty://foreground`'s `command`); this module turns that string
// into a role, which the rail, the switcher and the Companion render as a
// single icon. Kept pure and store-free so the vocabulary is unit-testable and
// has exactly one definition.
//
// Design record: docs/superpowers/plans/2026-08-15-run-terminal-navigation-design.md

export type SessionRole =
  | "shell"
  | "dev"
  | "build"
  | "test"
  | "deps"
  | "git"
  | "agent"
  | "edit"
  | "unknown";

/** Human phrase for a role — tooltips, the Companion's "doing" line, the
 *  switcher's state column. Sentence-shaped, lowercase; callers cap it. */
export const ROLE_WORD: Record<SessionRole, string> = {
  shell: "shell at the prompt",
  dev: "dev server",
  build: "building",
  test: "test run",
  deps: "installing packages",
  git: "git",
  agent: "agent CLI",
  edit: "editor · TUI",
  unknown: "running a command",
};

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "login", "tmux", "screen"]);
const AGENTS = new Set(["claude", "codex", "aider", "gemini", "opencode", "cursor-agent"]);
const GIT = new Set(["git", "gh", "lazygit", "tig", "hub", "jj"]);
const EDITORS = new Set([
  "vim", "nvim", "vi", "nano", "emacs", "hx", "helix", "kak", "micro",
  "htop", "btop", "top", "less", "man", "k9s", "lazydocker", "ncdu",
]);
const TEST_BINS = new Set([
  "vitest", "jest", "mocha", "ava", "tap", "pytest", "phpunit", "rspec",
  "playwright", "cypress", "gotestsum", "nextest",
]);
const BUILD_BINS = new Set([
  "tsc", "esbuild", "rollup", "swc", "webpack", "parcel", "gradle", "gradlew",
  "mvn", "xcodebuild", "cmake", "ninja", "make", "gmake", "turbo",
]);
const DEV_BINS = new Set([
  "vite", "next", "nuxt", "astro", "remix", "nodemon", "serve", "http-server",
  "live-server", "watchexec", "watchman", "concurrently", "wrangler",
]);
/** Runners whose meaning lives entirely in their arguments. */
const DELEGATORS = new Set(["npx", "bunx", "pnpx", "dlx", "sudo", "time", "env", "watch", "nohup"]);

/** Script names, as passed to `npm run <name>` or invoked directly. */
function roleForScript(name: string): SessionRole | null {
  if (/^(dev|start|serve|preview|watch|storybook)(:|$)/.test(name)) return "dev";
  if (/^(build|compile|bundle|typecheck|tsc)(:|$)/.test(name)) return "build";
  if (/^(test|tests|spec|e2e|coverage|vitest|jest)(:|$)/.test(name)) return "test";
  return null;
}

/**
 * Classify a foreground command summary ("npm run dev", "cargo build
 * --release", "git status -sb") into a session role.
 *
 * Returns "shell" for an absent command (nothing is running) and "unknown" for
 * a command we can't place — both are honest answers with their own icon, and
 * neither is an error. Ambiguity is deliberate where it exists: a bare `node`
 * could be anything, so it stays unknown rather than guessing "dev".
 */
export function roleForCommand(command: string | null | undefined): SessionRole {
  if (!command) return "shell";
  const tokens = command.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return classify(tokens, 0);
}

function classify(tokens: string[], depth: number): SessionRole {
  const raw = tokens[0];
  if (!raw) return "shell";
  // Strip any path and a .exe/.cmd suffix so /opt/homebrew/bin/cargo and
  // cargo.exe classify the same way.
  const bin = (raw.split("/").pop() ?? raw).replace(/\.(exe|cmd|bat)$/, "");
  const args = tokens.slice(1).filter((a) => !a.startsWith("-"));
  const first = args[0] ?? "";

  // A delegator means nothing on its own — classify what it is running,
  // skipping any leading `KEY=value` assignments (`env FOO=1 vite`).
  // Depth-capped so `sudo sudo sudo …` can't spin.
  if (DELEGATORS.has(bin) && depth < 3) {
    const inner = args.filter((a) => !/^[\w.]+=/.test(a));
    if (inner.length > 0) return classify(inner, depth + 1);
  }

  if (SHELLS.has(bin)) return "shell";
  if (AGENTS.has(bin)) return "agent";
  if (GIT.has(bin)) return "git";
  if (EDITORS.has(bin)) return "edit";
  if (TEST_BINS.has(bin)) return "test";

  // A dev-server binary asked to build is a build, not a server.
  if (DEV_BINS.has(bin)) return first === "build" ? "build" : "dev";
  if (BUILD_BINS.has(bin)) return "build";

  // ── Package managers: the subcommand carries the meaning ──────────
  if (["npm", "pnpm", "yarn", "bun", "deno"].includes(bin)) {
    if (["install", "i", "ci", "add", "remove", "rm", "uninstall", "up", "update", "upgrade"].includes(first)) {
      return "deps";
    }
    if (first === "test" || first === "t") return "test";
    if (first === "run" || first === "run-script") {
      return roleForScript(args[1] ?? "") ?? "unknown";
    }
    // `yarn dev` / `bun dev` — the script name sits where a subcommand would.
    return roleForScript(first) ?? "unknown";
  }

  if (bin === "cargo") {
    if (["test", "nextest", "bench"].includes(first)) return "test";
    if (["build", "b", "check", "c", "clippy", "doc"].includes(first)) return "build";
    if (["run", "r", "watch"].includes(first)) return "dev";
    if (["add", "install", "update", "fetch"].includes(first)) return "deps";
    return "unknown";
  }

  if (bin === "go") {
    if (first === "test") return "test";
    if (first === "build" || first === "vet") return "build";
    if (first === "run") return "dev";
    if (first === "get" || first === "mod") return "deps";
    return "unknown";
  }

  if (["pip", "pip3", "poetry", "uv", "pipenv", "brew", "apt", "apt-get"].includes(bin)) {
    return ["install", "add", "sync", "upgrade", "update"].includes(first) ? "deps" : "unknown";
  }

  if (bin === "docker" || bin === "docker-compose" || bin === "podman") {
    // `docker compose up` puts the meaningful verb one token further along.
    const verb = first === "compose" ? (args[1] ?? "") : first;
    if (verb === "build") return "build";
    if (verb === "up" || verb === "run" || verb === "start") return "dev";
    return "unknown";
  }

  // `python -m pytest` is the one python invocation worth naming; the flag
  // filter above drops `-m`, so this reads the unfiltered tokens.
  if (bin === "python" || bin === "python3") {
    return tokens.some((t) => t === "pytest" || t.endsWith("/pytest")) ? "test" : "unknown";
  }

  return "unknown";
}
