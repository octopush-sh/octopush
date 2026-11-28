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
//!   searches PATH. A refused call exits 1 with one line on stderr. The git
//!   shim refuses every push outright, runs git's own commands only (never
//!   an alias), takes display and identity settings only from `-c`, and
//!   runs git with every setting that can run a program turned off, from
//!   whichever config it comes ([`git_call`]).
//! - **A push rewrite**, for a git the shims don't reach (one named by its
//!   full path): `GIT_CONFIG_*` entries that rewrite a push URL to a path
//!   that can't exist ([`PUSH_BASE`], `url.<base>.pushInsteadOf` with an
//!   empty prefix, which every URL starts with, and the usual schemes),
//!   whichever remote `git push` picks. Git takes the longest matching
//!   prefix and never rewrites a remote's own `pushurl`, so a longer
//!   `pushInsteadOf` or a `pushurl` in a config file wins over it; the check
//!   refuses setting either.
//! - **A token scrub**: the publish and deploy tokens in [`SCRUBBED`] are
//!   removed from the environment, `credential.helper` is set empty (so no
//!   saved credential, the keychain's included, reaches git), and
//!   `GIT_ASKPASS`/`SSH_ASKPASS` name a refuser. The user's keychain and
//!   files are never touched.
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
pub const PROBE_REPLY: &str = "octopush-ship-nothing-barrier 2";

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
            SHIMMED.iter().map(|name| (name.to_string(), shim_script(helper, name, real.find(name).as_deref(), &bin, workspace))).collect();
        sync_folder(&bin, &shims).map_err(|e| fail("shims", e))?;
        let refuser = root.join("askpass");
        sync_folder(&refuser, &[("refuse".to_string(), ASKPASS.to_string())]).map_err(|e| fail("askpass refuser", e))?;
        let zdotdir = root.join("zsh");
        sync_folder(&zdotdir, &zsh_files()).map_err(|e| fail("zsh startup files", e))?;
        // The empty folder the git shim points `core.hooksPath` at.
        sync_folder(&root.join(EMPTY), &[]).map_err(|e| fail("empty folder", e))?;
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

    /// Put a Talk background command's spawn env (`talk_procs::launch_env`)
    /// behind the barrier: PATH, as `env` holds it, with the shims first;
    /// the askpass refuser; the push rewrite after the `GIT_CONFIG_*`
    /// entries `env` holds; and each [`SCRUBBED`] token set empty, since the
    /// PTY daemon can only set variables. Its command runs in a
    /// non-interactive bash, which reads no startup file.
    pub fn daemon_env(&self, env: &mut HashMap<String, String>) {
        let path = env.get("PATH").cloned().unwrap_or_default();
        let count = env.get("GIT_CONFIG_COUNT").cloned();
        env.extend(self.env(&path, count.as_deref()));
        for name in SCRUBBED {
            env.insert(name.to_string(), String::new());
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
/// (`talk_shell::git_hardening_env`), an empty `credential.helper`, which
/// empties the list of helpers every config read before it named (the
/// keychain's included), and the push rewrite.
fn git_pairs() -> Vec<(String, String)> {
    let mut pairs = vec![
        ("safe.bareRepository".to_string(), "explicit".to_string()),
        ("credential.helper".to_string(), String::new()),
    ];
    pairs.extend(PUSH_PREFIXES.iter().map(|p| (rewrite_key(), p.to_string())));
    pairs
}

/// The barrier's empty folder, under its root: the git shim's
/// `core.hooksPath`, so no hook runs.
const EMPTY: &str = "empty";

/// The settings the git shim gives every git call, as `-c` after the
/// caller's own (display and identity ones only,
/// `permissions::git_setting_allowed`) and before the subcommand, so they win
/// over every config file and the environment, and reach the gits git
/// starts itself: each key that names a program is turned off, pointed at
/// something that runs nothing (`cat`, `true`, an empty value, shell
/// builtins), or at a refuser; a hook finds an empty folder; a new
/// repository gets no template; and a URL can't pick a remote helper of
/// its own (`protocol.allow=never` but git's own transports, `ext::`
/// included in the refusal). `{empty}`, `{ssh}` and `{refuser}` stand for
/// the empty folder, the ssh shim (shell-quoted, as git runs
/// `core.sshCommand` through the shell) and the askpass refuser.
const GIT_SHIM_SETTINGS: &[&str] = &[
    "credential.helper=",
    "safe.bareRepository=explicit",
    "core.fsmonitor=false",
    "core.hooksPath={empty}",
    "core.pager=cat",
    "core.editor=true",
    "sequence.editor=true",
    "core.sshCommand={ssh}",
    "core.askPass={refuser}",
    "gpg.program={refuser}",
    "gpg.openpgp.program={refuser}",
    "gpg.x509.program={refuser}",
    "gpg.ssh.program={refuser}",
    "gpg.ssh.defaultKeyCommand={refuser}",
    "commit.gpgSign=false",
    "tag.gpgSign=false",
    "log.showSignature=false",
    "interactive.diffFilter=cat",
    "init.templateDir=",
    "protocol.allow=never",
    "protocol.file.allow=user",
    "protocol.git.allow=always",
    "protocol.http.allow=always",
    "protocol.https.allow=always",
    "protocol.ssh.allow=always",
];

/// The config keys that name a program under a name of the config's own
/// (a filter, a merge or diff driver, a remote, a submodule, a trailer),
/// which the git shim can only learn by reading the config
/// ([`configured_programs`]), and the ones it refuses outright.
const PROGRAM_KEYS: &str = r"^(filter\..+\.(clean|smudge|process)|merge\..+\.driver|diff\..+\.(textconv|command)|diff\.external|remote\..+\.uploadpack|submodule\..+\.update|trailer\..+\.(cmd|command)|core\.alternaterefscommand|uploadpack\.packobjectshook)$";

/// The most repositories a git call's submodules may add to the ones
/// [`configured_programs`] reads, and how deep they may nest.
const NESTED_MAX: usize = 64;
const NESTED_DEPTH: usize = 6;

/// The values [`program_overrides`] gives, through `--config-env` (a key
/// may hold `=`, which `-c` can't carry): the variable and its value.
const NEUTRAL: &[(&str, &str)] = &[
    ("OCTOPUSH_GIT_CAT", "cat"),
    ("OCTOPUSH_GIT_EMPTY", ""),
    ("OCTOPUSH_GIT_FALSE", "false"),
    ("OCTOPUSH_GIT_TRUE", "true"),
    ("OCTOPUSH_GIT_CHECKOUT", "checkout"),
];

/// A git the shim runs for itself, to read: with `location`, no fsmonitor,
/// pager, input or error output, and none of the variables that could run a
/// program.
fn git_reader(real: &std::ffi::OsStr, location: &[std::ffi::OsString]) -> std::process::Command {
    let mut command = std::process::Command::new(real);
    command
        .args(location)
        .args(["--no-pager", "-c", "core.fsmonitor=false"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for name in ["GIT_EXTERNAL_DIFF", "GIT_EXEC_PATH", "GIT_PAGER", "GIT_EDITOR"] {
        command.env_remove(name);
    }
    command
}

/// `command` without the variables that tie a git to one repository, as
/// git clears them for a submodule's git (its config ones kept).
fn other_repository(command: &mut std::process::Command) {
    const LOCAL: &[&str] = &[
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_PREFIX", "GIT_GRAFT_FILE", "GIT_IMPLICIT_WORK_TREE",
        "GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_CONFIG",
    ];
    for name in LOCAL {
        command.env_remove(name);
    }
}

/// The repository a git call run with `location` works in, as git finds
/// it: its git folder, its common git folder and its working tree (`None`
/// in a bare repository). `None` outside one.
fn git_folders(real: &std::ffi::OsStr, location: &[std::ffi::OsString]) -> Option<(PathBuf, PathBuf, Option<PathBuf>)> {
    let out = git_reader(real, location)
        .args(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut lines = text.lines().filter(|l| !l.is_empty()).map(PathBuf::from);
    let (git_dir, common) = (lines.next()?, lines.next()?);
    Some((git_dir, common, lines.next()))
}

/// The git folders of the repositories a git call can reach into beyond its
/// own, which a git it starts itself would read (a submodule's `git status`
/// under the caller's): its submodules', absorbed under the common git
/// folder's `modules` or kept in their own `.git`, nested ones included.
/// `Err` past [`NESTED_MAX`] or [`NESTED_DEPTH`].
fn nested_git_dirs(real: &std::ffi::OsStr, git_dir: &Path, common: &Path, top: Option<&Path>) -> Result<Vec<PathBuf>, &'static str> {
    const TOO_MANY: &str = "more nested repositories than the barrier reads the config of";
    fn absorbed(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) -> Result<(), &'static str> {
        let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
                continue;
            }
            if depth >= NESTED_DEPTH * 2 || found.len() >= NESTED_MAX {
                return Err(TOO_MANY);
            }
            if path.join("HEAD").is_file() && path.join("config").is_file() {
                found.push(path.clone());
                absorbed(&path.join("modules"), depth + 1, found)?;
            } else {
                // A submodule's name may hold `/`.
                absorbed(&path, depth + 1, found)?;
            }
        }
        Ok(())
    }
    // `nested`: a repository other than the call's, whose git git starts
    // without the call's index or repository variables.
    fn gitlinks(real: &std::ffi::OsStr, tree: &Path, git_dir: &Path, nested: bool, depth: usize, found: &mut Vec<PathBuf>) -> Result<(), &'static str> {
        let mut command = git_reader(real, &[]);
        if nested {
            other_repository(&mut command);
        }
        command.arg(format!("--git-dir={}", git_dir.display())).arg(format!("--work-tree={}", tree.display()));
        let Ok(out) = command.current_dir(tree).args(["ls-files", "--stage", "-z", "--full-name"]).output() else { return Ok(()) };
        for entry in out.stdout.split(|b| *b == 0) {
            let entry = String::from_utf8_lossy(entry);
            let Some((meta, path)) = entry.split_once('\t') else { continue };
            if !meta.starts_with("160000 ") {
                continue;
            }
            let worktree = tree.join(path);
            let dotgit = worktree.join(".git");
            let nested = match std::fs::symlink_metadata(&dotgit) {
                Ok(m) if m.is_dir() => dotgit,
                Ok(m) if m.is_file() => {
                    let text = std::fs::read_to_string(&dotgit).unwrap_or_default();
                    let Some(target) = text.lines().next().and_then(|l| l.strip_prefix("gitdir:")) else { continue };
                    worktree.join(target.trim())
                }
                _ => continue,
            };
            if depth >= NESTED_DEPTH || found.len() >= NESTED_MAX {
                return Err(TOO_MANY);
            }
            let canonical = std::fs::canonicalize(&nested).unwrap_or(nested);
            if !found.contains(&canonical) {
                found.push(canonical.clone());
            }
            gitlinks(real, &worktree, &canonical, true, depth + 1, found)?;
        }
        Ok(())
    }
    let mut found = Vec::new();
    absorbed(&common.join("modules"), 0, &mut found)?;
    let mut found: Vec<PathBuf> = found.into_iter().map(|p| std::fs::canonicalize(&p).unwrap_or(p)).collect();
    if let Some(top) = top {
        gitlinks(real, top, git_dir, false, 0, &mut found)?;
    }
    found.dedup();
    Ok(found)
}

/// The [`PROGRAM_KEYS`] a git call can meet, and their values: in the
/// config of the repository it runs in (`location`, every scope and include
/// read as git reads them, the environment's `GIT_CONFIG_*` included) and in
/// that of every submodule it can reach ([`nested_git_dirs`]).
fn configured_programs(real: &std::ffi::OsStr, location: &[std::ffi::OsString]) -> Result<Vec<(String, String)>, &'static str> {
    let read = |command: &mut std::process::Command| -> Vec<(String, String)> {
        let Ok(out) = command.args(["config", "--null", "--get-regexp", PROGRAM_KEYS]).output() else { return Vec::new() };
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|entry| !entry.is_empty())
            .map(|entry| match entry.split_once('\n') {
                Some((key, value)) => (key.to_string(), value.to_string()),
                None => (entry.to_string(), String::new()),
            })
            .collect()
    };
    let mut keys = read(&mut git_reader(real, location));
    if let Some((git_dir, common, top)) = git_folders(real, location) {
        for nested in nested_git_dirs(real, &git_dir, &common, top.as_deref())? {
            let mut reader = git_reader(real, &[]);
            other_repository(&mut reader);
            keys.extend(read(reader.arg(format!("--git-dir={}", nested.display()))));
        }
    }
    Ok(keys)
}

/// The settings that turn off each program [`configured_programs`] found,
/// as `(key, variable)` for `--config-env` ([`NEUTRAL`]): a filter's
/// `clean` and `smudge` become `cat`, its `process` empty, and none is
/// required; a merge driver `false`; a diff driver's `textconv` `cat`; an
/// external diff (`diff.external`, a driver's `command`) the refuser, which
/// a call meets only where git would run it (`git diff` gets
/// `--no-ext-diff`, and `--ext-diff` is refused); a submodule's `!command`
/// update a checkout; a trailer's command `true`; an alternate-refs command
/// `true`. And why the call is refused, where a key takes no `-c` (git
/// keeps the first value it reads): a remote's own `uploadpack` program, or
/// an `uploadpack.packObjectsHook`, which a git started for a local fetch
/// reads without the shim's settings.
fn program_overrides(configured: &[(String, String)]) -> (Vec<(String, &'static str)>, Option<&'static str>) {
    let mut out = Vec::new();
    let mut refused = None;
    for (key, value) in configured {
        let lower = key.to_ascii_lowercase();
        let base = key.rsplit_once('.').map_or(key.as_str(), |(b, _)| b);
        if lower == "uploadpack.packobjectshook" {
            refused = Some("a packObjectsHook in git's config, which a local fetch would run");
        } else if lower.starts_with("remote.") {
            if !matches!(value.trim(), "git-upload-pack" | "git upload-pack") {
                refused = Some("a remote whose config names an upload-pack program of its own");
            }
        } else if lower.starts_with("filter.") {
            out.push((key.clone(), if lower.ends_with(".process") { "OCTOPUSH_GIT_EMPTY" } else { "OCTOPUSH_GIT_CAT" }));
            out.push((format!("{base}.required"), "OCTOPUSH_GIT_FALSE"));
        } else if lower.starts_with("merge.") {
            out.push((key.clone(), "OCTOPUSH_GIT_FALSE"));
        } else if lower.starts_with("diff.") && lower.ends_with(".textconv") {
            out.push((key.clone(), "OCTOPUSH_GIT_CAT"));
        } else if lower.starts_with("diff.") {
            out.push((key.clone(), "OCTOPUSH_GIT_REFUSER"));
        } else if lower.starts_with("submodule.") {
            if value.trim_start().starts_with('!') {
                out.push((key.clone(), "OCTOPUSH_GIT_CHECKOUT"));
            }
        } else if lower.starts_with("trailer.") || lower == "core.alternaterefscommand" {
            out.push((key.clone(), "OCTOPUSH_GIT_TRUE"));
        }
    }
    (out, refused)
}

/// Where git's subcommand is in `args`: past its global options and their
/// values. `None` without one (`git --version`).
fn git_subcommand_at(args: &[&str]) -> Option<usize> {
    const VALUED: &[&str] = &["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source", "--super-prefix"];
    let mut i = 0;
    while i < args.len() {
        if VALUED.contains(&args[i]) {
            i += 2;
        } else if args[i].starts_with('-') {
            i += 1;
        } else {
            return Some(i);
        }
    }
    None
}

/// The global options among the first `until` of `args` that say which
/// repository a git call works in (`-C`, `--git-dir`, `--work-tree`,
/// `--bare`), to read it with.
fn git_location(args: &[std::ffi::OsString], words: &[&str], until: usize) -> Vec<std::ffi::OsString> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < until {
        match words[i] {
            "-C" | "--git-dir" | "--work-tree" => {
                out.extend(args[i..(i + 2).min(until)].iter().cloned());
                i += 2;
            }
            w if w.starts_with("--git-dir=") || w.starts_with("--work-tree=") || w == "--bare" => {
                out.push(args[i].clone());
                i += 1;
            }
            "-c" | "--config-env" | "--namespace" | "--attr-source" | "--super-prefix" => i += 2,
            _ => i += 1,
        }
    }
    out
}

/// Whether the interactive rebase a `git rebase --continue` (or `--skip`)
/// would go on with has an `exec` line, which runs a command the agent
/// could have written into its todo list.
fn rebase_todo_runs(git_dir: &Path) -> bool {
    let todo = std::fs::read_to_string(git_dir.join("rebase-merge").join("git-rebase-todo")).unwrap_or_default();
    todo.lines().map(str::trim_start).any(|line| {
        let verb = line.split(|c: char| c.is_whitespace()).next().unwrap_or_default();
        verb == "x" || verb == "exec"
    })
}

/// PATH as the real git gets it: the shims first, then each absolute folder
/// of `path` outside `workspace` and the barrier's `root`, as written and
/// where it resolves ([`RealDirs`]), so neither a program git looks up by
/// name (a merge strategy, `git-lfs`) nor one a setting names can come from
/// the workspace.
fn git_path(bin: &Path, workspace: &Path, root: &Path, path: &str) -> String {
    let fence = RealDirs::new("", workspace, root);
    let mut dirs: Vec<String> = vec![bin.to_string_lossy().into_owned()];
    dirs.extend(path.split(':').filter(|d| d.starts_with('/') && !fence.fenced(Path::new(d))).map(str::to_string));
    dirs.join(":")
}

/// A git call the shim lets through, as it runs (#1287): the caller's
/// global options (whose settings are display or identity ones), then
/// `--no-pager`, [`GIT_SHIM_SETTINGS`] as `-c` and [`program_overrides`] as
/// `--config-env`, then the subcommand and its arguments, `git diff` with
/// `--no-ext-diff`. Its environment can't bring a program back: `GIT_PAGER`
/// is `cat`, `GIT_SSH_COMMAND` the ssh shim, `GIT_PROXY_COMMAND` empty (so
/// no `core.gitProxy` runs), `GIT_ASKPASS` and `SSH_ASKPASS` the refuser, a
/// merge doesn't open an editor, `GIT_EXTERNAL_DIFF`, `GIT_EDITOR`,
/// `GIT_SEQUENCE_EDITOR`, `GIT_SSH`, `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR`
/// are removed, and PATH holds no folder of the workspace ([`git_path`]).
/// `Err`: why a call is refused ([`program_overrides`]' keys, but for
/// `git config`; more nested repositories than it reads; a rebase whose
/// todo list runs a command).
fn git_call(
    real: &std::ffi::OsStr,
    bin: &Path,
    workspace: &Path,
    args: &[std::ffi::OsString],
    words: &[&str],
) -> Result<std::process::Command, &'static str> {
    let root = bin.parent().unwrap_or(bin);
    let refuser = root.join("askpass").join("refuse");
    let ssh = sh_quote(&bin.join("ssh").to_string_lossy());
    let at = git_subcommand_at(words);
    let location = git_location(args, words, at.unwrap_or(words.len()));
    let (overrides, refused) = program_overrides(&configured_programs(real, &location)?);
    // `git config` stays, so the key can be removed.
    if let Some(why) = refused.filter(|_| at.map(|i| words[i]) != Some("config")) {
        return Err(why);
    }
    if let Some(i) = at.filter(|i| words[*i] == "rebase") {
        let goes_on = words[i + 1..].iter().any(|a| matches!(*a, "--continue" | "--skip"));
        if goes_on && git_folders(real, &location).is_some_and(|(git_dir, _, _)| rebase_todo_runs(&git_dir)) {
            return Err("a rebase whose todo list runs a command (exec)");
        }
    }
    let mut full: Vec<std::ffi::OsString> = Vec::new();
    // After the caller's global options, or before them without a
    // subcommand, which `git --version` would take its arguments for.
    let split = at.unwrap_or(0);
    full.extend(args[..split].iter().cloned());
    full.push("--no-pager".into());
    for setting in GIT_SHIM_SETTINGS {
        let setting = setting
            .replace("{empty}", &root.join(EMPTY).to_string_lossy())
            .replace("{ssh}", &ssh)
            .replace("{refuser}", &refuser.to_string_lossy());
        full.push("-c".into());
        full.push(setting.into());
    }
    for (key, variable) in &overrides {
        full.push(format!("--config-env={key}={variable}").into());
    }
    match at {
        Some(i) => {
            full.push(args[i].clone());
            if words[i] == "diff" {
                full.push("--no-ext-diff".into());
            }
            full.extend(args[i + 1..].iter().cloned());
        }
        None => full.extend(args.iter().cloned()),
    }
    let mut command = std::process::Command::new(real);
    command
        .args(&full)
        .env("PATH", git_path(bin, workspace, root, &std::env::var("PATH").unwrap_or_default()))
        .env("GIT_PAGER", "cat")
        .env("GIT_SSH_COMMAND", &ssh)
        .env("GIT_PROXY_COMMAND", "")
        .env("GIT_ASKPASS", &refuser)
        .env("SSH_ASKPASS", &refuser)
        .env("GIT_MERGE_AUTOEDIT", "no")
        // Git runs an external diff through the shell.
        .env("OCTOPUSH_GIT_REFUSER", sh_quote(&refuser.to_string_lossy()));
    for (variable, value) in NEUTRAL {
        command.env(variable, value);
    }
    for name in ["GIT_EXTERNAL_DIFF", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_SSH", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR"] {
        command.env_remove(name);
    }
    Ok(command)
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
/// (empty when none was found), the shims' folder and the workspace.
fn shim_script(helper: &Path, name: &str, real: Option<&Path>, bin: &Path, workspace: &Path) -> String {
    format!(
        "#!/bin/sh\n\
         # Octopush: this workspace's mission ships nothing, so {name} is checked before it runs. Written by the app; read-only.\n\
         exec {} {HELPER_MODE} {} {} {} {} \"$@\"\n",
        sh_quote(&helper.to_string_lossy()),
        sh_quote(name),
        sh_quote(&real.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()),
        sh_quote(&bin.to_string_lossy()),
        sh_quote(&workspace.to_string_lossy()),
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
/// program's name, its real path (empty when none was found), the shims'
/// folder, the workspace and its arguments. A call the ship-nothing check refuses
/// (`permissions::shim_refusal`) exits 1 with one line on stderr; one with
/// no real program exits 127; any other becomes the real program (`exec`),
/// with its arguments and environment as they came, git as [`git_call`]
/// runs it. [`PROBE`] answers [`PROBE_REPLY`].
pub fn shim_main(args: Vec<std::ffi::OsString>) -> i32 {
    if args.len() == 1 && args[0] == PROBE {
        println!("{PROBE_REPLY}");
        return 0;
    }
    let [name, real, bin, workspace, rest @ ..] = args.as_slice() else {
        eprintln!("octopush-mcp barrier: expected a program, its path, the shims' folder, the workspace and its arguments");
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
    if name == "git" {
        return match git_call(real, Path::new(bin), Path::new(workspace), rest, &refs) {
            Ok(command) => exec(command, real),
            Err(what) => {
                eprintln!("{}", shim_refusal_text(&name, what));
                1
            }
        };
    }
    let mut command = std::process::Command::new(real);
    command.args(rest);
    exec(command, real)
}

/// The one line a refused shim call prints.
pub fn shim_refusal_text(name: &str, what: &str) -> String {
    format!("Octopush refused `{name}`: this workspace's mission ships nothing ({what}). Nothing was sent.")
}

#[cfg(unix)]
fn exec(mut command: std::process::Command, real: &std::ffi::OsStr) -> i32 {
    use std::os::unix::process::CommandExt;
    let err = command.exec();
    eprintln!("Octopush: couldn't run {}: {err}", Path::new(real).display());
    126
}

#[cfg(not(unix))]
fn exec(_command: std::process::Command, real: &std::ffi::OsStr) -> i32 {
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

    /// The review's reproduction (#1287): a git config the agent wrote and
    /// named for the command (`XDG_CONFIG_HOME`), holding an alias to
    /// `push`, a `pushInsteadOf` longer than the rewrite's prefixes, and a
    /// credential helper that holds a token. The Talk check refuses the
    /// prefix; through the shim the alias and the credential store are
    /// refused; and no git, by name or by full path, gets the token, since
    /// the barrier empties `credential.helper`. Without the barrier the same
    /// config does hand the token out.
    #[test]
    fn a_config_the_agent_wrote_neither_pushes_nor_hands_out_a_token() {
        let r = repo();
        let real = r.real_git();
        let cfg = r.ws.join("cfg");
        std::fs::create_dir_all(cfg.join("git")).unwrap();
        let creds = r.ws.join("creds");
        std::fs::write(&creds, "https://user:ghp_saved_token@example.com\n").unwrap();
        let remote = r.remote.to_str().unwrap();
        let config = format!(
            "[alias]\n\tp = push\n\tStatus = push\n[url \"{remote}\"]\n\tpushInsteadOf = {remote}\n[credential]\n\thelper = store --file={}\n",
            creds.display()
        );
        std::fs::write(cfg.join("git/config"), config).unwrap();
        for line in ["XDG_CONFIG_HOME=cfg git p origin main", "XDG_CONFIG_HOME=cfg git push origin main"] {
            assert!(crate::permissions::ship_nothing_shell_refusal(line).is_some(), "{line}");
        }
        let with_cfg = "export XDG_CONFIG_HOME=\"$PWD/cfg\";";
        for call in ["git p origin main", "git Status", "git push origin main"] {
            let (ok, out) = r.run(&format!("{with_cfg} {call}"));
            assert!(!ok && out.contains("Octopush refused `git`"), "{call}: {out}");
        }
        assert!(!r.pushed(), "the remote got the push");
        let fill = "printf 'protocol=https\\nhost=example.com\\n\\n' |";
        let (ok, out) = r.run(&format!("{with_cfg} {fill} git credential fill"));
        assert!(!ok && out.contains("Octopush refused `git`") && !out.contains("ghp_saved_token"), "{out}");
        let (_, out) = r.run(&format!("{with_cfg} {fill} '{}' credential fill", real.display()));
        assert!(!out.contains("ghp_saved_token"), "by full path: {out}");
        // The same config, without the barrier, hands the token out.
        let mut plain = Command::new(&real);
        plain
            .args(["credential", "fill"])
            .current_dir(&r.ws)
            .env("XDG_CONFIG_HOME", &cfg)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());
        let mut child = plain.spawn().unwrap();
        {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(b"protocol=https\nhost=example.com\n\n").unwrap();
        }
        let out = child.wait_with_output().unwrap();
        assert!(String::from_utf8_lossy(&out.stdout).contains("ghp_saved_token"), "the test's config is real");
    }

    /// The review's reproduction (#1287, at `7a175724`): a git setting that
    /// runs a program, given with `-c` or `--config-env`, and the same keys
    /// in the repository's own config, its hooks, a filter, and a nested
    /// repository's config. Each program would push (it drops the push
    /// rewrite, and git puts its own folder ahead of the shims on its PATH).
    /// Through the shim the settings are refused and the config's programs
    /// never run; without the barrier the same config runs one and pushes.
    #[test]
    fn a_program_a_git_setting_names_never_runs() {
        use std::os::unix::fs::PermissionsExt;
        let r = repo();
        let marker = r.ws.join("evil-ran");
        let evil = r.ws.join("evil");
        std::fs::write(
            &evil,
            format!(
                "#!/bin/sh\ntouch '{}'\nunset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS\ngit -C '{}' push -q origin HEAD:refs/heads/evil >/dev/null 2>&1\nexit 0\n",
                marker.display(),
                r.ws.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&evil, std::fs::Permissions::from_mode(0o755)).unwrap();
        let e = evil.display().to_string();
        let ran = || {
            let ran = marker.exists();
            let _ = std::fs::remove_file(&marker);
            ran
        };
        std::fs::write(r.ws.join("f.txt"), "one\n").unwrap();
        let (ok, out) = r.run("git add f.txt && git -c user.name=t -c user.email=t@example.com commit -q -m f");
        assert!(ok, "{out}");
        // Given on the command line: refused before git runs.
        for call in [
            format!("git -c diff.external={e} diff"),
            format!("git -c core.fsmonitor={e} status"),
            format!("git -c core.pager={e} log -1"),
            "git -c core.hooksPath=. commit --allow-empty -m x".to_string(),
            format!("EVIL={e} git --config-env=core.fsmonitor=EVIL status"),
            format!("EVIL={e} git --config-env core.pager=EVIL log -1"),
            format!("git -c pager.log={e} log -1"),
            "git log -p --ext-diff -1".to_string(),
            "git --exec-path=. status".to_string(),
        ] {
            let (ok, out) = r.run(&call);
            assert!(!ok && out.contains("Octopush refused `git`"), "{call}: {out}");
        }
        assert!(!ran() && !r.pushed(), "a refused call ran its program");
        // In the repository's config, a hook, a filter: they never run.
        std::fs::write(r.ws.join("f.txt"), "two\n").unwrap();
        let in_ws = |args: &[&str]| git(&r.ws, args);
        in_ws(&["config", "core.fsmonitor", &e]);
        in_ws(&["config", "diff.external", &e]);
        in_ws(&["config", "filter.ev.clean", &e]);
        in_ws(&["config", "filter.ev.process", &e]);
        in_ws(&["config", "diff.dd.textconv", &e]);
        std::fs::write(r.ws.join(".git/info/attributes"), "* filter=ev diff=dd\n").unwrap();
        std::fs::create_dir_all(r.ws.join(".git/hooks")).unwrap();
        std::fs::copy(&evil, r.ws.join(".git/hooks/post-commit")).unwrap();
        for call in [
            "git status --short",
            "git diff",
            "git log -p -1",
            "git show --stat",
            "git add f.txt",
            "git -c user.name=t -c user.email=t@example.com commit -q -m two",
        ] {
            let (ok, out) = r.run(call);
            assert!(ok, "{call}: {out}");
            assert!(!ran(), "{call} ran a program the config names");
        }
        // A nested repository, which `git status` looks into, with a filter
        // of its own.
        let inner = r.ws.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        in_ws(&["init", "-q", "-b", "main", "inner"]);
        std::fs::write(inner.join(".gitattributes"), "* filter=nested\n").unwrap();
        std::fs::write(inner.join("a.txt"), "x\n").unwrap();
        git(&inner, &["add", "."]);
        git(&inner, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "in"]);
        git(&inner, &["config", "filter.nested.clean", &e]);
        in_ws(&["add", "inner"]);
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(inner.join("a.txt"), "y\n").unwrap();
        let (ok, out) = r.run("git status --short");
        assert!(ok, "{out}");
        assert!(!ran(), "git status ran the nested repository's filter");
        assert!(!r.pushed(), "the remote got a push");
        // Without the barrier, the same config runs its program, which pushes.
        Command::new(r.real_git()).args(["status", "--short"]).current_dir(&r.ws).stdin(std::process::Stdio::null()).output().unwrap();
        assert!(ran(), "the test's config is real");
        assert!(r.pushed(), "the test's program pushes");
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
        let call = |args: &[&str]| {
            let mut all: Vec<std::ffi::OsString> = ["git", "", "/nonexistent/bin", "/nonexistent/ws"].iter().map(Into::into).collect();
            all.extend(args.iter().map(Into::into));
            shim_main(all)
        };
        assert_eq!(call(&["push"]), 1, "refused before anything runs");
        assert_eq!(call(&["-c", "core.fsmonitor=./x", "status"]), 1, "a setting that runs a program is refused first");
        assert_eq!(call(&["status"]), 127, "no real program");
        assert_eq!(shim_main(vec!["git".into(), "".into(), "push".into()]), 2, "the old layout is refused");
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
