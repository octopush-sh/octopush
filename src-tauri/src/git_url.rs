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
    /// The `user@` in front of the host, when the URL carries one — Azure
    /// DevOps and Bitbucket clone URLs do. Git then never asks for a
    /// username, and stores the credential under this one.
    pub user: Option<String>,
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
    // A pasted URL may carry a BOM; the frontend mirror's `trim` drops it too.
    let url = url.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
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
                    user: Some(url[..at_pos].to_string()).filter(|u| !u.is_empty()),
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
    let scheme = url[..scheme_end].to_ascii_lowercase();
    let scheme = scheme.as_str();
    let rest = &url[scheme_end + 3..]; // everything after "://"

    let is_ssh = matches!(scheme, "ssh" | "git");

    // Strip optional `user@` (or `user:password@`) prefix from the authority.
    let mut user = None;
    let rest = if let Some(at) = rest.find('@') {
        // Only strip user@ if @ appears before the first /
        let slash_pos = rest.find('/').unwrap_or(usize::MAX);
        if at < slash_pos {
            let userinfo = &rest[..at];
            let name = userinfo.split(':').next().unwrap_or("");
            user = Some(decode_segment(name)).filter(|u| !u.is_empty());
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
        user,
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

    // The repo becomes a directory name; `.`/`..` would point elsewhere.
    if [&owner, &repo].iter().any(|s| matches!(s.as_str(), "" | "." | "..")) {
        return None;
    }

    Some((owner, repo))
}

/// Undo `%20`-style escapes so a repository called "My Repo" (Azure DevOps
/// allows spaces and encodes them in its clone URLs) gets a readable folder
/// name, `My Repo` (a terminal `git clone` would create `My%20Repo`). A
/// segment that decodes to something that can't be a single directory name,
/// or carries a malformed escape, is kept as written — the same cases the
/// frontend's `decodeURIComponent` mirror refuses.
fn decode_segment(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let well_formed = bytes.iter().enumerate().all(|(i, &b)| {
        b != b'%'
            || (i + 2 < bytes.len()
                && bytes[i + 1].is_ascii_hexdigit()
                && bytes[i + 2].is_ascii_hexdigit())
    });
    if !well_formed {
        return segment.to_string();
    }
    match urlencoding::decode(segment) {
        Ok(decoded)
            if !decoded.contains(|c: char| matches!(c, '/' | '\\') || c.is_control()) =>
        {
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
        assert_eq!(r.user.as_deref(), Some("org"));
        assert_eq!(r.owner, "project");
        assert_eq!(r.repo, "repo");
        assert!(!r.is_ssh);
    }

    #[test]
    fn the_url_user_is_exposed_only_when_present() {
        assert_eq!(p("https://github.com/owner/repo").user, None);
        assert_eq!(p("https://jane%40corp@bitbucket.org/ws/repo.git").user.as_deref(), Some("jane@corp"));
        assert_eq!(p("https://jane:secret@gitea.example.com/o/r").user.as_deref(), Some("jane"));
        assert_eq!(p("git@github.com:owner/repo.git").user.as_deref(), Some("git"));
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
    fn azure_devops_https_with_the_project_omitted() {
        // Allowed when the repository is named after the project.
        let r = p("https://dev.azure.com/org/_git/repo");
        assert_eq!(r.owner, "org");
        assert_eq!(r.repo, "repo");
    }

    #[test]
    fn percent_encoded_names_decode_into_a_readable_folder_name() {
        let r = p("https://dev.azure.com/org/My%20Project/_git/My%20Repo");
        assert_eq!(r.owner, "My Project");
        assert_eq!(r.repo, "My Repo");
    }

    #[test]
    fn decoding_keeps_plus_and_refuses_malformed_or_non_utf8_escapes() {
        assert_eq!(p("https://github.com/owner/c++").repo, "c++");
        assert_eq!(p("https://example.com/owner/50%off%20sale").repo, "50%off%20sale");
        assert_eq!(p("https://example.com/owner/bad%C3%28").repo, "bad%C3%28");
        assert_eq!(p("https://example.com/owner/line%0Abreak").repo, "line%0Abreak");
    }

    #[test]
    fn a_repo_that_decodes_to_a_dot_directory_is_rejected() {
        assert!(parse_git_url("https://example.com/owner/%2e%2e").is_none());
        assert!(parse_git_url("https://example.com/owner/..").is_none());
    }

    #[test]
    fn a_pasted_bom_or_nel_around_the_url_is_ignored() {
        assert_eq!(p("\u{feff}https://github.com/owner/repo\u{85}").repo, "repo");
    }

    #[test]
    fn scheme_is_case_insensitive() {
        let r = p("HTTPS://github.com/owner/repo");
        assert_eq!(r.host, "github.com");
        assert!(!r.is_ssh);
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
