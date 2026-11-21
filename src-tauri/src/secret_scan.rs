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
//! only with key material under the header, `.env` files and MCP configs'
//! `env` entries only for credential-named variables, a few files by name
//! (`id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
//! `.claude/settings.local.json`), an entropy-gated
//! generic assignment rule (with its own path for 32+ char hex values) kept
//! out of test paths, and an exact-value canary for the credentials Octopush
//! itself holds (provider keys, git tokens, the Jira token).
//!
//! **Privacy.** A finding carries the file, the line, a stable rule id, a
//! human kind and a masked preview (`sk-ant-…9fQ2`, #820) — never the value
//! or a hash of it. The preview reaches the screen only: summaries, the
//! journal and a persisted hold leave it out. Nothing here logs, persists or
//! sends a candidate value. Known credentials live in memory only
//! for the length of one scan and print as `[redacted]` in `Debug`.
//!
//! **Binding an override to what was shown.** A scan's [`ScanReport`] carries
//! a fingerprint over EVERY finding (not just the first [`MAX_FINDINGS`]
//! shown), the total count and whether the scan was partial. Each finding's
//! key includes a keyed hash (HMAC-SHA256) of the matched value, so editing
//! the value on the same line yields a new fingerprint and a new question.
//! The HMAC key is 256 random bits kept in `~/.octopush/secret-guard.key`
//! (0600): a per-process key would break a Direct hold the director approved
//! in the app but that a detached worker (another process) or a restarted app
//! re-checks. The per-value hashes never leave this module; only the
//! aggregate fingerprint (a hash of hashes) is returned, shown to nobody and
//! stored on a held stage.

use crate::error::{AppError, AppResult};
use git2::{Delta, Diff, DiffOptions, Oid, Repository};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

/// At most this many findings are reported: enough to act on, never a wall.
pub const MAX_FINDINGS: usize = 50;
/// A push/PR range longer than this is scanned as one net diff instead of
/// commit by commit (keeps a long-lived branch fast). The on-demand branch
/// scan has no cap: it promises every commit.
const MAX_RANGE_COMMITS: usize = 200;
/// The generic assignment rule looks at the first N bytes of a line only (a
/// minified bundle line must never stall the commit button). Every other rule
/// — the prefixed provider keys, your own credentials, AWS, private keys and
/// `.env` credentials — reads the whole line: their regexes are linear.
const MAX_LINE_BYTES: usize = 16 * 1024;
/// Total added bytes looked at per scan.
const MAX_SCAN_BYTES: usize = 16 * 1024 * 1024;
/// A configured credential shorter than this is too short to match exactly
/// without false hits.
const MIN_KNOWN_SECRET_LEN: usize = 12;

/// One possible secret in a change. Carries no part of the value beyond its
/// masked `preview`, which only the confirm dialog and the branch scan show.
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
    /// `sk-ant-…9fQ2`: the provider's public prefix (prefixed token rules
    /// and AWS key ids only; `…4bYw` for any other rule) and the last
    /// [`PREVIEW_TAIL`] characters, to tell two keys apart (#820). `None`
    /// for a whole-file finding, a private key or a short value. Never in a
    /// summary, the journal, a log line or a persisted hold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// How many trailing characters a masked preview shows.
pub const PREVIEW_TAIL: usize = 4;
/// A value with fewer characters than this after its prefix gets no
/// preview: four of them would be too large a part of it.
const MIN_PREVIEW_LEN: usize = 16;

/// The public prefixes a preview may keep, longest first (leftmost-first
/// alternation): what tells an Anthropic key from an OpenAI one, never a
/// character of the random part.
static PUBLIC_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^(?:sk-ant-|sk-(?:proj|svcacct|admin)-|sk-or-v1-|sk-|github_pat_|gh[pousr]_|(?:sk|rk)_live_|xox[abprs]-|xapp-|AIza|xai-|gsk_|hf_|glpat-|npm_|AKIA|ASIA)",
    )
    .unwrap()
});

/// `sk-ant-…9fQ2` for `value`, or `None` when it is too short to show any
/// of it. Only for a value a prefixed token rule (or the AWS key id rule)
/// matched, where the prefix is the provider's: any other value gets
/// [`masked_tail`]. Pure.
pub fn masked_preview(value: &str) -> Option<String> {
    let prefix = PUBLIC_PREFIX.find(value).map(|m| m.as_str()).unwrap_or("");
    masked(prefix, &value[prefix.len()..])
}

/// `…4bYw` for `value`: the last [`PREVIEW_TAIL`] characters alone, for a
/// value no provider prefix vouches for (a `.env` password, an MCP env
/// value, a generic assignment, one of your own keys), whose first
/// characters are as secret as the rest. Pure.
pub fn masked_tail(value: &str) -> Option<String> {
    masked("", value)
}

fn masked(prefix: &str, rest: &str) -> Option<String> {
    let n = rest.chars().count();
    if n < MIN_PREVIEW_LEN {
        return None;
    }
    let tail: String = rest.chars().skip(n - PREVIEW_TAIL).collect();
    Some(format!("{prefix}…{tail}"))
}

impl SecretFinding {
    /// This finding with a masked preview of `value`, provider prefix kept.
    fn masked(mut self, value: &str) -> Self {
        self.preview = masked_preview(value);
        self
    }

    /// This finding with a tail-only preview of `value`.
    fn masked_tail(mut self, value: &str) -> Self {
        self.preview = masked_tail(value);
        self
    }

    /// This finding without its preview (what a persisted hold keeps).
    pub fn without_preview(self) -> Self {
        SecretFinding { preview: None, ..self }
    }

    /// `tests/fixtures.ts:12`, or just the file for a whole-file finding.
    pub fn location(&self) -> String {
        match self.line {
            Some(l) => format!("{}:{l}", self.file),
            None => self.file.clone(),
        }
    }
}

/// The one-line refusal text: the summary, "and N more" counted against the
/// TOTAL (not the capped list), and the partial-scan note.
pub fn refusal_summary(findings: &[SecretFinding], total: usize, partial: bool) -> String {
    let mut out = match findings {
        [] => String::new(),
        [f, ..] if total <= 1 => format!("{} in {}", f.kind, f.location()),
        [f, ..] => format!("{} in {} and {} more", f.kind, f.location(), total - 1),
    };
    if partial {
        if !out.is_empty() {
            out.push_str(" · ");
        }
        out.push_str(PARTIAL_NOTE);
    }
    if out.is_empty() {
        out = "no possible secrets".into();
    }
    out
}

/// Shown whenever the byte budget ran out before the scan reached the end.
pub const PARTIAL_NOTE: &str = "scanned the first 16 MB; the rest wasn't checked";

// ─── Fingerprint ───────────────────────────────────────────────────────

/// The HMAC key for per-value hashes. Tests use a fresh random key per
/// process; the app keeps one per install (see the module docs for why).
static VALUE_KEY: LazyLock<[u8; 32]> = LazyLock::new(|| {
    #[cfg(not(test))]
    {
        match dirs::home_dir() {
            Some(home) => {
                if let Some(k) = load_or_create_key_in(&home.join(".octopush")) {
                    return k;
                }
            }
            None => tracing::warn!("secret guard: no home folder for its key"),
        }
        tracing::warn!(
            "secret guard: using a key for this process only; a held stage the director approved will ask again after a restart or in a detached worker"
        );
    }
    random_key()
});

fn random_key() -> [u8; 32] {
    // Two v4 UUIDs: 244 bits from the OS CSPRNG (uuid uses getrandom).
    let mut k = [0u8; 32];
    k[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    k[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    k
}

/// The file the per-install key lives in, inside `dir`.
pub(crate) const KEY_FILE: &str = "secret-guard.key";

fn parse_key(s: &str) -> Option<[u8; 32]> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut k = [0u8; 32];
    for (i, b) in k.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(k)
}

/// Load the key from `dir/secret-guard.key`, or create it there. The new key
/// is written to a temp file (0600, synced) and only then linked into place,
/// so a crash mid-write never leaves an empty or half-written key: an
/// existing file is never overwritten unless it is corrupt. When two
/// processes race, the one that links second uses the first one's key.
/// `None` (with a warning) when the key can't be read or written; the
/// caller then falls back to a per-process key.
pub(crate) fn load_or_create_key_in(dir: &Path) -> Option<[u8; 32]> {
    use std::io::Write;
    let path = dir.join(KEY_FILE);
    let mut corrupt = false;
    match std::fs::read_to_string(&path) {
        Ok(s) => match parse_key(&s) {
            Some(k) => return Some(k),
            None => {
                tracing::warn!("secret guard: {} is corrupt; writing a new key", path.display());
                corrupt = true;
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!("secret guard: can't read {}: {e}", path.display());
            return None;
        }
    }
    let warn = |what: &str, e: &dyn std::fmt::Display| {
        tracing::warn!("secret guard: can't {what} {}: {e}", path.display());
    };
    if let Err(e) = std::fs::create_dir_all(dir) {
        warn("create the folder for", &e);
        return None;
    }
    let k = random_key();
    let hex: String = k.iter().map(|b| format!("{b:02x}")).collect();
    let tmp = dir.join(format!("{KEY_FILE}.tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let written = o.open(&tmp).and_then(|mut f| {
        f.write_all(hex.as_bytes())?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        warn("write", &e);
        return None;
    }
    // A corrupt key is replaced; otherwise link, which fails if another
    // process got there first (then theirs is read back below).
    let placed = if corrupt { std::fs::rename(&tmp, &path) } else { std::fs::hard_link(&tmp, &path) };
    let _ = std::fs::remove_file(&tmp);
    if let Err(e) = &placed {
        if e.kind() != std::io::ErrorKind::AlreadyExists {
            warn("write", e);
            return None;
        }
    }
    match std::fs::read_to_string(&path).ok().and_then(|s| parse_key(&s)) {
        Some(theirs) => Some(theirs),
        None => {
            warn("read back", &"the key file is unreadable or corrupt");
            None
        }
    }
}

fn hmac_sha256(key: &[u8; 32], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for (i, b) in key.iter().enumerate() {
        ipad[i] ^= b;
        opad[i] ^= b;
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(&inner[..]);
    let mut out = [0u8; 32];
    out.copy_from_slice(&outer.finalize()[..]);
    out
}

/// The keyed hash of one matched value. Stays inside this module.
fn value_tag(value: &str) -> [u8; 32] {
    hmac_sha256(&VALUE_KEY, value.as_bytes())
}

/// One detection: the value-free finding plus the keyed hash of its value.
/// A hit whose value lies inside one already reported on the line (an `.env`
/// value that is a provider key, a generic assignment of your own key) is
/// hashed into the fingerprint but not `shown` as a second finding.
struct Hit {
    finding: SecretFinding,
    tag: [u8; 32],
    shown: bool,
}

/// Fingerprint over the scope (`commit`, `push`, `pr`, `worktree`), every hit
/// (file, line, rule, keyed value hash), the total, the partial flag and,
/// for a partial scan, what wasn't scanned (paths with blob ids or, for a
/// worktree file git hasn't hashed, its size, mtime, inode and ctime; commits),
/// so a confirmed partial scan can't cover a different unread blob later.
/// Order-independent.
fn fingerprint_hits(hits: &[Hit], scope: &str, partial: bool, unscanned: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut keys: Vec<String> = hits
        .iter()
        .map(|h| {
            let tag = hex(&h.tag);
            format!("{}\u{0}{}\u{0}{}\u{0}{tag}", h.finding.file, h.finding.line.unwrap_or(0), h.finding.rule)
        })
        .collect();
    keys.sort();
    keys.dedup();
    let mut h = Sha256::new();
    h.update(format!("v3\u{0}{scope}\u{0}{}\u{0}{}", keys.len(), partial).as_bytes());
    for k in keys {
        h.update(k.as_bytes());
        h.update([0xff]);
    }
    if partial {
        let mut skipped: Vec<&String> = unscanned.iter().collect();
        skipped.sort();
        skipped.dedup();
        h.update([0xfe]);
        for u in skipped {
            h.update(u.as_bytes());
            h.update([0xff]);
        }
    }
    hex(&h.finalize())
}

/// Lower-case hex of `bytes`, without a `format!` per byte (a fingerprint
/// can cover a hundred thousand hits).
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0xf) as usize] as char);
    }
    out
}

/// What one scan found: the first [`MAX_FINDINGS`] findings to show, the
/// total, whether the byte budget cut the scan short, and the fingerprint of
/// all of it (what an override must echo back).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanReport {
    pub findings: Vec<SecretFinding>,
    pub total: usize,
    pub partial: bool,
    pub fingerprint: String,
}

impl ScanReport {
    /// A finding, or a scan that didn't reach the end: both ask first.
    pub fn needs_confirmation(&self) -> bool {
        self.total > 0 || self.partial
    }
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
        // Formats per TruffleHog's detectors (openrouter, xai, groq) and
        // gitleaks' rules (huggingface-access-token, gitlab-pat[-routable],
        // npm-access-token, slack-app-token; Slack's lengths tightened).
        rule("openrouter-key", "OpenRouter API key", r"\bsk-or-v1-[0-9a-f]{64}", true),
        rule("xai-key", "xAI API key", r"\bxai-[0-9A-Za-z_]{80}", true),
        rule("groq-key", "Groq API key", r"\bgsk_[A-Za-z0-9]{52}", true),
        rule("huggingface-token", "Hugging Face token", r"\bhf_[A-Za-z]{34}", true),
        rule("gitlab-token", "GitLab token", r"\bglpat-[A-Za-z0-9_\-]{20,}", false),
        rule("npm-token", "npm token", r"\bnpm_[A-Za-z0-9]{36}", true),
        rule("slack-token", "Slack app token", r"(?i)\bxapp-[0-9]-[A-Z0-9]{8,}-[0-9]{8,}-[a-z0-9]{32,}", false),
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
/// Key material, or an encrypted key's `Proc-Type:` header, inline after the
/// header (`…-----\nMIIEv…` in JSON/YAML).
static PEM_INLINE_BODY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"PRIVATE KEY(?: BLOCK)?-----(?:\\r)?\\n(?:Proc-Type:|[A-Za-z0-9+/=]{40,})").unwrap()
});
/// A line of key material — or a legacy encrypted key's `Proc-Type: 4,ENCRYPTED`
/// header — on the next line.
static PEM_BODY_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^[\s"'+]*(?:Proc-Type:|[A-Za-z0-9+/=]{40,})"#).unwrap());

/// A `NEXT_PUBLIC_*` assignment: Next.js inlines these into the browser
/// bundle, so they are public by design (a prefixed provider key there is
/// still flagged).
static NEXT_PUBLIC_ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bNEXT_PUBLIC_[A-Za-z0-9_]*["']?\s*(?::|=|:=|=>)"#).unwrap()
});
/// A Firebase web config's tell-tale keys: its `apiKey` is a public
/// identifier, not a credential (Firebase docs).
static FIREBASE_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"authDomain|firebaseapp\.com|messagingSenderId|storageBucket").unwrap()
});
static JWT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]*$").unwrap()
});

static ENV_ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$").unwrap()
});
static ENV_CREDENTIAL_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|AUTH)").unwrap()
});

/// A `"NAME": "value"` pair with an UPPER_SNAKE name: the shape of an entry
/// in an MCP server's `env` block.
static MCP_ENV_PAIR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""([A-Z][A-Z0-9_]*)"\s*:\s*"([^"]*)""#).unwrap()
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
    let n = s.chars().count() as f64;
    let term = |c: usize| {
        let p = c as f64 / n;
        -p * p.log2()
    };
    // Tokens are ASCII: count into an array (a scan can judge a hundred
    // thousand of them; a hash map per token dominated that).
    if s.is_ascii() {
        let mut counts = [0usize; 128];
        for b in s.bytes() {
            counts[b as usize] += 1;
        }
        return counts.iter().filter(|&&c| c > 0).map(|&c| term(c)).sum();
    }
    let mut counts = std::collections::HashMap::new();
    for c in s.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
    }
    counts.values().map(|&c| term(c)).sum()
}

/// How many distinct characters `s` holds.
fn distinct_chars(s: &str) -> usize {
    if s.is_ascii() {
        let mut seen = [false; 128];
        for b in s.bytes() {
            seen[b as usize] = true;
        }
        return seen.iter().filter(|&&x| x).count();
    }
    s.chars().collect::<HashSet<char>>().len()
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
    distinct_chars(token) < 10
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

/// Prose docs, where example JWTs are illustrations.
fn is_doc_file(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".md", ".mdx", ".markdown", ".rst", ".adoc", ".txt"].iter().any(|e| lower.ends_with(e))
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

/// A file whose name alone makes a newly added copy a finding, whatever it
/// holds: (rule id, kind).
fn sensitive_file(path: &str) -> Option<(&'static str, &'static str)> {
    let base = path.rsplit('/').next().unwrap_or(path);
    if matches!(base, "id_rsa" | "id_dsa" | "id_ecdsa" | "id_ed25519" | "id_ecdsa_sk" | "id_ed25519_sk") {
        return Some(("ssh-private-key-file", "SSH private key file"));
    }
    let lower = base.to_ascii_lowercase();
    if lower.ends_with(".pem") {
        return Some(("pem-file", "PEM file"));
    }
    if [".p12", ".pfx", ".jks"].iter().any(|e| lower.ends_with(e)) {
        return Some(("keystore-file", "certificate or keystore file"));
    }
    // A zip `.key` is a Keynote document: `scan_hits` skips it.
    if lower.ends_with(".key") {
        return Some(("key-file", "private key file"));
    }
    if path == ".claude/settings.local.json" || path.ends_with("/.claude/settings.local.json") {
        return Some(("claude-local-settings", "Claude Code local settings"));
    }
    None
}

/// A project MCP config: Claude Code's `.mcp.json` or `.claude/mcp.json`,
/// Cursor's `.cursor/mcp.json`, VS Code's `.vscode/mcp.json`.
fn is_mcp_config(path: &str) -> bool {
    [".mcp.json", ".claude/mcp.json", ".cursor/mcp.json", ".vscode/mcp.json"]
        .iter()
        .any(|f| path == *f || path.ends_with(&format!("/{f}")))
}

/// The zip local-file signature: a Keynote document (`.key`) starts with it.
const ZIP_MAGIC: &[u8; 4] = b"PK\x03\x04";

/// A hex value of 32+ characters: below the generic rule's 4 bits/char by
/// construction, so it gets its own path.
fn is_hex_secret(v: &str) -> bool {
    v.len() >= 32
        && v.bytes().all(|b| b.is_ascii_hexdigit())
        && v.bytes().any(|b| b.is_ascii_digit())
        && v.bytes().any(|b| b.is_ascii_alphabetic())
        && shannon_entropy(v) > 3.0
}

/// A name for a digest of something, not the thing (`password_hash`).
fn names_a_digest(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["hash", "digest", "checksum", "sha1", "sha256", "md5"].iter().any(|m| lower.contains(m))
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
    /// Lines the diff didn't add that continue a PEM block (an unchanged
    /// line inside the key, or the block's rest after its last added line),
    /// read from the file's new side: the lines right after `lines[i]`,
    /// keyed by `i`.
    pub unchanged: BTreeMap<usize, Vec<String>>,
    /// The new side starts like a zip archive ([`ZIP_MAGIC`]). Read only for
    /// a `*.key` file: a zip one is a Keynote document, not a key.
    pub zip: bool,
}

type SeenKey = (String, Option<u32>, String, [u8; 32]);

/// Record a hit unless this file, line, rule and value were already recorded
/// (two different values on one line are two findings). `shown: false`
/// hashes the value into the fingerprint without listing it again.
fn push_hit(out: &mut Vec<Hit>, seen: &mut HashSet<SeenKey>, finding: SecretFinding, value: &str, shown: bool) {
    let tag = value_tag(value);
    if seen.insert((finding.file.clone(), finding.line, finding.rule.clone(), tag)) {
        out.push(Hit { finding, tag, shown });
    }
}

/// The byte spans of one line already reported, kept non-overlapping and
/// keyed by start, so "is this match inside one we have?" is a log-time
/// lookup instead of a scan of every earlier value (a minified line can
/// carry a hundred thousand tokens).
#[derive(Default)]
struct Spans(BTreeMap<usize, usize>);

impl Spans {
    /// Whether `[start, end)` overlaps a claimed span. The spans never
    /// overlap one another, so the one starting last before `end` also ends
    /// last: checking it alone is enough.
    fn overlaps(&self, start: usize, end: usize) -> bool {
        self.0.range(..end).next_back().is_some_and(|(_, &e)| e > start)
    }

    /// Claim `[start, end)` unless it overlaps a claimed span; whether it did.
    fn claim(&mut self, start: usize, end: usize) -> bool {
        if self.overlaps(start, end) {
            return false;
        }
        self.0.insert(start, end);
        true
    }
}

/// Every prefixed-token hit on `line` with its matched span and whether to
/// list it. `skip_google` drops the Google rule (a Firebase web config or a
/// `NEXT_PUBLIC_*` value). Each listed token is claimed, so two rules
/// matching one token list the first. A token overlapping a claimed span
/// (your own credential, or a token an earlier rule listed), even only
/// partly, is still returned unlisted: it is hashed into the fingerprint, so
/// editing its part outside your key asks again. Linear in the matches.
fn token_hits(line: &str, skip_google: bool, claimed: &mut Spans) -> Vec<(&'static TokenRule, usize, usize, bool)> {
    let mut out = Vec::new();
    for r in TOKEN_RULES.iter() {
        if skip_google && r.id == "google-api-key" {
            continue;
        }
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
            // Your own key (reported as yours), or a token an earlier rule
            // matched (`sk-…` shapes): list the first, hash this one too.
            let shown = claimed.claim(m.start(), m.end());
            out.push((r, m.start(), m.end(), shown));
        }
    }
    out
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

/// The entries of `sorted` (by line number) within `w` lines of `n`.
fn window_of<T>(sorted: &[(u32, T)], n: u32, w: u32) -> &[(u32, T)] {
    let lo = sorted.partition_point(|(x, _)| *x < n.saturating_sub(w));
    let hi = sorted.partition_point(|(x, _)| *x <= n.saturating_add(w));
    &sorted[lo..hi.max(lo)]
}

/// Whether `sorted` holds a line number within `w` lines of `n`.
fn any_within(sorted: &[u32], n: u32, w: u32) -> bool {
    let i = sorted.partition_point(|x| *x < n.saturating_sub(w));
    sorted.get(i).is_some_and(|x| *x <= n.saturating_add(w))
}

/// The most of a PEM block hashed into the fingerprint.
const MAX_PEM_BYTES: usize = 64 * 1024;

/// The whole PEM block whose header starts at byte `start` of `lines[idx]`:
/// the header line from that offset through the line holding the matching
/// `-----END …-----` (or through the last line it can read, stopping before
/// the next PEM header line), bounded to [`MAX_PEM_BYTES`]. A gap in the
/// added lines' numbers is read from `unchanged` ([`AddedFile::unchanged`]),
/// so two keys alike up to an unchanged line inside them don't hash alike.
/// Hashing only the header and the first body line would hash a constant for
/// an unencrypted OpenSSH key (and the `Proc-Type:` line for a legacy
/// encrypted one).
pub(crate) fn pem_block(
    lines: &[(u32, String)],
    unchanged: &BTreeMap<usize, Vec<String>>,
    idx: usize,
    start: usize,
    header: &str,
) -> String {
    pem_walk(lines, idx, start, header, &mut |j, n| {
        let off = n.checked_sub(lines[j].0.saturating_add(1))? as usize;
        unchanged.get(&j)?.get(off).cloned()
    })
}

/// The walk behind [`pem_block`]. `gap(j, n)` is line `n` of the file when
/// the diff didn't add it, `j` the index of the last added line walked.
fn pem_walk(
    lines: &[(u32, String)],
    idx: usize,
    start: usize,
    header: &str,
    gap: &mut dyn FnMut(usize, u32) -> Option<String>,
) -> String {
    let end_marker = header.replacen("-----BEGIN ", "-----END ", 1);
    let (first_n, line) = &lines[idx];
    // From the header on: on a long line the bytes before it are unrelated,
    // and the cap must not spend itself on them.
    let first = line.get(start..).unwrap_or(line.as_str());
    let mut v = String::new();
    let push = |v: &mut String, l: &str| {
        let room = MAX_PEM_BYTES.saturating_sub(v.len());
        let mut cut = l.len().min(room);
        while !l.is_char_boundary(cut) {
            cut -= 1;
        }
        v.push_str(&l[..cut]);
        v.push('\u{0}');
    };
    push(&mut v, first);
    // The header line itself may carry the END (inline JSON/YAML).
    let after_header = first.find(header).map(|i| i + header.len()).unwrap_or(first.len());
    if !end_marker.is_empty() && first[after_header..].contains(&end_marker) {
        return v;
    }
    // `j`: the last added line walked; `n`: the line number read next.
    let (mut j, mut n) = (idx, first_n.saturating_add(1));
    while v.len() < MAX_PEM_BYTES {
        let l = if lines.get(j + 1).is_some_and(|(m, _)| *m == n) {
            j += 1;
            Cow::Borrowed(lines[j].1.as_str())
        } else {
            match gap(j, n) {
                Some(l) => Cow::Owned(l),
                None => break,
            }
        };
        // A new header starts its own block: repeated headers with no END
        // must not each walk the next MAX_PEM_BYTES.
        if PEM_HEADER.is_match(&l) {
            break;
        }
        push(&mut v, &l);
        if !end_marker.is_empty() && l.contains(&end_marker) {
            break;
        }
        n = n.saturating_add(1);
    }
    v
}

/// The unchanged lines [`pem_block`] needs for each PEM block among `lines`
/// (one diff's added lines of a file), read from `new_side`, the file's
/// content after the change, keyed like [`AddedFile::unchanged`].
fn pem_unchanged(lines: &[(u32, String)], new_side: &str) -> BTreeMap<usize, Vec<String>> {
    let text: Vec<&str> = new_side.lines().collect();
    let mut out: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    for (idx, (_, line)) in lines.iter().enumerate() {
        let Some(h) = PEM_HEADER.find(line) else { continue };
        pem_walk(lines, idx, h.start(), h.as_str(), &mut |j, n| {
            let l = text.get((n as usize).checked_sub(1)?)?.to_string();
            let off = n.checked_sub(lines[j].0.saturating_add(1))? as usize;
            let run = out.entry(j).or_default();
            if run.len() == off {
                run.push(l.clone());
            }
            Some(l)
        });
    }
    out
}

/// The content of `path` after the change: its blob, or the worktree file
/// when git holds no blob for it. `None` past [`MAX_SCAN_BYTES`] or for
/// anything but a regular file.
fn new_side(repo: &Repository, path: &str, id: Oid) -> Option<String> {
    let blob = (!id.is_zero()).then(|| repo.find_blob(id).ok()).flatten();
    let bytes = match blob {
        Some(b) if b.size() > MAX_SCAN_BYTES => return None,
        Some(b) => b.content().to_vec(),
        None => {
            let p = repo.workdir()?.join(path);
            let meta = std::fs::symlink_metadata(&p).ok()?;
            if !meta.is_file() || meta.len() > MAX_SCAN_BYTES as u64 {
                return None;
            }
            std::fs::read(&p).ok()?
        }
    };
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether the new side of `path` starts with [`ZIP_MAGIC`]: its blob, or
/// the worktree file when git holds no blob for it. Reads four bytes of a
/// worktree file, never more.
fn starts_like_zip(repo: &Repository, path: &str, id: Oid) -> bool {
    if let Some(b) = (!id.is_zero()).then(|| repo.find_blob(id).ok()).flatten() {
        return b.content().starts_with(ZIP_MAGIC);
    }
    let Some(p) = repo.workdir().map(|w| w.join(path)) else { return false };
    if !std::fs::symlink_metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
        return false;
    }
    let mut head = [0u8; 4];
    std::fs::File::open(&p)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head))
        .is_ok_and(|()| &head == ZIP_MAGIC)
}

/// Every hit in `files`, uncapped (the fingerprint covers all of them).
fn scan_hits(files: &[AddedFile], known: &[KnownSecret]) -> Vec<Hit> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for file in files {
        let path = file.path.as_str();
        if let Some((rule, kind)) = sensitive_file(path).filter(|(r, _)| file.is_new && !(*r == "key-file" && file.zip)) {
            let body: String = file.lines.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join("\n");
            push_hit(&mut out, &mut seen, SecretFinding {
                file: path.into(), line: None, rule: rule.into(), kind: kind.into(), yours: false, preview: None,
            }, &body, true);
        }
        let env_file = is_env_file(path);
        let mcp_config = is_mcp_config(path);
        let doc_file = is_doc_file(path);
        let generic_ok = !is_test_path(path) && !is_lockfile(path);
        // AWS needs the key id AND a secret within a few lines of it:
        // (line number, index into `file.lines`), sorted. `range_files`
        // appends lines from several commits, so the numbers aren't monotonic.
        let mut aws_secret_lines: Vec<(u32, usize)> = file
            .lines
            .iter()
            .enumerate()
            .filter(|(_, (_, l))| aws_secret_on(l))
            .map(|(i, (n, _))| (*n, i))
            .collect();
        aws_secret_lines.sort_unstable();
        // Lines near a Firebase web config's other keys, sorted and unique.
        let mut firebase_lines: Vec<u32> =
            file.lines.iter().filter(|(_, l)| FIREBASE_CONTEXT.is_match(l)).map(|(n, _)| *n).collect();
        firebase_lines.sort_unstable();
        firebase_lines.dedup();

        for (idx, (n, line)) in file.lines.iter().enumerate() {
            let line = line.as_str();
            // Only the generic rule is held to the first MAX_LINE_BYTES.
            let head: &str = if line.len() > MAX_LINE_BYTES {
                let mut end = MAX_LINE_BYTES;
                while !line.is_char_boundary(end) {
                    end -= 1;
                }
                &line[..end]
            } else {
                line
            };
            let at = |rule: &str, kind: String, yours: bool| SecretFinding {
                file: path.into(), line: Some(*n), rule: rule.into(), kind, yours, preview: None,
            };
            let next_public = NEXT_PUBLIC_ASSIGN.is_match(line);
            let firebase_key = line.to_ascii_lowercase().contains("apikey")
                && any_within(&firebase_lines, *n, 8);
            let public_web_value = next_public || firebase_key;
            // Every rule runs on every line and every value it flags is hashed
            // into the fingerprint, so editing any of them asks again. A value
            // inside a span already reported here is hashed but not listed twice.
            let mut claimed = Spans::default();

            for k in known.iter() {
                let mut found = false;
                for (at_byte, v) in line.match_indices(k.value.as_str()) {
                    found = true;
                    claimed.claim(at_byte, at_byte + v.len());
                }
                if found {
                    let f = at("your-credential", k.label.clone(), true).masked_tail(&k.value);
                    push_hit(&mut out, &mut seen, f, &k.value, true);
                }
            }
            for (r, start, end, shown) in token_hits(line, public_web_value, &mut claimed) {
                let token = &line[start..end];
                push_hit(&mut out, &mut seen, at(r.id, r.kind.into(), false).masked(token), token, shown);
            }
            if let Some(m) = AWS_KEY_ID.find(line) {
                let window = window_of(&aws_secret_lines, *n, 5);
                let near = !window.is_empty() || aws_bare_secret_on(line);
                if near && !is_placeholder(m.as_str()) {
                    // The id plus every secret line near it: a new secret is a new question.
                    let mut v = m.as_str().to_string();
                    for &(_, i) in window {
                        v.push('\u{0}');
                        v.push_str(&file.lines[i].1);
                    }
                    v.push('\u{0}');
                    v.push_str(line);
                    claimed.claim(m.start(), m.end());
                    // The preview shows the key id, never the secret beside it.
                    let f = at("aws-access-key", "AWS access key".into(), false).masked(m.as_str());
                    push_hit(&mut out, &mut seen, f, &v, true);
                }
            }
            if PEM_HEADER.is_match(line) {
                let inline = PEM_INLINE_BODY.is_match(line);
                let next = file
                    .lines
                    .get(idx + 1)
                    .filter(|(m, _)| *m == n + 1)
                    .filter(|(_, l)| PEM_BODY_LINE.is_match(l));
                if inline || next.is_some() {
                    let h = PEM_HEADER.find(line);
                    let v = pem_block(&file.lines, &file.unchanged, idx, h.map(|h| h.start()).unwrap_or(0), h.map(|h| h.as_str()).unwrap_or(""));
                    if let Some(h) = h {
                        claimed.claim(h.start(), h.end());
                    }
                    push_hit(&mut out, &mut seen, at("private-key", "private key".into(), false), &v, true);
                }
            }
            if env_file && !next_public {
                if let Some(c) = ENV_ASSIGN.captures(line) {
                    let name = c.get(1).map(|m| m.as_str()).unwrap_or("");
                    let raw = c.get(2);
                    let value = env_value(raw.map(|m| m.as_str()).unwrap_or(""));
                    if !name.starts_with("NEXT_PUBLIC_") && ENV_CREDENTIAL_NAME.is_match(name) && env_value_is_credential(value) {
                        let (s0, e0) = raw.map(|m| (m.start(), m.end())).unwrap_or((0, line.len()));
                        let shown = claimed.claim(s0, e0);
                        let f = at("env-credential", format!("credential in a .env file ({name})"), false).masked_tail(value);
                        push_hit(&mut out, &mut seen, f, value, shown);
                    }
                }
            }
            if mcp_config {
                for c in MCP_ENV_PAIR.captures_iter(line) {
                    let (Some(name), Some(m)) = (c.get(1), c.get(2)) else { continue };
                    let name = name.as_str();
                    if ENV_CREDENTIAL_NAME.is_match(name) && env_value_is_credential(m.as_str()) {
                        let shown = claimed.claim(m.start(), m.end());
                        let f = at("mcp-env-credential", format!("credential in an MCP config ({name})"), false).masked_tail(m.as_str());
                        push_hit(&mut out, &mut seen, f, m.as_str(), shown);
                    }
                }
            }
            if generic_ok && !public_web_value {
                for c in GENERIC_ASSIGN.captures_iter(head) {
                    let Some(m) = c.get(1) else { continue };
                    let v = m.as_str();
                    let name = c.get(0).map(|all| &head[all.start()..m.start()]).unwrap_or("");
                    let plausible = !is_placeholder(v)
                        && (shannon_entropy(v) > 4.0 || (is_hex_secret(v) && !names_a_digest(name)))
                        && v.chars().any(|c| c.is_ascii_digit())
                        && v.chars().any(|c| c.is_ascii_alphabetic())
                        && !v.contains("://")
                        // An example JWT in prose docs is an illustration.
                        && !(doc_file && JWT.is_match(v));
                    if plausible {
                        let shown = claimed.claim(m.start(), m.end());
                        push_hit(&mut out, &mut seen, at("generic-secret", "hard-coded secret".into(), false).masked_tail(v), v, shown);
                    }
                }
            }
        }
    }
    out
}

// ─── Redaction (one line of text shown to people) ──────────────────────

/// What a redacted value reads as.
pub const REDACTED: &str = "[redacted]";

/// `NAME=value` anywhere on a line (a command's inline env), quoted or not.
static INLINE_ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']+)"#).unwrap()
});
/// A bearer token (`Authorization: Bearer …`, `curl -H "…Bearer …"`).
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bbearer\s+([A-Za-z0-9._~+/=\-]{8,})").unwrap());
/// The password of a URL's userinfo (`https://user:pass@host`).
static URL_PASSWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"://[^/\s:@]+:([^@\s/]+)@").unwrap());

/// `line` with every value the guard's rules would call a secret replaced by
/// [`REDACTED`]: your own credentials, the prefixed provider tokens, AWS key
/// ids, credential-named assignments (`TOKEN=…`, `api_key: "…"`), bearer
/// tokens and URL passwords. Unlike a scan it leans to over-redacting (no
/// entropy or placeholder filter): it guards text shown on screen, such as a
/// refused command in the journal, not a commit. Pure.
pub fn redact_line(line: &str, known: &[KnownSecret]) -> String {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for k in known.iter().filter(|k| !k.value.is_empty()) {
        spans.extend(line.match_indices(k.value.as_str()).map(|(at, v)| (at, at + v.len())));
    }
    for r in TOKEN_RULES.iter() {
        spans.extend(r.re.find_iter(line).map(|m| (m.start(), m.end())));
    }
    spans.extend(AWS_KEY_ID.find_iter(line).map(|m| (m.start(), m.end())));
    for c in INLINE_ASSIGN.captures_iter(line) {
        let (Some(name), Some(v)) = (c.get(1), c.get(2)) else { continue };
        let value = v.as_str().trim_matches(['"', '\'']);
        if ENV_CREDENTIAL_NAME.is_match(name.as_str()) && !value.is_empty() && !value.starts_with('$') {
            spans.push((v.start(), v.end()));
        }
    }
    for re in [&*GENERIC_ASSIGN, &*BEARER, &*URL_PASSWORD] {
        spans.extend(re.captures_iter(line).filter_map(|c| c.get(1)).map(|m| (m.start(), m.end())));
    }
    if spans.is_empty() {
        return line.to_string();
    }
    spans.sort_unstable();
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    for (start, end) in spans {
        if end <= at {
            continue;
        }
        if start >= at {
            out.push_str(&line[at..start]);
            out.push_str(REDACTED);
        }
        at = end;
    }
    out.push_str(&line[at..]);
    out
}

/// Scan the added lines of `files` and return the first [`MAX_FINDINGS`]
/// findings. `known` are the credentials Octopush holds; a hit on one of
/// them is reported as "your … key" and wins over any pattern on the line.
pub fn scan_added(files: &[AddedFile], known: &[KnownSecret]) -> Vec<SecretFinding> {
    scan_report(files, known, false).findings
}

/// Scan `files` into a [`ScanReport`]: the capped findings for people, the
/// total, `partial`, and the fingerprint over all of it.
pub fn scan_report(files: &[AddedFile], known: &[KnownSecret], partial: bool) -> ScanReport {
    report_of(files, known, "", partial, &[])
}

/// Scan what a collector gathered, binding the fingerprint to its scope and,
/// when partial, to what it left unscanned. What the guard and Direct use.
pub fn scan_collected(c: &Collected, known: &[KnownSecret]) -> ScanReport {
    report_of(&c.files, known, c.scope, c.partial, &c.unscanned)
}

fn report_of(files: &[AddedFile], known: &[KnownSecret], scope: &str, partial: bool, unscanned: &[String]) -> ScanReport {
    let hits = scan_hits(files, known);
    let fingerprint = fingerprint_hits(&hits, scope, partial, unscanned);
    let shown: Vec<SecretFinding> = hits.into_iter().filter(|h| h.shown).map(|h| h.finding).collect();
    let total = shown.len();
    let findings = shown.into_iter().take(MAX_FINDINGS).collect();
    ScanReport { findings, total, partial, fingerprint }
}

// ─── Collecting the added side of a diff ───────────────────────────────

/// The added side of a change, and whether collecting it stopped early
/// (the byte budget ran out, or a file was too large to read as text).
#[derive(Debug, Clone, Default)]
pub struct Collected {
    pub files: Vec<AddedFile>,
    pub partial: bool,
    /// Which action this is for: `commit`, `push`, `pr`, `worktree` or
    /// `history` (the on-demand branch scan).
    pub scope: &'static str,
    /// What a partial scan didn't read: `path@blob` for a file it couldn't
    /// (or only partly) read (`path@stat:size:mtime_ns:inode:ctime_ns` when git has no
    /// blob id for it yet), `commit <oid>` for a commit it never reached.
    pub unscanned: Vec<String>,
}

impl std::ops::Deref for Collected {
    type Target = [AddedFile];
    fn deref(&self) -> &[AddedFile] {
        &self.files
    }
}

/// The scanned-bytes budget for one scan.
struct Budget {
    left: usize,
    exhausted: bool,
    unscanned: Vec<String>,
}

impl Budget {
    fn new() -> Self {
        Budget { left: MAX_SCAN_BYTES, exhausted: false, unscanned: Vec::new() }
    }

    fn into_collected(self, files: Vec<AddedFile>, scope: &'static str) -> Collected {
        Collected { files, partial: self.exhausted, scope, unscanned: self.unscanned }
    }
}

/// `path@blob` for the unscanned list. A worktree file git hasn't hashed
/// (untracked or modified, its blob id still zero) is bound to its content by
/// `path@stat:size:mtime_ns:inode:ctime_ns` instead, so confirming a partial scan
/// can't later cover a different unread file at the same path. Hashing the
/// file would be stronger but means reading a file the scan skipped for being
/// too large, so the metadata stands in for it.
fn unscanned_entry(repo: &Repository, path: &str, id: Oid) -> String {
    if !id.is_zero() {
        return format!("{path}@{id}");
    }
    let Some(meta) = repo.workdir().and_then(|w| std::fs::symlink_metadata(w.join(path)).ok()) else {
        return format!("{path}@missing");
    };
    format!("{path}@stat:{}", content_stamp(&meta))
}

/// `size:mtime_ns:inode:ctime_ns` of a file (inode and ctime 0 where the
/// platform has none). The ctime can't be set back from user space, so a
/// rewrite with the same size and a restored mtime still changes the stamp.
fn content_stamp(meta: &std::fs::Metadata) -> String {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    let (ino, ctime) = {
        use std::os::unix::fs::MetadataExt;
        (meta.ino(), meta.ctime() as i128 * 1_000_000_000 + meta.ctime_nsec() as i128)
    };
    #[cfg(not(unix))]
    let (ino, ctime) = (0u64, 0i128);
    format!("{}:{mtime}:{ino}:{ctime}", meta.len())
}

fn opts() -> DiffOptions {
    let mut o = DiffOptions::new();
    o.context_lines(0);
    // A blob past the whole scan budget is never loaded as text (libgit2's
    // default is 512 MB); `collect_added` marks the scan partial instead.
    o.max_size(MAX_SCAN_BYTES as i64);
    o
}

/// Collect the added lines of `diff`, appending to `files` (keyed by path).
/// `budget` counts down the scanned bytes across one scan.
///
/// A blob past `max_size` is never loaded: git flags it binary and no line
/// callback runs. In a tree-to-tree diff `new_file().size()` is still 0 when
/// the deltas are listed (libgit2 reads it only while generating the patch),
/// so the size is checked in the per-file callback, where it is known, and a
/// binary-flagged blob whose size is still unknown has it read from the
/// object database's header. Either way such a file marks the scan partial.
fn collect_added(repo: &Repository, diff: &Diff, files: &mut Vec<AddedFile>, budget: &mut Budget) -> AppResult<()> {
    let mut index: std::collections::HashMap<String, usize> =
        files.iter().enumerate().map(|(i, f)| (f.path.clone(), i)).collect();
    let path_of = |d: &git2::DiffDelta| d.new_file().path().map(|p| p.to_string_lossy().replace('\\', "/"));
    // Every delta in foreach order: (path, new blob id), None for a deletion.
    let mut order: Vec<Option<(String, Oid)>> = Vec::new();
    // Register every delta first so a newly added empty or binary file is
    // still seen (its name alone can be the finding).
    for delta in diff.deltas() {
        if matches!(delta.status(), Delta::Deleted) {
            order.push(None);
            continue;
        }
        let Some(path) = path_of(&delta) else {
            order.push(None);
            continue;
        };
        let id = delta.new_file().id();
        order.push(Some((path.clone(), id)));
        let is_new = matches!(delta.status(), Delta::Added | Delta::Untracked);
        let zip = is_new && path.to_ascii_lowercase().ends_with(".key") && starts_like_zip(repo, &path, id);
        match index.get(&path) {
            Some(&i) => {
                files[i].is_new |= is_new;
                files[i].zip |= zip;
            }
            None => {
                index.insert(path.clone(), files.len());
                files.push(AddedFile { path, is_new, zip, ..Default::default() });
            }
        }
    }
    // Where this diff's lines start in each file (`range_files` appends).
    let starts: Vec<usize> = files.iter().map(|f| f.lines.len()).collect();
    let odb = repo.odb().ok();
    // How many file callbacks have run: the delta being read is `pos - 1`.
    let mut pos = 0usize;
    let mut stopped = false;
    let mut oversized: Vec<String> = Vec::new();
    let result = {
        let stopped = &mut stopped;
        let pos = &mut pos;
        let oversized = &mut oversized;
        let budget = &mut *budget;
        let files = &mut *files;
        diff.foreach(
            &mut |delta, _| {
                *pos += 1;
                if matches!(delta.status(), Delta::Deleted) {
                    return true;
                }
                let new = delta.new_file();
                let mut size = new.size();
                if size == 0 && new.is_binary() && !new.id().is_zero() {
                    size = odb
                        .as_ref()
                        .and_then(|o| o.read_header(new.id()).ok())
                        .map(|(len, _)| len as u64)
                        .unwrap_or(0);
                }
                if size > MAX_SCAN_BYTES as u64 {
                    // Too large to read as text: the scan didn't see it.
                    let p = path_of(&delta).unwrap_or_default();
                    oversized.push(unscanned_entry(repo, &p, new.id()));
                }
                true
            },
            None,
            None,
            Some(&mut |delta, _hunk, line| {
                if line.origin() != '+' {
                    return true;
                }
                if budget.left == 0 {
                    budget.exhausted = true;
                    *stopped = true;
                    return false;
                }
                let Some(n) = line.new_lineno() else { return true };
                let Some(path) = path_of(&delta) else { return true };
                let content = line.content();
                budget.left = budget.left.saturating_sub(content.len());
                let text = String::from_utf8_lossy(content).trim_end_matches(['\n', '\r']).to_string();
                if let Some(&i) = index.get(&path) {
                    files[i].lines.push((n, text));
                }
                true
            }),
        )
    };
    // An unchanged line inside a PEM block (or the block's rest after its
    // last added line) is not in a diff without context: read it from the
    // file's new side, so the whole block is hashed.
    let mut read = HashSet::new();
    for (path, id) in order.iter().flatten() {
        let Some(&i) = index.get(path) else { continue };
        if !read.insert(i) {
            continue;
        }
        let from = starts.get(i).copied().unwrap_or(0);
        let added = &files[i].lines[from..];
        if !added.iter().any(|(_, l)| PEM_HEADER.is_match(l)) {
            continue;
        }
        let Some(content) = new_side(repo, path, *id) else { continue };
        let fills = pem_unchanged(added, &content);
        files[i].unchanged.extend(fills.into_iter().map(|(j, v)| (j + from, v)));
    }
    if !oversized.is_empty() {
        budget.exhausted = true;
        budget.unscanned.extend(oversized);
    }
    if stopped {
        // The file being read when the budget ran out, and every one after it.
        for (p, id) in order.into_iter().skip(pos.saturating_sub(1)).flatten() {
            budget.unscanned.push(unscanned_entry(repo, &p, id));
        }
    }
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
pub fn staged_files(path: &Path) -> AppResult<Collected> {
    let repo = crate::git_ops::open_repo(path)?;
    let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let index = repo.index().map_err(|e| AppError::Other(format!("secret scan: index: {e}")))?;
    let diff = repo
        .diff_tree_to_index(head.as_ref(), Some(&index), Some(&mut opts()))
        .map_err(|e| AppError::Other(format!("secret scan: staged diff: {e}")))?;
    let mut files = Vec::new();
    let mut budget = Budget::new();
    collect_added(&repo, &diff, &mut files, &mut budget)?;
    Ok(budget.into_collected(files, "commit"))
}

/// Where a range starts: after one commit already on the remote, or — when
/// nothing marks the remote's side — after every remote-tracking ref
/// (`git log HEAD --not --remotes`).
#[derive(Clone, Copy)]
enum RangeBase {
    After(Oid),
    NotOnAnyRemote,
}

/// The added lines of every commit in the range (each against its first
/// parent), so a secret added in one commit and removed in the next is still
/// caught. A range longer than `max_commits` (`Some(MAX_RANGE_COMMITS)` for a
/// push, a PR or a crew's worktree) is scanned as one net diff; with `None`
/// (the branch scan, which promises every commit) only the byte budget bounds
/// it, and running out of it marks the scan partial.
fn range_files(
    repo: &Repository,
    base: RangeBase,
    head: Oid,
    max_commits: Option<usize>,
    budget: &mut Budget,
) -> AppResult<Vec<AddedFile>> {
    let err = |e: git2::Error| AppError::Other(format!("secret scan: {e}"));
    let mut files = Vec::new();
    let mut walk = repo.revwalk().map_err(err)?;
    walk.push(head).map_err(err)?;
    match base {
        RangeBase::After(h) => walk.hide(h).map_err(err)?,
        RangeBase::NotOnAnyRemote => {
            if repo.references_glob("refs/remotes/*").map(|mut r| r.next().is_some()).unwrap_or(false) {
                walk.hide_glob("refs/remotes/*").map_err(err)?;
            }
        }
    }
    let commits: Vec<Oid> = match max_commits {
        Some(cap) => walk.filter_map(|o| o.ok()).take(cap + 1).collect(),
        None => walk.filter_map(|o| o.ok()).collect(),
    };
    if max_commits.is_some_and(|cap| commits.len() > cap) {
        let from = match base {
            RangeBase::After(h) => Some(tree_of(repo, h)?),
            RangeBase::NotOnAnyRemote => None,
        };
        let to = tree_of(repo, head)?;
        let diff = repo.diff_tree_to_tree(from.as_ref(), Some(&to), Some(&mut opts())).map_err(err)?;
        collect_added(repo, &diff, &mut files, budget)?;
        return Ok(files);
    }
    for (i, &oid) in commits.iter().enumerate() {
        if budget.left == 0 {
            budget.exhausted = true;
            budget.unscanned.extend(commits[i..].iter().map(|c| format!("commit {c}")));
            break;
        }
        let commit = repo.find_commit(oid).map_err(err)?;
        let to = commit.tree().map_err(err)?;
        let from = commit.parent(0).ok().and_then(|p| p.tree().ok());
        let diff = repo.diff_tree_to_tree(from.as_ref(), Some(&to), Some(&mut opts())).map_err(err)?;
        collect_added(repo, &diff, &mut files, budget)?;
    }
    Ok(files)
}

/// The commit already on the remote that a push from HEAD starts after: the
/// branch's upstream, else the remote's default branch. `None` when neither
/// exists (the range then is every commit not on any remote ref).
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

fn base_or_unpushed(base: Option<Oid>) -> RangeBase {
    base.map(RangeBase::After).unwrap_or(RangeBase::NotOnAnyRemote)
}

/// The commits a push of the current branch would send.
pub fn push_files(path: &Path) -> AppResult<Collected> {
    let repo = crate::git_ops::open_repo(path)?;
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else {
        return Ok(Budget::new().into_collected(Vec::new(), "push"));
    };
    let base = base_or_unpushed(push_base(&repo, head));
    let mut budget = Budget::new();
    let files = range_files(&repo, base, head, Some(MAX_RANGE_COMMITS), &mut budget)?;
    Ok(budget.into_collected(files, "push"))
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
pub fn pr_files(path: &Path, base: &str) -> AppResult<Collected> {
    let repo = crate::git_ops::open_repo(path)?;
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else {
        return Ok(Budget::new().into_collected(Vec::new(), "pr"));
    };
    let mb = pr_merge_base(&repo, base, head).or_else(|| push_base(&repo, head));
    let mut budget = Budget::new();
    let files = range_files(&repo, base_or_unpushed(mb), head, Some(MAX_RANGE_COMMITS), &mut budget)?;
    Ok(budget.into_collected(files, "pr"))
}

/// Every commit on HEAD since its merge base with `base`, resolved like
/// Review's "Since base" view: what "Scan this branch's commits" reads
/// (#820). Each commit is scanned against its first parent, so a key added
/// and removed again is still found. An error when no merge base resolves.
pub fn branch_files(path: &Path, base: &str) -> AppResult<Collected> {
    let repo = crate::git_ops::open_repo(path)?;
    let Some(head) = repo.head().ok().and_then(|h| h.target()) else {
        return Ok(Budget::new().into_collected(Vec::new(), "history"));
    };
    let Some(mb) = crate::collisions::resolve_merge_base(&repo, head, base) else {
        return Err(AppError::Other(format!("secret scan: this branch shares no history with {base}")));
    };
    let mut budget = Budget::new();
    let files = if mb == head { Vec::new() } else { range_files(&repo, RangeBase::After(mb), head, None, &mut budget)? };
    Ok(budget.into_collected(files, "history"))
}

/// Everything a crew's Action stage could commit and push: the branch's
/// commits since `base` (or the remote's default branch) plus the worktree's
/// uncommitted changes, staged or not, untracked files included (ignored files
/// excluded, as `git add -A` would).
pub fn worktree_files(path: &Path, base: Option<&str>) -> AppResult<Collected> {
    let repo = crate::git_ops::open_repo(path)?;
    let mut budget = Budget::new();
    let head = repo.head().ok().and_then(|h| h.target());
    let mut files = match head {
        Some(h) => {
            let mb = base.and_then(|b| pr_merge_base(&repo, b, h)).or_else(|| push_base(&repo, h));
            // HEAD's own commits only when they aren't on the base already.
            if mb == Some(h) { Vec::new() } else { range_files(&repo, base_or_unpushed(mb), h, Some(MAX_RANGE_COMMITS), &mut budget)? }
        }
        None => Vec::new(),
    };
    let head_tree = head.map(|h| tree_of(&repo, h)).transpose()?;
    let mut o = opts();
    o.include_untracked(true).recurse_untracked_dirs(true).show_untracked_content(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut o))
        .map_err(|e| AppError::Other(format!("secret scan: worktree diff: {e}")))?;
    collect_added(&repo, &diff, &mut files, &mut budget)?;
    Ok(budget.into_collected(files, "worktree"))
}

// ─── Enforcement ───────────────────────────────────────────────────────

/// Block when the report needs confirmation (a finding, or a partial scan)
/// unless `allow` is exactly the fingerprint of THIS report — the one the
/// dialog showed. A stale or mismatched fingerprint gets the new findings.
pub fn enforce(report: ScanReport, allow: Option<&str>) -> AppResult<()> {
    if !report.needs_confirmation() || allow == Some(report.fingerprint.as_str()) {
        return Ok(());
    }
    Err(AppError::SecretsFound {
        findings: report.findings,
        total: report.total,
        partial: report.partial,
        fingerprint: report.fingerprint,
    })
}

/// The commands' entry point: when the guard is on, collect with `collect`
/// on a blocking thread, rescan, and block unless `allow_findings` matches
/// the fresh fingerprint. A scan that can't read the repository never blocks
/// an interactive action (the git command that follows reports the real
/// problem); it is logged without any diff content.
pub async fn guard<F>(allow_findings: Option<String>, collect: F) -> AppResult<()>
where
    F: FnOnce() -> AppResult<Collected> + Send + 'static,
{
    let settings = crate::settings::load_settings().unwrap_or_default();
    if !guard_enabled(&settings) {
        return Ok(());
    }
    let known = known_secrets_from(&settings);
    let scanned = tokio::task::spawn_blocking(move || {
        collect().map(|c| scan_collected(&c, &known))
    })
    .await
    .unwrap_or_else(|e| Err(AppError::Other(format!("secret scan stopped: {e}"))));
    match scanned {
        Ok(report) => enforce(report, allow_findings.as_deref()),
        Err(e) => {
            tracing::warn!("secret guard skipped: {e}");
            Ok(())
        }
    }
}

/// What the guard would say about a change, for a surface that shows it
/// before the action (the Review Companion's verdict). No fingerprint: a
/// preview can't stand in for the confirm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPreview {
    pub findings: Vec<SecretFinding>,
    pub total: usize,
    pub partial: bool,
}

impl From<ScanReport> for ScanPreview {
    fn from(r: ScanReport) -> Self {
        ScanPreview { findings: r.findings, total: r.total, partial: r.partial }
    }
}

/// Scan what `collect` gathers without enforcing anything; `None` when the
/// guard is off. The action itself still rescans when it runs.
pub async fn preview<F>(collect: F) -> AppResult<Option<ScanPreview>>
where
    F: FnOnce() -> AppResult<Collected> + Send + 'static,
{
    if !guard_enabled(&crate::settings::load_settings().unwrap_or_default()) {
        return Ok(None);
    }
    scan_now(collect).await.map(Some)
}

/// Scan what `collect` gathers, on a blocking thread, whatever the guard's
/// switch says: for a scan the user asked for (#820). Enforces nothing.
pub async fn scan_now<F>(collect: F) -> AppResult<ScanPreview>
where
    F: FnOnce() -> AppResult<Collected> + Send + 'static,
{
    let known = known_secrets_from(&crate::settings::load_settings().unwrap_or_default());
    let report = tokio::task::spawn_blocking(move || collect().map(|c| scan_collected(&c, &known)))
        .await
        .unwrap_or_else(|e| Err(AppError::Other(format!("secret scan stopped: {e}"))))?;
    Ok(report.into())
}

/// A Direct stage held by the guard, persisted on `run_stages.secret_hold`.
/// `acknowledged` flips when the director approves the held stage: the
/// stage may then start once past exactly these findings (same fingerprint).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretHold {
    pub acknowledged: bool,
    pub fingerprint: String,
    /// The first [`MAX_FINDINGS`] findings.
    pub findings: Vec<SecretFinding>,
    /// Every finding, including those past the cap.
    #[serde(default)]
    pub total: usize,
    /// The byte budget ran out: the rest of the change wasn't checked.
    #[serde(default)]
    pub partial: bool,
    /// The worktree couldn't be read at all: nothing was checked.
    #[serde(default)]
    pub unreadable: bool,
}

/// The fingerprint of a hold whose worktree couldn't be read.
pub const UNREADABLE_FINGERPRINT: &str = "unreadable";

impl SecretHold {
    /// The hold for `r`. It is persisted with the run, so its findings keep
    /// no masked preview.
    pub fn from_report(r: ScanReport) -> Self {
        SecretHold {
            acknowledged: false,
            fingerprint: r.fingerprint,
            findings: r.findings.into_iter().map(SecretFinding::without_preview).collect(),
            total: r.total,
            partial: r.partial,
            unreadable: false,
        }
    }

    pub fn unreadable() -> Self {
        SecretHold {
            acknowledged: false,
            fingerprint: UNREADABLE_FINGERPRINT.into(),
            findings: Vec::new(),
            total: 0,
            partial: false,
            unreadable: true,
        }
    }

    /// "Anthropic API key in a.ts:3 and 2 more", or why nothing was checked.
    pub fn summary(&self) -> String {
        if self.unreadable {
            return "couldn't read the worktree's changes, so nothing was checked".into();
        }
        refusal_summary(&self.findings, self.total.max(self.findings.len()), self.partial)
    }
}

/// The journal line for a held stage: "Held before the pull request: possible
/// secret · Anthropic API key in tests/fixtures.ts:12".
pub fn hold_notice(stage_label: &str, hold: &SecretHold) -> String {
    if hold.unreadable {
        return format!("Held before {stage_label}: the secret guard {}", hold.summary());
    }
    let total = hold.total.max(hold.findings.len());
    let what = match total {
        0 => "secret scan incomplete",
        1 => "possible secret",
        _ => "possible secrets",
    };
    format!("Held before {stage_label}: {what} · {}", hold.summary())
}
