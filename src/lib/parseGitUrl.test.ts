import { describe, it, expect } from "vitest";
import { parseGitUrl } from "./parseGitUrl";
import { sshToHttps } from "../components/NewProjectFlow";

describe("parseGitUrl", () => {
  // ── Happy path ──────────────────────────────────────────────────────

  it("parses HTTPS with .git suffix", () => {
    const r = parseGitUrl("https://github.com/owner/repo.git");
    expect(r).toMatchObject({ host: "github.com", owner: "owner", repo: "repo", isSsh: false });
  });

  it("parses HTTPS without .git suffix", () => {
    const r = parseGitUrl("https://github.com/owner/repo");
    expect(r).toMatchObject({ host: "github.com", owner: "owner", repo: "repo", isSsh: false });
  });

  it("parses SCP-style SSH (git@)", () => {
    const r = parseGitUrl("git@github.com:owner/repo.git");
    expect(r).toMatchObject({ host: "github.com", owner: "owner", repo: "repo", isSsh: true });
  });

  it("parses ssh:// scheme", () => {
    const r = parseGitUrl("ssh://git@github.com/owner/repo.git");
    expect(r).toMatchObject({ host: "github.com", owner: "owner", repo: "repo", isSsh: true });
  });

  it("parses multi-level GitLab path", () => {
    const r = parseGitUrl("https://gitlab.com/group/subgroup/repo.git");
    // owner = segment before repo
    expect(r).toMatchObject({ host: "gitlab.com", owner: "subgroup", repo: "repo", isSsh: false });
  });

  it("parses Bitbucket HTTPS", () => {
    const r = parseGitUrl("https://bitbucket.org/owner/repo.git");
    expect(r).toMatchObject({ host: "bitbucket.org", owner: "owner", repo: "repo", isSsh: false });
  });

  it("parses custom host (Gitea)", () => {
    const r = parseGitUrl("https://gitea.example.com/owner/repo.git");
    expect(r).toMatchObject({ host: "gitea.example.com", owner: "owner", repo: "repo", isSsh: false });
  });

  it("parses SCP-style Bitbucket", () => {
    const r = parseGitUrl("git@bitbucket.org:owner/repo.git");
    expect(r).toMatchObject({ host: "bitbucket.org", owner: "owner", repo: "repo", isSsh: true });
  });

  it("parses http:// (plain HTTP)", () => {
    const r = parseGitUrl("http://gitea.internal.company.com/team/project.git");
    expect(r).toMatchObject({ host: "gitea.internal.company.com", repo: "project", isSsh: false });
  });

  it("parses GitLab HTTPS without .git", () => {
    const r = parseGitUrl("https://gitlab.com/owner/repo");
    expect(r).toMatchObject({ host: "gitlab.com", owner: "owner", repo: "repo" });
  });

  // ── Rejection ───────────────────────────────────────────────────────

  it("returns null for empty string", () => {
    expect(parseGitUrl("")).toBeNull();
  });

  it("returns null for plain word", () => {
    expect(parseGitUrl("not a url")).toBeNull();
  });

  it("returns null for bare http://", () => {
    expect(parseGitUrl("http://")).toBeNull();
  });

  it("returns null for URL with no path", () => {
    expect(parseGitUrl("https://github.com")).toBeNull();
  });

  it("returns null for URL with only one path segment", () => {
    expect(parseGitUrl("https://github.com/onlyone")).toBeNull();
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it("trims surrounding whitespace", () => {
    const r = parseGitUrl("  https://github.com/owner/repo  ");
    expect(r).not.toBeNull();
    expect(r?.repo).toBe("repo");
  });
});

describe("sshToHttps", () => {
  it("converts SCP-style SSH to HTTPS", () => {
    expect(sshToHttps("git@github.com:owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("converts ssh:// scheme to HTTPS", () => {
    expect(sshToHttps("ssh://git@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("leaves an already-HTTPS URL unchanged", () => {
    expect(sshToHttps("https://github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo.git",
    );
  });

  it("converts Bitbucket SCP-style SSH to HTTPS", () => {
    expect(sshToHttps("git@bitbucket.org:owner/repo.git")).toBe(
      "https://bitbucket.org/owner/repo.git",
    );
  });
});
