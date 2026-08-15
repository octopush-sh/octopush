import { describe, it, expect } from "vitest";
import { roleForCommand, ROLE_WORD, type SessionRole } from "./sessionRole";

describe("roleForCommand", () => {
  it("treats an absent command as a shell at the prompt", () => {
    expect(roleForCommand(null)).toBe("shell");
    expect(roleForCommand(undefined)).toBe("shell");
    expect(roleForCommand("")).toBe("shell");
    expect(roleForCommand("   ")).toBe("shell");
  });

  it("recognises shells themselves", () => {
    expect(roleForCommand("zsh")).toBe("shell");
    expect(roleForCommand("/bin/bash -l")).toBe("shell");
  });

  it.each<[string, SessionRole]>([
    ["npm run dev", "dev"],
    ["pnpm dev", "dev"],
    ["yarn start", "dev"],
    ["vite", "dev"],
    ["next dev", "dev"],
    ["nodemon server.js", "dev"],
    ["cargo run", "dev"],
    ["cargo watch -x run", "dev"],
    ["docker compose up", "dev"],
  ])("classifies %s as a dev server", (cmd, role) => {
    expect(roleForCommand(cmd)).toBe(role);
  });

  it.each<[string, SessionRole]>([
    ["cargo build --release", "build"],
    ["cargo clippy", "build"],
    ["npm run build", "build"],
    ["npm run typecheck", "build"],
    ["tsc --noEmit", "build"],
    ["make", "build"],
    ["vite build", "build"],
  ])("classifies %s as a build", (cmd, role) => {
    expect(roleForCommand(cmd)).toBe(role);
  });

  it.each<[string, SessionRole]>([
    ["cargo test", "test"],
    ["npm test", "test"],
    ["npm run test:watch", "test"],
    ["vitest run", "test"],
    ["npx vitest", "test"],
    ["pytest -q", "test"],
    ["python -m pytest", "test"],
    ["go test ./...", "test"],
  ])("classifies %s as a test run", (cmd, role) => {
    expect(roleForCommand(cmd)).toBe(role);
  });

  it.each<[string, SessionRole]>([
    ["npm install", "deps"],
    ["npm i", "deps"],
    ["pnpm add zustand", "deps"],
    ["cargo add serde", "deps"],
    ["pip install -r requirements.txt", "deps"],
    ["brew install ripgrep", "deps"],
  ])("classifies %s as dependency work", (cmd, role) => {
    expect(roleForCommand(cmd)).toBe(role);
  });

  it("recognises git, agents and editors", () => {
    expect(roleForCommand("git status -sb")).toBe("git");
    expect(roleForCommand("gh pr list")).toBe("git");
    expect(roleForCommand("claude")).toBe("agent");
    expect(roleForCommand("codex exec")).toBe("agent");
    expect(roleForCommand("nvim src/App.tsx")).toBe("edit");
    expect(roleForCommand("htop")).toBe("edit");
  });

  it("looks through delegators to the real command", () => {
    expect(roleForCommand("sudo cargo build")).toBe("build");
    expect(roleForCommand("npx playwright test")).toBe("test");
    expect(roleForCommand("env FOO=1 vite")).toBe("dev");
  });

  it("strips paths and executable suffixes", () => {
    expect(roleForCommand("/opt/homebrew/bin/cargo test")).toBe("test");
    expect(roleForCommand("C:/tools/git.exe status")).toBe("git");
  });

  it("reads the subcommand of a build tool that also runs tests", () => {
    // `make`/`gradle`/`mvn`/`turbo` are only "build" by default, never by
    // definition — claiming a Hammer for a test run also overwrites the
    // session's sticky role with the wrong one.
    expect(roleForCommand("make test")).toBe("test");
    expect(roleForCommand("mvn test")).toBe("test");
    expect(roleForCommand("gradlew test")).toBe("test");
    expect(roleForCommand("turbo test")).toBe("test");
    expect(roleForCommand("make")).toBe("build");
    expect(roleForCommand("make build")).toBe("build");
  });

  it("finds a test anywhere in a script name, not only at the front", () => {
    expect(roleForCommand("npm run watch:test")).toBe("test");
    expect(roleForCommand("npm run test:watch")).toBe("test");
  });

  it("finds the docker verb wherever a dropped flag value left it", () => {
    expect(roleForCommand("docker compose up")).toBe("dev");
    expect(roleForCommand("docker compose dev.yml up")).toBe("dev");
    expect(roleForCommand("docker compose build")).toBe("build");
    // A bare container run is not a dev server.
    expect(roleForCommand("docker run ubuntu")).toBe("unknown");
  });

  it("survives the flags the daemon could not strip", () => {
    expect(roleForCommand("npm run dev")).toBe("dev");
    expect(roleForCommand("cargo build")).toBe("build");
  });

  it("stays honest about ambiguity instead of guessing", () => {
    // A bare launcher could be anything — the app shows the neutral icon
    // rather than pretending it knows.
    expect(roleForCommand("node")).toBe("unknown");
    expect(roleForCommand("python")).toBe("unknown");
    expect(roleForCommand("npm run lint")).toBe("unknown");
    expect(roleForCommand("./scripts/whatever.sh")).toBe("unknown");
  });

  it("cannot be spun by nested delegators", () => {
    expect(roleForCommand("sudo sudo sudo sudo cargo build")).toBe("unknown");
  });

  it("gives every role a phrase", () => {
    const roles: SessionRole[] = [
      "shell", "dev", "build", "test", "deps", "git", "agent", "edit", "unknown",
    ];
    for (const r of roles) expect(ROLE_WORD[r]).toBeTruthy();
  });
});
