//! Remote MCP servers. Octopush speaks only stdio, so a remote server runs
//! through the `mcp-remote` bridge, which Octopush builds itself from the
//! choices the Settings form stores in [`RemoteConfig`]:
//!
//! ```text
//! npx -y mcp-remote <url> [--header Name:${OCTOPUSH_MCP_H_NAME}]…
//!     [--static-oauth-client-info {"client_id":…}] [--transport http-only|sse-only]
//! ```
//!
//! A header's value never sits in the arguments: mcp-remote reads
//! `${VAR}` from its own environment, so the value travels in the server's
//! `env` under [`header_env`]. The command, args and env are written to
//! `mcp.json` like any other entry, so other readers of the file still work.

use super::McpServerConfig;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// The bridge package `npx` runs.
pub const BRIDGE_PACKAGE: &str = "mcp-remote";
/// What every header's env var starts with.
pub const HEADER_ENV_PREFIX: &str = "OCTOPUSH_MCP_H_";
/// The env var holding a pre-registered OAuth client's secret.
pub const CLIENT_SECRET_ENV: &str = "OCTOPUSH_MCP_CLIENT_SECRET";
/// The header a Token sign-in sends.
pub const TOKEN_HEADER: &str = "Authorization";

/// The Settings form's choices for a remote server. Every field has a
/// default, so a hand-edited block that lacks one still parses.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
pub struct RemoteConfig {
    #[serde(default)]
    pub url: String,
    /// `oauth` (mcp-remote's browser sign-in), `token` (an `Authorization:
    /// Bearer …` header) or `headers` (the user's own headers).
    #[serde(default = "default_auth")]
    pub auth: String,
    /// The custom headers, by name (`auth: headers` only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub header_names: Vec<String>,
    /// `auto`, `http-only` or `sse-only`.
    #[serde(default = "default_transport")]
    pub transport: String,
    /// A pre-registered OAuth client, for a server without Dynamic Client
    /// Registration (`auth: oauth` only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

fn default_auth() -> String {
    "oauth".into()
}

fn default_transport() -> String {
    "auto".into()
}

/// The env var carrying header `name`'s value: [`HEADER_ENV_PREFIX`] and the
/// name upper-cased, any other character than a letter or digit as `_`.
pub fn header_env(name: &str) -> String {
    let tail: String =
        name.trim().chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' }).collect();
    format!("{HEADER_ENV_PREFIX}{tail}")
}

/// A header name mcp-remote accepts (`Name:value`, name `[A-Za-z0-9_-]+`).
fn valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The headers the bridge sends for these choices, each once.
pub fn effective_headers(remote: &RemoteConfig) -> Vec<String> {
    match remote.auth.as_str() {
        "token" => vec![TOKEN_HEADER.to_string()],
        "headers" => {
            let mut seen = HashSet::new();
            remote
                .header_names
                .iter()
                .map(|n| n.trim().to_string())
                .filter(|n| valid_header_name(n) && seen.insert(header_env(n)))
                .collect()
        }
        _ => Vec::new(),
    }
}

/// The bridge's arguments. `client_secret`: the entry has a value for
/// [`CLIENT_SECRET_ENV`], which the client info then reads as a placeholder
/// (mcp-remote expands `${VAR}` in it, so the secret isn't an argument).
pub fn bridge_args(remote: &RemoteConfig, client_secret: bool) -> Vec<String> {
    let mut args = vec!["-y".to_string(), BRIDGE_PACKAGE.to_string(), remote.url.trim().to_string()];
    for name in effective_headers(remote) {
        args.push("--header".into());
        // No space after the colon: a client that splits arguments on spaces
        // would break the value; it comes from the env var anyway.
        args.push(format!("{}:${{{}}}", name, header_env(&name)));
    }
    if remote.auth == "oauth" {
        if let Some(id) = remote.client_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
            let mut info = serde_json::json!({ "client_id": id });
            if client_secret {
                info["client_secret"] = serde_json::Value::String(format!("${{{}}}", CLIENT_SECRET_ENV));
            }
            args.push("--static-oauth-client-info".into());
            args.push(info.to_string());
        }
    }
    if matches!(remote.transport.as_str(), "http-only" | "sse-only") {
        args.push("--transport".into());
        args.push(remote.transport.clone());
    }
    args
}

/// Whether the entry carries a value for env var `name`.
fn has_value(cfg: &McpServerConfig, name: &str) -> bool {
    cfg.env.get(name).is_some_and(|v| !v.is_empty())
}

/// Rebuild a remote entry's bridge from its choices: `npx` as the command,
/// [`bridge_args`] as the args, and only the current headers' env vars (any
/// other env the entry has is kept). A Token's value gets its `Bearer `
/// prefix here. Unknown choices read as their defaults. A local entry is
/// left as it is.
pub fn apply_bridge(cfg: &mut McpServerConfig, npx: &str) {
    let Some(mut remote) = cfg.remote.take() else { return };
    remote.url = remote.url.trim().to_string();
    if !matches!(remote.auth.as_str(), "oauth" | "token" | "headers") {
        remote.auth = default_auth();
    }
    if !matches!(remote.transport.as_str(), "auto" | "http-only" | "sse-only") {
        remote.transport = default_transport();
    }
    remote.header_names = if remote.auth == "headers" { effective_headers(&remote) } else { Vec::new() };
    remote.client_id = remote
        .client_id
        .take()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && remote.auth == "oauth");

    let wanted: HashSet<String> = effective_headers(&remote).iter().map(|n| header_env(n)).collect();
    cfg.env.retain(|k, _| !k.starts_with(HEADER_ENV_PREFIX) || wanted.contains(k));
    if remote.auth == "token" {
        if let Some(v) = cfg.env.get_mut(&header_env(TOKEN_HEADER)) {
            let token = v.trim().to_string();
            if !token.is_empty() && !token.to_ascii_lowercase().starts_with("bearer ") {
                *v = format!("Bearer {token}");
            }
        }
    }
    let client_secret = remote.client_id.is_some() && has_value(cfg, CLIENT_SECRET_ENV);
    if !client_secret {
        cfg.env.remove(CLIENT_SECRET_ENV);
    }
    cfg.command = npx.to_string();
    cfg.args = bridge_args(&remote, client_secret);
    cfg.remote = Some(remote);
}

/// `npx` as CLI stages find it (the login shell's PATH ∪ the app's ∪
/// common bin dirs), or the bare name when it isn't found: the spawn then
/// says so.
pub fn resolve_npx() -> String {
    use crate::orchestrator::cli_runner::{resolve_executable, resolved_cli_path};
    resolve_executable("npx", &resolved_cli_path()).map_or_else(|| "npx".to_string(), |p| p.display().to_string())
}

/// Every remote entry's bridge rebuilt ([`apply_bridge`]); `npx` is
/// resolved once, and only if there is a remote entry.
pub fn with_bridges(mut servers: HashMap<String, McpServerConfig>) -> HashMap<String, McpServerConfig> {
    if servers.values().any(|c| c.remote.is_some()) {
        let npx = resolve_npx();
        for cfg in servers.values_mut() {
            apply_bridge(cfg, &npx);
        }
    }
    servers
}

// ─── "Clear sign-in": mcp-remote's cached OAuth state ──────────────────

/// Where mcp-remote keeps its state: `MCP_REMOTE_CONFIG_DIR` (the server's
/// env first, then the app's), else `~/.mcp-auth`.
fn auth_dir(cfg: &McpServerConfig) -> Option<PathBuf> {
    let set = |v: Option<String>| v.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
    set(cfg.env.get("MCP_REMOTE_CONFIG_DIR").cloned())
        .or_else(|| set(std::env::var("MCP_REMOTE_CONFIG_DIR").ok()))
        .or_else(|| dirs::home_dir().map(|h| h.join(".mcp-auth")))
}

/// The files mcp-remote keeps for a server at `url` with no headers under
/// `base`. It names each `<md5 of the URL>_<what>` (`_tokens.json`,
/// `_client_info.json`, `_code_verifier_<state>.txt`, `_debug.log`…) in a
/// store directory, `mcp-remote-v1` since its store stopped following the
/// package version, `mcp-remote-<version>` before. The hash covers the URL
/// plus any headers, `--resource` or other parameters; a Browser (OAuth)
/// entry Octopush builds has none of those, so the URL alone names them.
pub fn sign_in_files(base: &Path, url: &str) -> Vec<PathBuf> {
    let prefix = format!("{}_", md5_hex(url.as_bytes()));
    let mut dirs = vec![base.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(base) {
        dirs.extend(
            entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("mcp-remote-"))
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path()),
        );
    }
    let mut files: Vec<PathBuf> = dirs
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flat_map(|entries| entries.flatten())
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.path())
        .collect();
    files.sort();
    files
}

/// Delete mcp-remote's saved sign-in for a Browser (OAuth) entry, so its
/// next connection signs in afresh. Returns how many files went.
pub fn clear_sign_in(cfg: &McpServerConfig) -> Result<usize, String> {
    let remote = cfg.remote.as_ref().filter(|r| r.auth == "oauth").ok_or("Only a Browser (OAuth) server has a sign-in to clear.")?;
    let base = auth_dir(cfg).ok_or("no home directory")?;
    let mut removed = 0;
    for file in sign_in_files(&base, remote.url.trim()) {
        match std::fs::remove_file(&file) {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("couldn't delete {}: {e}", file.display())),
        }
    }
    Ok(removed)
}

/// MD5 (RFC 1321) as lower-case hex. Used only to find the files
/// mcp-remote names by an MD5 of the server URL; never for security.
fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
        14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
        21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8,
        0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
        0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87,
        0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039,
        0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
        0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());
    let mut state: [u32; 4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for chunk in msg.chunks_exact(64) {
        let m: [u32; 16] = std::array::from_fn(|i| {
            u32::from_le_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]])
        });
        let [mut a, mut b, mut c, mut d] = state;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let f = f.wrapping_add(a).wrapping_add(K[i]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(S[i]));
        }
        for (s, v) in state.iter_mut().zip([a, b, c, d]) {
            *s = s.wrapping_add(v);
        }
    }
    state.iter().flat_map(|w| w.to_le_bytes()).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://mcp.example.com/mcp";

    fn remote(auth: &str) -> RemoteConfig {
        RemoteConfig { url: URL.into(), auth: auth.into(), transport: "auto".into(), ..Default::default() }
    }

    fn entry(remote: RemoteConfig, env: &[(&str, &str)]) -> McpServerConfig {
        McpServerConfig {
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            remote: Some(remote),
            ..Default::default()
        }
    }

    #[test]
    fn md5_matches_rfc_1321() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(md5_hex(b"The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
        // Two blocks.
        assert_eq!(md5_hex("1234567890".repeat(8).as_bytes()), "57edf4a22be3c955ac49da2e2107b67a");
        assert_eq!(md5_hex(URL.as_bytes()), "94baabe3c3fadb285b26c035e4e86046");
    }

    #[test]
    fn header_env_names() {
        assert_eq!(header_env("Authorization"), "OCTOPUSH_MCP_H_AUTHORIZATION");
        assert_eq!(header_env(" X-Api-Key "), "OCTOPUSH_MCP_H_X_API_KEY");
    }

    #[test]
    fn a_browser_sign_in_is_the_url_alone() {
        let mut cfg = entry(remote("oauth"), &[]);
        apply_bridge(&mut cfg, "/opt/homebrew/bin/npx");
        assert_eq!(cfg.command, "/opt/homebrew/bin/npx");
        assert_eq!(cfg.args, vec!["-y", "mcp-remote", URL]);
        assert!(cfg.env.is_empty());
    }

    #[test]
    fn a_token_goes_in_an_env_var_never_in_the_args() {
        let mut cfg = entry(remote("token"), &[("OCTOPUSH_MCP_H_AUTHORIZATION", "tok-123")]);
        apply_bridge(&mut cfg, "npx");
        assert_eq!(cfg.args, vec!["-y", "mcp-remote", URL, "--header", "Authorization:${OCTOPUSH_MCP_H_AUTHORIZATION}"]);
        assert_eq!(cfg.env["OCTOPUSH_MCP_H_AUTHORIZATION"], "Bearer tok-123");
        assert!(!cfg.args.iter().any(|a| a.contains("tok-123")));
        // Already prefixed: left as it is (so a re-save doesn't double it).
        apply_bridge(&mut cfg, "npx");
        assert_eq!(cfg.env["OCTOPUSH_MCP_H_AUTHORIZATION"], "Bearer tok-123");
    }

    #[test]
    fn custom_headers_each_get_their_own_env_var() {
        let mut r = remote("headers");
        r.header_names = vec!["X-Api-Key".into(), " X-Tenant ".into(), "x-api-key".into(), "bad header".into()];
        let mut cfg = entry(r, &[("OCTOPUSH_MCP_H_X_API_KEY", "k"), ("OCTOPUSH_MCP_H_X_TENANT", "sample"), ("OCTOPUSH_MCP_H_OLD", "gone"), ("NODE_EXTRA_CA_CERTS", "/ca.pem")]);
        apply_bridge(&mut cfg, "npx");
        assert_eq!(
            cfg.args,
            vec!["-y", "mcp-remote", URL, "--header", "X-Api-Key:${OCTOPUSH_MCP_H_X_API_KEY}", "--header", "X-Tenant:${OCTOPUSH_MCP_H_X_TENANT}"]
        );
        let remote = cfg.remote.as_ref().unwrap();
        assert_eq!(remote.header_names, vec!["X-Api-Key", "X-Tenant"], "trimmed, deduplicated, invalid names dropped");
        assert!(!cfg.env.contains_key("OCTOPUSH_MCP_H_OLD"), "a removed header's value goes");
        assert_eq!(cfg.env["NODE_EXTRA_CA_CERTS"], "/ca.pem", "other env is kept");
    }

    #[test]
    fn a_pre_registered_oauth_client_and_transport() {
        let mut r = remote("oauth");
        r.client_id = Some(" client-abc ".into());
        r.transport = "http-only".into();
        let mut cfg = entry(r.clone(), &[]);
        apply_bridge(&mut cfg, "npx");
        assert_eq!(
            cfg.args,
            vec!["-y", "mcp-remote", URL, "--static-oauth-client-info", r#"{"client_id":"client-abc"}"#, "--transport", "http-only"]
        );
        let mut cfg = entry(r, &[(CLIENT_SECRET_ENV, "shh")]);
        apply_bridge(&mut cfg, "npx");
        let info: serde_json::Value = serde_json::from_str(&cfg.args[4]).unwrap();
        assert_eq!(info, serde_json::json!({ "client_id": "client-abc", "client_secret": "${OCTOPUSH_MCP_CLIENT_SECRET}" }));
        assert!(!cfg.args.iter().any(|a| a.contains("shh")));
        assert_eq!(cfg.env[CLIENT_SECRET_ENV], "shh");
    }

    #[test]
    fn choices_that_dont_apply_are_dropped() {
        // A client id outside OAuth, headers outside Custom headers, unknown values.
        let mut r = remote("token");
        r.client_id = Some("client-abc".into());
        r.header_names = vec!["X-Tenant".into()];
        r.transport = "carrier-pigeon".into();
        let mut cfg = entry(r, &[(CLIENT_SECRET_ENV, "shh"), ("OCTOPUSH_MCP_H_X_TENANT", "sample")]);
        apply_bridge(&mut cfg, "npx");
        let remote = cfg.remote.as_ref().unwrap();
        assert_eq!((remote.client_id.as_deref(), remote.header_names.len(), remote.transport.as_str()), (None, 0, "auto"));
        assert!(!cfg.env.contains_key(CLIENT_SECRET_ENV) && !cfg.env.contains_key("OCTOPUSH_MCP_H_X_TENANT"));
        let mut cfg = entry(RemoteConfig { auth: "magic".into(), ..remote("oauth") }, &[]);
        apply_bridge(&mut cfg, "npx");
        assert_eq!(cfg.remote.unwrap().auth, "oauth");
    }

    #[test]
    fn a_local_entry_is_left_alone() {
        let local = McpServerConfig { command: "uvx".into(), args: vec!["example-server".into()], ..Default::default() };
        let out = with_bridges(HashMap::from([("example".to_string(), local.clone())]));
        assert_eq!(out["example"], local);
    }

    #[test]
    fn the_stored_choices_round_trip_and_old_entries_have_none() {
        let mut r = remote("headers");
        r.header_names = vec!["X-Tenant".into()];
        let mut cfg = entry(r, &[("OCTOPUSH_MCP_H_X_TENANT", "sample")]);
        apply_bridge(&mut cfg, "npx");
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["remote"], serde_json::json!({ "url": URL, "auth": "headers", "header_names": ["X-Tenant"], "transport": "auto" }));
        assert_eq!(json["command"], "npx");
        let back: McpServerConfig = serde_json::from_value(json).unwrap();
        assert_eq!(back, cfg);
        // An entry from before remote servers: no `remote` key, read or written.
        let old: McpServerConfig = serde_json::from_str(r#"{"command":"npx","args":["-y","mcp-remote","https://mcp.example.com/sse"]}"#).unwrap();
        assert_eq!(old.remote, None);
        assert!(serde_json::to_value(&old).unwrap().get("remote").is_none());
        // A hand-edited block missing fields still parses, with defaults.
        let partial: McpServerConfig = serde_json::from_str(r#"{"command":"npx","remote":{"url":"https://mcp.example.com/mcp"}}"#).unwrap();
        assert_eq!(partial.remote.unwrap(), RemoteConfig { url: URL.into(), auth: "oauth".into(), transport: "auto".into(), ..Default::default() });
    }

    #[test]
    fn clear_sign_in_deletes_only_that_urls_files() {
        let base = tempfile::tempdir().unwrap();
        let hash = md5_hex(URL.as_bytes());
        let other = md5_hex(b"https://other.example.com/mcp");
        let v1 = base.path().join("mcp-remote-v1");
        let legacy = base.path().join("mcp-remote-0.1.37");
        std::fs::create_dir_all(&v1).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        for (dir, name) in [
            (&v1, format!("{hash}_tokens.json")),
            (&v1, format!("{hash}_client_info.json")),
            (&v1, format!("{hash}_code_verifier_abc.txt")),
            (&legacy, format!("{hash}_tokens.json")),
            (&v1, format!("{other}_tokens.json")),
            (&v1, "unrelated.json".to_string()),
        ] {
            std::fs::write(dir.join(name), "{}").unwrap();
        }
        std::fs::write(base.path().join(format!("{hash}_debug.log")), "log").unwrap();
        assert_eq!(sign_in_files(base.path(), URL).len(), 5);

        let dir = base.path().to_string_lossy().into_owned();
        let mut cfg = entry(remote("oauth"), &[("MCP_REMOTE_CONFIG_DIR", dir.as_str())]);
        apply_bridge(&mut cfg, "npx");
        assert_eq!(clear_sign_in(&cfg).unwrap(), 5);
        assert!(sign_in_files(base.path(), URL).is_empty());
        assert!(v1.join(format!("{other}_tokens.json")).exists(), "another server's sign-in stays");
        assert!(v1.join("unrelated.json").exists());
        assert_eq!(clear_sign_in(&cfg).unwrap(), 0, "nothing left to clear");

        let token = entry(remote("token"), &[]);
        assert!(clear_sign_in(&token).is_err(), "only a Browser (OAuth) server has a sign-in");
        assert!(clear_sign_in(&McpServerConfig::default()).is_err());
    }
}
