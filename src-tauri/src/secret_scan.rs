//! Secret guard (#730): a local, offline check that keeps a crew's
//! credentials out of a commit, a push and a pull request.
//!
//! The sandbox stops writes OUTSIDE the worktree. It can't stop an agent that
//! read a key (from `.env`, a config file) writing it into a tracked file
//! INSIDE the worktree. This module scans only what is about to leave: the
//! added lines of the staged diff (commit), of the commits being pushed (push,
//! PR) or of the worktree's changes against its base (a crew's Action stage).
//!
//! Rules favour precision over recall: provider key prefixes with their real
//! lengths, AWS access key ids only next to a secret key, PEM private keys
//! only with key material under the header, `.env` files only for
//! credential-named variables, an entropy-gated generic assignment rule kept
//! out of test paths, and an exact-value canary for the credentials Octopush
//! itself holds (provider keys, git tokens, the Jira token).
//!
//! **Privacy.** A finding carries the file, the line, a stable rule id and a
//! human kind — never the value, a preview or a hash of it. Nothing here logs,
//! persists or sends a candidate value. Known credentials live in memory only
//! for the length of one scan and print as `[redacted]` in `Debug`.

use crate::error::{AppError, AppResult};
use git2::{Delta, Diff, DiffOptions, Oid, Repository};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

/// At most this many findings are reported: enough to act on, never a wall.
pub const MAX_FINDINGS: usize = 50;
/// A push/PR range longer than this is scanned as one net diff instead of
/// commit by commit (keeps a long-lived branch fast).
const MAX_RANGE_COMMITS: usize = 200;
/// Lines longer than this are scanned on their first N bytes only (a minified
/// bundle line must never stall the commit button).
const MAX_LINE_BYTES: usize = 16 * 1024;
/// Total added bytes looked at per scan.
const MAX_SCAN_BYTES: usize = 16 * 1024 * 1024;
/// A configured credential shorter than this is too short to match exactly
/// without false hits.
const MIN_KNOWN_SECRET_LEN: usize = 12;

/// One possible secret in a change. Deliberately carries no part of the value.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretFinding {
    /// Repo-relative path, forward slashes.
    pub file: String,
    /// 1-based line in the new file; `None` for a whole-file finding.
    pub line: Option<u32>,
    /// Stable rule id (`anthropic-key`, `github-token`, `your-credential`, …).
    pub rule: String,
    /// What it looks like, for people: "Anthropic API key".
    pub kind: String,
    /// True when it matched a credential the user configured in Octopush.
    pub yours: bool,
}

impl SecretFinding {
    /// `tests/fixtures.ts:12`, or just the file for a whole-file finding.
    pub fn location(&self) -> String {
        match self.line {
            Some(l) => format!("{}:{l}", self.file),
            None => self.file.clone(),
        }
    }
}

/// One-line summary: "Anthropic API key in tests/fixtures.ts:12" (+ "and N more").
pub fn summarize(findings: &[SecretFinding]) -> String {
    match findings {
        [] => "no possible secrets".into(),
        [f] => format!("{} in {}", f.kind, f.location()),
        [f, rest @ ..] => format!("{} in {} and {} more", f.kind, f.location(), rest.len()),
    }
}

/// A fingerprint of a set of findings (file, line, rule — never a value), so
/// a director's "proceed regardless" applies to exactly the findings they saw.
pub fn fingerprint(findings: &[SecretFinding]) -> String {
    use sha2::{Digest, Sha256};
    let mut keys: Vec<String> = findings
        .iter()
        .map(|f| format!("{}\u{0}{}\u{0}{}", f.file, f.line.unwrap_or(0), f.rule))
        .collect();
    keys.sort();
    keys.dedup();
    let mut h = Sha256::new();
    for k in keys {
        h.update(k.as_bytes());
        h.update([0xff]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// ─── Known credentials (the "that's your key" canary) ──────────────────

/// A credential Octopush holds. `Debug` never prints the value.
pub struct KnownSecret {
    label: String,
    value: String,
}

impl std::fmt::Debug for KnownSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KnownSecret").field("label", &self.label).field("value", &"[redacted]").finish()
    }
}

impl KnownSecret {
    pub fn new(label: impl Into<String>, value: impl Into<String>) -> Self {
        Self { label: label.into(), value: value.into() }
    }
}

/// A provider id as people say it ("anthropic" → "Anthropic").
fn provider_name(id: &str) -> String {
    match id.to_ascii_lowercase().as_str() {
        "anthropic" => "Anthropic".into(),
        "openai" => "OpenAI".into(),
        "google" | "gemini" => "Google".into(),
        "openrouter" => "OpenRouter".into(),
        "xai" => "xAI".into(),
        "deepseek" => "DeepSeek".into(),
        "mistral" => "Mistral".into(),
        "groq" => "Groq".into(),
        other => {
            let mut c = other.chars();
            match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => "provider".into(),
            }
        }
    }
}

/// Every credential in `settings` worth matching exactly: provider API keys,
/// git host tokens and the Jira API token.
pub fn known_secrets_from(settings: &crate::settings::AppSettings) -> Vec<KnownSecret> {
    let mut out = Vec::new();
    for (provider, key) in &settings.provider_keys {
        out.push(KnownSecret::new(format!("your {} API key", provider_name(provider)), key.trim()));
    }
    for (host, cred) in &settings.git_credentials {
        out.push(KnownSecret::new(format!("your {host} token"), cred.token.trim()));
    }
    if let Some(jira) = &settings.issue_tracker {
        out.push(KnownSecret::new("your Jira API token", jira.api_token.trim()));
    }
    out.retain(|k| k.value.len() >= MIN_KNOWN_SECRET_LEN);
    out
}

/// The guard's on/off switch (Settings › General): on unless saved `false`.
pub fn guard_enabled(settings: &crate::settings::AppSettings) -> bool {
    settings.secret_guard_enabled.unwrap_or(true)
}

// ─── Rules ─────────────────────────────────────────────────────────────

struct TokenRule {
    id: &'static str,
    kind: &'static str,
    re: Regex,
    /// For fixed-length tokens: the token must not run on into more token
    /// characters (the `regex` crate has no lookahead).
    fixed_len: bool,
}

fn rule(id: &'static str, kind: &'static str, pattern: &str, fixed_len: bool) -> TokenRule {
    TokenRule { id, kind, re: Regex::new(pattern).expect("secret rule compiles"), fixed_len }
}

static TOKEN_RULES: LazyLock<Vec<TokenRule>> = LazyLock::new(|| {
    vec![
        rule("anthropic-key", "Anthropic API key", r"\bsk-ant-[A-Za-z0-9_\-]{40,}", false),
        rule("openai-key", "OpenAI API key", r"\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{40,}", false),
        rule("openai-key", "OpenAI API key", r"\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}", true),
        rule("openai-key", "OpenAI API key", r"\bsk-[A-Za-z0-9]{48}", true),
        rule("github-token", "GitHub token", r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}", true),
        rule("github-token", "GitHub token", r"\bgithub_pat_[A-Za-z0-9_]{80,}", false),
        rule("stripe-key", "Stripe live key", r"\b(?:sk|rk)_live_[A-Za-z0-9]{24,}", false),
        rule("slack-token", "Slack token", r"\bxox[abprs]-[0-9]{6,}-[A-Za-z0-9\-]{10,}", false),
        rule("google-api-key", "Google API key", r"\bAIza[0-9A-Za-z_\-]{35}", true),
    ]
});

static AWS_KEY_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").unwrap());
/// An AWS secret access key: 40 base64 characters, either named
/// (`aws_secret_access_key = …`) or bare on the same line as the key id.
static AWS_SECRET_NAMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)secret_?(?:access_?)?key["']?\s*[:=>]+\s*["']?([A-Za-z0-9/+]{40})(?:[^A-Za-z0-9/+=]|$)"#).unwrap()
});
static AWS_SECRET_BARE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[^A-Za-z0-9/+=])([A-Za-z0-9/+]{40})(?:[^A-Za-z0-9/+=]|$)").unwrap());

static PEM_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----").unwrap()
});
/// Key material inline after the header (`…-----\nMIIEv…` in JSON/YAML).
static PEM_INLINE_BODY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"PRIVATE KEY(?: BLOCK)?-----(?:\\r)?\\n[A-Za-z0-9+/=]{40,}").unwrap()
});
/// A line of key material on the next line.
static PEM_BODY_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^[\s"'+]*[A-Za-z0-9+/=]{40,}"#).unwrap());

static ENV_ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$").unwrap()
});
static ENV_CREDENTIAL_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|AUTH)").unwrap()
});

static GENERIC_ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b[A-Za-z0-9_.\-]*(?:api[_\-]?key|apikey|secret|access[_\-]?token|auth[_\-]?token|passw(?:or)?d)[A-Za-z0-9_.\-]*["']?\s*(?::|=|:=|=>)\s*["']([^"'\s]{20,})["']"#,
    )
    .unwrap()
});

// ─── Plausibility filters ──────────────────────────────────────────────

/// Shannon entropy in bits per character.
pub fn shannon_entropy(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let mut counts = std::collections::HashMap::new();
    for c in s.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
    }
    let n = s.chars().count() as f64;
    counts.values().map(|&c| {
        let p = c as f64 / n;
        -p * p.log2()
    }).sum()
}

/// An obvious stand-in rather than a real credential: docs and examples say
/// `xxxx`, `your-key-here`, `<token>`, `EXAMPLE`, or repeat one character.
pub fn is_placeholder(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "example", "xxxx", "your_", "your-", "yourkey", "placeholder", "dummy", "redacted",
        "changeme", "change_me", "fake", "sample", "<", ">", "...", "****", "${", "{{", "%(",
        "000000", "123456", "abcdef",
    ];
    if MARKERS.iter().any(|m| lower.contains(m)) {
        return true;
    }
    // A long run of one character.
    let mut run = 1;
    let mut prev = None;
    for c in token.chars() {
        if Some(c) == prev {
            run += 1;
            if run >= 6 {
                return true;
            }
        } else {
            run = 1;
            prev = Some(c);
        }
    }
    // Too few distinct characters to be random.
    let distinct: HashSet<char> = token.chars().collect();
    distinct.len() < 10
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Paths where the generic rule stays quiet (tests deliberately hold
/// credential-shaped strings). Prefixed rules still apply there.
fn is_test_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.split('/').any(|seg| {
        matches!(seg, "test" | "tests" | "__tests__" | "spec" | "specs" | "fixtures" | "fixture" | "__mocks__" | "mocks" | "testdata")
    }) || lower.contains(".test.") || lower.contains(".spec.") || lower.ends_with("_test.go") || lower.ends_with("_test.rs")
}

fn is_lockfile(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    base.ends_with(".lock") || base == "package-lock.json" || base == "pnpm-lock.yaml" || base == "go.sum"
}

/// `.env`, `.env.local`, `.env.production`… but not the templates people commit on purpose.
pub fn is_env_file(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    if base != ".env" && !base.starts_with(".env.") {
        return false;
    }
    let suffix = base.trim_start_matches(".env").trim_start_matches('.').to_ascii_lowercase();
    !matches!(suffix.as_str(), "example" | "sample" | "template" | "dist" | "defaults" | "schema" | "tpl")
}

fn is_ssh_private_key_file(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    matches!(base, "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519" | "id_ecdsa_sk" | "id_ed25519_sk")
}

/// Strip quotes and a trailing `# comment` from a `.env` value.
fn env_value(raw: &str) -> &str {
    let v = raw.trim();
    if let Some(rest) = v.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("");
    }
    if let Some(rest) = v.strip_prefix('\'') {
        return rest.split('\'').next().unwrap_or("");
    }
    v.split(" #").next().unwrap_or("").trim()
}

fn env_value_is_credential(value: &str) -> bool {
    if value.len() < 8 || is_placeholder(value) {
        return false;
    }
    if value.starts_with('$') {
        return false; // a reference to another variable
    }
    let lower = value.to_ascii_lowercase();
    if matches!(lower.as_str(), "true" | "false" | "null" | "none") || value.parse::<f64>().is_ok() {
        return false;
    }
    // A URL is configuration, unless it carries credentials.
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return value.split("://").nth(1).is_some_and(|rest| {
            rest.split('/').next().is_some_and(|auth| auth.contains(':') && auth.contains('@'))
        });
    }
    true
}

// ─── Scanning ──────────────────────────────────────────────────────────

/// The added side of one file in a diff.
#[derive(Debug, Clone, Default)]
pub struct AddedFile {
    pub path: String,
    /// The file is newly added (not modified).
    pub is_new: bool,
    /// (1-based new line number, content without the trailing newline).
    pub lines: Vec<(u32, String)>,
}

fn push_finding(out: &mut Vec<SecretFinding>, seen: &mut HashSet<(String, Option<u32>)>, f: SecretFinding) {
    if out.len() >= MAX_FINDINGS {
        return;
    }
    if seen.insert((f.file.clone(), f.line)) {
        out.push(f);
    }
}

fn token_hit(line: &str) -> Option<&'static TokenRule> {
    for r in TOKEN_RULES.iter() {
        for m in r.re.find_iter(line) {
            if r.fixed_len && line[m.end()..].chars().next().is_some_and(is_token_char) {
                continue;
            }
            let token = m.as_str();
            // Judge randomness on the part after the fixed prefix.
            let body = token.splitn(3, ['-', '_']).last().unwrap_or(token);
            if is_placeholder(body) || shannon_entropy(body) < 3.0 {
                continue;
            }
            return Some(r);
        }
    }
    None
}

fn aws_secret_on(line: &str) -> bool {
    AWS_SECRET_NAMED.captures_iter(line).any(|c| {
        let v = c.get(1).map(|m| m.as_str()).unwrap_or("");
        !is_placeholder(v) && shannon_entropy(v) >= 3.5
    })
}

fn aws_bare_secret_on(line: &str) -> bool {
    AWS_SECRET_BARE.captures_iter(line).any(|c| {
        let v = c.get(1).map(|m| m.as_str()).unwrap_or("");
        !is_placeholder(v)
            && shannon_entropy(v) >= 3.5
            && v.chars().any(|c| c.is_ascii_lowercase())
            && v.chars().any(|c| c.is_ascii_uppercase())
    })
}

/// Scan the added lines of `files`. `known` are the credentials Octopush
/// holds; a hit on one of them is reported as "your … key" and wins over any
/// pattern on the same line.
pub fn scan_added(files: &[AddedFile], known: &[KnownSecret]) -> Vec<SecretFinding> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for file in files {
        if out.len() >= MAX_FINDINGS {
            break;
        }
        let path = file.path.as_str();
        if file.is_new && is_ssh_private_key_file(path) {
            push_finding(&mut out, &mut seen, SecretFinding {
                file: path.into(), line: None, rule: "ssh-private-key-file".into(),
                kind: "SSH private key file".into(), yours: false,
            });
        }
        let env_file = is_env_file(path);
        let generic_ok = !is_test_path(path) && !is_lockfile(path);
        // AWS needs the key id AND a secret within a few lines of it.
        let aws_secret_lines: Vec<u32> =
            file.lines.iter().filter(|(_, l)| aws_secret_on(l)).map(|(n, _)| *n).collect();

        for (idx, (n, raw)) in file.lines.iter().enumerate() {
            let line: &str = if raw.len() > MAX_LINE_BYTES {
                let mut end = MAX_LINE_BYTES;
                while !raw.is_char_boundary(end) {
                    end -= 1;
                }
                &raw[..end]
            } else {
                raw
            };
            let at = |rule: &str, kind: String, yours: bool| SecretFinding {
                file: path.into(), line: Some(*n), rule: rule.into(), kind, yours,
            };

            if let Some(k) = known.iter().find(|k| line.contains(k.value.as_str())) {
                push_finding(&mut out, &mut seen, at("your-credential", k.label.clone(), true));
                continue;
            }
            if let Some(r) = token_hit(line) {
                push_finding(&mut out, &mut seen, at(r.id, r.kind.into(), false));
                continue;
            }
            if let Some(m) = AWS_KEY_ID.find(line) {
                let near = aws_secret_lines.iter().any(|s| s.abs_diff(*n) <= 5) || aws_bare_secret_on(line);
                if near && !is_placeholder(m.as_str()) {
                    push_finding(&mut out, &mut seen, at("aws-access-key", "AWS access key".into(), false));
                    continue;
                }
            }
            if PEM_HEADER.is_match(line) {
                let inline = PEM_INLINE_BODY.is_match(line);
                let next = file
                    .lines
                    .get(idx + 1)
                    .filter(|(m, _)| *m == n + 1)
                    .is_some_and(|(_, l)| PEM_BODY_LINE.is_match(l));
                if inline || next {
                    push_finding(&mut out, &mut seen, at("private-key", "private key".into(), false));
                    continue;
                }
            }
            if env_file {
                if let Some(c) = ENV_ASSIGN.captures(line) {
                    let name = c.get(1).map(|m| m.as_str()).unwrap_or("");
                    let value = env_value(c.get(2).map(|m| m.as_str()).unwrap_or(""));
                    if ENV_CREDENTIAL_NAME.is_match(name) && env_value_is_credential(value) {
                        push_finding(&mut out, &mut seen, at("env-credential", format!("credential in a .env file ({name})"), false));
                        continue;
                    }
                }
            }
            if generic_ok {
                let hit = GENERIC_ASSIGN.captures_iter(line).any(|c| {
                    let v = c.get(1).map(|m| m.as_str()).unwrap_or("");
                    !is_placeholder(v)
                        && shannon_entropy(v) > 4.0
                        && v.chars().any(|c| c.is_ascii_digit())
                        && v.chars().any(|c| c.is_ascii_alphabetic())
                        && !v.contains("://")
                });
                if hit {
                    push_finding(&mut out, &mut seen, at("generic-secret", "hard-coded secret".into(), false));
                }
            }
        }
    }
    out
}

// ─── Collecting the added side of a diff ───────────────────────────────

fn opts() -> DiffOptions {
    let mut o = DiffOptions::new();
    o.context_lines(0);
    o
}

/// Collect the added lines of `diff`, appending to `files` (keyed by path).
/// `budget` counts down the scanned bytes across one scan.
fn collect_added(diff: &Diff, files: &mut Vec<AddedFile>, budget: &mut usize) -> AppResult<()> {
    let mut index: std::collections::HashMap<String, usize> =
        files.iter().enumerate().map(|(i, f)| (f.path.clone(), i)).collect();
    // Register every delta first so a newly added empty or binary file is
    // still seen (its name alone can be the finding).
    for delta in diff.deltas() {
        if matches!(delta.status(), Delta::Deleted) {
            continue;
        }
        let Some(path) = delta.new_file().path().map(|p| p.to_string_lossy().replace('\\', "/")) else { continue };
        let is_new = matches!(delta.status(), Delta::Added | Delta::Untracked);
        match index.get(&path) {
            Some(&i) => files[i].is_new |= is_new,
            None => {
                index.insert(path.clone(), files.len());
                files.push(AddedFile { path, is_new, lines: Vec::new() });
            }
        }
    }
    let result = diff.foreach(
        &mut |_, _| true,
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            if line.origin() != '+' {
                return true;
            }
            if *budget == 0 {
                return false;
            }
            let Some(n) = line.new_lineno() else { return true };
            let Some(path) = delta.new_file().path().map(|p| p.to_string_lossy().replace('\\', "/")) else { return true };
            let content = line.content();
            *budget = budget.saturating_sub(content.len());
            let text = String::from_utf8_lossy(content).trim_end_matches(['\n', '\r']).to_string();
            if let Some(&i) = index.get(&path) {
                files[i].lines.push((n, text));
            }
            true
        }),
    );
    match result {
        Ok(()) => Ok(()),
        // Our own callback stopped it: the byte budget ran out.
        Err(e) if e.code() == git2::ErrorCode::User => Ok(()),
        Err(e) => Err(AppError::Other(format!("secret scan: reading the diff failed: {e}"))),
    }
}

fn tree_of(repo: &Repository, oid: Oid) -> AppResult<git2::Tree<'_>> {
    repo.find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| AppError::Other(format!("secret scan: {e}")))
}

/// The staged change a commit would record (HEAD → index).
pub fn staged_files(path: &Path) -> AppResult<Vec<AddedFile>> {
    let repo = crate::git_ops::open_repo(path)?;
    let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let index = repo.index().map_err(|e| AppError::Other(format!("secret scan: index: {e}")))?;
    let diff = repo
        .diff_tree_to_index(head.as_ref(), Some(&index), Some(&mut opts()))
        .map_err(|e| AppError::Other(format!("secret scan: staged diff: {e}")))?;
    let mut files = Vec::new();
    let mut budget = MAX_SCAN_BYTES;
    collect_added(&diff, &mut files, &mut budget)?;
    Ok(files)
}

/// The added lines of every commit in `hide..head` (each against its first
/// parent), so a secret added in one commit and removed in the next is still
/// caught. A range longer than [`MAX_RANGE_COMMITS`] is scanned as one net diff.
fn range_files(repo: &Repository, hide: Option<Oid>, head: Oid, budget: &mut usize) -> AppResult<Vec<AddedFile>> {
    let mut files = Vec::new();
    let mut walk = repo.revwalk().map_err(|e| AppError::Other(format!("secret scan: {e}")))?;
    walk.push(head).map_err(|e| AppError::Other(format!("secret scan: {e}")))?;
    if let Some(h) = hide {
        walk.hide(h).map_err(|e| AppError::Other(format!("secret scan: {e}")))?;
    }
    let commits: Vec<Oid> = walk.filter_map(|o| o.ok()).take(MAX_RANGE_COMMITS + 1).collect();
    if commits.len() > MAX_RANGE_COMMITS {
        let from = match hide {
            Some(h) => Some(tree_of(repo, h)?),
            None => None,
        };
        let to = tree_of(repo, head)?;
        let diff = repo
            .diff_tree_to_tree(from.as_ref(), Some(&to), Some(&mut opts()))
            .map_err(|e| AppError::Other(format!("secret scan: {e}")))?;
        collect_added(&diff, &mut files, budget)?;
        return Ok(files);
    }
    for oid in commits {
        let commit = repo.find_commit(oid).map_err(|e| AppError::Other(format!("secret scan: {e}")))?;
        let to = commit.tree().map_err(|e| AppError::Other(format!("secret scan: {e}")))?;
        let from = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let diff = repo
            .diff_tree_to_tree(from.as_ref(), Some(&to), Some(&mut opts()))
            .map_err(|e| AppError::Other(format!("secret scan: {e}")))?;
        collect_added(&diff, &mut files, budget)?;
        if *budget == 0 {
            break;
        }
    }
    Ok(files)
}

/// The commit already on the remote that a push from HEAD starts after: the
/// branch's upstream, else the remote's default branch. `None` when the
/// remote has nothing in common (a first push: everything is new).
fn push_base(repo: &Repository, head: Oid) -> Option<Oid> {
    let upstream = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_string))
        .and_then(|b| repo.find_branch(&b, git2::BranchType::Local).ok())
        .and_then(|b| b.upstream().ok())
        .and_then(|u| u.get().target());
    let candidates = upstream.into_iter().chain(
        ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"]
            .iter()
            .filter_map(|r| repo.revparse_single(r).ok().and_then(|o| o.peel_to_commit().ok()).map(|c| c.id())),
    );
    for c in candidates {
        if let Ok(mb) = repo.merge_base(c, head) {
            return Some(mb);
        }
    }
    None
}

/// The commits a push of the current branch would send.
pub fn push_files(path: &Path) -> AppResult<Vec<AddedFile>> {
    let repo = crate::git_ops::open_repo(path)?;
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else { return Ok(Vec::new()) };
    let base = push_base(&repo, head);
    let mut budget = MAX_SCAN_BYTES;
    range_files(&repo, base, head, &mut budget)
}

/// The merge base of HEAD with `base` (resolved like the PR it opens:
/// `pr_target`'s remote ref first, then the local name).
fn pr_merge_base(repo: &Repository, base: &str, head: Oid) -> Option<Oid> {
    let branch = crate::git_ops::current_branch(repo).unwrap_or_default();
    let target = crate::git_ops::pr_target(repo, base, &branch);
    let mut refs: Vec<String> =
        target.base_remote.iter().map(|r| format!("{r}/{}", target.base_branch)).collect();
    refs.push(target.base_branch.clone());
    refs.push(base.to_string());
    refs.iter()
        .find_map(|r| repo.revparse_single(r).ok().and_then(|o| o.peel_to_commit().ok()))
        .and_then(|c| repo.merge_base(c.id(), head).ok())
}

/// The commits a pull request from HEAD onto `base` contains.
pub fn pr_files(path: &Path, base: &str) -> AppResult<Vec<AddedFile>> {
    let repo = crate::git_ops::open_repo(path)?;
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else { return Ok(Vec::new()) };
    let mb = pr_merge_base(&repo, base, head).or_else(|| push_base(&repo, head));
    let mut budget = MAX_SCAN_BYTES;
    range_files(&repo, mb, head, &mut budget)
}

/// Everything a crew's Action stage could commit and push: the branch's
/// commits since `base` (or the remote's default branch) plus the worktree's
/// uncommitted changes, staged or not, untracked files included (ignored files
/// excluded, as `git add -A` would).
pub fn worktree_files(path: &Path, base: Option<&str>) -> AppResult<Vec<AddedFile>> {
    let repo = crate::git_ops::open_repo(path)?;
    let mut budget = MAX_SCAN_BYTES;
    let head = repo.head().ok().and_then(|h| h.target());
    let mut files = match head {
        Some(h) => {
            let mb = base.and_then(|b| pr_merge_base(&repo, b, h)).or_else(|| push_base(&repo, h));
            // HEAD's own commits only when they aren't on the base already.
            if mb == Some(h) { Vec::new() } else { range_files(&repo, mb, h, &mut budget)? }
        }
        None => Vec::new(),
    };
    let head_tree = head.map(|h| tree_of(&repo, h)).transpose()?;
    let mut o = opts();
    o.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut o))
        .map_err(|e| AppError::Other(format!("secret scan: worktree diff: {e}")))?;
    collect_added(&diff, &mut files, &mut budget)?;
    Ok(files)
}

// ─── Enforcement ───────────────────────────────────────────────────────

/// Block when `findings` is non-empty and the user hasn't explicitly allowed
/// this one action.
pub fn enforce(findings: Vec<SecretFinding>, allow: bool) -> AppResult<()> {
    if findings.is_empty() || allow {
        return Ok(());
    }
    Err(AppError::SecretsFound { findings })
}

/// The commands' entry point: when the guard is on and `allow` isn't set,
/// collect with `files` and block on any finding. A scan that can't read the
/// repository never blocks (the git command that follows reports the real
/// problem); it is logged without any diff content.
pub fn guard(allow: bool, files: impl FnOnce() -> AppResult<Vec<AddedFile>>) -> AppResult<()> {
    if allow {
        return Ok(());
    }
    let settings = crate::settings::load_settings().unwrap_or_default();
    if !guard_enabled(&settings) {
        return Ok(());
    }
    let files = match files() {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("secret guard skipped: {e}");
            return Ok(());
        }
    };
    let known = known_secrets_from(&settings);
    enforce(scan_added(&files, &known), false)
}

/// A Direct stage held by the guard, persisted on `run_stages.secret_hold`.
/// `acknowledged` flips when the director approves the held stage: the
/// stage may then start once past exactly these findings (same fingerprint).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretHold {
    pub acknowledged: bool,
    pub fingerprint: String,
    pub findings: Vec<SecretFinding>,
}

/// The journal line for a held stage: "Held before the pull request: possible
/// secret · Anthropic API key in tests/fixtures.ts:12".
pub fn hold_notice(stage_label: &str, findings: &[SecretFinding]) -> String {
    let what = if findings.len() == 1 { "possible secret" } else { "possible secrets" };
    format!("Held before {stage_label}: {what} · {}", summarize(findings))
}
