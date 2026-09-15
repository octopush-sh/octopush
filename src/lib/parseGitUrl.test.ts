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

  // ── Azure DevOps ────────────────────────────────────────────────────

  it("parses Azure DevOps HTTPS (the `_git` marker is not the owner)", () => {
    const r = parseGitUrl("https://dev.azure.com/org/project/_git/repo");
    expect(r).toMatchObject({ host: "dev.azure.com", owner: "project", repo: "repo", isSsh: false });
  });

  it("parses the `org@` HTTPS URL Azure's Clone button hands out", () => {
    const r = parseGitUrl("https://org@dev.azure.com/org/project/_git/repo");
    expect(r).toMatchObject({ host: "dev.azure.com", owner: "project", repo: "repo", isSsh: false });
  });

  it("parses Azure DevOps SSH (v3)", () => {
    const r = parseGitUrl("git@ssh.dev.azure.com:v3/org/project/repo");
    expect(r).toMatchObject({ host: "ssh.dev.azure.com", owner: "project", repo: "repo", isSsh: true });
  });

  it("parses the legacy visualstudio.com host", () => {
    const r = parseGitUrl("https://org.visualstudio.com/DefaultCollection/project/_git/repo");
    expect(r).toMatchObject({ host: "org.visualstudio.com", owner: "project", repo: "repo" });
  });

  it("decodes percent-encoded names into a readable folder name", () => {
    const r = parseGitUrl("https://dev.azure.com/org/My%20Project/_git/My%20Repo");
    expect(r).toMatchObject({ owner: "My Project", repo: "My Repo" });
  });

  it("treats a leading `_git` as an ordinary owner", () => {
    const r = parseGitUrl("https://gitea.example.com/_git/repo");
    expect(r).toMatchObject({ owner: "_git", repo: "repo" });
  });

  it("keeps a segment as written when it would decode to a path", () => {
    const r = parseGitUrl("https://example.com/owner/..%2F..%2Fescape");
    expect(r?.repo).toBe("..%2F..%2Fescape");
  });

  it("keeps a segment as written when an escape is malformed", () => {
    const r = parseGitUrl("https://example.com/owner/50%off%20sale");
    expect(r?.repo).toBe("50%off%20sale");
  });

  it("keeps `+` and refuses control characters and non-UTF-8 escapes", () => {
    expect(parseGitUrl("https://github.com/owner/c++")?.repo).toBe("c++");
    expect(parseGitUrl("https://example.com/owner/line%0Abreak")?.repo).toBe("line%0Abreak");
    expect(parseGitUrl("https://example.com/owner/bad%C3%28")?.repo).toBe("bad%C3%28");
  });

  it("rejects a repo that decodes to a dot directory", () => {
    expect(parseGitUrl("https://example.com/owner/%2e%2e")).toBeNull();
    expect(parseGitUrl("https://example.com/owner/..")).toBeNull();
  });

  it("exposes the URL's user only when present", () => {
    expect(parseGitUrl("https://github.com/owner/repo")?.user).toBeUndefined();
    expect(parseGitUrl("https://org@dev.azure.com/org/project/_git/repo")?.user).toBe("org");
    expect(parseGitUrl("https://jane%40corp@bitbucket.org/ws/repo.git")?.user).toBe("jane@corp");
    expect(parseGitUrl("https://jane:secret@gitea.example.com/o/r")?.user).toBe("jane");
    expect(parseGitUrl("git@github.com:owner/repo.git")?.user).toBe("git");
  });

  it("ignores a pasted BOM or NEL around the URL, as the Rust parser does", () => {
    expect(parseGitUrl("\ufeffhttps://github.com/owner/repo\u0085")?.repo).toBe("repo");
  });

  it("parses the Azure DevOps URL with the project omitted", () => {
    const r = parseGitUrl("https://dev.azure.com/org/_git/repo");
    expect(r).toMatchObject({ owner: "org", repo: "repo" });
  });

  it("strips every trailing slash, as git does", () => {
    const r = parseGitUrl("https://github.com/owner/repo.git//");
    expect(r).toMatchObject({ owner: "owner", repo: "repo" });
  });

  it("accepts an upper-case scheme", () => {
    const r = parseGitUrl("HTTPS://github.com/owner/repo");
    expect(r).toMatchObject({ host: "github.com", repo: "repo", isSsh: false });
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

  it("converts Azure DevOps SSH (v3) to its dev.azure.com HTTPS form", () => {
    expect(sshToHttps("git@ssh.dev.azure.com:v3/org/project/repo")).toBe(
      "https://dev.azure.com/org/project/_git/repo",
    );
  });

  it("converts Azure DevOps ssh:// (v3) to its dev.azure.com HTTPS form", () => {
    expect(sshToHttps("ssh://git@ssh.dev.azure.com/v3/org/project/repo")).toBe(
      "https://dev.azure.com/org/project/_git/repo",
    );
  });

  it("does not forward a .git suffix into the Azure repository name", () => {
    expect(sshToHttps("git@ssh.dev.azure.com:v3/org/project/repo.git")).toBe(
      "https://dev.azure.com/org/project/_git/repo",
    );
  });

  it("converts legacy visualstudio.com SSH to its HTTPS form", () => {
    expect(sshToHttps("org@vs-ssh.visualstudio.com:v3/org/project/repo")).toBe(
      "https://org.visualstudio.com/project/_git/repo",
    );
  });

  it("tolerates trailing slashes on an Azure SSH URL", () => {
    expect(sshToHttps("git@ssh.dev.azure.com:v3/org/project/repo//")).toBe(
      "https://dev.azure.com/org/project/_git/repo",
    );
  });

  it("leaves an unrecognised Azure SSH path alone rather than invent a dead HTTPS URL", () => {
    expect(sshToHttps("git@ssh.dev.azure.com:v3/org/repo")).toBe("git@ssh.dev.azure.com:v3/org/repo");
    expect(sshToHttps("git@ssh.dev.azure.com:v3/org/project/repo/extra")).toBe(
      "git@ssh.dev.azure.com:v3/org/project/repo/extra",
    );
  });

  it("drops a custom ssh:// port, which has no HTTPS meaning", () => {
    expect(sshToHttps("ssh://git@gitea.example.com:2222/owner/repo.git")).toBe(
      "https://gitea.example.com/owner/repo.git",
    );
  });
});
