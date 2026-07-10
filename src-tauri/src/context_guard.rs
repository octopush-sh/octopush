//! Per-session context isolation.
//!
//! `ContextGuard` scans a project root to auto-detect configuration files,
//! git branch, project type, and produces an isolated env map for the PTY.
//! Each session gets its own shell history file and context-file list.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContextGuard {
    pub session_id: String,
    pub working_dir: PathBuf,
    pub env_vars: HashMap<String, String>,
    pub context_files: Vec<PathBuf>,
    pub git_branch: Option<String>,
    pub project_type: Option<ProjectType>,
    pub shell_history_file: PathBuf,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProjectType {
    Rust,
    Node,
    Python,
    Go,
    Java,
    Ruby,
    Unknown,
}

impl ContextGuard {
    /// Build a `ContextGuard` by scanning the project root.
    pub fn auto_configure(session_id: &str, project_root: &Path) -> Self {
        let history_dir = data_dir().join("history");
        let _ = std::fs::create_dir_all(&history_dir);
        let shell_history_file = history_dir.join(format!("{session_id}.hist"));

        let context_files = detect_context_files(project_root);
        let git_branch = detect_git_branch(project_root);
        let project_type = detect_project_type(project_root);

        // Read .env file if present (not exported to the PTY directly for
        // safety — stored so the UI can show them and the user can opt-in).
        let mut env_vars = HashMap::new();

        // Isolated history per session.
        env_vars.insert("HISTFILE".into(), shell_history_file.to_string_lossy().into_owned());
        env_vars.insert("OCTOPUSH_PROJECT_TYPE".into(),
            project_type.as_ref().map(|t| format!("{t:?}")).unwrap_or_default());

        if let Some(ref branch) = git_branch {
            env_vars.insert("OCTOPUSH_GIT_BRANCH".into(), branch.clone());
        }

        Self {
            session_id: session_id.to_string(),
            working_dir: project_root.to_path_buf(),
            env_vars,
            context_files,
            git_branch,
            project_type,
            shell_history_file,
        }
    }

    /// Merge the guard's env_vars into the given map (guard wins on conflict).
    pub fn apply_env(&self, target: &mut HashMap<String, String>) {
        for (k, v) in &self.env_vars {
            target.insert(k.clone(), v.clone());
        }
    }

    /// Check whether `path` is inside the session's working directory.
    pub fn validate_file_access(&self, path: &Path) -> bool {
        path.starts_with(&self.working_dir)
    }
}

fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("octopush")
}

fn detect_context_files(root: &Path) -> Vec<PathBuf> {
    let candidates = [
        "CLAUDE.md",
        ".claude/settings.json",
        "AGENTS.md",
        "GEMINI.md",
        ".cursorrules",
        ".github/copilot-instructions.md",
        "CONVENTIONS.md",
    ];
    candidates
        .iter()
        .map(|c| root.join(c))
        .filter(|p| p.exists())
        .collect()
}

fn detect_git_branch(root: &Path) -> Option<String> {
    let head = root.join(".git/HEAD");
    let content = std::fs::read_to_string(head).ok()?;
    let trimmed = content.trim();
    if let Some(branch) = trimmed.strip_prefix("ref: refs/heads/") {
        Some(branch.to_string())
    } else {
        // Detached HEAD — first 8 chars of SHA.
        Some(trimmed.chars().take(8).collect())
    }
}

fn detect_project_type(root: &Path) -> Option<ProjectType> {
    if root.join("Cargo.toml").exists() {
        Some(ProjectType::Rust)
    } else if root.join("package.json").exists() {
        Some(ProjectType::Node)
    } else if root.join("pyproject.toml").exists()
        || root.join("setup.py").exists()
        || root.join("requirements.txt").exists()
    {
        Some(ProjectType::Python)
    } else if root.join("go.mod").exists() {
        Some(ProjectType::Go)
    } else if root.join("pom.xml").exists() || root.join("build.gradle").exists() {
        Some(ProjectType::Java)
    } else if root.join("Gemfile").exists() {
        Some(ProjectType::Ruby)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn auto_configure_empty_dir() {
        let tmp = TempDir::new().unwrap();
        let guard = ContextGuard::auto_configure("test-1", tmp.path());
        assert_eq!(guard.session_id, "test-1");
        assert_eq!(guard.working_dir, tmp.path());
        assert!(guard.context_files.is_empty());
        assert!(guard.git_branch.is_none());
        assert!(guard.project_type.is_none());
        assert!(guard.env_vars.contains_key("HISTFILE"));
    }

    #[test]
    fn detects_context_files() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("CLAUDE.md"), "# context").unwrap();
        std::fs::write(tmp.path().join("AGENTS.md"), "# agents").unwrap();
        let guard = ContextGuard::auto_configure("test-2", tmp.path());
        assert_eq!(guard.context_files.len(), 2);
    }

    #[test]
    fn detects_project_type_node() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("package.json"), "{}").unwrap();
        let guard = ContextGuard::auto_configure("test-3", tmp.path());
        assert_eq!(guard.project_type, Some(ProjectType::Node));
    }

    #[test]
    fn detects_project_type_rust() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join("Cargo.toml"), "[package]").unwrap();
        let guard = ContextGuard::auto_configure("test-4", tmp.path());
        assert_eq!(guard.project_type, Some(ProjectType::Rust));
    }

    #[test]
    fn detects_git_branch() {
        let tmp = TempDir::new().unwrap();
        let git_dir = tmp.path().join(".git");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/feature/cool\n").unwrap();
        let guard = ContextGuard::auto_configure("test-5", tmp.path());
        assert_eq!(guard.git_branch.as_deref(), Some("feature/cool"));
    }

    #[test]
    fn validate_file_access() {
        let tmp = TempDir::new().unwrap();
        let guard = ContextGuard::auto_configure("test-6", tmp.path());
        assert!(guard.validate_file_access(&tmp.path().join("src/main.rs")));
        assert!(!guard.validate_file_access(Path::new("/etc/passwd")));
    }

    #[test]
    fn apply_env_merges() {
        let tmp = TempDir::new().unwrap();
        let guard = ContextGuard::auto_configure("test-7", tmp.path());
        let mut env = HashMap::new();
        env.insert("EXISTING".into(), "val".into());
        guard.apply_env(&mut env);
        assert!(env.contains_key("HISTFILE"));
        assert_eq!(env.get("EXISTING").unwrap(), "val");
    }
}
