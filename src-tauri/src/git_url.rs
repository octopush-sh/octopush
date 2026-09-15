//! Git remote URL parser — understands HTTPS, SSH, and ssh:// schemes.
//!
//! The parser is deliberately permissive about host names so that
//! self-hosted Gitea / Forgejo instances work out of the box.

/// A successfully parsed remote URL.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedGitUrl {
    /// Original string passed to `parse_git_url`.
    pub raw: String,
    /// Host name, e.g. `github.com`, `gitlab.com`, `gitea.example.com`.
    pub host: String,
    /// User or organisation, e.g. `octocat`.
    pub owner: String,
    /// Repository name **without** any trailing `.git`, e.g. `Hello-World`.
    pub repo: String,
    /// `true` for `git@…` and `ssh://…` URLs.
    pub is_ssh: bool,
}

/// Parse a git remote URL into its constituent parts.
///
/// Returns `None` for obviously invalid input (empty string, bare hostname,
/// no path segments, etc.).
///
/// # Supported shapes
///
/// | Shape | Example |
/// |-------|---------|
/// | HTTPS with .git | `https://github.com/owner/repo.git` |
/// | HTTPS without .git | `https://github.com/owner/repo` |
/// | SCP (git@) | `git@github.com:owner/repo.git` |
/// | ssh:// | `ssh://git@github.com/owner/repo.git` |
/// | Multi-level GitLab | `https://gitlab.com/group/sub/repo.git` |
/// | Custom host | `https://gitea.example.com/owner/repo.git` |
/// | Azure DevOps HTTPS | `https://org@dev.azure.com/org/project/_git/repo` |
/// | Azure DevOps SSH | `git@ssh.dev.azure.com:v3/org/project/repo` |
pub fn parse_git_url(url: &str) -> Option<ParsedGitUrl> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }

    // ── SCP-style: git@github.com:owner/repo.git ──────────────────────
    if !url.contains("://") {
        if let Some(at_pos) = url.find('@') {
            let after_at = &url[at_pos + 1..];
            if let Some(colon_pos) = after_at.find(':') {
                let host = after_at[..colon_pos].to_string();
                let path = &after_at[colon_pos + 1..];
                if host.is_empty() || path.is_empty() {
                    return None;
                }
                let (owner, repo) = split_owner_repo(path)?;
                return Some(ParsedGitUrl {
                    raw: url.to_string(),
                    host,
                    owner,
                    repo,
                    is_ssh: true,
                });
            }
        }
        return None; // Not a valid URL shape we handle
    }

    // ── URL-scheme forms ───────────────────────────────────────────────
    let scheme_end = url.find("://")?;
    let scheme = &url[..scheme_end];
    let rest = &url[scheme_end + 3..]; // everything after "://"

    let is_ssh = matches!(scheme, "ssh" | "git");

    // Strip optional `user@` prefix from the authority.
    let rest = if let Some(at) = rest.find('@') {
        // Only strip user@ if @ appears before the first /
        let slash_pos = rest.find('/').unwrap_or(usize::MAX);
        if at < slash_pos {
            &rest[at + 1..]
        } else {
            rest
        }
    } else {
        rest
    };

    // Split off the host (everything up to the first /).
    let slash = rest.find('/')?;
    let host = rest[..slash].to_string();
    let path = &rest[slash + 1..];

    if host.is_empty() || path.is_empty() {
        return None;
    }

    // Validate that the scheme is one we know about.
    match scheme {
        "https" | "http" | "ssh" | "git" => {}
        _ => return None,
    }

    let (owner, repo) = split_owner_repo(path)?;

    Some(ParsedGitUrl {
        raw: url.to_string(),
        host,
        owner,
        repo,
        is_ssh,
    })
}

/// Extract the owner and repo from a URL path segment.
///
/// The path may have multiple components (GitLab groups); the last segment
/// is the repo name and the second-to-last is the owner. Strips a trailing
/// `.git` suffix from the repo name.
fn split_owner_repo(path: &str) -> Option<(String, String)> {
    // Remove trailing slashes and .git.
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);

    let mut segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    // Azure DevOps (dev.azure.com, *.visualstudio.com, on-prem Server) puts a
    // literal `_git` between the project and the repository:
    //   https://dev.azure.com/org/project/_git/repo
    // Drop the marker so the owner is the project, not `_git`.
    if segments.len() >= 3 && segments[segments.len() - 2] == "_git" {
        segments.remove(segments.len() - 2);
    }

    if segments.len() < 2 {
        return None;
    }

    let repo = decode_segment(segments.last()?);
    // For multi-level GitLab paths, owner is the segment before the repo.
    let owner = decode_segment(segments[segments.len() - 2]);

    if owner.is_empty() || repo.is_empty() {
        return None;
    }

    Some((owner, repo))
}

/// Undo `%20`-style escapes so a repository called "My Repo" (Azure DevOps
/// allows spaces and encodes them in its clone URLs) lands in `My Repo` — the
/// directory `git clone` itself would pick. A segment that decodes to
/// something that can't be a single directory name is kept as written.
fn decode_segment(segment: &str) -> String {
    match urlencoding::decode(segment) {
        Ok(decoded) if !decoded.contains(|c| matches!(c, '/' | '\\' | '\0')) => {
            decoded.into_owned()
        }
        _ => segment.to_string(),
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn p(url: &str) -> ParsedGitUrl {
        parse_git_url(url).unwrap_or_else(|| panic!("expected Ok for {url:?}"))
    }

    #[test]
    fn https_with_dot_git() {
        let r = p("https://github.com/owner/repo.git");
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn https_without_dot_git() {
        let r = p("https://github.com/owner/repo");
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn scp_style_ssh() {
        let r = p("git@github.com:owner/repo.git");
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
        assert!(r.is_ssh);
    }

    #[test]
    fn ssh_scheme() {
        let r = p("ssh://git@github.com/owner/repo.git");
        assert_eq!(r.host, "github.com");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
        assert!(r.is_ssh);
    }

    #[test]
    fn gitlab_multi_level_path() {
        let r = p("https://gitlab.com/group/subgroup/repo.git");
        assert_eq!(r.host, "gitlab.com");
        // owner is the segment immediately before the repo
        assert_eq!(r.owner, "subgroup");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn bitbucket_https() {
        let r = p("https://bitbucket.org/owner/repo.git");
        assert_eq!(r.host, "bitbucket.org");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn custom_host_gitea() {
        let r = p("https://gitea.example.com/owner/repo.git");
        assert_eq!(r.host, "gitea.example.com");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn https_no_dot_git_gitlab() {
        let r = p("https://gitlab.com/owner/repo");
        assert_eq!(r.host, "gitlab.com");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
    }

    #[test]
    fn scp_style_bitbucket() {
        let r = p("git@bitbucket.org:owner/repo.git");
        assert_eq!(r.host, "bitbucket.org");
        assert_eq!(r.owner, "owner");
        assert_eq!(r.repo, "repo");
        assert!(r.is_ssh);
    }

    #[test]
    fn http_scheme() {
        let r = p("http://gitea.internal.company.com/team/project.git");
        assert_eq!(r.host, "gitea.internal.company.com");
        assert_eq!(r.repo, "project");
        assert!(!r.is_ssh);
    }

    // ── Azure DevOps ──────────────────────────────────────────────────

    #[test]
    fn azure_devops_https() {
        let r = p("https://dev.azure.com/org/project/_git/repo");
        assert_eq!(r.host, "dev.azure.com");
        assert_eq!(r.owner, "project");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn azure_devops_https_with_org_user_prefix() {
        // The URL Azure's "Clone" button hands out carries `org@`.
        let r = p("https://org@dev.azure.com/org/project/_git/repo");
        assert_eq!(r.host, "dev.azure.com");
        assert_eq!(r.owner, "project");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn azure_devops_ssh_v3() {
        let r = p("git@ssh.dev.azure.com:v3/org/project/repo");
        assert_eq!(r.host, "ssh.dev.azure.com");
        assert_eq!(r.owner, "project");
        assert_eq!(r.repo, "repo");
        assert!(r.is_ssh);
    }

    #[test]
    fn azure_devops_legacy_visualstudio_host() {
        let r = p("https://org.visualstudio.com/DefaultCollection/project/_git/repo");
        assert_eq!(r.host, "org.visualstudio.com");
        assert_eq!(r.owner, "project");
        assert_eq!(r.repo, "repo");
    }

    #[test]
    fn percent_encoded_names_decode_to_the_directory_git_would_pick() {
        let r = p("https://dev.azure.com/org/My%20Project/_git/My%20Repo");
        assert_eq!(r.owner, "My Project");
        assert_eq!(r.repo, "My Repo");
    }

    #[test]
    fn a_leading_git_marker_is_an_ordinary_owner() {
        // Only a `_git` *between* two segments is the Azure marker.
        let r = p("https://gitea.example.com/_git/repo");
        assert_eq!(r.owner, "_git");
        assert_eq!(r.repo, "repo");
    }

    #[test]
    fn a_segment_that_decodes_to_a_path_is_kept_as_written() {
        let r = p("https://example.com/owner/..%2F..%2Fescape");
        assert_eq!(r.repo, "..%2F..%2Fescape");
    }

    // ── Rejection tests ───────────────────────────────────────────────

    #[test]
    fn empty_string_is_none() {
        assert!(parse_git_url("").is_none());
    }

    #[test]
    fn plain_word_is_none() {
        assert!(parse_git_url("not a url").is_none());
    }

    #[test]
    fn bare_http_is_none() {
        assert!(parse_git_url("http://").is_none());
    }

    #[test]
    fn https_no_path_is_none() {
        assert!(parse_git_url("https://github.com").is_none());
    }

    #[test]
    fn https_only_one_segment_is_none() {
        assert!(parse_git_url("https://github.com/onlyone").is_none());
    }
}
