//! The process barrier of a mission that ships nothing (#1238, slice 2).
//!
//! Talk's command check (`permissions::decide`) reads the commands an agent
//! asks for, not the processes they start: a release script that pushes
//! three calls deep is a command the check never sees. So every process a
//! ship-nothing workspace spawns (the Talk shell, the confined runner,
//! sub-agent commands, CLI stages, Run terminals and the setup terminal)
//! starts behind this barrier:
//!
//! - **PATH shims**, first on its PATH ([`SHIMMED`]): one small script per
//!   program the ship-nothing check has a rule for. Each hands its
//!   arguments to `octopush-mcp barrier`, which reads them with that same
//!   check (`permissions::shim_refusal`) and, when the call ships nothing,
//!   runs the real program, found by absolute path when the shims were
//!   written, outside the workspace and the shims' own folder. A shim never
//!   searches PATH. A refused call exits 1 with one line on stderr.
//! - **A push rewrite**: `GIT_CONFIG_*` entries that rewrite every push URL
//!   to a path that can't exist ([`PUSH_BASE`], `url.<base>.pushInsteadOf`
//!   with an empty prefix, which every URL starts with), whichever remote
//!   `git push` picks (`remote.pushDefault`, `branch.<name>.pushRemote`, a
//!   name or a URL), so a git the shims don't reach (one named by absolute
//!   path) can't push to a remote's URL either. Git never rewrites a
//!   remote's own `pushurl` this way: the check refuses setting one.
//! - **A token scrub**: the publish and deploy tokens in [`SCRUBBED`] are
//!   removed from the environment, and `GIT_ASKPASS`/`SSH_ASKPASS` name a
//!   refuser. The user's keychain and files are never touched.
//!
//! The shims live in the app's data folder, one read-only folder per
//! workspace, checked and rewritten where they differ each time a barrier
//! is built. What stays out of reach is in `docs/FEATURES.md` ("Ship
//! nothing"): chiefly a program that opens its own connection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// The programs a ship-nothing workspace's PATH shims stand in for: git and
/// the hosted git CLIs, package publishers, image and cluster tools, the
/// builds that deploy, remote shells and copies, tunnels, and hosted deploy
/// and cloud CLIs. Each has a rule in the ship-nothing check
/// (`permissions::shim_knows`). Interpreters and HTTP clients aren't
/// shimmed: what they send is their own connection.
pub const SHIMMED: &[&str] = &[
    "git", "gh", "glab", "hub",
    "npm", "pnpm", "yarn", "bun", "npx", "pnpx", "bunx", "cargo", "poetry", "uv", "uvx", "twine", "gem",
    "docker", "podman", "docker-compose", "podman-compose", "kubectl", "oc", "helm", "terraform", "tofu",
    "mvn", "gradle",
    "ssh", "scp", "sftp", "rsync", "autossh", "cloudflared", "ngrok", "lt", "localtunnel", "bore", "zrok", "tailscale",
    "vercel", "now", "netlify", "ntl", "fly", "flyctl", "heroku", "firebase", "wrangler", "railway", "surge", "pulumi",
    "serverless", "sls", "cdk", "eb", "aws", "gcloud", "gsutil", "bq", "az", "doctl",
];

/// The tokens a ship-nothing workspace's processes start without: the ones
/// git hosts, package registries and deploy services read from the
/// environment to publish or deploy.
pub const SCRUBBED: &[&str] = &[
    "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GL_TOKEN",
    "GITLAB_PRIVATE_TOKEN", "BITBUCKET_TOKEN", "HOMEBREW_GITHUB_API_TOKEN",
    "NPM_TOKEN", "NODE_AUTH_TOKEN", "YARN_NPM_AUTH_TOKEN", "CARGO_REGISTRY_TOKEN", "TWINE_PASSWORD",
    "POETRY_PYPI_TOKEN_PYPI", "UV_PUBLISH_TOKEN", "UV_PUBLISH_PASSWORD", "FLIT_PASSWORD", "GEM_HOST_API_KEY",
    "VERCEL_TOKEN", "NETLIFY_AUTH_TOKEN", "FLY_API_TOKEN", "FLY_ACCESS_TOKEN", "HEROKU_API_KEY", "FIREBASE_TOKEN",
    "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN", "RAILWAY_TOKEN", "RAILWAY_API_TOKEN", "SURGE_TOKEN",
    "PULUMI_ACCESS_TOKEN", "DIGITALOCEAN_ACCESS_TOKEN", "DOCKERHUB_TOKEN", "CR_PAT",
];

/// Where every push URL is rewritten to: a path under `/dev/null`, which is
/// a device, so nothing can ever exist below it.
pub const PUSH_BASE: &str = "/dev/null/octopush-ship-nothing-refuses-push/";

/// The URL prefixes the push rewrite names: the empty one, which every URL
/// starts with, and the usual forms besides, so a git that read the empty
/// one differently still rewrites them.
const PUSH_PREFIXES: &[&str] = &["", "https://", "http://", "ssh://", "git://", "file://", "git@", "/"];

/// `octopush-mcp`'s mode for a shim's call.
pub const HELPER_MODE: &str = "barrier";

/// The argument that asks the helper to prove it knows [`HELPER_MODE`], and
/// its answer. An older `octopush-mcp` would serve MCP on the program's
/// input instead, so it is asked before any shim names it.
pub const PROBE: &str = "--probe";
pub const PROBE_REPLY: &str = "octopush-ship-nothing-barrier 1";

/// The refuser `GIT_ASKPASS` and `SSH_ASKPASS` name.
const ASKPASS: &str = "#!/bin/sh\n\
# Octopush: this workspace's mission ships nothing. Written by the app; read-only.\n\
printf '%s\\n' 'Octopush: this mission ships nothing, so no credential is asked for here.' >&2\n\
exit 1\n";

/// One installed barrier: the folders and the refuser its spawns name.
#[derive(Clone, Debug, PartialEq)]
pub struct Barrier {
    /// The workspace's shim folder, first on PATH.
    bin: PathBuf,
    /// The refuser `GIT_ASKPASS` and `SSH_ASKPASS` name.
    askpass: PathBuf,
    /// The zsh startup folder a terminal's `ZDOTDIR` names ([`zsh_files`]).
    zdotdir: PathBuf,
}

/// One install at a time in this process: two would race on the read-only
/// folders.
static INSTALL: parking_lot::Mutex<()> = parking_lot::const_mutex(());

/// The helper this process last proved knows the barrier.
static PROBED: parking_lot::Mutex<Option<PathBuf>> = parking_lot::const_mutex(None);

/// Where the barriers live: the app's data folder. Tests use a folder of
/// their own, per process.
fn root() -> PathBuf {
    #[cfg(not(test))]
    {
        dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("octopush").join("ship-nothing")
    }
    #[cfg(test)]
    {
        std::env::temp_dir().join(format!("octopush-ship-nothing-test-{}", std::process::id()))
    }
}

/// The `octopush-mcp` the shims hand their calls to.
fn helper() -> Result<PathBuf, String> {
    #[cfg(not(test))]
    {
        crate::mcp_setup::resolve_mcp_binary().map_err(|e| e.to_string())
    }
    #[cfg(test)]
    {
        Ok(crate::test_support::mcp_bin())
    }
}

/// What a terminal of workspace `workspace_id` (a Run terminal, the setup
/// terminal) starts with on top of its own variables: the barrier's
/// ([`Barrier::terminal_env`]) when the workspace's active mission ships
/// nothing, else nothing. A mission that can't be read counts as one that
/// ships nothing (`permissions::mission_ships_nothing`). `Err` when the
/// barrier can't be set up: the terminal doesn't start.
pub fn terminal_env_for(db: &parking_lot::Mutex<crate::db::Db>, workspace_id: &str) -> Result<HashMap<String, String>, String> {
    let (mission, worktree) = {
        let db = db.lock();
        let mission = db.active_mission_for_workspace(workspace_id);
        let worktree = db.get_workspace(workspace_id).ok().flatten().and_then(|w| w.worktree_path);
        (mission, worktree)
    };
    if !crate::permissions::mission_ships_nothing(&mission) {
        return Ok(HashMap::new());
    }
    let worktree = worktree.ok_or_else(|| "the workspace has no worktree".to_string())?;
    let barrier = Barrier::for_workspace(Path::new(&worktree))?;
    Ok(barrier.terminal_env(&std::env::var("PATH").unwrap_or_default()))
}

/// [`terminal_env_for`] for a Run session opened on `root`, when `root` is
/// a workspace's worktree; nothing for any other folder.
pub fn terminal_env_for_root(db: &parking_lot::Mutex<crate::db::Db>, root: &str) -> Result<HashMap<String, String>, String> {
    let workspace = db.lock().workspace_by_path(root).ok().flatten().map(|(id, _)| id);
    match workspace {
        Some(id) => terminal_env_for(db, &id),
        None => Ok(HashMap::new()),
    }
}

/// Why a terminal of a ship-nothing workspace didn't start.
pub fn terminal_refusal(why: &str) -> String {
    format!("This workspace's mission ships nothing, and its terminal couldn't be put behind the process barrier ({why}).")
}

/// What a command gets when its mission's barrier can't be set up: it
/// doesn't run, as a sandbox that can't be set up doesn't.
pub fn unavailable(why: &str) -> String {
    format!(
        "Not run: this mission ships nothing, and its process barrier couldn't be set up ({why}). \
         Nothing ran; note the step in your findings."
    )
}

impl Barrier {
    /// The barrier of the workspace at `workspace`, installed (or checked)
    /// in the app's data folder, its programs found on the PATH spawns get
    /// (`cli_runner::resolved_cli_path`).
    pub fn for_workspace(workspace: &Path) -> Result<Self, String> {
        let helper = helper()?;
        Self::install(&root(), workspace, &crate::orchestrator::cli_runner::resolved_cli_path(), &helper)
    }

    /// Install the barrier of `workspace` under `root`: one shim per
    /// [`SHIMMED`] program, each naming `helper` and the real program found
    /// on `path_env` ([`resolve_real`]); the askpass refuser; the zsh
    /// startup files. Each folder ends read-only and holds only what it
    /// should: a file that differs is rewritten, one that shouldn't be there
    /// is removed, and a link where a folder belongs is replaced.
    pub fn install(root: &Path, workspace: &Path, path_env: &str, helper: &Path) -> Result<Self, String> {
        probe(helper)?;
        let _one = INSTALL.lock();
        let fail = |what: &str, e: std::io::Error| format!("couldn't write its {what} under {}: {e}", root.display());
        std::fs::create_dir_all(root).map_err(|e| fail("folder", e))?;
        let bin = root.join(format!("ws-{}", workspace_key(workspace)));
        let real = RealDirs::new(path_env, workspace, root);
        let shims: Vec<(String, String)> =
            SHIMMED.iter().map(|name| (name.to_string(), shim_script(helper, name, real.find(name).as_deref()))).collect();
        sync_folder(&bin, &shims).map_err(|e| fail("shims", e))?;
        let refuser = root.join("askpass");
        sync_folder(&refuser, &[("refuse".to_string(), ASKPASS.to_string())]).map_err(|e| fail("askpass refuser", e))?;
        let zdotdir = root.join("zsh");
        sync_folder(&zdotdir, &zsh_files()).map_err(|e| fail("zsh startup files", e))?;
        Ok(Self { bin, askpass: refuser.join("refuse"), zdotdir })
    }

    /// The shim folder.
    pub fn bin(&self) -> &Path {
        &self.bin
    }

    /// The askpass refuser.
    pub fn askpass(&self) -> &Path {
        &self.askpass
    }

    /// `path` with the shim folder first.
    pub fn path(&self, path: &str) -> String {
        let bin = self.bin.to_string_lossy();
        if path.is_empty() {
            bin.into_owned()
        } else {
            format!("{bin}:{path}")
        }
    }

    /// The variables a spawn sets: PATH with the shims first ([`Self::path`]),
    /// the askpass refuser, and git's hardening and the push rewrite after
    /// the `count` `GIT_CONFIG_*` entries its environment holds already.
    pub fn env(&self, path: &str, count: Option<&str>) -> Vec<(String, String)> {
        let askpass = self.askpass.to_string_lossy().into_owned();
        let mut env = vec![
            ("PATH".to_string(), self.path(path)),
            ("GIT_ASKPASS".to_string(), askpass.clone()),
            ("SSH_ASKPASS".to_string(), askpass),
        ];
        env.extend(git_env(count));
        env
    }

    /// Put `command` behind the barrier: [`Self::env`] over `path` (the
    /// PATH it would get) after the app's own `GIT_CONFIG_*` entries, and
    /// [`SCRUBBED`] removed.
    pub fn apply(&self, command: &mut std::process::Command, path: &str) {
        let count = std::env::var("GIT_CONFIG_COUNT").ok();
        command.envs(self.env(path, count.as_deref()));
        for name in SCRUBBED {
            command.env_remove(name);
        }
    }

    /// [`Self::apply`] for a CLI stage's process, whose `GIT_CONFIG_*`
    /// entries may come from the login shell (`count`).
    pub fn apply_tokio(&self, command: &mut tokio::process::Command, path: &str, count: Option<&str>) {
        command.envs(self.env(path, count));
        for name in SCRUBBED {
            command.env_remove(name);
        }
    }

    /// What a terminal of the workspace (a Run terminal, the setup terminal)
    /// is spawned with. The PTY daemon can only set variables, so each
    /// [`SCRUBBED`] token is set empty. Its login shell reads its startup
    /// files after that, and they can put PATH back in their own order or
    /// export a token again; a zsh (the macOS default) starts through
    /// [`zsh_files`] (`ZDOTDIR`), which runs the user's own files and then
    /// puts the shims first again and unsets the tokens.
    pub fn terminal_env(&self, path: &str) -> HashMap<String, String> {
        let count = std::env::var("GIT_CONFIG_COUNT").ok();
        let mut env: HashMap<String, String> = self.env(path, count.as_deref()).into_iter().collect();
        for name in SCRUBBED {
            env.insert(name.to_string(), String::new());
        }
        env.insert("ZDOTDIR".to_string(), self.zdotdir.to_string_lossy().into_owned());
        env.insert(USER_ZDOTDIR.to_string(), std::env::var("ZDOTDIR").unwrap_or_default());
        env.insert(BIN_ENV.to_string(), self.bin.to_string_lossy().into_owned());
        env.insert(ASKPASS_ENV.to_string(), self.askpass.to_string_lossy().into_owned());
        env
    }

    /// The lines that put a Talk shell behind the barrier once its profile
    /// ran (`talk_shell::apply_strict_shell`, after its cleanup), written a
    /// line at a time: the shims first on PATH and the askpass refuser; the
    /// tokens unset; then the push rewrite, each entry unless the shell holds
    /// it already, through a helper function removed after.
    pub fn shell_lines(&self) -> Vec<String> {
        let askpass = sh_quote(&self.askpass.to_string_lossy());
        let ensure: String = git_pairs().iter().map(|(k, v)| format!("__octo_gc {} {}; ", sh_quote(k), sh_quote(v))).collect();
        vec![
            format!("\\builtin export PATH={}:\"$PATH\" GIT_ASKPASS={askpass} SSH_ASKPASS={askpass}", sh_quote(&self.bin.to_string_lossy())),
            format!("\\builtin unset {} 2>/dev/null; true", SCRUBBED.join(" ")),
            "__octo_gc() { local i=0 n=\"${GIT_CONFIG_COUNT:-0}\" k v; case \"$n\" in ''|*[!0-9]*) n=0;; esac; \
             while [ \"$i\" -lt \"$n\" ]; do k=GIT_CONFIG_KEY_$i; v=GIT_CONFIG_VALUE_$i; \
             [ \"${!k}\" = \"$1\" ] && [ \"${!v}\" = \"$2\" ] && return; i=$((i+1)); done; \
             \\builtin export GIT_CONFIG_KEY_$n=\"$1\" GIT_CONFIG_VALUE_$n=\"$2\" GIT_CONFIG_COUNT=$((n+1)); }"
                .to_string(),
            format!("{ensure}\\builtin unset -f __octo_gc"),
        ]
    }

    /// The line that reports, tagged with `nonce`, whether a Talk shell
    /// holds the barrier: `OCTO_BARRIER_<nonce>:<shims first>:<tokens
    /// set>:<askpass>:<push rewrite>` ([`BarrierReport`]). The RS bytes come
    /// from a variable, so the tag is whole only in the shell's output.
    pub fn report_line(&self, nonce: &str) -> String {
        let bin = sh_quote(&self.bin.to_string_lossy());
        let askpass = sh_quote(&self.askpass.to_string_lossy());
        let key = sh_quote(&rewrite_key());
        format!(
            "__octo_bp=0; case $PATH in {bin}:*) __octo_bp=1;; esac; \
             __octo_bt=0; while \\builtin read -r __octo_l; do case $__octo_l in '') ;; *) __octo_bt=$((__octo_bt+1));; esac; done \
             <<< \"$(\\builtin declare -p {} 2>/dev/null)\"; \
             __octo_ba=0; [ \"${{GIT_ASKPASS-}}\" = {askpass} ] && [ \"${{SSH_ASKPASS-}}\" = {askpass} ] && __octo_ba=1; \
             __octo_br=0; __octo_i=0; __octo_n=\"${{GIT_CONFIG_COUNT:-0}}\"; case \"$__octo_n\" in ''|*[!0-9]*) __octo_n=0;; esac; \
             while [ \"$__octo_i\" -lt \"$__octo_n\" ]; do __octo_k=GIT_CONFIG_KEY_$__octo_i; __octo_w=GIT_CONFIG_VALUE_$__octo_i; \
             [ \"${{!__octo_k}}\" = {key} ] && [ -z \"${{!__octo_w}}\" ] && __octo_br=1; __octo_i=$((__octo_i+1)); done; \
             \\builtin printf '%s%sOCTO_BARRIER_{nonce}:%s:%s:%s:%s%s%s\\n' \"$__OCTORS\" \"$__OCTORS\" \"$__octo_bp\" \"$__octo_bt\" \"$__octo_ba\" \"$__octo_br\" \"$__OCTORS\" \"$__OCTORS\"; \
             \\builtin unset __octo_bp __octo_bt __octo_ba __octo_br __octo_i __octo_n __octo_k __octo_w __octo_l",
            SCRUBBED.join(" "),
        )
    }
}

/// What a Talk shell reported about its barrier ([`Barrier::report_line`]).
#[derive(Debug, PartialEq)]
pub struct BarrierReport {
    pub shims_first: bool,
    pub tokens: u32,
    pub askpass: bool,
    pub rewrite: bool,
}

impl BarrierReport {
    /// The report tagged with `nonce` in `output`, if there is one. Pure.
    pub fn read(output: &str, nonce: &str) -> Option<Self> {
        let re = regex::Regex::new(&format!(r"\x1e\x1eOCTO_BARRIER_{}:([01]):(\d+):([01]):([01])\x1e\x1e", regex::escape(nonce))).ok()?;
        let caps = re.captures(output)?;
        Some(Self { shims_first: &caps[1] == "1", tokens: caps[2].parse().ok()?, askpass: &caps[3] == "1", rewrite: &caps[4] == "1" })
    }

    /// What is missing, as the end of a refusal (`None` when nothing is).
    /// Pure.
    pub fn missing(&self) -> Option<String> {
        let mut parts = Vec::new();
        if !self.shims_first {
            parts.push("its PATH doesn't start with the shims".to_string());
        }
        match self.tokens {
            0 => {}
            1 => parts.push("1 token is still set".to_string()),
            n => parts.push(format!("{n} tokens are still set")),
        }
        if !self.askpass {
            parts.push("GIT_ASKPASS or SSH_ASKPASS isn't the refuser".to_string());
        }
        if !self.rewrite {
            parts.push("git's push rewrite is missing".to_string());
        }
        let held = match parts.as_slice() {
            [] => return None,
            [one] => one.clone(),
            [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
        };
        Some(format!("doesn't hold the process barrier after it was set: {held} (a variable marked readonly can't be changed)"))
    }
}

/// The `GIT_CONFIG_*` pairs of the barrier, in order: git's hardening
/// (`talk_shell::git_hardening_env`) and the push rewrite.
fn git_pairs() -> Vec<(String, String)> {
    let mut pairs = vec![("safe.bareRepository".to_string(), "explicit".to_string())];
    pairs.extend(PUSH_PREFIXES.iter().map(|p| (rewrite_key(), p.to_string())));
    pairs
}

/// The push rewrite's key.
fn rewrite_key() -> String {
    format!("url.{PUSH_BASE}.pushInsteadOf")
}

/// [`git_pairs`] as `GIT_CONFIG_*` variables after `count` entries.
pub fn git_env(count: Option<&str>) -> Vec<(String, String)> {
    let pairs = git_pairs();
    let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    crate::talk_shell::git_config_after(count, &refs)
}

/// The variable a terminal's `ZDOTDIR` the user had is kept in.
const USER_ZDOTDIR: &str = "OCTOPUSH_USER_ZDOTDIR";
/// The variables the zsh startup files read the shims and the refuser from.
const BIN_ENV: &str = "OCTOPUSH_SHIP_NOTHING_BIN";
const ASKPASS_ENV: &str = "OCTOPUSH_SHIP_NOTHING_ASKPASS";

/// What a zsh startup file of the barrier runs for `file`: the user's own
/// `file`, read from the folder their `ZDOTDIR` names (else home), with
/// `ZDOTDIR` set to it as zsh would; a `ZDOTDIR` it sets is kept for the
/// next file; then `ZDOTDIR` goes back to the barrier's, so zsh reads the
/// barrier's next file too. Not in a function, so the user's `local` and
/// `typeset` mean what they always do.
fn zsh_runs_user(file: &str) -> String {
    format!(
        "__octo_zd=$ZDOTDIR\n\
         ZDOTDIR=${{{USER_ZDOTDIR}:-$HOME}}\n\
         [[ -r \"$ZDOTDIR/{file}\" ]] && builtin source \"$ZDOTDIR/{file}\"\n\
         {USER_ZDOTDIR}=$ZDOTDIR\n\
         ZDOTDIR=$__octo_zd\n\
         builtin unset __octo_zd\n"
    )
}

/// The end of zsh's startup (`.zlogin` for a login shell, else `.zshrc`):
/// `ZDOTDIR` back to the user's, the shims first on PATH (once), the
/// tokens unset, the askpass refuser.
fn zsh_finish() -> String {
    format!(
        "if [[ ${{{USER_ZDOTDIR}:-$HOME}} == \"$HOME\" ]]; then builtin unset ZDOTDIR; else builtin export ZDOTDIR=${USER_ZDOTDIR}; fi\n\
         builtin unset {USER_ZDOTDIR}\n\
         if [[ -n ${BIN_ENV} ]]; then path=(\"${BIN_ENV}\" \"${{(@)path:#${BIN_ENV}}}\"); builtin export PATH; fi\n\
         builtin unset {} 2>/dev/null\n\
         if [[ -n ${ASKPASS_ENV} ]]; then builtin export GIT_ASKPASS=${ASKPASS_ENV} SSH_ASKPASS=${ASKPASS_ENV}; fi\n",
        SCRUBBED.join(" ")
    )
}

/// The zsh startup files a terminal's `ZDOTDIR` names: each runs the user's
/// own ([`zsh_runs_user`]); the last one zsh reads ends the startup
/// ([`zsh_finish`]), after every file of the user's, so their profile can't
/// leave PATH or a token in its own order.
fn zsh_files() -> Vec<(String, String)> {
    const HEAD: &str = "# Octopush: this workspace's mission ships nothing. Written by the app; read-only.\n";
    vec![
        (".zshenv".to_string(), format!("{HEAD}{}", zsh_runs_user(".zshenv"))),
        (".zprofile".to_string(), format!("{HEAD}{}", zsh_runs_user(".zprofile"))),
        (".zshrc".to_string(), format!("{HEAD}{}if [[ ! -o login ]]; then\n{}fi\n", zsh_runs_user(".zshrc"), zsh_finish())),
        (".zlogin".to_string(), format!("{HEAD}{}{}", zsh_runs_user(".zlogin"), zsh_finish())),
    ]
}

/// A shim: hands its call to the helper with the real program's path
/// (empty when none was found).
fn shim_script(helper: &Path, name: &str, real: Option<&Path>) -> String {
    format!(
        "#!/bin/sh\n\
         # Octopush: this workspace's mission ships nothing, so {name} is checked before it runs. Written by the app; read-only.\n\
         exec {} {HELPER_MODE} {} {} \"$@\"\n",
        sh_quote(&helper.to_string_lossy()),
        sh_quote(name),
        sh_quote(&real.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
    )
}

/// `s` single-quoted for a POSIX shell.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// A short stable name for the workspace's shim folder.
fn workspace_key(workspace: &Path) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(workspace.to_string_lossy().as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// The real `name` for a shim: the first executable `dir/name` on
/// `path_env` whose folder is absolute and, as written and where it
/// resolves, outside `workspace` and `root` (so a relative entry, a
/// `node_modules/.bin` or `venv/bin` in the workspace, or the shims
/// themselves, never count), and that doesn't itself resolve into either.
/// The path is kept as found, not resolved, since a multi-call program
/// (rustup's `cargo`) reads which tool it is from its name.
fn resolve_real(name: &str, path_env: &str, workspace: &Path, root: &Path) -> Option<PathBuf> {
    RealDirs::new(path_env, workspace, root).find(name)
}

/// The PATH folders a shim's real program may come from, worked out once
/// per install ([`resolve_real`]).
struct RealDirs {
    dirs: Vec<PathBuf>,
    fences: Vec<PathBuf>,
}

impl RealDirs {
    fn new(path_env: &str, workspace: &Path, root: &Path) -> Self {
        let fences: Vec<PathBuf> = [workspace, root]
            .iter()
            .flat_map(|p| [p.to_path_buf(), std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())])
            .collect();
        let mut this = Self { dirs: Vec::new(), fences };
        let dirs: Vec<PathBuf> =
            path_env.split(':').filter(|dir| dir.starts_with('/')).map(PathBuf::from).filter(|dir| !this.fenced(dir)).collect();
        this.dirs = dirs;
        this
    }

    /// Whether `p`, as written or where it resolves, is inside a fence.
    fn fenced(&self, p: &Path) -> bool {
        let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        self.fences.iter().any(|f| p.starts_with(f) || resolved.starts_with(f))
    }

    fn find(&self, name: &str) -> Option<PathBuf> {
        self.dirs.iter().map(|dir| dir.join(name)).find(|candidate| executable(candidate) && !self.fenced(candidate))
    }
}

/// Whether `path` is an executable regular file, links followed.
fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Make `dir` hold exactly `files` (name, content), each read-only and
/// executable, the folder itself read-only. Only what differs is written,
/// through a temporary file renamed into place; anything else in it is
/// removed; a link or a file where the folder belongs is replaced.
fn sync_folder(dir: &Path, files: &[(String, String)]) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let set_mode = |p: &Path, mode: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    match std::fs::symlink_metadata(dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => std::fs::remove_file(dir)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let wanted: HashMap<&str, &str> = files.iter().map(|(n, c)| (n.as_str(), c.as_str())).collect();
    let ok = |name: &str, content: &str| {
        let path = dir.join(name);
        std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o777 == 0o555)
            && std::fs::read_to_string(&path).is_ok_and(|c| c == content)
    };
    let extra = |dir: &Path| -> std::io::Result<Vec<PathBuf>> {
        Ok(std::fs::read_dir(dir)?
            .filter_map(Result::ok)
            .filter(|e| !wanted.contains_key(e.file_name().to_string_lossy().as_ref()))
            .map(|e| e.path())
            .collect())
    };
    let folder_ok = std::fs::symlink_metadata(dir).is_ok_and(|m| m.is_dir() && m.permissions().mode() & 0o777 == 0o555);
    if folder_ok && files.iter().all(|(n, c)| ok(n, c)) && extra(dir)?.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    set_mode(dir, 0o755)?;
    for path in extra(dir)? {
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.is_dir() => {
                let _ = set_mode(&path, 0o755);
                std::fs::remove_dir_all(&path)?
            }
            _ => std::fs::remove_file(&path)?,
        }
    }
    for (name, content) in files {
        if ok(name, content) {
            continue;
        }
        let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
        std::fs::write(&tmp, content)?;
        set_mode(&tmp, 0o555)?;
        std::fs::rename(&tmp, dir.join(name))?;
    }
    set_mode(dir, 0o555)
}

/// Prove `helper` knows the barrier ([`PROBE`]), once per process per
/// helper.
fn probe(helper: &Path) -> Result<(), String> {
    let mut proved = PROBED.lock();
    if proved.as_deref() == Some(helper) {
        return Ok(());
    }
    let out = std::process::Command::new(helper)
        .args([HELPER_MODE, PROBE])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("{} couldn't start: {e}", helper.display()))?;
    if String::from_utf8_lossy(&out.stdout).trim() != PROBE_REPLY {
        return Err(format!("{} doesn't know the barrier; it may be from an older build", helper.display()));
    }
    *proved = Some(helper.to_path_buf());
    Ok(())
}

/// What `octopush-mcp barrier` does (a shim's call): `args` are the
/// program's name, its real path (empty when none was found) and its
/// arguments. A call the ship-nothing check refuses
/// (`permissions::shim_refusal`) exits 1 with one line on stderr; one with
/// no real program exits 127; any other becomes the real program (`exec`),
/// with its arguments and environment as they came. [`PROBE`] answers
/// [`PROBE_REPLY`].
pub fn shim_main(args: Vec<std::ffi::OsString>) -> i32 {
    if args.len() == 1 && args[0] == PROBE {
        println!("{PROBE_REPLY}");
        return 0;
    }
    let [name, real, rest @ ..] = args.as_slice() else {
        eprintln!("octopush-mcp barrier: expected a program, its path and its arguments");
        return 2;
    };
    let name = name.to_string_lossy().into_owned();
    let words: Vec<String> = rest.iter().map(|a| a.to_string_lossy().into_owned()).collect();
    let refs: Vec<&str> = words.iter().map(String::as_str).collect();
    if let Some(what) = crate::permissions::shim_refusal(&name, &refs) {
        eprintln!("{}", shim_refusal_text(&name, what));
        return 1;
    }
    if real.is_empty() {
        eprintln!(
            "Octopush: {name} wasn't found outside this workspace when its shims were written, so it doesn't run here \
             (this mission ships nothing)."
        );
        return 127;
    }
    exec(real, rest)
}

/// The one line a refused shim call prints.
pub fn shim_refusal_text(name: &str, what: &str) -> String {
    format!("Octopush refused `{name}`: this workspace's mission ships nothing ({what}). Nothing was sent.")
}

#[cfg(unix)]
fn exec(real: &std::ffi::OsStr, args: &[std::ffi::OsString]) -> i32 {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(real).args(args).exec();
    eprintln!("Octopush: couldn't run {}: {err}", Path::new(real).display());
    126
}

#[cfg(not(unix))]
fn exec(real: &std::ffi::OsStr, _args: &[std::ffi::OsString]) -> i32 {
    eprintln!("Octopush: couldn't run {}: no exec on this platform", Path::new(real).display());
    126
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A temporary workspace with a git repository whose `origin` is a
    /// local bare repository, one commit on `main`, and a barrier installed
    /// for it under its own root.
    struct Repo {
        _tmp: tempfile::TempDir,
        ws: PathBuf,
        remote: PathBuf,
        barrier: Barrier,
        path: String,
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo() -> Repo {
        let tmp = tempfile::TempDir::new().unwrap();
        let ws = tmp.path().join("ws");
        let remote = tmp.path().join("remote.git");
        std::fs::create_dir_all(&ws).unwrap();
        git(tmp.path(), &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(&ws, &["init", "-q", "-b", "main"]);
        git(&ws, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "one"]);
        git(&ws, &["remote", "add", "origin", remote.to_str().unwrap()]);
        let path = std::env::var("PATH").unwrap_or_default();
        let barrier = Barrier::install(&tmp.path().join("root"), &ws, &path, &crate::test_support::mcp_bin()).unwrap();
        Repo { _tmp: tmp, ws, remote, barrier, path }
    }

    /// Make every folder under `dir` writable again, so the temporary
    /// folder holding read-only shims can be removed.
    fn unlock(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
                unlock(&path);
            }
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            unlock(self._tmp.path());
        }
    }

    impl Repo {
        /// `script` in bash in the workspace, behind the barrier, from an
        /// environment that carries a token.
        fn run(&self, script: &str) -> (bool, String) {
            let mut command = Command::new(crate::talk_shell::TALK_BASH);
            command.arg("-c").arg(script).current_dir(&self.ws).env("GITHUB_TOKEN", "ghp_example").env("NPM_TOKEN", "npm_example");
            command.envs(crate::talk_shell::git_hardening_env());
            self.barrier.apply(&mut command, &self.path);
            let out = command.output().unwrap();
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            (out.status.success(), text)
        }

        /// Whether the bare remote holds any branch.
        fn pushed(&self) -> bool {
            let out = Command::new("git").args(["--git-dir", self.remote.to_str().unwrap(), "for-each-ref"]).output().unwrap();
            !String::from_utf8_lossy(&out.stdout).trim().is_empty()
        }

        fn real_git(&self) -> PathBuf {
            resolve_real("git", &self.path, &self.ws, self.barrier.bin.parent().unwrap()).expect("a git on PATH")
        }
    }

    /// Every program the shims stand in for has a rule in the ship-nothing
    /// check, so no shim lets everything through.
    #[test]
    fn every_shim_has_a_rule() {
        for name in SHIMMED {
            assert!(crate::permissions::shim_knows(name), "{name} has no rule");
        }
    }

    /// The shims refuse a push however it is started (#1275): by name, with
    /// the environment cleared, past a `git` planted earlier on PATH, and
    /// with a push URL given on the command line. A git named by absolute
    /// path gets past the shim, and the push rewrite refuses it.
    #[test]
    fn the_barrier_refuses_a_push_however_it_is_started() {
        let r = repo();
        let real = r.real_git();
        let planted = r.ws.join("bin");
        std::fs::create_dir_all(&planted).unwrap();
        std::fs::write(planted.join("git"), "#!/bin/sh\ntouch \"$(dirname \"$0\")/planted-ran\"\nexit 0\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(planted.join("git"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let remote = r.remote.to_str().unwrap();
        let cases = [
            ("by name", "git push origin main".to_string(), true),
            ("env -i", "env -i PATH=\"$PATH\" git push origin main".to_string(), true),
            ("a planted git later on PATH", "PATH=\"${PATH%%:*}:./bin:${PATH#*:}\" git push origin main".to_string(), true),
            ("a relative PATH entry", "cd bin && PATH=\"${PATH%%:*}:.:${PATH#*:}\" git push origin main".to_string(), true),
            ("a push URL on the command line", format!("git -c remote.origin.pushurl={remote} push origin main"), true),
            ("a mirror push", "git push --mirror origin".to_string(), true),
            ("an absolute path", format!("'{}' push origin main", real.display()), false),
            ("an absolute path, to a URL", format!("'{}' push 'file://{remote}' main", real.display()), false),
            ("an absolute path, through pushDefault", format!("'{}' -c remote.pushDefault=origin -c push.default=current push", real.display()), false),
        ];
        for (how, script, shim) in cases {
            let (ok, out) = r.run(&script);
            assert!(!ok, "{how}: the push ran: {out}");
            if shim {
                assert!(out.contains("Octopush refused `git`"), "{how}: the shim didn't refuse it: {out}");
            } else {
                assert!(out.contains("octopush-ship-nothing-refuses-push"), "{how}: the rewrite didn't refuse it: {out}");
            }
            assert!(!r.pushed(), "{how}: the remote got the push");
        }
        assert!(!planted.join("planted-ran").exists(), "the planted git ran");
        // Reading and committing still work, through the shim.
        let (ok, out) = r.run("git status --short && git log --oneline -1 && git fetch origin");
        assert!(ok, "{out}");
        let (ok, out) = r.run("git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m two && git log --oneline | wc -l");
        assert!(ok && out.trim() == "2", "{out}");
    }

    /// A spawn behind the barrier has no token, the askpass refuser, and the
    /// shims first on PATH; one without it keeps what it inherits.
    #[test]
    fn the_barrier_scrubs_tokens_and_puts_the_shims_first() {
        let r = repo();
        let probe = "printf '%s|%s|%s|%s' \"${GITHUB_TOKEN-unset}\" \"${NPM_TOKEN-unset}\" \"${PATH%%:*}\" \"$GIT_ASKPASS\"";
        let (ok, out) = r.run(probe);
        assert!(ok, "{out}");
        assert_eq!(out, format!("unset|unset|{}|{}", r.barrier.bin.display(), r.barrier.askpass.display()));
        let (ok, out) = r.run("GIT_TERMINAL_PROMPT=0 \"$GIT_ASKPASS\" 'Password: '");
        assert!(!ok && out.contains("ships nothing"), "{out}");
    }

    /// A CLI stage's process: `apply_stage_env` with the barrier puts the
    /// shims first on the stage's PATH, removes the tokens and adds the push
    /// rewrite; without one the env is exactly what it was.
    #[test]
    fn a_cli_stage_starts_behind_the_barrier() {
        use crate::orchestrator::cli_runner::{apply_stage_env, CliDialect};
        let r = repo();
        let envs = |barrier: Option<(&Barrier, &str)>| {
            let mut command = tokio::process::Command::new("claude");
            command.env("PATH", "/usr/bin:/bin");
            apply_stage_env(&mut command, CliDialect::Claude, "claude-sonnet-5", None, false, None, barrier);
            command
                .as_std()
                .get_envs()
                .map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned())))
                .collect::<HashMap<String, Option<String>>>()
        };
        let plain = envs(None);
        let behind = envs(Some((&r.barrier, "/usr/bin:/bin")));
        assert_eq!(plain.get("PATH"), Some(&Some("/usr/bin:/bin".to_string())));
        assert!(!plain.contains_key("GITHUB_TOKEN") && !plain.contains_key("GIT_ASKPASS"), "{plain:?}");
        assert_eq!(behind.get("PATH"), Some(&Some(r.barrier.path("/usr/bin:/bin"))));
        assert_eq!(behind.get("GITHUB_TOKEN"), Some(&None), "removed from the stage's env");
        assert!(behind.values().any(|v| v.as_deref() == Some(rewrite_key().as_str())), "{behind:?}");
        for (k, v) in plain.iter().filter(|(k, _)| k.as_str() != "PATH") {
            assert_eq!(behind.get(k), Some(v), "{k}");
        }
    }

    /// The real program is never one inside the workspace or the shims'
    /// root, nor a relative PATH entry.
    #[test]
    fn the_real_program_is_found_outside_the_workspace() {
        let tmp = tempfile::TempDir::new().unwrap();
        let ws = tmp.path().join("ws");
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        for dir in [ws.join("node_modules/.bin"), root.join("ws-x"), outside.clone()] {
            std::fs::create_dir_all(&dir).unwrap();
            let tool = dir.join("tool");
            std::fs::write(&tool, "#!/bin/sh\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = format!(
            "node_modules/.bin:{}:{}:{}:{}",
            ws.join("node_modules/.bin").display(),
            root.join("ws-x").display(),
            tmp.path().display(),
            outside.display()
        );
        let link = tmp.path().join("tool");
        std::os::unix::fs::symlink(ws.join("node_modules/.bin/tool"), &link).unwrap();
        assert_eq!(resolve_real("tool", &path, &ws, &root), Some(outside.join("tool")), "a link into the workspace doesn't count");
        assert_eq!(resolve_real("missing", &path, &ws, &root), None);
    }

    /// The shim folder holds only the shims, read-only; a changed or added
    /// file is put back as it was.
    #[test]
    fn the_shim_folder_is_read_only_and_put_back() {
        use std::os::unix::fs::PermissionsExt;
        let r = repo();
        let bin = r.barrier.bin.clone();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&bin), 0o555);
        assert_eq!(mode(&bin.join("git")), 0o555);
        let names: std::collections::HashSet<String> =
            std::fs::read_dir(&bin).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, SHIMMED.iter().map(|s| s.to_string()).collect::<std::collections::HashSet<String>>());
        assert!(std::fs::write(bin.join("git"), "#!/bin/sh\nexit 0\n").is_err(), "a shim is writable");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(bin.join("git"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(bin.join("git"), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::write(bin.join("curl"), "#!/bin/sh\nexit 0\n").unwrap();
        let again = Barrier::install(bin.parent().unwrap(), &r.ws, &r.path, &crate::test_support::mcp_bin()).unwrap();
        assert_eq!(again, r.barrier);
        assert!(std::fs::read_to_string(bin.join("git")).unwrap().contains(HELPER_MODE), "the shim wasn't put back");
        assert!(!bin.join("curl").exists(), "an added file stayed");
        assert_eq!(mode(&bin), 0o555);
    }

    /// A refused call names the program and what it would have changed.
    #[test]
    fn a_refused_shim_call_says_why() {
        let text = shim_refusal_text("vercel", "a hosted deploy CLI command that deploys or changes something there");
        assert!(text.starts_with("Octopush refused `vercel`") && text.contains("ships nothing"), "{text}");
        assert_eq!(shim_main(vec![PROBE.into()]), 0);
        assert_eq!(shim_main(vec!["git".into(), "".into(), "push".into()]), 1, "refused before anything runs");
        assert_eq!(shim_main(vec!["git".into(), "".into(), "status".into()]), 127, "no real program");
    }

    /// The Talk shell's barrier report reads back, and says what is missing.
    #[test]
    fn the_barrier_report_reads_back() {
        let line = "\u{1e}\u{1e}OCTO_BARRIER_n0:1:0:1:1\u{1e}\u{1e}";
        let all = BarrierReport::read(line, "n0").unwrap();
        assert_eq!(all.missing(), None);
        assert_eq!(BarrierReport::read(line, "other"), None);
        let some = BarrierReport::read("\u{1e}\u{1e}OCTO_BARRIER_n0:0:2:1:0\u{1e}\u{1e}", "n0").unwrap();
        let why = some.missing().unwrap();
        assert!(why.contains("PATH doesn't start with the shims, 2 tokens are still set and git's push rewrite is missing"), "{why}");
    }

    /// A login zsh started through the barrier's `ZDOTDIR` runs the user's
    /// own startup files, then ends with the shims first, no token and the
    /// user's `ZDOTDIR` back, whatever those files did to PATH.
    #[test]
    fn a_login_zsh_keeps_the_barrier_after_the_users_files() {
        let Some(zsh) = ["/bin/zsh", "/usr/bin/zsh"].into_iter().map(Path::new).find(|p| p.exists()) else {
            return;
        };
        let r = repo();
        let home = r.ws.parent().unwrap().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".zshenv"), "export FROM_ZSHENV=1\n").unwrap();
        std::fs::write(home.join(".zprofile"), "export PATH=/usr/bin:/bin:$PATH\nexport GITHUB_TOKEN=ghp_profile\n").unwrap();
        std::fs::write(home.join(".zshrc"), "export FROM_ZSHRC=1\n").unwrap();
        std::fs::write(home.join(".zlogin"), "export GITLAB_TOKEN=glpat_login\n").unwrap();
        let probe = "print -r -- \"${PATH%%:*}|${GITHUB_TOKEN-unset}|${GITLAB_TOKEN-unset}|${ZDOTDIR-unset}|${FROM_ZSHENV-}|${FROM_ZSHRC-}\"";
        for (how, args) in [("login", vec!["-l", "-c", probe]), ("interactive login", vec!["-l", "-i", "-c", probe])] {
            let out = Command::new(zsh)
                .args(&args)
                .env_clear()
                .env("HOME", &home)
                .env("PATH", "/usr/bin:/bin")
                .envs(r.barrier.terminal_env("/usr/bin:/bin"))
                // As for a user who never set `ZDOTDIR`, whatever the test's
                // own environment holds.
                .env(USER_ZDOTDIR, "")
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&out.stdout);
            let last = text.lines().last().unwrap_or_default();
            let rc = if how == "login" { "" } else { "1" };
            assert_eq!(last, format!("{}|unset|unset|unset|1|{rc}", r.barrier.bin.display()), "{how}: {text}");
        }
    }
}
